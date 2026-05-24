/**
 * Stage 12 — pipeline adapter for the benchmark runner.
 *
 *   1. Reads the Stage 11 outputs:
 *        - `tests/positive.jsonl` and `tests/negative.jsonl` (design SoT)
 *      Falls back to `.compile/stage11-output.json` when the jsonl files
 *      are missing (e.g., during a partial recovery).
 *   2. Constructs an in-process `AlmanacRuntime` over the compiled almanac
 *      via `createAlmanacRuntimeAsync`.
 *   3. Drives every fixture through the runtime with `runBenchmark` (defined
 *      in `s12-benchmark-run.ts`) and persists the resulting `BenchmarkReport`
 *      to `.compile/benchmark-result.json`.
 *
 * Pure direct-retrieval evaluation: the runner does NOT spawn a subprocess
 * MCP server and does NOT delegate to an LLM orchestrator. The MCP-driven
 * E2E benchmark described in `docs/design.md` §4 is a v0.2 enhancement;
 * direct retrieval still exercises the runtime's dispatch + capability
 * surface + ToolResult validation pipeline, which is what Stage 12 needs to
 * gate compile-time quality.
 *
 * `outputHash` = sha256 of the canonical `BenchmarkReport` JSON.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  BenchmarkSetSchema,
  NegativeFixtureSchema,
  PositiveFixtureSchema,
  Stage11OutputSchema,
  type BenchmarkReport,
  type BenchmarkSet,
  type NegativeFixture,
  type PositiveFixture,
} from "../../core/types.ts";
import { readManifest } from "../storage.ts";
import { createAlmanacRuntimeAsync } from "../../serve/runtime.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { runBenchmark } from "./s12-benchmark-run.ts";
import {
  negativeJsonlPath,
  positiveJsonlPath,
  stage11OutputPath,
} from "./s11-benchmark-gen.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths + constants
// ──────────────────────────────────────────────────────────────────────────────

export const BENCHMARK_RESULT_REL_PATH = ".compile/benchmark-result.json";

export function benchmarkResultPath(almanacDir: string): string {
  return join(almanacDir, BENCHMARK_RESULT_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingBenchmarkSetError extends Error {
  constructor(public readonly almanacDir: string) {
    super(
      `Stage 12 requires the Stage 11 benchmark set under ${almanacDir}/tests/ ` +
        `(positive.jsonl + negative.jsonl) or .compile/stage11-output.json; ` +
        "run Stage 11 first or restore the files",
    );
    this.name = "MissingBenchmarkSetError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateBenchmarkRunRunnerOptions {
  /** Test seam: read the BenchmarkSet for an almanac. */
  readBenchmarkSet?: (almanacDir: string) => Promise<BenchmarkSet>;
  /**
   * Test seam: open an `AlmanacRuntime` over the almanac. Defaults to the
   * concrete `createAlmanacRuntimeAsync`.
   */
  openRuntime?: (
    almanacDir: string,
  ) => Promise<{ runtime: import("../../core/runtime.ts").AlmanacRuntime; close: () => void }>;
}

/**
 * Build the Stage 12 `StageRunner`. Deterministic — `promptVersion = null`.
 */
export function createBenchmarkRunRunner(
  opts: CreateBenchmarkRunRunnerOptions = {},
): StageRunner {
  const readBenchmarkSet = opts.readBenchmarkSet ?? defaultReadBenchmarkSet;
  const openRuntime = opts.openRuntime ?? defaultOpenRuntime;

  return {
    promptVersion: null,
    async run(ctx) {
      const set = await readBenchmarkSet(ctx.almanacDir);

      ctx.log({
        event: "stage12:start",
        almanacId: set.almanacId,
        positives: set.positive.length,
        negatives: set.negative.length,
      });

      const { runtime, close } = await openRuntime(ctx.almanacDir);

      let report: BenchmarkReport;
      try {
        report = await runBenchmark({
          almanacId: set.almanacId,
          set,
          runtime,
          ranAt: ctx.now(),
        });
      } finally {
        try {
          close();
        } catch {
          /* ignore close errors — the report is what matters */
        }
      }

      const canonicalText = JSON.stringify(report, null, 2);
      const outPath = benchmarkResultPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage12:done",
        outputHash,
        total: report.summary.total,
        passed: report.summary.passed,
        failed: report.summary.failed,
        errored: report.summary.errored,
        citationRate: report.summary.citationRate,
      });

      return { kind: "success", outputHash };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Default readers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Prefer reading from the JSONL files (the design's SoT for Stage 11 output).
 * Fall back to `.compile/stage11-output.json` if either jsonl file is missing —
 * useful for partial recoveries where only the schema-validated record exists.
 */
async function defaultReadBenchmarkSet(
  almanacDir: string,
): Promise<BenchmarkSet> {
  const posPath = positiveJsonlPath(almanacDir);
  const negPath = negativeJsonlPath(almanacDir);

  if (existsSync(posPath) && existsSync(negPath)) {
    const manifest = await readManifest(almanacDir);
    const positive = await readFixtureJsonl(posPath, PositiveFixtureSchema);
    const negative = await readFixtureJsonl(negPath, NegativeFixtureSchema);
    return BenchmarkSetSchema.parse({
      schemaVersion: "0.1.0" as const,
      almanacId: manifest.almanacId,
      positive,
      negative,
    });
  }

  const stage11Path = stage11OutputPath(almanacDir);
  if (existsSync(stage11Path)) {
    const body = await readFile(stage11Path, "utf8");
    const parsed = Stage11OutputSchema.parse(JSON.parse(body));
    return parsed.set;
  }

  throw new MissingBenchmarkSetError(almanacDir);
}

async function readFixtureJsonl<T>(
  path: string,
  schema: typeof PositiveFixtureSchema | typeof NegativeFixtureSchema,
): Promise<T[]> {
  const body = await readFile(path, "utf8");
  const out: T[] = [];
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line);
    out.push(schema.parse(parsed) as T);
  }
  return out;
}

// Strict signature for the public option; internal use returns those types.
export type PositiveFixturesT = PositiveFixture[];
export type NegativeFixturesT = NegativeFixture[];

async function defaultOpenRuntime(
  almanacDir: string,
): Promise<{ runtime: import("../../core/runtime.ts").AlmanacRuntime; close: () => void }> {
  const runtime = await createAlmanacRuntimeAsync({ almanacDir });
  // The concrete runtime in serve/runtime.ts exposes a `close` method, but the
  // interface does not. Probe at runtime and no-op if absent.
  const close = () => {
    const maybeClose = (runtime as unknown as { close?: () => void }).close;
    if (typeof maybeClose === "function") maybeClose.call(runtime);
  };
  return { runtime, close };
}
