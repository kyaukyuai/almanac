/**
 * Management-layer boundary for local runtime invocation.
 *
 * `almanac run` will be a CLI wrapper over this module. Keeping the runtime
 * invocation here avoids coupling Commander parsing to `AlmanacRuntime` and
 * gives tests one deterministic place to pin status / exit-code semantics.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  AlmanacRuntimeOptions,
  ToolLogger,
} from "../core/runtime.ts";
import {
  createAlmanacRuntime,
  ToolNotFoundError,
} from "../core/runtime.ts";
import {
  ToolResultSchema,
  type ToolManifest,
  type ToolResult,
} from "../core/types.ts";
import { readManifest } from "../compile/storage.ts";

export type RunToolStatus =
  | "ok"
  | "bad-input"
  | "tool-not-found"
  | "tool-error";

export type RunToolExitCode = 0 | 1 | 2;

export interface RunToolOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Tool manifest name, e.g. `query_facts`. */
  toolName: string;
  /** Parsed JSON object supplied to the tool. */
  input: unknown;
  /** Optional runtime dependency overrides, mainly for tests. */
  resolveSecret?: AlmanacRuntimeOptions["resolveSecret"];
  fetchImpl?: AlmanacRuntimeOptions["fetchImpl"];
  log?: ToolLogger;
}

export interface RunToolExecution {
  almanacId: string;
  version: string;
  toolName: string;
  input: Record<string, unknown> | null;
  status: RunToolStatus;
  result: ToolResult;
  durationMs: number;
  citationsCount: number;
  availableTools?: string[];
}

export interface ListRunToolsOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Optional runtime dependency overrides, mainly for tests. */
  resolveSecret?: AlmanacRuntimeOptions["resolveSecret"];
  fetchImpl?: AlmanacRuntimeOptions["fetchImpl"];
  log?: ToolLogger;
}

export interface RunToolList {
  almanacId: string;
  version: string;
  tools: ToolManifest[];
}

export class RunToolSetupError extends Error {
  constructor(
    public readonly code: "bad-almanac-dir" | "almanac-not-found",
    message: string,
  ) {
    super(message);
    this.name = "RunToolSetupError";
  }
}

/**
 * Invoke one compiled almanac tool and normalize expected command-facing
 * failures into a stable `RunToolExecution`.
 */
export async function runTool(
  options: RunToolOptions,
): Promise<RunToolExecution> {
  const startedAt = Date.now();
  const manifest = await readRunToolManifest(options.almanacDir);
  const input = normalizeToolInput(options.input);
  if (input === null) {
    return {
      almanacId: manifest.almanacId,
      version: manifest.version,
      toolName: options.toolName,
      input: null,
      status: "bad-input",
      result: errorResult(
        "bad-input",
        "tool input must be a JSON object",
      ),
      durationMs: Date.now() - startedAt,
      citationsCount: 0,
    };
  }

  const runtime = await createAlmanacRuntime({
    almanacDir: options.almanacDir,
    resolveSecret: options.resolveSecret,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });

  try {
    const result = await runtime.execTool(options.toolName, input);
    return {
      almanacId: manifest.almanacId,
      version: manifest.version,
      toolName: options.toolName,
      input,
      status: classifyToolResult(result),
      result,
      durationMs: Date.now() - startedAt,
      citationsCount: result.ok ? result.citations.length : 0,
    };
  } catch (cause) {
    if (cause instanceof ToolNotFoundError) {
      const availableTools = (await runtime.listTools()).map(
        (tool) => tool.name,
      );
      return {
        almanacId: manifest.almanacId,
        version: manifest.version,
        toolName: options.toolName,
        input,
        status: "tool-not-found",
        result: errorResult(
          "tool-not-found",
          `tool not found: "${options.toolName}"`,
        ),
        durationMs: Date.now() - startedAt,
        citationsCount: 0,
        availableTools,
      };
    }
    throw cause;
  } finally {
    closeRuntime(runtime);
  }
}

export async function listRunTools(
  options: ListRunToolsOptions,
): Promise<RunToolList> {
  const manifest = await readRunToolManifest(options.almanacDir);
  const runtime = await createAlmanacRuntime({
    almanacDir: options.almanacDir,
    resolveSecret: options.resolveSecret,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });

  try {
    return {
      almanacId: manifest.almanacId,
      version: manifest.version,
      tools: await runtime.listTools(),
    };
  } finally {
    closeRuntime(runtime);
  }
}

export function exitCodeForRunTool(
  execution: RunToolExecution,
): RunToolExitCode {
  if (execution.status === "ok") return 0;
  if (
    execution.status === "bad-input" ||
    execution.status === "tool-not-found"
  ) {
    return 2;
  }
  return 1;
}

export function formatRunToolHuman(execution: RunToolExecution): string {
  const lines = [
    `tool: ${execution.toolName}`,
    `status: ${execution.status}`,
    `almanac: ${execution.almanacId} (${execution.version})`,
  ];

  if (execution.result.ok) {
    lines.push(`citations: ${execution.citationsCount}`);
    lines.push(
      `freshness: ${execution.result.freshness.class}/${execution.result.freshness.staleness}`,
    );
    lines.push("data:");
    lines.push(JSON.stringify(execution.result.data, null, 2));
  } else {
    lines.push(
      `error: ${execution.result.error.code}: ${execution.result.error.message}`,
    );
    if (execution.availableTools !== undefined) {
      lines.push(
        `available tools: ${execution.availableTools.join(", ") || "(none)"}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

export function formatRunToolListHuman(list: RunToolList): string {
  const lines = [
    `tools: ${list.almanacId} (${list.version})`,
  ];
  if (list.tools.length === 0) {
    lines.push("  (none)");
    return lines.join("\n") + "\n";
  }

  for (const tool of list.tools) {
    lines.push(
      `  - ${tool.name}  ${tool.volatilityClass}  facts=${tool.knowledgeUsage.facts ? "yes" : "no"}`,
    );
    lines.push(`    ${tool.description}`);
  }
  return lines.join("\n") + "\n";
}

async function readRunToolManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new RunToolSetupError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new RunToolSetupError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}

function normalizeToolInput(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function classifyToolResult(result: ToolResult): RunToolStatus {
  if (result.ok) return "ok";
  if (result.error.code === "bad-input") return "bad-input";
  return "tool-error";
}

function errorResult(code: string, message: string): ToolResult {
  return ToolResultSchema.parse({
    ok: false,
    error: { code, message, retryable: false },
  }) as ToolResult;
}

function closeRuntime(runtime: unknown): void {
  const candidate = runtime as { close?: unknown };
  if (typeof candidate.close === "function") {
    candidate.close();
  }
}
