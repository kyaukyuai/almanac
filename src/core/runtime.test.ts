/**
 * Tests for `src/core/runtime.ts`:
 *   - `computeStaleness` rules across the 4 volatility classes
 *   - error classes
 *   - `createAlmanacRuntime` skeleton stub
 *
 * The interfaces themselves (`AlmanacRuntime`, `ToolContext`, `KnowledgeReader`,
 * `ToolModule`) are zero-runtime — TypeScript compilation (`bun typecheck`) is
 * the test for those.
 */

import { describe, expect, test } from "bun:test";

import {
  NetworkNotAllowedError,
  ResourceNotFoundError,
  ToolNotFoundError,
  computeStaleness,
  createAlmanacRuntime,
} from "./runtime.ts";

describe("computeStaleness", () => {
  test('static is always "fresh"', () => {
    expect(computeStaleness("static", 0, null)).toBe("fresh");
    expect(computeStaleness("static", 999_999_999, null)).toBe("fresh");
  });

  test('live is always "fresh" (each call refetches)', () => {
    expect(computeStaleness("live", 0, null)).toBe("fresh");
    expect(computeStaleness("live", 9999, null)).toBe("fresh");
  });

  test("slow: age <= maxAge → fresh; <= 2*maxAge → warm; else stale", () => {
    const maxAge = 2_592_000; // 30d
    expect(computeStaleness("slow", 0, maxAge)).toBe("fresh");
    expect(computeStaleness("slow", maxAge, maxAge)).toBe("fresh");
    expect(computeStaleness("slow", maxAge + 1, maxAge)).toBe("warm");
    expect(computeStaleness("slow", 2 * maxAge, maxAge)).toBe("warm");
    expect(computeStaleness("slow", 2 * maxAge + 1, maxAge)).toBe("stale");
  });

  test("fast: same threshold logic with shorter maxAge", () => {
    const maxAge = 86_400; // 24h
    expect(computeStaleness("fast", 3600, maxAge)).toBe("fresh");
    expect(computeStaleness("fast", maxAge + 1, maxAge)).toBe("warm");
    expect(computeStaleness("fast", 3 * maxAge, maxAge)).toBe("stale");
  });

  test("throws on negative or non-finite age", () => {
    expect(() => computeStaleness("slow", -1, 60)).toThrow(RangeError);
    expect(() => computeStaleness("slow", Number.NaN, 60)).toThrow(RangeError);
    expect(() => computeStaleness("slow", Infinity, 60)).toThrow(RangeError);
  });

  test("throws when slow/fast called with null/zero maxAge", () => {
    expect(() => computeStaleness("slow", 10, null)).toThrow(RangeError);
    expect(() => computeStaleness("fast", 10, 0)).toThrow(RangeError);
  });
});

describe("error classes", () => {
  test("ToolNotFoundError exposes the missing name", () => {
    const e = new ToolNotFoundError("no_such");
    expect(e.name).toBe("ToolNotFoundError");
    expect(e.message).toContain("no_such");
    expect(e.name).toBe("ToolNotFoundError");
    expect(e instanceof Error).toBe(true);
  });

  test("ResourceNotFoundError exposes the URI", () => {
    const e = new ResourceNotFoundError("almanac://x/missing.md");
    expect(e.uri).toBe("almanac://x/missing.md");
    expect(e.message).toContain("missing.md");
  });

  test("NetworkNotAllowedError lists the allowlist", () => {
    const e = new NetworkNotAllowedError("evil.example.com", [
      "api.github.com",
      "raw.githubusercontent.com",
    ]);
    expect(e.host).toBe("evil.example.com");
    expect(e.allowedHosts).toHaveLength(2);
    expect(e.message).toContain("api.github.com");
  });
});

describe("createAlmanacRuntime (skeleton)", () => {
  test("throws a clear 'not implemented' error", () => {
    expect(() => createAlmanacRuntime({ almanacDir: "/tmp/x" })).toThrow(
      /not implemented/i,
    );
  });
});
