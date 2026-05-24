/**
 * `LlmImplementer` — concrete `ToolImplementer` for domain-specific custom
 * tools designed in Stage 6 (anything outside `DEFAULT_TOOL_NAMES`).
 *
 * Strategy per tool:
 *
 *   for attempt in 1..maxAttempts:
 *     1. `ctx.llm.generate({ manifest, almanacDir, previousAttempt? })`
 *         → { code, testCode }                         (llm-failed on throw)
 *     2. `ctx.writeToolFiles({ toolName, code, testCode })`
 *         → { implPath, testPath }                     (write-failed on throw)
 *     3. `ctx.tsc.check([implPath, testPath])`         (tsc-failed on ok:false)
 *     4. `ctx.smoke.test(testPath)`                    (smoke-failed on ok:false)
 *
 * Each failed step records an `ImplementationAttempt` and feeds the failure
 * context back into the next `generate` call as `previousAttempt`. When all
 * attempts are exhausted the implementer returns a `disabled` result whose
 * `finalManifest.disabled = true` so the runtime won't try to load it.
 *
 * The implementer NEVER throws for routine LLM / tsc / smoke failures — that
 * is the orchestrator contract documented on `ToolImplementer`. It throws
 * only for programmer errors (e.g., being routed a default-tool manifest).
 */

import {
  DEFAULT_TOOL_NAMES,
  ToolManifestSchema,
  type ImplementationAttempt,
  type ImplementationOutcome,
  type ToolImplementationProvenance,
  type ToolImplementationResult,
  type ToolManifest,
} from "../../../core/types.ts";
import {
  ImplementerMisroutedError,
  type ImplementationContext,
  type ToolImplementer,
} from "../s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

export interface LlmImplementerOptions {
  /**
   * Names this implementer refuses to handle, regardless of any other
   * predicate. Defaults to `DEFAULT_TOOL_NAMES` so the `TemplateImplementer`
   * has first claim on the four canonical defaults.
   */
  refuseNames?: ReadonlySet<string>;
  /** Implementer identifier (surfaced in logs). Defaults to `"llm"`. */
  name?: string;
}

const DEFAULT_REFUSE_NAMES: ReadonlySet<string> = new Set(DEFAULT_TOOL_NAMES);

// ──────────────────────────────────────────────────────────────────────────────
// Implementer
// ──────────────────────────────────────────────────────────────────────────────

export class LlmImplementer implements ToolImplementer {
  readonly name: string;
  private readonly refuseNames: ReadonlySet<string>;

  constructor(opts: LlmImplementerOptions = {}) {
    this.name = opts.name ?? "llm";
    this.refuseNames = opts.refuseNames ?? DEFAULT_REFUSE_NAMES;
  }

  canHandle(manifest: ToolManifest): boolean {
    return !this.refuseNames.has(manifest.name);
  }

  async implement(
    manifest: ToolManifest,
    ctx: ImplementationContext,
    opts: { maxAttempts: number },
  ): Promise<ToolImplementationResult> {
    if (!this.canHandle(manifest)) {
      throw new ImplementerMisroutedError(this.name, manifest.name);
    }
    const maxAttempts = Math.max(1, opts.maxAttempts);
    const attempts: ImplementationAttempt[] = [];

    // Carried between attempts — the previous generation's code + testCode
    // + the failure that came after, fed to the LLM via `previousAttempt`.
    let priorCode = "";
    let priorTestCode = "";
    let priorOutcome: Exclude<ImplementationOutcome, "success"> | null = null;
    let priorDiagnostics = "";

    ctx.log({
      event: "tool:impl:llm:start",
      tool: manifest.name,
      maxAttempts,
    });

    for (let n = 1; n <= maxAttempts; n++) {
      const startedAt = ctx.now();
      const previousAttempt =
        priorOutcome === null
          ? undefined
          : {
              code: priorCode,
              testCode: priorTestCode,
              outcome: priorOutcome,
              diagnostics: priorDiagnostics,
            };

      // ── 1. LLM ──────────────────────────────────────────────────────────
      let generated: { code: string; testCode: string };
      try {
        generated = await ctx.llm.generate({
          manifest,
          almanacDir: ctx.almanacDir,
          ...(previousAttempt !== undefined ? { previousAttempt } : {}),
        });
      } catch (cause) {
        const diagnostics = errorMessage(cause);
        const rawText = (cause as { rawText?: string }).rawText ?? "";
        attempts.push(
          buildAttempt({
            n,
            llm: ctx.llm,
            startedAt,
            finishedAt: ctx.now(),
            outcome: "llm-failed",
            diagnostics,
          }),
        );
        priorCode = rawText;
        priorTestCode = "";
        priorOutcome = "llm-failed";
        priorDiagnostics = diagnostics;
        ctx.log({
          event: "tool:impl:llm:attempt",
          tool: manifest.name,
          attempt: n,
          outcome: "llm-failed",
        });
        continue;
      }

      // ── 2. Write files ──────────────────────────────────────────────────
      let paths: { implPath: string; testPath: string };
      try {
        paths = await ctx.writeToolFiles({
          toolName: manifest.name,
          code: generated.code,
          testCode: generated.testCode,
        });
      } catch (cause) {
        const diagnostics = errorMessage(cause);
        attempts.push(
          buildAttempt({
            n,
            llm: ctx.llm,
            startedAt,
            finishedAt: ctx.now(),
            outcome: "write-failed",
            diagnostics,
          }),
        );
        priorCode = generated.code;
        priorTestCode = generated.testCode;
        priorOutcome = "write-failed";
        priorDiagnostics = diagnostics;
        ctx.log({
          event: "tool:impl:llm:attempt",
          tool: manifest.name,
          attempt: n,
          outcome: "write-failed",
        });
        continue;
      }

      // ── 3. tsc ──────────────────────────────────────────────────────────
      const tscResult = await ctx.tsc.check([paths.implPath, paths.testPath]);
      if (!tscResult.ok) {
        attempts.push(
          buildAttempt({
            n,
            llm: ctx.llm,
            startedAt,
            finishedAt: ctx.now(),
            outcome: "tsc-failed",
            diagnostics: tscResult.diagnostics,
          }),
        );
        priorCode = generated.code;
        priorTestCode = generated.testCode;
        priorOutcome = "tsc-failed";
        priorDiagnostics = tscResult.diagnostics;
        ctx.log({
          event: "tool:impl:llm:attempt",
          tool: manifest.name,
          attempt: n,
          outcome: "tsc-failed",
        });
        continue;
      }

      // ── 4. smoke ────────────────────────────────────────────────────────
      const smokeResult = await ctx.smoke.test(paths.testPath);
      if (!smokeResult.ok) {
        attempts.push(
          buildAttempt({
            n,
            llm: ctx.llm,
            startedAt,
            finishedAt: ctx.now(),
            outcome: "smoke-failed",
            diagnostics: smokeResult.diagnostics,
          }),
        );
        priorCode = generated.code;
        priorTestCode = generated.testCode;
        priorOutcome = "smoke-failed";
        priorDiagnostics = smokeResult.diagnostics;
        ctx.log({
          event: "tool:impl:llm:attempt",
          tool: manifest.name,
          attempt: n,
          outcome: "smoke-failed",
        });
        continue;
      }

      // ── success ─────────────────────────────────────────────────────────
      attempts.push(
        buildAttempt({
          n,
          llm: ctx.llm,
          startedAt,
          finishedAt: ctx.now(),
          outcome: "success",
          diagnostics: null,
        }),
      );
      const provenance: ToolImplementationProvenance = {
        model: ctx.llm.model,
        promptVersion: ctx.llm.promptVersion,
        tscPassed: true,
        smokePassed: true,
        attempts: n,
      };
      const finalManifest: ToolManifest = ToolManifestSchema.parse({
        ...manifest,
        disabled: false,
        implementedBy: provenance,
      });
      ctx.log({
        event: "tool:impl:llm:done",
        tool: manifest.name,
        attempts: n,
        status: "implemented",
      });
      return {
        toolName: manifest.name,
        status: "implemented",
        attempts,
        finalManifest,
      };
    }

    // ── exhausted ─────────────────────────────────────────────────────────
    const last = attempts[attempts.length - 1]!;
    const reason = `Stage 7 LLM implementer gave up after ${attempts.length} attempt(s); last outcome=${last.outcome}: ${(last.diagnostics ?? "").slice(0, 200)}`;
    const finalManifest: ToolManifest = ToolManifestSchema.parse({
      ...manifest,
      disabled: true,
      disabledReason: reason.slice(0, 300),
    });
    ctx.log({
      event: "tool:impl:llm:done",
      tool: manifest.name,
      attempts: attempts.length,
      status: "disabled",
      lastOutcome: last.outcome,
    });
    return {
      toolName: manifest.name,
      status: "disabled",
      attempts,
      finalManifest,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildAttempt(input: {
  n: number;
  llm: { model: string; promptVersion: string };
  startedAt: Date;
  finishedAt: Date;
  outcome: ImplementationOutcome;
  diagnostics: string | null;
}): ImplementationAttempt {
  return {
    attemptNumber: input.n,
    model: input.llm.model,
    promptVersion: input.llm.promptVersion,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    outcome: input.outcome,
    diagnostics: input.diagnostics,
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return `non-Error thrown: ${String(cause)}`;
}
