import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readManifest } from "../compile/storage.ts";
import type {
  AnswerArtifact,
  AnswerTraceQuality,
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

export interface AnswerReadiness {
  status: AnswerReadinessStatus;
  fixtures: AnswerFixtureCoverage;
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
