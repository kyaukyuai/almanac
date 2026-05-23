/**
 * Stage 12 — benchmark run.
 *
 * Drives an `AlmanacRuntime` against a `BenchmarkSet` and produces a
 * `BenchmarkReport`. Pure evaluation logic (`evaluateFixture`) is exposed
 * separately so it can be unit-tested without a real runtime.
 *
 * Pass criteria, per fixture kind:
 *
 *   POSITIVE
 *     - result.ok === true
 *     - citations.length >= expected.minCitations
 *     - freshness.staleness ∈ expected.acceptableStaleness
 *     - JSON.stringify(result.data) contains every entry in expected.contains
 *
 *   NEGATIVE
 *     - if expectedErrorCode is set: result.ok === false AND error.code matches
 *     - else: (result.ok === false) OR (citations.length <= expected.maxCitations)
 */

import {
  buildBenchmarkReport,
  type BenchmarkReport,
  type BenchmarkResult,
  type BenchmarkSet,
  type NegativeFixture,
  type PositiveFixture,
  type ToolResult,
} from "../../core/types.ts";
import type { AlmanacRuntime } from "../../core/runtime.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Pure evaluation
// ──────────────────────────────────────────────────────────────────────────────

export function evaluatePositive(
  fixture: PositiveFixture,
  result: ToolResult,
  durationMs: number,
): BenchmarkResult {
  const observed = summarize(result);
  if (!result.ok) {
    return makeResult(fixture.id, "positive", "fail", observed, durationMs, {
      reason: `expected ok:true, got error '${result.error.code}': ${result.error.message}`,
    });
  }
  if (result.citations.length < fixture.expected.minCitations) {
    return makeResult(fixture.id, "positive", "fail", observed, durationMs, {
      reason: `expected >= ${fixture.expected.minCitations} citations, got ${result.citations.length}`,
    });
  }
  if (
    !fixture.expected.acceptableStaleness.includes(result.freshness.staleness)
  ) {
    return makeResult(fixture.id, "positive", "fail", observed, durationMs, {
      reason: `staleness '${result.freshness.staleness}' not in acceptable set [${fixture.expected.acceptableStaleness.join(", ")}]`,
    });
  }
  if (fixture.expected.contains.length > 0) {
    const haystack = JSON.stringify(result.data);
    const missing = fixture.expected.contains.filter(
      (needle) => !haystack.includes(needle),
    );
    if (missing.length > 0) {
      return makeResult(fixture.id, "positive", "fail", observed, durationMs, {
        reason: `result.data missing required substrings: [${missing.join(", ")}]`,
      });
    }
  }
  return makeResult(fixture.id, "positive", "pass", observed, durationMs, {
    reason: `ok:true, ${result.citations.length} citation(s), staleness=${result.freshness.staleness}`,
  });
}

export function evaluateNegative(
  fixture: NegativeFixture,
  result: ToolResult,
  durationMs: number,
): BenchmarkResult {
  const observed = summarize(result);
  if (fixture.expected.expectedErrorCode !== undefined) {
    if (result.ok) {
      return makeResult(fixture.id, "negative", "fail", observed, durationMs, {
        reason: `expected error '${fixture.expected.expectedErrorCode}', got ok:true`,
      });
    }
    if (result.error.code !== fixture.expected.expectedErrorCode) {
      return makeResult(fixture.id, "negative", "fail", observed, durationMs, {
        reason: `expected error code '${fixture.expected.expectedErrorCode}', got '${result.error.code}'`,
      });
    }
    return makeResult(fixture.id, "negative", "pass", observed, durationMs, {
      reason: `error code '${result.error.code}' matched expectation`,
    });
  }
  // No specific error code required: pass if ok:false OR citations <= maxCitations
  if (!result.ok) {
    return makeResult(fixture.id, "negative", "pass", observed, durationMs, {
      reason: `ok:false ('${result.error.code}'), within negative expectations`,
    });
  }
  if (result.citations.length <= fixture.expected.maxCitations) {
    return makeResult(fixture.id, "negative", "pass", observed, durationMs, {
      reason: `citations (${result.citations.length}) <= maxCitations (${fixture.expected.maxCitations})`,
    });
  }
  return makeResult(fixture.id, "negative", "fail", observed, durationMs, {
    reason: `expected at most ${fixture.expected.maxCitations} citations, got ${result.citations.length}`,
  });
}

function summarize(result: ToolResult): BenchmarkResult["observed"] {
  if (result.ok) {
    return {
      ok: true,
      citationsCount: result.citations.length,
      staleness: result.freshness.staleness,
      errorCode: null,
    };
  }
  return {
    ok: false,
    citationsCount: 0,
    staleness: null,
    errorCode: result.error.code,
  };
}

function makeResult(
  fixtureId: string,
  kind: BenchmarkResult["kind"],
  status: BenchmarkResult["status"],
  observed: BenchmarkResult["observed"],
  durationMs: number,
  rest: { reason: string },
): BenchmarkResult {
  return { fixtureId, kind, status, observed, durationMs, reason: rest.reason };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

export interface RunBenchmarkInput {
  almanacId: string;
  set: BenchmarkSet;
  runtime: AlmanacRuntime;
  /** Wall-clock used for the report's `ranAt`. Defaults to `new Date()`. */
  ranAt?: Date;
  /** Time source for per-fixture `durationMs`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run every fixture sequentially and return a validated `BenchmarkReport`.
 * `runtime.execTool` is allowed to throw — those failures are recorded as
 * `errored` results rather than aborting the whole run.
 */
export async function runBenchmark(
  input: RunBenchmarkInput,
): Promise<BenchmarkReport> {
  const ranAt = input.ranAt ?? new Date();
  const clock = input.now ?? Date.now;
  const results: BenchmarkResult[] = [];

  for (const f of input.set.positive) {
    const start = clock();
    let res: BenchmarkResult;
    try {
      const out = await input.runtime.execTool(f.invocation.tool, f.invocation.input);
      res = evaluatePositive(f, out, Math.max(0, clock() - start));
    } catch (e) {
      res = {
        fixtureId: f.id,
        kind: "positive",
        status: "errored",
        observed: { ok: false, citationsCount: 0, staleness: null, errorCode: "runtime-threw" },
        durationMs: Math.max(0, clock() - start),
        reason: `runtime.execTool threw: ${(e as Error).message}`,
      };
    }
    results.push(res);
  }

  for (const f of input.set.negative) {
    const start = clock();
    let res: BenchmarkResult;
    try {
      const out = await input.runtime.execTool(f.invocation.tool, f.invocation.input);
      res = evaluateNegative(f, out, Math.max(0, clock() - start));
    } catch (e) {
      res = {
        fixtureId: f.id,
        kind: "negative",
        status: "errored",
        observed: { ok: false, citationsCount: 0, staleness: null, errorCode: "runtime-threw" },
        durationMs: Math.max(0, clock() - start),
        reason: `runtime.execTool threw: ${(e as Error).message}`,
      };
    }
    results.push(res);
  }

  return buildBenchmarkReport({
    almanacId: input.almanacId,
    ranAt,
    set: input.set,
    results,
  });
}
