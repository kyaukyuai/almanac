/**
 * LLM provider abstraction for the `almanac` compile pipeline.
 *
 * The compile pipeline is the only consumer of LLMs in the codebase. The
 * runtime (`almanac serve`) does NOT call LLMs — it only serves cached facts
 * and live tools to host LLMs (Claude Code, Cursor, …).
 *
 * Design pillars:
 *   - SDK-agnostic interface; concrete providers (Anthropic now;
 *     OpenAI / local later) implement the same surface.
 *   - Easy to mock in tests via `src/llm/mock.ts`.
 *   - JSON-mode helper (`completeJson`) handles the common stage pattern:
 *     LLM → text → strip code-fence → JSON.parse → zod validate.
 *
 * Concrete adapters live alongside this file:
 *   - `./anthropic.ts` — `createAnthropicProvider`
 *   - `./mock.ts`      — `createMockProvider`
 */

import type { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────────
// Wire types
// ──────────────────────────────────────────────────────────────────────────────

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmCompletionRequest {
  /** Provider-specific model id (e.g., "claude-sonnet-4-20250514"). */
  model: string;
  /** Conversation. Most stages use 1 system + 1 user message. */
  messages: LlmMessage[];
  /** Required hard cap on output tokens. */
  maxTokens: number;
  /** 0..1; lower = more deterministic. Provider default if omitted. */
  temperature?: number;
  /**
   * Identifier for log/metrics correlation. Conventionally
   * `<stageId>@<promptVersion>` (e.g., "01-domain-analysis@v1").
   */
  callName?: string;
}

export type LlmFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_use"
  | "other";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletion {
  /** Raw assistant text. */
  text: string;
  usage: LlmUsage;
  /** Echo of the model that produced the response. */
  model: string;
  /** Wall-clock duration of the API call. */
  durationMs: number;
  finishReason: LlmFinishReason;
  /** Provider's request id, when surfaced. */
  requestId?: string;
}

export interface LlmProvider {
  /** Stable id ("anthropic", "mock", …). */
  readonly id: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletion>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export type LlmErrorCode =
  | "rate-limited"
  | "auth"
  | "bad-request"
  | "server-error"
  | "timeout"
  | "network"
  | "unknown";

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Raised by `completeJson` when the LLM text cannot be parsed as JSON. The
 * raw `text` is attached so callers (or the retry loop) can feed it back into
 * the next attempt's user message for self-correction.
 */
export class LlmJsonParseError extends Error {
  constructor(
    message: string,
    public readonly text: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmJsonParseError";
  }
}

/**
 * Raised by `completeJson` when the parsed JSON does not match the supplied
 * zod schema. Carries both the parsed value and the raw text for debugging.
 */
export class LlmSchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly text: string,
    public readonly parsed: unknown,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmSchemaValidationError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// JSON-mode helper
// ──────────────────────────────────────────────────────────────────────────────

export interface CompleteJsonInput<T> {
  provider: LlmProvider;
  request: LlmCompletionRequest;
  schema: z.ZodType<T>;
}

export interface CompleteJsonResult<T> {
  result: T;
  completion: LlmCompletion;
  /** The cleaned JSON text that was actually parsed. */
  jsonText: string;
}

/**
 * Stage-friendly helper: call `provider.complete`, strip a leading
 * markdown code fence if present, JSON.parse, then validate against `schema`.
 *
 * - Throws `LlmJsonParseError` if the body is not valid JSON.
 * - Throws `LlmSchemaValidationError` if the parsed value does not match.
 * - All other errors propagate from `provider.complete`.
 *
 * The retry loop is intentionally NOT here. Callers who want to retry on
 * parse/validation failure (e.g., Stage 7) should catch the typed errors and
 * compose their own loop with the diagnostics they want to surface.
 */
export async function completeJson<T>(
  input: CompleteJsonInput<T>,
): Promise<CompleteJsonResult<T>> {
  const completion = await input.provider.complete(input.request);
  const jsonText = stripCodeFence(completion.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    throw new LlmJsonParseError(
      `LLM output is not valid JSON: ${(cause as Error).message}`,
      completion.text,
      cause,
    );
  }

  const validated = input.schema.safeParse(parsed);
  if (!validated.success) {
    throw new LlmSchemaValidationError(
      `LLM output does not match schema: ${validated.error.message}`,
      completion.text,
      parsed,
      validated.error,
    );
  }

  return { result: validated.data, completion, jsonText };
}

/**
 * Strip a single leading/trailing markdown code fence (```json … ``` or
 * ``` … ```). Returns the input unchanged when no fence is present.
 *
 * Exported for tests; not part of the public provider interface.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // Match ```<lang>\n ... \n``` or ``` ... ```
  const match = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (match) return match[1]!.trim();
  return trimmed;
}
