/**
 * Concrete `LlmCodeWriter` — drives the Stage 7 prompt against an `LlmProvider`.
 *
 * Responsibilities:
 *   1. Render `prompts/07-tool-impl/v1.md` with the current `ToolManifest`
 *      and an optional `previousAttempt` block.
 *   2. Call the provider once, strip a leading code fence, JSON.parse, and
 *      validate that `{ implCode, testCode }` are both non-empty strings.
 *   3. Throw `LlmCodeWriterError` on any parse / shape failure. The
 *      `LlmImplementer` (the caller) decides whether to retry by feeding the
 *      error back into the next call's `previousAttempt`.
 *
 * The retry loop itself is NOT in here — it lives in `LlmImplementer.implement`
 * so that tsc + smoke failures can be folded into the same loop as LLM
 * failures.
 */

import { z } from "zod";

import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmProvider,
} from "../../../llm/provider.ts";
import { loadPromptTemplate } from "../../prompt-loader.ts";
import type { ToolManifest } from "../../../core/types.ts";
import type { LlmCodeWriter } from "../s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE7_LLM_PROMPT_STAGE_ID = "07-tool-impl";
export const STAGE7_LLM_PROMPT_VERSION = "v1";

/** Matches `recommendedModel` in `prompts/07-tool-impl/v1.md`. */
export const STAGE7_LLM_DEFAULT_MODEL = "claude-sonnet-4-5";
export const STAGE7_LLM_DEFAULT_MAX_TOKENS = 8192;
export const STAGE7_LLM_DEFAULT_TEMPERATURE = 0.2;

// ──────────────────────────────────────────────────────────────────────────────
// Output schema
// ──────────────────────────────────────────────────────────────────────────────

/**
 * What the LLM must emit. Both fields are full TypeScript source files.
 * Lengths are deliberately generous — a complex live tool can run 4 KB easy.
 */
export const LlmCodeWriterOutputSchema = z.object({
  implCode: z.string().min(40).max(40_000),
  testCode: z.string().min(40).max(40_000),
});

export type LlmCodeWriterOutput = z.infer<typeof LlmCodeWriterOutputSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Failure to coerce the LLM's response into `LlmCodeWriterOutput`. Carries the
 * raw text so the caller can include it as `previousAttempt.code` on retry.
 */
export class LlmCodeWriterError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmCodeWriterError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateLlmCodeWriterOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE7_LLM_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE7_LLM_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE7_LLM_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;
  /**
   * Test seam: capture every provider request as it flies past. Useful for
   * asserting prompt rendering without coupling to the prompt body.
   */
  onRequest?: (req: LlmCompletionRequest) => void;
  /** Test seam: surface the raw completion in addition to the parsed pair. */
  onCompletion?: (completion: LlmCompletion) => void;
}

/**
 * Wrap an `LlmProvider` in the `LlmCodeWriter` interface that the Stage 7
 * orchestrator expects. The returned writer can be reused across many tools;
 * it is stateless apart from the captured options.
 */
export function createLlmCodeWriter(
  opts: CreateLlmCodeWriterOptions,
): LlmCodeWriter {
  const model = opts.model ?? STAGE7_LLM_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE7_LLM_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE7_LLM_DEFAULT_TEMPERATURE;
  const promptVersion = STAGE7_LLM_PROMPT_VERSION;

  return {
    model,
    promptVersion: `${STAGE7_LLM_PROMPT_STAGE_ID}/${promptVersion}`,

    async generate(input) {
      const manifestText = JSON.stringify(input.manifest);
      const previousAttemptText = JSON.stringify(
        renderPreviousAttempt(input.previousAttempt),
      );

      const prompt = loadPromptTemplate({
        stageId: STAGE7_LLM_PROMPT_STAGE_ID,
        version: promptVersion,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          manifest: manifestText,
          previousAttempt: previousAttemptText,
        },
      });

      const request: LlmCompletionRequest = {
        model,
        maxTokens,
        temperature,
        callName: `${STAGE7_LLM_PROMPT_STAGE_ID}@${promptVersion}`,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      };
      if (opts.onRequest) opts.onRequest(request);
      const completion = await opts.provider.complete(request);
      if (opts.onCompletion) opts.onCompletion(completion);

      const jsonText = stripFence(completion.text);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonText);
      } catch (cause) {
        throw new LlmCodeWriterError(
          `Stage 7 LLM output is not valid JSON: ${(cause as Error).message}`,
          completion.text,
          cause,
        );
      }
      const validated = LlmCodeWriterOutputSchema.safeParse(parsedJson);
      if (!validated.success) {
        throw new LlmCodeWriterError(
          `Stage 7 LLM output does not match { implCode, testCode } shape: ${validated.error.message}`,
          completion.text,
          validated.error,
        );
      }
      return { code: validated.data.implCode, testCode: validated.data.testCode };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Render the optional `previousAttempt` into a stable string. When absent the
 * placeholder is the literal `null` JSON value — making it obvious to the
 * model that this is the first attempt. When present we keep `code` /
 * `testCode` truncated so the prompt context stays bounded.
 */
function renderPreviousAttempt(
  attempt: Parameters<LlmCodeWriter["generate"]>[0]["previousAttempt"],
): unknown {
  if (!attempt) return null;
  const TRUNCATE = 8_000;
  return {
    outcome: attempt.outcome,
    diagnostics: attempt.diagnostics.slice(0, 6_000),
    code: attempt.code.slice(0, TRUNCATE),
    testCode: attempt.testCode.slice(0, TRUNCATE),
  };
}

/**
 * Strip a single leading/trailing markdown code fence (```json … ``` or
 * ``` … ```). The Stage 7 prompt forbids fences in the output, but a stray
 * one from the model shouldn't tank the run.
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}

/** Re-export so test files don't need to dig into types. */
export type { ToolManifest };
