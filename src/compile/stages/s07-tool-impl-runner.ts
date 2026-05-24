/**
 * Stage 7 — pipeline adapter for tool implementation.
 *
 *   1. Reads the Stage 6 `ToolDesignResult` (`.compile/tool-design.json`).
 *   2. Synthesizes the four default `ToolManifest`s via
 *      `synthesizeAllDefaultManifests` and concatenates them with the
 *      design's `customTools` (defaults first, then customs).
 *   3. Drives the per-tool implementation loop with `runToolImplementation`,
 *      registering only `TemplateImplementer` for v0.1. Custom tools without
 *      a matching implementer are recorded as `disabled` (the orchestrator's
 *      built-in fallback for `NoImplementerForToolError`).
 *   4. Persists per-tool final manifests as `tools/<name>.json` and the
 *      aggregate Stage 7 output as `.compile/stage07-output.json`.
 *
 * `outputHash` = sha256 of the canonical Stage 7 output JSON.
 *
 * NOTE: This runner accepts an optional `customToolImplementer` so a future
 * `LlmImplementer` can be wired in without changing the runner. When omitted,
 * only the four template tools land successfully — that is the intended
 * minimum-e2e shape for v0.1.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ToolDesignResultSchema,
  type Stage07Output,
  type ToolDesignResult,
  type ToolManifest,
} from "../../core/types.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { toolDesignPath } from "./s06-tool-design.ts";
import { writeFinalManifest, writeToolFiles } from "./s07/file-writer.ts";
import {
  TemplateImplementer,
  synthesizeAllDefaultManifests,
} from "./s07/template-implementer.ts";
import {
  runToolImplementation,
  type ImplementationContext,
  type LlmCodeWriter,
  type SmokeTestRunner,
  type ToolImplementer,
  type TscRunner,
} from "./s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Re-exports
// ──────────────────────────────────────────────────────────────────────────────
// Surface the implementer-context sub-interfaces here so callers that build a
// runner (cli.ts) don't need to dip into `s07-tool-impl.ts` directly.
export type {
  LlmCodeWriter,
  TscRunner,
  SmokeTestRunner,
} from "./s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths + constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE07_OUTPUT_REL_PATH = ".compile/stage07-output.json";

export function stage07OutputPath(almanacDir: string): string {
  return join(almanacDir, STAGE07_OUTPUT_REL_PATH);
}

/** Default per-tool retry budget. Templates always succeed in 1 attempt. */
export const STAGE7_DEFAULT_MAX_ATTEMPTS = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingToolDesignError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 7 requires the Stage 6 ToolDesignResult at ${path}; ` +
        "run Stage 6 first or restore the file",
    );
    this.name = "MissingToolDesignError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateToolImplRunnerOptions {
  /**
   * Implementer for domain-specific custom tools. Defaults to no second
   * implementer (in which case custom tools are recorded as `disabled` with
   * a `no implementer matched` reason). Wire in an `LlmImplementer` here to
   * enable LLM-driven generation for non-default tool names.
   */
  customToolImplementer?: ToolImplementer;
  /**
   * Code-generator service to inject into `ImplementationContext.llm`. When
   * omitted a stub that throws is used — appropriate for runs that only
   * have a `TemplateImplementer` registered (the four defaults never touch
   * `ctx.llm`).
   */
  llm?: LlmCodeWriter;
  /**
   * Type-checker to inject into `ImplementationContext.tsc`. Same stub-by-
   * default pattern as `llm`.
   */
  tsc?: TscRunner;
  /**
   * Smoke-test runner to inject into `ImplementationContext.smoke`. Same
   * stub-by-default pattern as `llm`.
   */
  smoke?: SmokeTestRunner;
  /** Override `STAGE7_DEFAULT_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Test seam: read Stage 6 output. */
  readToolDesign?: (almanacDir: string) => Promise<ToolDesignResult>;
  /** Test seam: skip default tools (used by tests that want only customs). */
  skipDefaults?: boolean;
}

/**
 * Build the Stage 7 `StageRunner`. Deterministic from the runner's POV
 * (`promptVersion = null`); the underlying templates are pure code generation.
 */
export function createToolImplRunner(
  opts: CreateToolImplRunnerOptions = {},
): StageRunner {
  const readToolDesign = opts.readToolDesign ?? defaultReadToolDesign;
  const maxAttempts = opts.maxAttempts ?? STAGE7_DEFAULT_MAX_ATTEMPTS;
  const skipDefaults = opts.skipDefaults ?? false;

  const implementers: ToolImplementer[] = [new TemplateImplementer()];
  if (opts.customToolImplementer) {
    implementers.push(opts.customToolImplementer);
  }

  return {
    promptVersion: null,
    async run(ctx) {
      const design = await readToolDesign(ctx.almanacDir);

      const manifests: ToolManifest[] = [];
      if (!skipDefaults) {
        manifests.push(...synthesizeAllDefaultManifests());
      }
      manifests.push(...design.customTools);

      if (manifests.length === 0) {
        // The schema requires ≥1 result; with no manifests there's nothing to
        // write. Skip the stage rather than failing.
        ctx.log({ event: "stage7:skipped", reason: "no-manifests" });
        return { kind: "skipped", reason: "no-manifests" };
      }

      // Remove stale tool files from prior runs. Without this, an `update
      // --from-stage=...` that re-designs Stage 6 with a different custom-
      // tool set leaves orphan `tools/<old-name>.{json,ts,test.ts}` on
      // disk. The runtime tool-loader then picks them up and the next
      // Stage 11 / 12 / runtime call dispatches to a dead manifest.
      const expectedNames = new Set(manifests.map((m) => m.name));
      const removed = await removeStaleToolFiles(
        ctx.almanacDir,
        expectedNames,
      );
      if (removed.length > 0) {
        ctx.log({
          event: "stage7:stale-tools-removed",
          names: removed,
        });
      }

      const implementationCtx: ImplementationContext = {
        almanacDir: ctx.almanacDir,
        llm: opts.llm ?? stubLlmCodeWriter,
        tsc: opts.tsc ?? stubTscRunner,
        smoke: opts.smoke ?? stubSmokeTestRunner,
        writeToolFiles: (input) =>
          writeToolFiles({ almanacDir: ctx.almanacDir, ...input }),
        now: ctx.now,
        log: ctx.log,
      };

      ctx.log({
        event: "stage7:start",
        defaults: skipDefaults ? 0 : manifests.length - design.customTools.length,
        customs: design.customTools.length,
      });

      const output = await runToolImplementation({
        manifests,
        almanacDir: ctx.almanacDir,
        ctx: implementationCtx,
        implementers,
        maxAttempts,
      });

      // Persist each tool's final manifest under tools/<name>.json so the
      // runtime can discover them.
      for (const r of output.results) {
        await writeFinalManifest({
          almanacDir: ctx.almanacDir,
          manifest: r.finalManifest,
        });
      }

      const canonicalText = JSON.stringify(output, null, 2);
      const outPath = stage07OutputPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage7:done",
        outputHash,
        implemented: output.summary.implemented,
        disabled: output.summary.disabled,
      });

      return {
        kind: "success",
        outputHash,
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function defaultReadToolDesign(
  almanacDir: string,
): Promise<ToolDesignResult> {
  const path = toolDesignPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingToolDesignError(path, cause);
    }
    throw cause;
  }
  return ToolDesignResultSchema.parse(JSON.parse(body));
}

/**
 * Remove `<almanacDir>/tools/<name>.{json,ts,test.ts}` triplets for every
 * tool name NOT in `expectedNames`. Used to garbage-collect stale tool
 * files left over from a prior Stage 7 run whose custom-tool set differed.
 *
 * Returns the list of unique tool names that were removed (handy for
 * structured logging + tests).
 *
 * Files that are NOT part of a `(json, ts, test.ts)` triplet are left
 * alone — the runtime tool-loader ignores them anyway, and we don't want
 * to remove user-authored scratch files that might land in the dir.
 */
export async function removeStaleToolFiles(
  almanacDir: string,
  expectedNames: ReadonlySet<string>,
): Promise<string[]> {
  const dir = join(almanacDir, "tools");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const namesPresent = new Map<string, string[]>();
  for (const e of entries) {
    const parsed = parseToolFilename(e);
    if (parsed === null) continue;
    const existing = namesPresent.get(parsed) ?? [];
    existing.push(e);
    namesPresent.set(parsed, existing);
  }
  const removed: string[] = [];
  for (const [name, files] of namesPresent) {
    if (expectedNames.has(name)) continue;
    for (const f of files) {
      try {
        await unlink(join(dir, f));
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
    removed.push(name);
  }
  removed.sort();
  return removed;
}

/**
 * Extract the tool base-name from a `tools/` filename, or return null if
 * the file isn't part of the tool triplet shape.
 *
 *   `query_facts.json`       → "query_facts"
 *   `query_facts.ts`         → "query_facts"
 *   `query_facts.test.ts`    → "query_facts"
 *   `tsconfig.json`          → null  (not a tool name shape; here for safety)
 *   `README.md`              → null
 */
function parseToolFilename(filename: string): string | null {
  if (filename.endsWith(".test.ts")) {
    return filename.slice(0, -".test.ts".length);
  }
  if (filename.endsWith(".ts")) {
    return filename.slice(0, -".ts".length);
  }
  if (filename.endsWith(".json")) {
    return filename.slice(0, -".json".length);
  }
  return null;
}

// Stubs for `ImplementationContext` sub-runners that `TemplateImplementer`
// never touches. They throw if invoked so a future regression is loud.

const stubLlmCodeWriter: LlmCodeWriter = {
  model: "stub",
  promptVersion: "stub",
  async generate() {
    throw new Error(
      "Stage 7 runner: LlmCodeWriter is unwired in v0.1 (custom tools are not implemented yet)",
    );
  },
};

const stubTscRunner: TscRunner = {
  async check() {
    throw new Error(
      "Stage 7 runner: TscRunner is unwired in v0.1 (custom tools are not implemented yet)",
    );
  },
};

const stubSmokeTestRunner: SmokeTestRunner = {
  async test() {
    throw new Error(
      "Stage 7 runner: SmokeTestRunner is unwired in v0.1 (custom tools are not implemented yet)",
    );
  },
};

// Re-export for tests that want a single import path.
export type { Stage07Output };
