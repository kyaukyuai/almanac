/**
 * Tests for Stage 12.
 *
 *   - Schema validation: BenchmarkSet uniqueness, summary derivation
 *   - Pure evaluation: positive / negative pass + fail paths
 *   - Runner with mock AlmanacRuntime: collects results, builds report,
 *     handles thrown errors as `errored`
 */

import { describe, expect, test } from "bun:test";

import {
  BenchmarkReportSchema,
  BenchmarkSetSchema,
  buildBenchmarkReport,
  type BenchmarkResult,
  type BenchmarkSet,
  type NegativeFixture,
  type PositiveFixture,
  type ToolResult,
} from "../../core/types.ts";
import type { AlmanacRuntime } from "../../core/runtime.ts";
import {
  evaluateNegative,
  evaluatePositive,
  runBenchmark,
} from "./s12-benchmark-run.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const positive: PositiveFixture = {
  id: "k8s-pos-001",
  query: "what are the default kubelet eviction thresholds?",
  intent: "lookup",
  rationale: "stable spec lookup that should hit query_facts with citation",
  invocation: { tool: "query_facts", input: { q: "kubelet eviction thresholds" } },
  expected: {
    minCitations: 1,
    contains: ["eviction"],
    acceptableStaleness: ["fresh", "warm"],
  },
};

const negative: NegativeFixture = {
  id: "k8s-neg-001",
  query: "what is today's apple stock price?",
  rationale: "out-of-scope: stock prices are not in the kubernetes almanac",
  invocation: { tool: "query_facts", input: { q: "apple stock price" } },
  refusalReason: "out-of-scope",
  expected: { maxCitations: 0 },
};

const sampleSet: BenchmarkSet = BenchmarkSetSchema.parse({
  schemaVersion: "0.1.0",
  almanacId: "kubernetes",
  positive: [positive],
  negative: [negative],
});

const okWithCitations: ToolResult = {
  ok: true,
  data: { facts: [{ text: "default eviction thresholds are ..." }] },
  citations: [
    {
      sourceId: "k8s-docs",
      url: "https://kubernetes.io/docs/concepts/scheduling-eviction/",
      fetchedAt: "2026-05-08T12:00:00.000Z",
    },
  ],
  freshness: { class: "slow", maxAge: 2_592_000, staleness: "fresh" },
};

const okEmpty: ToolResult = {
  ok: true,
  data: { facts: [] },
  citations: [
    {
      sourceId: "k8s-docs",
      url: "https://kubernetes.io/docs/",
      fetchedAt: "2026-05-08T12:00:00.000Z",
    },
  ],
  freshness: { class: "slow", maxAge: 2_592_000, staleness: "fresh" },
};

const errResult: ToolResult = {
  ok: false,
  error: { code: "no-results", message: "no facts matched", retryable: false },
};

// ──────────────────────────────────────────────────────────────────────────────
// Schema invariants
// ──────────────────────────────────────────────────────────────────────────────

describe("BenchmarkSetSchema", () => {
  test("rejects duplicate fixture ids across positive/negative", () => {
    expect(() =>
      BenchmarkSetSchema.parse({
        schemaVersion: "0.1.0",
        almanacId: "x",
        positive: [{ ...positive, id: "dup-001" }],
        negative: [{ ...negative, id: "dup-001" }],
      }),
    ).toThrow(/duplicate fixture id/);
  });
});

describe("BenchmarkReportSchema (via buildBenchmarkReport)", () => {
  test("computes citationRate correctly", () => {
    const results: BenchmarkResult[] = [
      {
        fixtureId: "p-1",
        kind: "positive",
        status: "pass",
        observed: { ok: true, citationsCount: 1, staleness: "fresh", errorCode: null },
        durationMs: 10,
        reason: "ok",
      },
      {
        fixtureId: "p-2",
        kind: "positive",
        status: "fail",
        observed: { ok: true, citationsCount: 0, staleness: "fresh", errorCode: null },
        durationMs: 8,
        reason: "no citations",
      },
      {
        fixtureId: "n-1",
        kind: "negative",
        status: "pass",
        observed: { ok: false, citationsCount: 0, staleness: null, errorCode: "no-results" },
        durationMs: 6,
        reason: "ok:false within expectation",
      },
    ];
    const r = buildBenchmarkReport({
      almanacId: "x",
      ranAt: new Date("2026-05-08T12:00:00.000Z"),
      set: sampleSet,
      results,
    });
    expect(r.summary.total).toBe(3);
    expect(r.summary.passed).toBe(2);
    expect(r.summary.failed).toBe(1);
    expect(r.summary.errored).toBe(0);
    expect(r.summary.citationRate).toBeCloseTo(0.5, 6);
  });

  test("rejects manually-built report with mismatched summary", () => {
    expect(() =>
      BenchmarkReportSchema.parse({
        schemaVersion: "0.1.0",
        almanacId: "x",
        ranAt: "2026-05-08T12:00:00.000Z",
        set: sampleSet,
        results: [],
        summary: { total: 99, passed: 0, failed: 0, errored: 0, citationRate: 0 },
      }),
    ).toThrow(/summary\.total/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Pure evaluation
// ──────────────────────────────────────────────────────────────────────────────

describe("evaluatePositive", () => {
  test("pass on ok + citations + acceptable staleness + contains", () => {
    const r = evaluatePositive(positive, okWithCitations, 5);
    expect(r.status).toBe("pass");
    expect(r.observed.citationsCount).toBe(1);
  });

  test("fail when ok:false", () => {
    const r = evaluatePositive(positive, errResult, 5);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("expected ok:true");
  });

  test("fail when minCitations not met", () => {
    const r = evaluatePositive(
      { ...positive, expected: { ...positive.expected, minCitations: 5 } },
      okWithCitations,
      5,
    );
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("expected >= 5 citations");
  });

  test("fail when staleness not acceptable", () => {
    const stale: ToolResult = {
      ...okWithCitations,
      ok: true,
      freshness: { class: "slow", maxAge: 2_592_000, staleness: "stale" },
    } as ToolResult;
    const r = evaluatePositive(positive, stale, 5);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("staleness 'stale'");
  });

  test("fail when contains substring missing", () => {
    const noEviction: ToolResult = {
      ...okWithCitations,
      ok: true,
      data: { facts: [{ text: "irrelevant content" }] },
    } as ToolResult;
    const r = evaluatePositive(positive, noEviction, 5);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("missing required substrings: [eviction]");
  });

  test("contains is case-insensitive (fixture lowercase, data uppercase)", () => {
    const ftsFixture: PositiveFixture = {
      ...positive,
      id: "sqlite-pos-fts5",
      expected: { ...positive.expected, contains: ["fts5"] },
    };
    const upperData: ToolResult = {
      ...okWithCitations,
      ok: true,
      data: { facts: [{ text: "FTS5 external content tables..." }] },
    } as ToolResult;
    const r = evaluatePositive(ftsFixture, upperData, 5);
    expect(r.status).toBe("pass");
  });

  test("contains is case-insensitive (fixture mixed case, data lowercase)", () => {
    const fixture: PositiveFixture = {
      ...positive,
      expected: { ...positive.expected, contains: ["EvIcTiOn"] },
    };
    const r = evaluatePositive(fixture, okWithCitations, 5);
    expect(r.status).toBe("pass");
  });
});

describe("evaluateNegative", () => {
  test("pass when ok:false (no specific code required)", () => {
    const r = evaluateNegative(negative, errResult, 5);
    expect(r.status).toBe("pass");
  });

  test("pass when ok:true but citations <= maxCitations", () => {
    const noCit: ToolResult = {
      ...okEmpty,
      ok: true,
      citations: [],
    } as ToolResult;
    const r = evaluateNegative(negative, noCit, 5);
    expect(r.status).toBe("pass");
  });

  test("fail when ok:true and citations exceed maxCitations", () => {
    const r = evaluateNegative(negative, okEmpty, 5);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("expected at most 0 citations");
  });

  test("expectedErrorCode: pass on match", () => {
    const r = evaluateNegative(
      { ...negative, expected: { maxCitations: 0, expectedErrorCode: "no-results" } },
      errResult,
      5,
    );
    expect(r.status).toBe("pass");
  });

  test("expectedErrorCode: fail on mismatch", () => {
    const r = evaluateNegative(
      { ...negative, expected: { maxCitations: 0, expectedErrorCode: "upstream-timeout" } },
      errResult,
      5,
    );
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("expected error code 'upstream-timeout'");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runner with mock AlmanacRuntime
// ──────────────────────────────────────────────────────────────────────────────

describe("runBenchmark", () => {
  const mkRuntime = (
    handler: (name: string, input: unknown) => Promise<ToolResult>,
  ): AlmanacRuntime => ({
    listTools: async () => [],
    execTool: handler,
    listResources: async () => [],
    readResource: async () => ({ contents: "", mimeType: "text/plain" }),
  });

  test("happy path: positive passes, negative passes", async () => {
    const runtime = mkRuntime(async (name, _input) => {
      void name;
      // Both fixtures invoke `query_facts`. Differentiate via input.
      const q = (_input as { q: string }).q;
      if (q.includes("eviction")) return okWithCitations;
      return errResult; // out-of-scope query → no-results
    });
    const r = await runBenchmark({
      almanacId: "kubernetes",
      set: sampleSet,
      runtime,
      ranAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    expect(r.summary.total).toBe(2);
    expect(r.summary.passed).toBe(2);
    expect(r.summary.failed).toBe(0);
    expect(r.summary.citationRate).toBe(1);
  });

  test("runtime.execTool throwing produces an `errored` result, not abort", async () => {
    const runtime = mkRuntime(async () => {
      throw new Error("kaboom");
    });
    const r = await runBenchmark({
      almanacId: "kubernetes",
      set: sampleSet,
      runtime,
      ranAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    expect(r.summary.errored).toBe(2);
    expect(r.results.every((x) => x.status === "errored")).toBe(true);
    expect(r.results[0]!.reason).toContain("kaboom");
  });

  test("durationMs is recorded per fixture", async () => {
    let t = 0;
    const runtime = mkRuntime(async () => okWithCitations);
    const r = await runBenchmark({
      almanacId: "kubernetes",
      set: sampleSet,
      runtime,
      ranAt: new Date("2026-05-08T12:00:00.000Z"),
      now: () => {
        t += 7;
        return t;
      },
    });
    expect(r.results[0]!.durationMs).toBe(7);
    expect(r.results[1]!.durationMs).toBe(7);
  });
});

