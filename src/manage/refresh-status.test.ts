import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
  type StageId,
} from "../core/types.ts";
import {
  markStageCompleted,
  markStageFailed,
} from "../compile/pipeline.ts";
import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import { benchmarkResultPath } from "../compile/stages/s12-benchmark-run-runner.ts";
import {
  ensureAlmanacLayout,
  writeCompileState,
  writeManifest,
} from "../compile/storage.ts";

import {
  formatRefreshDueHuman,
  getRefreshDueStatus,
} from "./refresh-status.ts";

const cleanup: string[] = [];

afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getRefreshDueStatus", () => {
  test("returns not due for a fresh complete almanac", async () => {
    const almanacDir = await buildRefreshFixture({
      id: "refresh-fresh",
      fetchedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const status = await getRefreshDueStatus({
      almanacDir,
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(status.due).toBe(false);
    expect(status.recommendedFromStage).toBe("04-source-fetch");
    expect(status.reasons).toEqual([]);
    expect(status.sources).toEqual(
      expect.objectContaining({
        total: 1,
        fresh: 1,
        expired: 0,
        failed: 0,
        missingFetch: 0,
        nextDueAt: "2026-06-02T00:00:00.000Z",
      }),
    );
    expect(status.benchmark.status).toBe("passed");
    expect(formatRefreshDueHuman(status)).toContain("status: not-due");
  });

  test("flags expired sources and recommends Stage 4", async () => {
    const almanacDir = await buildRefreshFixture({
      id: "refresh-expired",
      fetchedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const status = await getRefreshDueStatus({
      almanacDir,
      now: new Date("2026-06-02T01:00:00.000Z"),
    });

    expect(status.due).toBe(true);
    expect(status.recommendedFromStage).toBe("04-source-fetch");
    expect(status.sources.expired).toBe(1);
    expect(status.reasons).toContainEqual(
      expect.objectContaining({
        code: "source-expired",
        fromStage: "04-source-fetch",
        sourceId: "sqlite-docs",
      }),
    );
  });

  test("flags failed stages and recommends the failed stage", async () => {
    const almanacDir = await buildRefreshFixture({
      id: "refresh-failed-stage",
      failedStage: "05-fact-extraction",
      fetchedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const status = await getRefreshDueStatus({
      almanacDir,
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(status.due).toBe(true);
    expect(status.recommendedFromStage).toBe("05-fact-extraction");
    expect(status.stages.failed).toEqual(["05-fact-extraction"]);
    expect(status.reasons).toContainEqual(
      expect.objectContaining({
        code: "stage-failed",
        fromStage: "05-fact-extraction",
        stageId: "05-fact-extraction",
      }),
    );
  });

  test("flags missing benchmark reports", async () => {
    const almanacDir = await buildRefreshFixture({
      id: "refresh-missing-benchmark",
      benchmark: "missing",
      fetchedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const status = await getRefreshDueStatus({
      almanacDir,
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(status.due).toBe(true);
    expect(status.benchmark.status).toBe("missing");
    expect(status.recommendedFromStage).toBe("12-benchmark-run");
    expect(status.reasons).toContainEqual(
      expect.objectContaining({
        code: "benchmark-missing",
        fromStage: "12-benchmark-run",
      }),
    );
  });

  test("flags missing source fetch manifests", async () => {
    const almanacDir = await buildRefreshFixture({
      id: "refresh-missing-fetch-manifest",
      includeSourceManifest: false,
      fetchedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const status = await getRefreshDueStatus({
      almanacDir,
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(status.due).toBe(true);
    expect(status.inputs.sourceFetchManifest).toBe("missing");
    expect(status.sources.missingFetch).toBe(1);
    expect(status.recommendedFromStage).toBe("04-source-fetch");
    expect(status.reasons).toContainEqual(
      expect.objectContaining({
        code: "source-fetch-manifest-missing",
        fromStage: "04-source-fetch",
      }),
    );
  });

  test("flags missing approved sources", async () => {
    const almanacDir = await buildRefreshFixture({
      id: "refresh-missing-sources",
      includeSources: false,
      includeSourceManifest: false,
      fetchedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const status = await getRefreshDueStatus({
      almanacDir,
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(status.due).toBe(true);
    expect(status.inputs.sourcesFile).toBe("missing");
    expect(status.recommendedFromStage).toBe("02b-source-discovery-evaluator");
    expect(status.reasons).toContainEqual(
      expect.objectContaining({
        code: "sources-missing",
        fromStage: "02b-source-discovery-evaluator",
      }),
    );
  });
});

async function buildRefreshFixture(options: {
  id: string;
  fetchedAt: Date;
  includeSources?: boolean;
  includeSourceManifest?: boolean;
  benchmark?: "passed" | "failed" | "missing";
  failedStage?: StageId;
}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-refresh-status-"));
  cleanup.push(root);
  const almanacDir = join(root, options.id);
  const boot = bootstrapAlmanac({
    almanacId: options.id,
    domain: "sqlite operations",
    displayName: "SQLite Operations",
    freshnessProfileId: "mixed",
    runId: `run-${options.id}`,
    forgerVersion: "0.5.0",
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
  if (options.failedStage !== undefined) {
    state = markStageFailed(
      state,
      options.failedStage,
      new Date("2026-06-01T00:02:00.000Z"),
      { code: "fixture-failed", message: "fixture stage failure" },
    );
  }
  await writeCompileState(almanacDir, state);

  if (options.includeSources !== false) {
    await writeFile(
      join(almanacDir, "sources", "sources.json"),
      JSON.stringify(buildSourcesFile(options.id), null, 2) + "\n",
      "utf8",
    );
  }

  if (options.includeSourceManifest !== false) {
    await writeFile(
      join(almanacDir, "sources", "manifest.summary.json"),
      JSON.stringify(buildFetchManifest(options.id, options.fetchedAt), null, 2) +
        "\n",
      "utf8",
    );
  }

  if (options.benchmark !== "missing") {
    await writeFile(
      benchmarkResultPath(almanacDir),
      JSON.stringify(
        buildBenchmark(options.id, options.benchmark ?? "passed"),
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  return almanacDir;
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
