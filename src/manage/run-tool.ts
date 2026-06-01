/**
 * Management-layer boundary for local runtime invocation.
 *
 * `almanac run` will be a CLI wrapper over this module. Keeping the runtime
 * invocation here avoids coupling Commander parsing to `AlmanacRuntime` and
 * gives tests one deterministic place to pin status / exit-code semantics.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
  AlmanacRuntimeOptions,
  ToolLogger,
} from "../core/runtime.ts";
import {
  createAlmanacRuntime,
  ToolNotFoundError,
} from "../core/runtime.ts";
import {
  RunToolArtifactSchema,
  RunToolRunIdSchema,
  ToolResultSchema,
  type RunToolArtifact,
  type RunToolExitCode,
  type RunToolStatus,
  type ToolManifest,
  type ToolResult,
} from "../core/types.ts";
import { readManifest } from "../compile/storage.ts";

export type { RunToolExitCode, RunToolStatus } from "../core/types.ts";

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
  runId: string;
  invokedAt: string;
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

export interface SaveRunToolArtifactOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  execution: RunToolExecution;
  /** Optional short human label for later audit lookup. */
  label?: string;
  /** Optional human note describing why this run was saved. */
  note?: string;
}

export interface SaveRunToolArtifactResult {
  artifact: RunToolArtifact;
  path: string;
  relPath: string;
}

export interface ListRunToolArtifactsOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Keep only artifacts with this status. */
  status?: RunToolStatus;
  /** Keep only artifacts with this exact label. */
  label?: string;
  /** Maximum number of newest artifacts to return. */
  limit?: number;
}

export interface RunToolArtifactSummary {
  artifactRelPath: string;
  runId: string;
  invokedAt: string;
  toolName: string;
  label?: string;
  status: RunToolStatus;
  exitCode: RunToolExitCode;
  durationMs: number;
  citationsCount: number;
}

export interface RunToolArtifactList {
  almanacId: string;
  version: string;
  artifactsDir: string;
  runs: RunToolArtifactSummary[];
}

export interface ReadRunToolArtifactOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  runId: string;
}

export interface ReadRunToolArtifactResult {
  artifact: RunToolArtifact;
  path: string;
  relPath: string;
}

export class RunToolSetupError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "bad-run-id"
      | "run-artifact-not-found"
      | "run-artifact-invalid",
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
  const invokedAt = new Date(startedAt).toISOString();
  const runId = generateRunToolRunId(invokedAt);
  const manifest = await readRunToolManifest(options.almanacDir);
  const input = normalizeToolInput(options.input);
  if (input === null) {
    return {
      runId,
      invokedAt,
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
      runId,
      invokedAt,
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
        runId,
        invokedAt,
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

export async function saveRunToolArtifact(
  options: SaveRunToolArtifactOptions,
): Promise<SaveRunToolArtifactResult> {
  await readRunToolManifest(options.almanacDir);
  const relPath = runToolArtifactRelPath(options.execution.runId);
  const path = join(options.almanacDir, relPath);
  const artifact = RunToolArtifactSchema.parse({
    schemaVersion: "0.1.0",
    artifactRelPath: relPath,
    ...options.execution,
    ...runToolArtifactMetadata(options),
    exitCode: exitCodeForRunTool(options.execution),
  });

  await mkdir(runToolArtifactsDirPath(options.almanacDir), { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { artifact, path, relPath };
}

export function runToolArtifactsDirPath(almanacDir: string): string {
  return join(almanacDir, ".runs");
}

export function runToolArtifactRelPath(runId: string): string {
  return `.runs/${runId}.json`;
}

export async function listRunToolArtifacts(
  options: ListRunToolArtifactsOptions,
): Promise<RunToolArtifactList> {
  const manifest = await readRunToolManifest(options.almanacDir);
  const artifactsDir = runToolArtifactsDirPath(options.almanacDir);
  const files = await readRunToolArtifactFiles(artifactsDir);
  const artifacts = await Promise.all(
    files.map(async (fileName) => {
      const relPath = `.runs/${fileName}`;
      const path = join(options.almanacDir, relPath);
      return readAndParseRunToolArtifact(path);
    }),
  );
  const filteredArtifacts = filterRunToolArtifacts(artifacts, options);
  filteredArtifacts.sort(compareRunToolArtifactsNewestFirst);

  const limit = options.limit ?? filteredArtifacts.length;
  return {
    almanacId: manifest.almanacId,
    version: manifest.version,
    artifactsDir,
    runs: filteredArtifacts.slice(0, limit).map(summarizeRunToolArtifact),
  };
}

export async function readRunToolArtifact(
  options: ReadRunToolArtifactOptions,
): Promise<ReadRunToolArtifactResult> {
  await readRunToolManifest(options.almanacDir);
  const runId = parseRunToolRunId(options.runId);
  const relPath = runToolArtifactRelPath(runId);
  const path = join(options.almanacDir, relPath);
  return {
    artifact: await readAndParseRunToolArtifact(path),
    path,
    relPath,
  };
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
    `run: ${execution.runId}`,
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

export function formatRunToolArtifactListHuman(
  list: RunToolArtifactList,
): string {
  const lines = [
    `runs: ${list.almanacId} (${list.version})`,
  ];
  if (list.runs.length === 0) {
    lines.push("  (none)");
    return lines.join("\n") + "\n";
  }

  for (const run of list.runs) {
    const label = run.label === undefined ? "" : `  label=${run.label}`;
    lines.push(
      `  - ${run.invokedAt}  ${run.runId}  ${run.status}  ${run.toolName}  exit=${run.exitCode} citations=${run.citationsCount} duration=${run.durationMs}ms${label}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function formatRunToolArtifactHuman(artifact: RunToolArtifact): string {
  const lines = [
    `run: ${artifact.runId}`,
    `tool: ${artifact.toolName}`,
    `status: ${artifact.status}`,
    `exit: ${artifact.exitCode}`,
    `almanac: ${artifact.almanacId} (${artifact.version})`,
    `invoked: ${artifact.invokedAt}`,
    `duration: ${artifact.durationMs}ms`,
    `citations: ${artifact.citationsCount}`,
    `artifact: ${artifact.artifactRelPath}`,
  ];
  if (artifact.label !== undefined) {
    lines.push(`label: ${artifact.label}`);
  }
  if (artifact.note !== undefined) {
    lines.push("note:");
    lines.push(artifact.note);
  }

  if (artifact.result.ok) {
    lines.push(
      `freshness: ${artifact.result.freshness.class}/${artifact.result.freshness.staleness}`,
    );
    lines.push("data:");
    lines.push(JSON.stringify(artifact.result.data, null, 2));
  } else {
    lines.push(
      `error: ${artifact.result.error.code}: ${artifact.result.error.message}`,
    );
    if (artifact.availableTools !== undefined) {
      lines.push(
        `available tools: ${artifact.availableTools.join(", ") || "(none)"}`,
      );
    }
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

async function readRunToolArtifactFiles(artifactsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(artifactsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^run-[A-Za-z0-9-]+\.json$/.test(name));
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      return [];
    }
    throw e;
  }
}

async function readAndParseRunToolArtifact(
  path: string,
): Promise<RunToolArtifact> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      throw new RunToolSetupError(
        "run-artifact-not-found",
        `run artifact does not exist: ${path}`,
      );
    }
    throw e;
  }

  try {
    return RunToolArtifactSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new RunToolSetupError(
      "run-artifact-invalid",
      `invalid run artifact ${path}: ${(e as Error).message}`,
    );
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function parseRunToolRunId(runId: string): string {
  const parsed = RunToolRunIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new RunToolSetupError(
      "bad-run-id",
      `run id must look like run-YYYY-MM-DDTHH-MM-SS-SSSZ-xxxxxxxx: ${runId}`,
    );
  }
  return parsed.data;
}

function summarizeRunToolArtifact(
  artifact: RunToolArtifact,
): RunToolArtifactSummary {
  return {
    artifactRelPath: artifact.artifactRelPath,
    runId: artifact.runId,
    invokedAt: artifact.invokedAt,
    toolName: artifact.toolName,
    ...(artifact.label === undefined ? {} : { label: artifact.label }),
    status: artifact.status,
    exitCode: artifact.exitCode,
    durationMs: artifact.durationMs,
    citationsCount: artifact.citationsCount,
  };
}

function filterRunToolArtifacts(
  artifacts: RunToolArtifact[],
  options: ListRunToolArtifactsOptions,
): RunToolArtifact[] {
  return artifacts.filter((artifact) => {
    if (options.status !== undefined && artifact.status !== options.status) {
      return false;
    }
    if (options.label !== undefined && artifact.label !== options.label) {
      return false;
    }
    return true;
  });
}

function runToolArtifactMetadata(
  options: SaveRunToolArtifactOptions,
): Partial<Pick<RunToolArtifact, "label" | "note">> {
  return {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.note === undefined ? {} : { note: options.note }),
  };
}

function compareRunToolArtifactsNewestFirst(
  a: RunToolArtifact,
  b: RunToolArtifact,
): number {
  const byInvokedAt = b.invokedAt.localeCompare(a.invokedAt);
  if (byInvokedAt !== 0) return byInvokedAt;
  return b.runId.localeCompare(a.runId);
}

function generateRunToolRunId(invokedAt: string): string {
  return (
    `run-${invokedAt.replace(/[:.]/g, "-")}-` +
    randomBytes(4).toString("hex")
  );
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
