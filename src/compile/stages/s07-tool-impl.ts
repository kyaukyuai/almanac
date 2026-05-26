/**
 * Stage 7 — tool implementation (tsc + bun test loop).
 *
 * Takes the per-tool `ToolManifest` produced by Stage 6 and turns each into:
 *   - `<almanacDir>/tools/<name>.ts`        (executable implementation)
 *   - `<almanacDir>/tools/<name>.test.ts`   (smoke tests)
 *   - the manifest with `implementedBy` filled in (success), or
 *     `disabled: true` + `disabledReason` (give-up after `maxAttempts`).
 *
 * The orchestrator delegates per-tool work to a `ToolImplementer`. Two
 * concrete implementers are anticipated:
 *
 *   - `TemplateImplementer` — for the four default tools (`query_facts`,
 *      `fetch_official_docs`, `web_search_recent`, `latest_releases`). No
 *      LLM, no retry loop. Always succeeds (or throws for programmer errors).
 *
 *   - `LlmImplementer` — for domain-specific custom tools. Drives the
 *      generate → write → tsc → bun-test → retry loop using
 *      `LlmCodeWriter`, `TscRunner`, and `SmokeTestRunner`.
 *
 * **Skeleton only.** Signatures are committed; the orchestrator body throws
 * `not implemented` until the per-implementer code lands.
 */

import {
  buildStage07Output,
  DEFAULT_TOOL_NAMES,
  type ImplementationAttempt,
  type Stage07Output,
  type ToolImplementationResult,
  type ToolManifest,
} from "../../core/types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Sub-interfaces — the LLM, tsc, and bun test runners
// ──────────────────────────────────────────────────────────────────────────────

/**
 * LLM-driven code generator. Produces the implementation + smoke-test source
 * for one tool. On retry, `previousAttempt` carries the diagnostics from the
 * prior failure so the model can correct its output.
 */
export interface LlmCodeWriter {
  /** The model id this writer routes to (e.g., "claude-sonnet-4"). */
  readonly model: string;
  /** The prompt-template version this writer uses (e.g., "07-tool-impl/v1"). */
  readonly promptVersion: string;

  generate(input: {
    manifest: ToolManifest;
    almanacDir: string;
    previousAttempt?: {
      code: string;
      testCode: string;
      outcome:
        | "llm-failed"
        | "write-failed"
        | "tsc-failed"
        | "validator-failed"
        | "smoke-failed";
      diagnostics: string;
    };
  }): Promise<{ code: string; testCode: string }>;
}

/**
 * Type-checks a set of files. Implemented by the CLI as a thin wrapper around
 * `tsc --noEmit` (or `bun build --no-bundle --check`); tests can supply a
 * stub.
 */
export interface TscRunner {
  check(files: string[]): Promise<
    { ok: true } | { ok: false; diagnostics: string }
  >;
}

/**
 * Runs `bun test <file>` for a single test file. Returns the runner's stderr
 * on failure for retry context.
 */
export interface SmokeTestRunner {
  test(testFile: string): Promise<
    { ok: true } | { ok: false; diagnostics: string }
  >;
}

/** Per-call context shared by every implementer. */
export interface ImplementationContext {
  almanacDir: string;
  llm: LlmCodeWriter;
  tsc: TscRunner;
  smoke: SmokeTestRunner;
  /**
   * Persist the implementation + test source to disk. Returns the absolute
   * paths so the orchestrator can pass them to `tsc.check` and `smoke.test`.
   */
  writeToolFiles(input: {
    toolName: string;
    code: string;
    testCode: string;
  }): Promise<{ implPath: string; testPath: string }>;
  now: () => Date;
  log: (event: object) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// ToolImplementer — strategy per manifest
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Implements one tool end-to-end and returns its `ToolImplementationResult`.
 *
 * Implementations MUST never throw for routine failures (LLM error, tsc
 * error, smoke test error). They convert those into a `disabled` result with
 * the failing attempts recorded. They throw only for programmer errors
 * (e.g., orchestrator misrouted a manifest whose `canHandle()` is false).
 */
export interface ToolImplementer {
  readonly name: string;
  canHandle(manifest: ToolManifest): boolean;
  implement(
    manifest: ToolManifest,
    ctx: ImplementationContext,
    opts: { maxAttempts: number },
  ): Promise<ToolImplementationResult>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class NoImplementerForToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`no implementer matched tool "${toolName}"`);
    this.name = "NoImplementerForToolError";
  }
}

export class ImplementerMisroutedError extends Error {
  constructor(
    public readonly implementerName: string,
    public readonly toolName: string,
  ) {
    super(
      `implementer "${implementerName}" cannot handle tool "${toolName}"; ` +
        "orchestrator should not have routed this manifest to this implementer",
    );
    this.name = "ImplementerMisroutedError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_NAME_SET: ReadonlySet<string> = new Set(DEFAULT_TOOL_NAMES);

/** Whether the tool name is one of the four canonical defaults. */
export function isDefaultToolName(name: string): boolean {
  return DEFAULT_NAME_SET.has(name);
}

/** Pick the first registered implementer that claims the manifest. */
export function selectImplementer(
  manifest: ToolManifest,
  implementers: readonly ToolImplementer[],
): ToolImplementer {
  for (const impl of implementers) {
    if (impl.canHandle(manifest)) return impl;
  }
  throw new NoImplementerForToolError(manifest.name);
}

/**
 * Build a `ToolImplementationResult` for a tool whose attempts are already
 * known. Pure helper used by both implementers and tests.
 */
export function buildToolImplementationResult(input: {
  toolName: string;
  attempts: ImplementationAttempt[];
  finalManifest: ToolManifest;
}): ToolImplementationResult {
  if (input.attempts.length === 0) {
    throw new RangeError("attempts must contain at least one entry");
  }
  const last = input.attempts[input.attempts.length - 1]!;
  const status = last.outcome === "success" ? "implemented" : "disabled";
  // Re-validate through the schema — catches drift between attempts and the
  // final manifest (e.g., success with no implementedBy).
  const candidate: ToolImplementationResult = {
    toolName: input.toolName,
    status,
    attempts: input.attempts,
    finalManifest: input.finalManifest,
  };
  // We rely on ToolImplementationResultSchema invariants checked by callers.
  // Returning the candidate verbatim keeps this helper a constructor and
  // lets validation happen one level up (in `buildStage07Output`).
  return candidate;
}

// ──────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────────────────────

export interface RunToolImplementationInput {
  manifests: ToolManifest[];
  almanacDir: string;
  ctx: ImplementationContext;
  /** Implementers in priority order. Default selection: template-first, then llm. */
  implementers: ToolImplementer[];
  /** Default 3. Max retry budget per tool. */
  maxAttempts?: number;
}

/**
 * Drive every manifest through the per-tool retry loop and aggregate results.
 *
 * Per-tool flow:
 *   - Pick the first registered `ToolImplementer` whose `canHandle` returns
 *     true (templates first by convention, then `LlmImplementer`).
 *   - Delegate to `impl.implement(manifest, ctx, { maxAttempts })`. The
 *     implementer is responsible for its own attempts; it MUST return a
 *     `ToolImplementationResult` (never throw for routine failures).
 *
 * The orchestrator does not retry across implementers: if the
 * `TemplateImplementer` declines a manifest (canHandle=false) the next
 * implementer in the list is tried. If none claim it, the tool is recorded
 * as `disabled` with a single failed `llm-failed` attempt — not the most
 * faithful outcome bucket but the closest to "no implementer matched".
 */
export async function runToolImplementation(
  input: RunToolImplementationInput,
): Promise<Stage07Output> {
  if (input.manifests.length === 0) {
    throw new RangeError("runToolImplementation: manifests must be non-empty");
  }
  const maxAttempts = input.maxAttempts ?? 3;
  const startedAt = input.ctx.now();
  const results: ToolImplementationResult[] = [];

  for (const manifest of input.manifests) {
    let impl: ToolImplementer;
    try {
      impl = selectImplementer(manifest, input.implementers);
    } catch (e) {
      if (e instanceof NoImplementerForToolError) {
        const ts = input.ctx.now().toISOString();
        results.push({
          toolName: manifest.name,
          status: "disabled",
          attempts: [
            {
              attemptNumber: 1,
              model: "",
              promptVersion: "",
              startedAt: ts,
              finishedAt: ts,
              outcome: "llm-failed",
              diagnostics: e.message,
            },
          ],
          finalManifest: {
            ...manifest,
            disabled: true,
            disabledReason: e.message.slice(0, 300),
          },
        });
        continue;
      }
      throw e;
    }

    input.ctx.log({
      event: "tool:impl:start",
      tool: manifest.name,
      implementer: impl.name,
    });
    const result = await impl.implement(manifest, input.ctx, { maxAttempts });
    results.push(result);
    input.ctx.log({
      event: "tool:impl:done",
      tool: manifest.name,
      implementer: impl.name,
      status: result.status,
      attempts: result.attempts.length,
    });
  }

  const finishedAt = input.ctx.now();
  return buildStage07Output({ startedAt, finishedAt, results });
}
