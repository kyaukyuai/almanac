/**
 * Tests for `src/llm/provider.ts` and `src/llm/mock.ts`.
 *
 *   - `stripCodeFence` handles the common LLM output shapes
 *   - `completeJson` happy path validates against schema
 *   - `completeJson` throws typed errors for parse/validation failures
 *   - `MockProvider` returns canned responses + records call log
 *   - `MockProvider` throws when no response configured
 *   - `MockProvider` can be configured to throw a typed `LlmError`
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  LlmError,
  LlmJsonParseError,
  LlmSchemaValidationError,
  completeJson,
  stripCodeFence,
} from "./provider.ts";
import { createMockProvider } from "./mock.ts";

// ──────────────────────────────────────────────────────────────────────────────
// stripCodeFence
// ──────────────────────────────────────────────────────────────────────────────

describe("stripCodeFence", () => {
  test("returns plain text unchanged", () => {
    expect(stripCodeFence('{"k":1}')).toBe('{"k":1}');
  });

  test("strips ```json fence", () => {
    const wrapped = '```json\n{"k": 1}\n```';
    expect(stripCodeFence(wrapped)).toBe('{"k": 1}');
  });

  test("strips bare ``` fence", () => {
    expect(stripCodeFence('```\n{"k":1}\n```')).toBe('{"k":1}');
  });

  test("strips fence even with no trailing newline", () => {
    expect(stripCodeFence('```{"k":1}```')).toBe('{"k":1}');
  });

  test("trims surrounding whitespace", () => {
    expect(stripCodeFence('   \n{"k":1}\n  ')).toBe('{"k":1}');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// MockProvider
// ──────────────────────────────────────────────────────────────────────────────

describe("MockProvider", () => {
  test("returns canned response by callName", async () => {
    const p = createMockProvider({
      responses: { "test@v1": '{"ok":true}' },
    });
    const r = await p.complete({
      model: "claude-sonnet-4",
      maxTokens: 100,
      messages: [{ role: "user", content: "hi" }],
      callName: "test@v1",
    });
    expect(r.text).toBe('{"ok":true}');
    expect(r.model).toBe("claude-sonnet-4");
    expect(r.finishReason).toBe("stop");
  });

  test("falls through to defaultResponse when callName not matched", async () => {
    const p = createMockProvider({ defaultResponse: "fallback" });
    const r = await p.complete({
      model: "claude-sonnet-4",
      maxTokens: 100,
      messages: [{ role: "user", content: "hi" }],
      callName: "unknown",
    });
    expect(r.text).toBe("fallback");
  });

  test("throws when neither callName nor defaultResponse configured", async () => {
    const p = createMockProvider();
    await expect(
      p.complete({
        model: "claude-sonnet-4",
        maxTokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  test("can be configured to throw a typed error", async () => {
    const p = createMockProvider({
      responses: {
        "rate-limit@v1": {
          error: new LlmError("rate-limited", "429 from upstream", true),
        },
      },
    });
    await expect(
      p.complete({
        model: "claude-sonnet-4",
        maxTokens: 100,
        messages: [{ role: "user", content: "hi" }],
        callName: "rate-limit@v1",
      }),
    ).rejects.toMatchObject({ code: "rate-limited", retryable: true });
  });

  test("call log records every call", async () => {
    const p = createMockProvider({ defaultResponse: "ok" });
    await p.complete({
      model: "m",
      maxTokens: 10,
      messages: [{ role: "user", content: "a" }],
      callName: "first",
    });
    await p.complete({
      model: "m",
      maxTokens: 10,
      messages: [{ role: "user", content: "b" }],
      callName: "second",
    });
    expect(p.callLog).toHaveLength(2);
    expect(p.callLog[0]!.request.callName).toBe("first");
    p.reset();
    expect(p.callLog).toHaveLength(0);
  });

  test("response can be a function of the request", async () => {
    const p = createMockProvider({
      responses: {
        "echo@v1": (req) => req.messages[req.messages.length - 1]!.content,
      },
    });
    const r = await p.complete({
      model: "m",
      maxTokens: 10,
      messages: [{ role: "user", content: "hello echo" }],
      callName: "echo@v1",
    });
    expect(r.text).toBe("hello echo");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// completeJson
// ──────────────────────────────────────────────────────────────────────────────

describe("completeJson", () => {
  const schema = z.object({ ok: z.boolean(), n: z.number().int() });

  test("happy path: parses + validates", async () => {
    const p = createMockProvider({
      responses: { "t@v1": '{"ok": true, "n": 42}' },
    });
    const out = await completeJson({
      provider: p,
      schema,
      request: {
        model: "m",
        maxTokens: 100,
        messages: [{ role: "user", content: "x" }],
        callName: "t@v1",
      },
    });
    expect(out.result).toEqual({ ok: true, n: 42 });
    expect(out.completion.text).toBe('{"ok": true, "n": 42}');
    expect(out.jsonText).toBe('{"ok": true, "n": 42}');
  });

  test("strips ```json fence before parsing", async () => {
    const p = createMockProvider({
      responses: {
        "t@v1": '```json\n{"ok": true, "n": 1}\n```',
      },
    });
    const out = await completeJson({
      provider: p,
      schema,
      request: {
        model: "m",
        maxTokens: 100,
        messages: [{ role: "user", content: "x" }],
        callName: "t@v1",
      },
    });
    expect(out.result).toEqual({ ok: true, n: 1 });
    expect(out.jsonText).toBe('{"ok": true, "n": 1}');
  });

  test("throws LlmJsonParseError when text isn't JSON", async () => {
    const p = createMockProvider({
      responses: { "t@v1": "not json at all" },
    });
    await expect(
      completeJson({
        provider: p,
        schema,
        request: {
          model: "m",
          maxTokens: 100,
          messages: [{ role: "user", content: "x" }],
          callName: "t@v1",
        },
      }),
    ).rejects.toBeInstanceOf(LlmJsonParseError);
  });

  test("throws LlmSchemaValidationError when JSON doesn't match schema", async () => {
    const p = createMockProvider({
      responses: { "t@v1": '{"ok": "yes", "n": "not-a-number"}' },
    });
    let caught: unknown;
    try {
      await completeJson({
        provider: p,
        schema,
        request: {
          model: "m",
          maxTokens: 100,
          messages: [{ role: "user", content: "x" }],
          callName: "t@v1",
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmSchemaValidationError);
    if (caught instanceof LlmSchemaValidationError) {
      expect(caught.text).toContain('"ok": "yes"');
      expect(caught.parsed).toEqual({ ok: "yes", n: "not-a-number" });
    }
  });

  test("propagates underlying provider error untouched", async () => {
    const p = createMockProvider({
      responses: {
        "t@v1": { error: new LlmError("auth", "bad key", false) },
      },
    });
    await expect(
      completeJson({
        provider: p,
        schema,
        request: {
          model: "m",
          maxTokens: 100,
          messages: [{ role: "user", content: "x" }],
          callName: "t@v1",
        },
      }),
    ).rejects.toMatchObject({ code: "auth", retryable: false });
  });
});
