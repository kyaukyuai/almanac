import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readManifest } from "../compile/storage.ts";
import type {
  AnswerArtifact,
  AnswerTraceQuality,
  RefreshArtifact,
} from "../core/types.ts";
import {
  listRunToolArtifacts,
  readRunToolArtifact,
  type RunToolArtifactSummary,
} from "./run-tool.ts";
import { ASK_FIXTURE_REL_PATHS } from "./ask-fixtures.ts";

export type AnswerReadinessStatus = "ready" | "needs-validation" | "not-ready";

export interface AnswerFixtureCoverage {
  count: number;
  paths: Array<{ relPath: string; count: number }>;
}

export interface AnswerReadinessLatestAnswer {
  answerId: string;
  status: AnswerArtifact["status"];
  startedAt: string;
  artifactRelPath: string;
  label?: string;
  abstentionReason?: string;
  quality: AnswerTraceQuality | null;
  staleCitationCount: number;
  hasTrace: boolean;
}

export interface AnswerReadinessLatestSuite {
  status: "passed" | "failed" | "missing" | "not-run" | "unreadable";
  source: "refresh-artifact" | "none";
  refreshId?: string;
  startedAt?: string;
  artifactRelPath?: string;
  label?: string;
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  citationRate?: number;
  unsupportedClaimCount?: number;
  staleCitationCount?: number;
  abstentionMismatchCount?: number;
  fixtureFiles: Array<{ relPath: string; count: number }>;
  error?: { code: string; message: string };
  readError?: string;
}

export interface AnswerReadiness {
  status: AnswerReadinessStatus;
  fixtures: AnswerFixtureCoverage;
  latestSuite: AnswerReadinessLatestSuite;
  latestAnswer: AnswerReadinessLatestAnswer | null;
  qualityGate: {
    status: "pass" | "fail" | "missing";
    reasons: string[];
  };
  issues: {
    blocking: string[];
    validation: string[];
  };
}

export async function getAnswerReadiness(input: {
  almanacDir: string;
}): Promise<AnswerReadiness> {
  const blocking: string[] = [];
  const validation: string[] = [];
  const manifest = await readManifest(input.almanacDir);
  if (manifest.toolCount <= 0) {
    blocking.push("no compiled tools available for answer mode");
  }

  const fixtures = await readAnswerFixtureCoverage(input.almanacDir);
  if (fixtures.count === 0) {
    validation.push("no ask replay fixtures");
  }

  const latestSuite = await readLatestAskSuite(input.almanacDir);
  if (fixtures.count > 0) {
    if (latestSuite.status === "not-run") {
      validation.push("ask suite has not been run");
    } else if (latestSuite.status === "unreadable") {
      validation.push(
        `ask suite artifacts unreadable: ${latestSuite.readError ?? "unknown error"}`,
      );
    } else if (latestSuite.status === "missing") {
      validation.push("latest ask suite found no ask fixtures");
    } else if (latestSuite.status === "failed") {
      validation.push("latest ask suite failed");
    } else if (!suiteMatchesFixtures(latestSuite, fixtures)) {
      validation.push(suiteFixtureMismatchMessage(latestSuite, fixtures));
    }
  }

  const latestAnswer = await readLatestAnswer(input.almanacDir);
  if (latestAnswer.status === "error") {
    validation.push(latestAnswer.message);
  }

  const latest =
    latestAnswer.status === "ok" ? latestAnswer.answer : null;
  if (latest === null && latestAnswer.status === "missing") {
    validation.push("no saved answer artifacts");
  }
  if (latest !== null && !latest.hasTrace) {
    validation.push("latest answer artifact has no trace");
  }
  if (latest !== null && latest.status !== "ok") {
    validation.push(`latest answer status is ${latest.status}`);
  }
  if (latest !== null && latest.staleCitationCount > 0) {
    validation.push(
      `latest answer has ${latest.staleCitationCount} stale citation(s)`,
    );
  }

  const qualityGate = latest?.quality ?? null;
  if (qualityGate === null) {
    validation.push("latest answer quality gate missing");
  } else if (qualityGate.status === "fail") {
    validation.push("latest answer quality gate failed");
  }

  const status: AnswerReadinessStatus =
    blocking.length > 0
      ? "not-ready"
      : validation.length > 0
        ? "needs-validation"
        : "ready";

  return {
    status,
    fixtures,
    latestSuite,
    latestAnswer: latest,
    qualityGate:
      qualityGate === null
        ? { status: "missing", reasons: [] }
        : { status: qualityGate.status, reasons: qualityGate.reasons },
    issues: {
      blocking,
      validation,
    },
  };
}

export function formatAnswerReadinessDoctor(readiness: AnswerReadiness): string {
  const parts = [
    `mode ${readiness.status}`,
    `${readiness.fixtures.count} fixture${readiness.fixtures.count === 1 ? "" : "s"}`,
    `suite ${formatDoctorSuite(readiness.latestSuite)}`,
    `quality ${readiness.qualityGate.status}`,
  ];
  if (readiness.latestAnswer === null) {
    parts.push("latest answer none");
  } else {
    parts.push(
      `latest answer ${readiness.latestAnswer.status} ${readiness.latestAnswer.answerId}`,
    );
  }
  const issues = [
    ...readiness.issues.blocking,
    ...readiness.issues.validation,
  ];
  if (issues.length > 0) {
    parts.push(issues.join("; "));
  }
  return parts.join("; ");
}

function formatDoctorSuite(suite: AnswerReadinessLatestSuite): string {
  if (suite.status === "not-run" || suite.status === "unreadable") {
    return suite.status;
  }
  const counts =
    suite.total === undefined
      ? ""
      : ` ${suite.passed ?? 0}/${suite.total}`;
  const refresh = suite.refreshId === undefined ? "" : ` ${suite.refreshId}`;
  return `${suite.status}${counts}${refresh}`;
}

function suiteMatchesFixtures(
  suite: AnswerReadinessLatestSuite,
  fixtures: AnswerFixtureCoverage,
): boolean {
  if (suite.status !== "passed") return false;
  if (suite.total !== undefined && suite.total !== fixtures.count) {
    return false;
  }
  if (suite.fixtureFiles.length === 0) {
    return suite.total === fixtures.count;
  }
  const suiteByPath = new Map(
    suite.fixtureFiles.map((file) => [file.relPath, file.count]),
  );
  const fixtureByPath = new Map(
    fixtures.paths.map((file) => [file.relPath, file.count]),
  );
  if (suiteByPath.size !== fixtureByPath.size) return false;
  for (const [relPath, count] of fixtureByPath) {
    if (suiteByPath.get(relPath) !== count) return false;
  }
  return true;
}

function suiteFixtureMismatchMessage(
  suite: AnswerReadinessLatestSuite,
  fixtures: AnswerFixtureCoverage,
): string {
  const suiteCoverage =
    suite.fixtureFiles.length === 0
      ? `${suite.total ?? 0} fixture(s)`
      : suite.fixtureFiles
          .map((file) => `${file.relPath}:${file.count}`)
          .join(", ");
  const currentCoverage =
    fixtures.paths.length === 0
      ? `${fixtures.count} fixture(s)`
      : fixtures.paths.map((file) => `${file.relPath}:${file.count}`).join(", ");
  return `latest ask suite fixture coverage differs: suite ${suiteCoverage}; current ${currentCoverage}`;
}

async function readAnswerFixtureCoverage(
  almanacDir: string,
): Promise<AnswerFixtureCoverage> {
  const paths: AnswerFixtureCoverage["paths"] = [];
  for (const relPath of ASK_FIXTURE_REL_PATHS) {
    const count = await countJsonlRows(join(almanacDir, relPath));
    if (count > 0) {
      paths.push({ relPath, count });
    }
  }
  return {
    count: paths.reduce((sum, path) => sum + path.count, 0),
    paths,
  };
}

async function countJsonlRows(path: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return 0;
    throw e;
  }
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function readLatestAnswer(
  almanacDir: string,
): Promise<
  | { status: "ok"; answer: AnswerReadinessLatestAnswer }
  | { status: "missing" }
  | { status: "error"; message: string }
> {
  let latest: RunToolArtifactSummary | undefined;
  try {
    const list = await listRunToolArtifacts({
      almanacDir,
      kind: "answer",
      limit: 1,
    });
    latest = list.runs[0];
  } catch (e) {
    return { status: "error", message: `answer artifacts unreadable: ${(e as Error).message}` };
  }
  if (latest === undefined) return { status: "missing" };

  try {
    const read = await readRunToolArtifact({
      almanacDir,
      runId: latest.runId,
    });
    if (read.artifact.kind !== "answer") {
      return {
        status: "error",
        message: `latest answer artifact is not an answer: ${latest.runId}`,
      };
    }
    return { status: "ok", answer: summarizeAnswer(read.artifact) };
  } catch (e) {
    return { status: "error", message: `latest answer unreadable: ${(e as Error).message}` };
  }
}

async function readLatestAskSuite(
  almanacDir: string,
): Promise<AnswerReadinessLatestSuite> {
  let latestRefreshes: RunToolArtifactSummary[] = [];
  try {
    const list = await listRunToolArtifacts({
      almanacDir,
      kind: "refresh",
    });
    latestRefreshes = list.runs;
  } catch (e) {
    return {
      status: "unreadable",
      source: "none",
      fixtureFiles: [],
      readError: (e as Error).message,
    };
  }

  for (const refresh of latestRefreshes) {
    try {
      const read = await readRunToolArtifact({
        almanacDir,
        runId: refresh.runId,
      });
      if (read.artifact.kind !== "refresh") continue;
      if (read.artifact.askSuite === undefined) continue;
      return summarizeAskSuite(read.artifact);
    } catch (e) {
      return {
        status: "unreadable",
        source: "refresh-artifact",
        refreshId: refresh.runId,
        artifactRelPath: refresh.artifactRelPath,
        fixtureFiles: [],
        readError: (e as Error).message,
      };
    }
  }

  return {
    status: "not-run",
    source: "none",
    fixtureFiles: [],
  };
}

function summarizeAskSuite(
  artifact: RefreshArtifact,
): AnswerReadinessLatestSuite {
  const askSuite = artifact.askSuite;
  if (askSuite === undefined) {
    return {
      status: "not-run",
      source: "none",
      fixtureFiles: [],
    };
  }
  return {
    status: askSuite.status,
    source: "refresh-artifact",
    refreshId: artifact.refreshId,
    startedAt: artifact.startedAt,
    artifactRelPath: artifact.artifactRelPath,
    ...(artifact.label === undefined ? {} : { label: artifact.label }),
    ...(askSuite.total === undefined ? {} : { total: askSuite.total }),
    ...(askSuite.passed === undefined ? {} : { passed: askSuite.passed }),
    ...(askSuite.failed === undefined ? {} : { failed: askSuite.failed }),
    ...(askSuite.errored === undefined ? {} : { errored: askSuite.errored }),
    ...(askSuite.citationRate === undefined
      ? {}
      : { citationRate: askSuite.citationRate }),
    ...(askSuite.unsupportedClaimCount === undefined
      ? {}
      : { unsupportedClaimCount: askSuite.unsupportedClaimCount }),
    ...(askSuite.staleCitationCount === undefined
      ? {}
      : { staleCitationCount: askSuite.staleCitationCount }),
    ...(askSuite.abstentionMismatchCount === undefined
      ? {}
      : { abstentionMismatchCount: askSuite.abstentionMismatchCount }),
    fixtureFiles: askSuite.fixtureFiles ?? [],
    ...(askSuite.error === undefined ? {} : { error: askSuite.error }),
  };
}

function summarizeAnswer(artifact: AnswerArtifact): AnswerReadinessLatestAnswer {
  return {
    answerId: artifact.answerId,
    status: artifact.status,
    startedAt: artifact.startedAt,
    artifactRelPath: artifact.artifactRelPath,
    ...(artifact.label === undefined ? {} : { label: artifact.label }),
    ...(artifact.abstentionReason === undefined
      ? {}
      : { abstentionReason: artifact.abstentionReason }),
    quality: artifact.trace?.quality ?? null,
    staleCitationCount: artifact.trace?.citations.staleCount ?? 0,
    hasTrace: artifact.trace !== undefined,
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code);
}
