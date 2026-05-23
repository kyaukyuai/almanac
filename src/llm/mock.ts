/**
 * In-process `LlmProvider` for tests and local development.
 *
 * Returns canned responses keyed by `request.callName` (or a fallback). Logs
 * every call so tests can assert on what the pipeline asked for.
 *
 * Usage:
 *
 *   const mock = createMockProvider({
 *     responses: {
 *       "01-domain-analysis@v1": JSON.stringify(KUBERNETES_DOMAIN_SPEC),
 *     },
 *     defaultResponse: "{}",
 *   });
 *   const out = await completeJson({ provider: mock, request, schema });
 *   expect(mock.callLog.length).toBe(1);
 */

import {
  LlmError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from "./provider.ts";

export type MockResponse =
  | string
  | ((req: LlmCompletionRequest) => string)
  | { error: LlmError };

export interface MockProviderOptions {
  /**
   * Map from `request.callName` to either a fixed response string, a
   * function that produces one, or an error to throw. Falls through to
   * `defaultResponse` (or throws) when no key matches.
   */
  responses?: Record<string, MockResponse>;
  /** Response when no `responses` entry matches. */
  defaultResponse?: MockResponse;
  /** Latency (ms) to await before responding. Default 0. */
  delayMs?: number;
  /** Echoed in `LlmCompletion.model`; defaults to the request's model. */
  echoModel?: boolean;
}

export interface MockProvider extends LlmProvider {
  readonly callLog: ReadonlyArray<{
    request: LlmCompletionRequest;
    timestamp: Date;
  }>;
  /** Reset the call log without rebuilding the provider. */
  reset(): void;
}

export function createMockProvider(opts: MockProviderOptions = {}): MockProvider {
  const log: Array<{ request: LlmCompletionRequest; timestamp: Date }> = [];
  const responses = opts.responses ?? {};
  const delayMs = opts.delayMs ?? 0;

  const provider: MockProvider = {
    id: "mock",
    callLog: log,
    reset() {
      log.length = 0;
    },
    async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
      log.push({ request: req, timestamp: new Date() });
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const entry =
        (req.callName !== undefined ? responses[req.callName] : undefined) ??
        opts.defaultResponse;

      if (entry === undefined) {
        throw new LlmError(
          "bad-request",
          `MockProvider: no response configured for callName=${JSON.stringify(req.callName)} and no defaultResponse`,
          false,
        );
      }

      if (typeof entry === "object" && "error" in entry) {
        throw entry.error;
      }

      const text = typeof entry === "function" ? entry(req) : entry;
      return {
        text,
        usage: estimateUsage(req, text),
        model: req.model,
        durationMs: delayMs,
        finishReason: "stop",
      };
    },
  };
  return provider;
}

/** Crude token-count estimate (4 chars ≈ 1 token). Useful for cost-shaped tests. */
function estimateUsage(
  req: LlmCompletionRequest,
  responseText: string,
): { inputTokens: number; outputTokens: number } {
  const inputChars = req.messages.reduce((n, m) => n + m.content.length, 0);
  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(responseText.length / 4),
  };
}
