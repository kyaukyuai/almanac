/**
 * Read-only refresh due detection.
 *
 * This module intentionally performs no writes and makes no provider calls.
 * It is the deterministic planning boundary that future refresh runners,
 * cron wrappers, and daemons can share.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  BenchmarkReportSchema,
  SourceFetchManifestSchema,
  SourcesFileSchema,
  STAGE_IDS,
  type BenchmarkReport,
  type SourceFetchEntry,
  type SourceFetchManifest,
  type SourcesFile,
  type StageId,
} from "../core/types.ts";
import {
  readCompileState,
  readManifest,
} from "../compile/storage.ts";

export const DEFAULT_REFRESH_FROM_STAGE: StageId = "04-source-fetch";

export type RefreshDueReasonCode =
  | "sources-missing"
  | "source-fetch-manifest-missing"
  | "source-not-fetched"
  | "source-expired"
  | "source-fetch-failed"
  | "stage-failed"
  | "stage-pending"
  | "benchmark-missing"
  | "benchmark-failed";

export interface RefreshDueReason {
  code: RefreshDueReasonCode;
  message: string;
  fromStage: StageId;
  sourceId?: string;
  stageId?: StageId;
  details?: Record<string, unknown>;
}

export type RefreshSourceStatus =
  | "fresh"
  | "expired"
  | "failed"
  | "missing-fetch";

export interface RefreshSourceSummary {
  sourceId: string;
  status: RefreshSourceStatus;
  refreshIntervalHours: number;
  ingestionMode: string;
  lastCheckedAt?: string;
  dueAt?: string;
  ageHours?: number;
  errorCode?: string;
}

export interface RefreshBenchmarkSummary {
  status: "missing" | "passed" | "failed";
  ranAt?: string;
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  citationRate?: number;
}

export interface RefreshDueStatus {
  schemaVersion: "0.1.0";
  checkedAt: string;
  almanacDir: string;
  almanacId: string;
  version: string;
  due: boolean;
  recommendedFromStage: StageId;
  reasons: RefreshDueReason[];
  sources: {
    total: number;
    fresh: number;
    expired: number;
    failed: number;
    missingFetch: number;
    nextDueAt: string | null;
    items: RefreshSourceSummary[];
  };
  stages: {
    failed: StageId[];
    pending: StageId[];
    running: StageId[];
  };
  benchmark: RefreshBenchmarkSummary;
  inputs: {
    sourcesFile: "present" | "missing";
    sourceFetchManifest: "present" | "missing";
    benchmarkReport: "present" | "missing";
  };
}

export interface GetRefreshDueStatusOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Clock override for tests. */
  now?: Date;
}

export class RefreshStatusError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "invalid-artifact",
    message: string,
  ) {
    super(message);
    this.name = "RefreshStatusError";
  }
}

export async function getRefreshDueStatus(
  options: GetRefreshDueStatusOptions,
): Promise<RefreshDueStatus> {
  const almanacDir = validateAlmanacDir(options.almanacDir);
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const manifest = await readRequiredArtifact(
    "manifest.json",
    () => readManifest(almanacDir),
  );
  const state = await readRequiredArtifact(
    ".compile/compile-state.json",
    () => readCompileState(almanacDir),
  );
  const sourcesFile = await readOptionalJson(
    join(almanacDir, "sources", "sources.json"),
    SourcesFileSchema,
    "sources/sources.json",
  );
  const sourceManifest = await readOptionalJson(
    join(almanacDir, "sources", "manifest.summary.json"),
    SourceFetchManifestSchema,
    "sources/manifest.summary.json",
  );
  const benchmarkReport = await readOptionalJson(
    join(almanacDir, ".compile", "benchmark-result.json"),
    BenchmarkReportSchema,
    ".compile/benchmark-result.json",
  );

  const reasons: RefreshDueReason[] = [];
  const stageSummary = summarizeStages(state.stages);
  for (const stageId of stageSummary.failed) {
    reasons.push({
      code: "stage-failed",
      message: `stage ${stageId} failed`,
      fromStage: stageId,
      stageId,
    });
  }
  if (stageSummary.failed.length === 0 && stageSummary.pending.length > 0) {
    const stageId = stageSummary.pending[0]!;
    reasons.push({
      code: "stage-pending",
      message: `stage ${stageId} is pending`,
      fromStage: stageId,
      stageId,
    });
  }

  const sourceSummary = summarizeSources({
    sourcesFile,
    sourceManifest,
    now,
    reasons,
  });
  const benchmark = summarizeBenchmark(benchmarkReport, reasons);
  const due = reasons.length > 0;

  return {
    schemaVersion: "0.1.0",
    checkedAt,
    almanacDir,
    almanacId: manifest.almanacId,
    version: manifest.version,
    due,
    recommendedFromStage: chooseRecommendedFromStage(reasons),
    reasons,
    sources: sourceSummary,
    stages: stageSummary,
    benchmark,
    inputs: {
      sourcesFile: sourcesFile === null ? "missing" : "present",
      sourceFetchManifest: sourceManifest === null ? "missing" : "present",
      benchmarkReport: benchmarkReport === null ? "missing" : "present",
    },
  };
}

export function formatRefreshDueHuman(status: RefreshDueStatus): string {
  const lines = [
    `refresh due: ${status.almanacId} (${status.version})`,
    `status: ${status.due ? "due" : "not-due"}`,
    `recommended fromStage: ${status.recommendedFromStage}`,
    `checked: ${status.checkedAt}`,
    `sources: ${status.sources.total} total, ${status.sources.expired} expired, ${status.sources.failed} failed, ${status.sources.missingFetch} missing fetch`,
    `benchmark: ${formatBenchmarkSummary(status.benchmark)}`,
  ];
  if (status.sources.nextDueAt !== null) {
    lines.push(`next source due: ${status.sources.nextDueAt}`);
  }
  if (status.reasons.length === 0) {
    lines.push("reasons: (none)");
  } else {
    lines.push("reasons:");
    for (const reason of status.reasons) {
      const target =
        reason.sourceId !== undefined
          ? ` source=${reason.sourceId}`
          : reason.stageId !== undefined
            ? ` stage=${reason.stageId}`
            : "";
      lines.push(`  - ${reason.code}${target}: ${reason.message}`);
    }
  }
  return lines.join("\n") + "\n";
}

function validateAlmanacDir(almanacDir: string): string {
  if (!isAbsolute(almanacDir)) {
    throw new RefreshStatusError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new RefreshStatusError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return almanacDir;
}

async function readRequiredArtifact<T>(
  label: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    throw new RefreshStatusError(
      "invalid-artifact",
      `${label} is missing or invalid: ${messageFor(cause)}`,
    );
  }
}

async function readOptionalJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
  label: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return null;
    throw cause;
  }

  try {
    return schema.parse(JSON.parse(raw));
  } catch (cause) {
    throw new RefreshStatusError(
      "invalid-artifact",
      `${label} is invalid: ${messageFor(cause)}`,
    );
  }
}

function summarizeStages(
  stages: Record<StageId, { status: string }>,
): RefreshDueStatus["stages"] {
  const failed: StageId[] = [];
  const pending: StageId[] = [];
  const running: StageId[] = [];
  for (const stageId of STAGE_IDS) {
    const status = stages[stageId].status;
    if (status === "failed") failed.push(stageId);
    if (status === "pending") pending.push(stageId);
    if (status === "running") running.push(stageId);
  }
  return { failed, pending, running };
}

function summarizeSources(input: {
  sourcesFile: SourcesFile | null;
  sourceManifest: SourceFetchManifest | null;
  now: Date;
  reasons: RefreshDueReason[];
}): RefreshDueStatus["sources"] {
  const items: RefreshSourceSummary[] = [];
  if (input.sourcesFile === null) {
    input.reasons.push({
      code: "sources-missing",
      message: "approved sources file is missing",
      fromStage: "02b-source-discovery-evaluator",
    });
    return emptySourceSummary();
  }
  if (input.sourceManifest === null) {
    input.reasons.push({
      code: "source-fetch-manifest-missing",
      message: "source fetch manifest is missing",
      fromStage: "04-source-fetch",
    });
  }

  const entriesBySourceId = new Map<string, SourceFetchEntry>();
  for (const entry of input.sourceManifest?.entries ?? []) {
    entriesBySourceId.set(entry.sourceId, entry);
  }

  let nextDueAtMs: number | null = null;
  for (const source of input.sourcesFile.sources) {
    const entry = entriesBySourceId.get(source.id);
    if (entry === undefined) {
      items.push({
        sourceId: source.id,
        status: "missing-fetch",
        refreshIntervalHours: source.ingestion.refreshIntervalHours,
        ingestionMode: source.ingestion.mode,
      });
      if (input.sourceManifest !== null) {
        input.reasons.push({
          code: "source-not-fetched",
          message: `source ${source.id} has no fetch manifest entry`,
          fromStage: "04-source-fetch",
          sourceId: source.id,
        });
      }
      continue;
    }

    if (entry.status === "failed") {
      items.push({
        sourceId: source.id,
        status: "failed",
        refreshIntervalHours: source.ingestion.refreshIntervalHours,
        ingestionMode: source.ingestion.mode,
        lastCheckedAt: entry.attemptedAt,
        errorCode: entry.error.code,
      });
      input.reasons.push({
        code: "source-fetch-failed",
        message: `source ${source.id} last fetch failed`,
        fromStage: "04-source-fetch",
        sourceId: source.id,
        details: { errorCode: entry.error.code },
      });
      continue;
    }

    const lastCheckedAt = entry.fetchedAt;
    const lastCheckedAtMs = Date.parse(lastCheckedAt);
    const dueAtMs =
      lastCheckedAtMs + source.ingestion.refreshIntervalHours * 60 * 60 * 1000;
    const dueAt = new Date(dueAtMs).toISOString();
    const ageHours = roundHours(
      (input.now.getTime() - lastCheckedAtMs) / (60 * 60 * 1000),
    );
    const expired = input.now.getTime() >= dueAtMs;
    items.push({
      sourceId: source.id,
      status: expired ? "expired" : "fresh",
      refreshIntervalHours: source.ingestion.refreshIntervalHours,
      ingestionMode: source.ingestion.mode,
      lastCheckedAt,
      dueAt,
      ageHours,
    });
    if (expired) {
      input.reasons.push({
        code: "source-expired",
        message: `source ${source.id} exceeded ${source.ingestion.refreshIntervalHours}h refresh interval`,
        fromStage: "04-source-fetch",
        sourceId: source.id,
        details: {
          lastCheckedAt,
          dueAt,
          ageHours,
          refreshIntervalHours: source.ingestion.refreshIntervalHours,
        },
      });
    } else {
      nextDueAtMs =
        nextDueAtMs === null ? dueAtMs : Math.min(nextDueAtMs, dueAtMs);
    }
  }

  return {
    total: items.length,
    fresh: items.filter((item) => item.status === "fresh").length,
    expired: items.filter((item) => item.status === "expired").length,
    failed: items.filter((item) => item.status === "failed").length,
    missingFetch: items.filter((item) => item.status === "missing-fetch").length,
    nextDueAt: nextDueAtMs === null ? null : new Date(nextDueAtMs).toISOString(),
    items,
  };
}

function summarizeBenchmark(
  report: BenchmarkReport | null,
  reasons: RefreshDueReason[],
): RefreshBenchmarkSummary {
  if (report === null) {
    reasons.push({
      code: "benchmark-missing",
      message: "benchmark report is missing",
      fromStage: "12-benchmark-run",
    });
    return { status: "missing" };
  }

  const failed = report.summary.failed > 0 || report.summary.errored > 0;
  if (failed) {
    reasons.push({
      code: "benchmark-failed",
      message:
        `benchmark has ${report.summary.failed} failed and ` +
        `${report.summary.errored} errored fixture(s)`,
      fromStage: "12-benchmark-run",
      details: {
        failed: report.summary.failed,
        errored: report.summary.errored,
      },
    });
  }

  return {
    status: failed ? "failed" : "passed",
    ranAt: report.ranAt,
    total: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    errored: report.summary.errored,
    citationRate: report.summary.citationRate,
  };
}

function emptySourceSummary(): RefreshDueStatus["sources"] {
  return {
    total: 0,
    fresh: 0,
    expired: 0,
    failed: 0,
    missingFetch: 0,
    nextDueAt: null,
    items: [],
  };
}

function chooseRecommendedFromStage(reasons: RefreshDueReason[]): StageId {
  if (reasons.length === 0) return DEFAULT_REFRESH_FROM_STAGE;
  return reasons
    .map((reason) => reason.fromStage)
    .sort((a, b) => STAGE_IDS.indexOf(a) - STAGE_IDS.indexOf(b))[0]!;
}

function formatBenchmarkSummary(benchmark: RefreshBenchmarkSummary): string {
  if (benchmark.status === "missing") return "missing";
  return (
    `${benchmark.status}, ${benchmark.passed}/${benchmark.total} passed` +
    `, failed=${benchmark.failed}, errored=${benchmark.errored}`
  );
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
