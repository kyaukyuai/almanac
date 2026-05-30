/**
 * Concrete `LlmProvider` backed by Anthropic's official SDK.
 *
 * Translates the SDK-agnostic `LlmCompletionRequest` into Anthropic's
 * `messages.create` shape and back, mapping SDK errors into typed `LlmError`s.
 */

import Anthropic, { APIError } from "@anthropic-ai/sdk";

import {
  LlmError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmFinishReason,
  type LlmMessage,
  type LlmProvider,
} from "./provider.ts";

export interface AnthropicProviderOptions {
  /** Defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Override the SDK base URL (useful for proxies or tests). */
  baseURL?: string;
  /** Per-request timeout. Default matches Anthropic SDK's 10 minute default. */
  timeoutMs?: number;
  /** Max SDK-level retries for transient errors. Default 2. */
  maxRetries?: number;
}

export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 600_000;
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 2;

/**
 * Construct an Anthropic-backed `LlmProvider`. Throws if no API key is
 * resolvable from the supplied options or `ANTHROPIC_API_KEY`.
 */
export function createAnthropicProvider(
  opts: AnthropicProviderOptions = {},
): LlmProvider {
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new LlmError(
      "auth",
      "Anthropic API key not found. Set ANTHROPIC_API_KEY or pass `apiKey`.",
      false,
    );
  }

  const client = new Anthropic({
    apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    timeout: opts.timeoutMs ?? ANTHROPIC_DEFAULT_TIMEOUT_MS,
    maxRetries: opts.maxRetries ?? ANTHROPIC_DEFAULT_MAX_RETRIES,
  });

  return {
    id: "anthropic",
    async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
      const { system, messages } = splitMessages(req.messages);
      const start = Date.now();
      try {
        const res = await client.messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(system !== undefined ? { system } : {}),
          messages,
        });
        const durationMs = Date.now() - start;
        return {
          text: extractText(res.content),
          usage: {
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
          },
          model: res.model,
          durationMs,
          finishReason: mapFinishReason(res.stop_reason),
          ...(res.id ? { requestId: res.id } : {}),
        };
      } catch (err) {
        throw mapError(err);
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal mappers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Anthropic's API takes `system` as its own field and only alternating
 * user/assistant in `messages`. Translate our flat `LlmMessage[]`:
 *   - leading `system` messages → concatenated into `system`
 *   - the rest → `messages` (must be user/assistant only)
 */
export function splitMessages(messages: readonly LlmMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systems: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];
  let seenNonSystem = false;
  for (const m of messages) {
    if (m.role === "system") {
      if (seenNonSystem) {
        throw new LlmError(
          "bad-request",
          "Anthropic API does not allow `system` messages after the conversation has started",
          false,
        );
      }
      systems.push(m.content);
    } else {
      seenNonSystem = true;
      rest.push({ role: m.role, content: m.content });
    }
  }
  return {
    ...(systems.length > 0 ? { system: systems.join("\n\n") } : {}),
    messages: rest,
  };
}

/** Concatenate text blocks from the SDK response. Ignores non-text blocks. */
function extractText(content: Anthropic.ContentBlock[]): string {
  let out = "";
  for (const block of content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

export function mapFinishReason(
  reason: Anthropic.Message["stop_reason"],
): LlmFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "content_filter";
    case null:
      return "other";
    default:
      // Forward-compat: any unknown reason gets bucketed.
      return "other";
  }
}

export function mapError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) {
      return new LlmError("auth", err.message, false, err);
    }
    if (status === 429) {
      return new LlmError("rate-limited", err.message, true, err);
    }
    if (status >= 400 && status < 500) {
      return new LlmError("bad-request", err.message, false, err);
    }
    if (status >= 500) {
      return new LlmError("server-error", err.message, true, err);
    }
  }
  // SDK wraps timeouts/network errors as APIConnectionTimeoutError /
  // APIConnectionError; check by class name to avoid tight import coupling.
  const name = (err as { name?: string })?.name ?? "";
  if (name.includes("Timeout")) {
    return new LlmError("timeout", (err as Error).message, true, err);
  }
  if (name.includes("Connection")) {
    return new LlmError("network", (err as Error).message, true, err);
  }
  return new LlmError(
    "unknown",
    err instanceof Error ? err.message : String(err),
    false,
    err,
  );
}
