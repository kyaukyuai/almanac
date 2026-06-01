import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBenchmarkReport,
  buildSourceFetchManifest,
  SourcesFileSchema,
  STAGE_IDS,
  type BenchmarkResult,
  type BenchmarkSet,
  type SourcesFile,
  type SourceFetchEntry,
} from "../core/types.ts";
import {
  markStageCompleted,
  type StageRunner,
} from "../compile/pipeline.ts";
import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import { benchmarkResultPath } from "../compile/stages/s12-benchmark-run-runner.ts";
import {
  ensureAlmanacLayout,
  writeCompileState,
  writeManifest,
} from "../compile/storage.ts";
import {
  listRunToolArtifacts,
  readRunToolArtifact,
} from "./run-tool.ts";
import {
  REFRESH_LOCK_REL_PATH,
  formatRefreshRunHuman,
  runRefresh,
} from "./refresh-run.ts";

const cleanup: string[] = [];

afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runRefresh", () => {
  test("runs the due recommendation and saves a refresh artifact", async () => {
    const almanacDir = await buildRefreshRunFixture({
      id: "refresh-run-missing-benchmark",
      benchmark: "missing",
    });

    const result = await runRefresh({
      almanacDir,
      runners: { "12-benchmark-run": benchmarkWritingRunner("passed") },
      forgerVersion: "0.6.0-test",
      save: true,
      label: "nightly",
      now: fixedClock("2026-06-01T12:00:00.000Z"),
    });

    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.dueDecision.due).toBe(true);
    expect(result.effectiveFromStage).toBe("12-benchmark-run");
    expect(result.benchmark.status).toBe("passed");
    expect(result.savedArtifact?.relPath).toBe(`.runs/${result.refreshId}.json`);
    expect(formatRefreshRunHuman(result)).toContain("status: ok");

    const readBack = await readRunToolArtifact({
      almanacDir,
      runId: result.refreshId,
    });
    expect(readBack.artifact.kind).toBe("refresh");
    if (readBack.artifact.kind === "refresh") {
      expect(readBack.artifact.status).toBe("ok");
      expect(readBack.artifact.label).toBe("nightly");
      expect(readBack.artifact.benchmark?.status).toBe("passed");
    }

    const refreshRuns = await listRunToolArtifacts({
      almanacDir,
      kind: "refresh",
    });
    expect(refreshRuns.runs).toEqual([
      expect.objectContaining({
        kind: "refresh",
        runId: result.refreshId,
        status: "ok",
        fromStage: "12-benchmark-run",
      }),
    ]);
  });

  test("does not mutate a not-due almanac unless fromStage is explicit", async () => {
    const almanacDir = await buildRefreshRunFixture({
      id: "refresh-run-not-due",
      benchmark: "passed",
    });
    let calls = 0;
    const runner = benchmarkWritingRunner("passed", () => {
      calls += 1;
    });

    const skipped = await runRefresh({
      almanacDir,
      runners: { "12-benchmark-run": runner },
      forgerVersion: "0.6.0-test",
      now: fixedClock("2026-06-01T12:00:00.000Z"),
    });

    expect(skipped.status).toBe("not-due");
    expect(skipped.exitCode).toBe(0);
    expect(calls).toBe(0);

    const forced = await runRefresh({
      almanacDir,
      fromStage: "12-benchmark-run",
      runners: { "12-benchmark-run": runner },
      forgerVersion: "0.6.0-test",
      now: fixedClock("2026-06-01T12:05:00.000Z"),
    });

    expect(forced.status).toBe("ok");
    expect(forced.requestedFromStage).toBe("12-benchmark-run");
    expect(calls).toBe(1);
  });

  test("returns a stable locked result without deleting the existing lock", async () => {
    const almanacDir = await buildRefreshRunFixture({
      id: "refresh-run-locked",
      benchmark: "missing",
    });
    const lockPath = join(almanacDir, REFRESH_LOCK_REL_PATH);
    await mkdir(join(almanacDir, ".compile"), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 12345,
        command: "almanac refresh run refresh-run-locked",
        acquiredAt: "2026-06-01T11:59:00.000Z",
      }) + "\n",
      "utf8",
    );

    const result = await runRefresh({
      almanacDir,
      runners: { "12-benchmark-run": benchmarkWritingRunner("passed") },
      forgerVersion: "0.6.0-test",
      save: true,
      now: fixedClock("2026-06-01T12:00:00.000Z"),
    });

    expect(result.status).toBe("locked");
    expect(result.exitCode).toBe(2);
    expect(result.lock?.pid).toBe(12345);
    expect(result.error?.code).toBe("locked");
    expect(existsSync(lockPath)).toBe(true);

    const readBack = await readRunToolArtifact({
      almanacDir,
      runId: result.refreshId,
    });
    expect(readBack.artifact.kind).toBe("refresh");
    expect(readBack.artifact.status).toBe("locked");
  });

  test("returns failed and persists a failed artifact when the pipeline fails", async () => {
    const almanacDir = await buildRefreshRunFixture({
      id: "refresh-run-failed",
      benchmark: "missing",
    });
    const lockPath = join(almanacDir, REFRESH_LOCK_REL_PATH);

    const result = await runRefresh({
      almanacDir,
      runners: {
        "12-benchmark-run": {
          promptVersion: null,
          async run() {
            throw new Error("fixture stage failure");
          },
        },
      },
      forgerVersion: "0.6.0-test",
      save: true,
      now: fixedClock("2026-06-01T12:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stageSummary.failed).toEqual(["12-benchmark-run"]);
    expect(result.error?.code).toBe("pipeline-failed");
    expect(existsSync(lockPath)).toBe(false);

    const readBack = await readRunToolArtifact({
      almanacDir,
      runId: result.refreshId,
    });
    expect(readBack.artifact.kind).toBe("refresh");
    expect(readBack.artifact.status).toBe("failed");
  });
});

async function buildRefreshRunFixture(options: {
  id: string;
  benchmark: "passed" | "failed" | "missing";
}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-refresh-run-"));
  cleanup.push(root);
  const almanacDir = join(root, options.id);
  const boot = bootstrapAlmanac({
    almanacId: options.id,
    domain: "sqlite operations",
    displayName: "SQLite Operations",
    freshnessProfileId: "mixed",
    runId: `run-${options.id}`,
    forgerVersion: "0.6.0-test",
    options: {
      depth: "quick",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  await ensureAlmanacLayout(almanacDir);
  await writeManifest(almanacDir, boot.manifest);
  let state = boot.compileState;
  for (const stageId of STAGE_IDS) {
    state = markStageCompleted(
      state,
      stageId,
      new Date("2026-06-01T00:01:00.000Z"),
      { outputHash: "a".repeat(64) },
    );
  }
  await writeCompileState(almanacDir, state);

  await writeFile(
    join(almanacDir, "sources", "sources.json"),
    JSON.stringify(buildSourcesFile(options.id), null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    join(almanacDir, "sources", "manifest.summary.json"),
    JSON.stringify(
      buildFetchManifest(options.id, new Date("2026-06-01T00:00:00.000Z")),
      null,
      2,
    ) + "\n",
    "utf8",
  );
  if (options.benchmark !== "missing") {
    await writeBenchmark(almanacDir, options.id, options.benchmark);
  }
  return almanacDir;
}

function benchmarkWritingRunner(
  status: "passed" | "failed",
  onRun?: () => void,
): StageRunner {
  return {
    promptVersion: null,
    async run(ctx) {
      onRun?.();
      await writeBenchmark(ctx.almanacDir, ctx.manifest.almanacId, status);
      return { kind: "success", outputHash: "c".repeat(64) };
    },
  };
}

async function writeBenchmark(
  almanacDir: string,
  almanacId: string,
  status: "passed" | "failed",
): Promise<void> {
  await writeFile(
    benchmarkResultPath(almanacDir),
    JSON.stringify(buildBenchmark(almanacId, status), null, 2) + "\n",
    "utf8",
  );
}

function buildSourcesFile(almanacId: string): SourcesFile {
  return SourcesFileSchema.parse({
    schemaVersion: "0.1.0",
    status: "approved",
    generatedAt: "2026-06-01T00:00:00.000Z",
    approvedAt: "2026-06-01T00:00:00.000Z",
    approvedBy: "auto",
    generatedBy: {
      stage: "02-source-discovery",
      evaluatorPromptVersion: "fixture-v1",
      candidateCount: 1,
      acceptedCount: 1,
    },
    coverage: {
      docs: 1,
      repo: 0,
      news: 0,
      community: 0,
      academic: 0,
      data: 0,
      file: 0,
      essay: 0,
      book: 0,
      talk: 0,
    },
    warnings: [],
    sources: [
      {
        id: "sqlite-docs",
        url: "https://www.sqlite.org/lang_transaction.html",
        kind: "docs",
        trust: 0.98,
        volatility: "slow",
        rationale: "Canonical SQLite transaction documentation.",
        ingestion: {
          mode: "snapshot",
          scope: ["/"],
          refreshIntervalHours: 24,
        },
        notes: null,
      },
    ],
    rejected: [],
  });
}

function buildFetchManifest(almanacId: string, fetchedAt: Date) {
  const fetchedAtIso = fetchedAt.toISOString();
  const hash = "b".repeat(64);
  const entries: SourceFetchEntry[] = [
    {
      sourceId: "sqlite-docs",
      status: "fetched",
      fetchedAt: fetchedAtIso,
      finalUrl: "https://www.sqlite.org/lang_transaction.html",
      fetcher: "fixture",
      documents: [
        {
          contentHash: hash,
          relPath: `sources/raw/${hash}.html`,
          url: "https://www.sqlite.org/lang_transaction.html",
          mediaType: "text/html",
          byteLength: 123,
          fetchedAt: fetchedAtIso,
          title: "SQLite Transactions",
        },
      ],
    },
  ];
  return buildSourceFetchManifest({
    almanacId,
    startedAt: fetchedAt,
    finishedAt: fetchedAt,
    entries,
  });
}

function buildBenchmark(
  almanacId: string,
  status: "passed" | "failed",
) {
  const set: BenchmarkSet = {
    schemaVersion: "0.1.0",
    almanacId,
    positive: [
      {
        id: "pos-sqlite",
        query: "What makes SQLite transactions atomic?",
        rationale: "Fixture confirms query_facts can cite source-backed facts.",
        intent: "lookup",
        invocation: { tool: "query_facts", input: { q: "transactions" } },
        expected: {
          minCitations: 1,
          contains: [],
          acceptableStaleness: ["fresh", "warm"],
        },
      },
    ],
    negative: [
      {
        id: "neg-unknown",
        query: "What is the weather on Mars tomorrow?",
        rationale: "Fixture confirms unrelated live facts are not fabricated.",
        invocation: { tool: "query_facts", input: { q: "mars weather" } },
        refusalReason: "out-of-scope",
        expected: { maxCitations: 0, expectedErrorCode: "no-results" },
      },
    ],
  };
  const positiveStatus = status === "passed" ? "pass" : "fail";
  const results: BenchmarkResult[] = [
    {
      fixtureId: "pos-sqlite",
      kind: "positive",
      status: positiveStatus,
      observed: {
        ok: status === "passed",
        citationsCount: status === "passed" ? 1 : 0,
        staleness: status === "passed" ? "fresh" : null,
        errorCode: status === "passed" ? null : "no-results",
      },
      reason: status === "passed" ? "ok" : "missing expected citation",
      durationMs: 1,
    },
    {
      fixtureId: "neg-unknown",
      kind: "negative",
      status: "pass",
      observed: {
        ok: false,
        citationsCount: 0,
        staleness: null,
        errorCode: "no-results",
      },
      reason: "negative abstained",
      durationMs: 1,
    },
  ];
  return buildBenchmarkReport({
    almanacId,
    ranAt: new Date("2026-06-01T00:03:00.000Z"),
    set,
    results,
  });
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
