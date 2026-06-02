import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import {
  ensureAlmanacLayout,
  writeManifest,
} from "../compile/storage.ts";
import {
  AlmanacManifestSchema,
  type AnswerTrace,
  type Citation,
  RefreshArtifactSchema,
} from "../core/types.ts";
import { saveAnswerArtifact } from "./answer-artifacts.ts";
import {
  formatAnswerReadinessDoctor,
  getAnswerReadiness,
} from "./answer-readiness.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("answer readiness", () => {
  test("reports missing ask fixtures and saved answers", async () => {
    const almanacDir = await buildAnswerReadinessFixture("answer-not-ready");

    const readiness = await getAnswerReadiness({ almanacDir });

    expect(readiness.status).toBe("needs-validation");
    expect(readiness.fixtures.count).toBe(0);
    expect(readiness.latestSuite.status).toBe("not-run");
    expect(readiness.latestAnswer).toBeNull();
    expect(readiness.qualityGate.status).toBe("missing");
    expect(formatAnswerReadinessDoctor(readiness)).toContain(
      "no ask replay fixtures",
    );
    expect(formatAnswerReadinessDoctor(readiness)).toContain("suite not-run");
  });

  test("requires a saved ask suite when ask fixtures exist", async () => {
    const almanacDir = await buildAnswerReadinessFixture("answer-suite-missing");
    writeAskFixture(almanacDir);
    await savePassingAnswer(almanacDir);

    const readiness = await getAnswerReadiness({ almanacDir });

    expect(readiness.status).toBe("needs-validation");
    expect(readiness.fixtures.count).toBe(1);
    expect(readiness.latestSuite.status).toBe("not-run");
    expect(readiness.issues.validation).toContain("ask suite has not been run");
  });

  test("reports failed latest ask suite as validation work", async () => {
    const almanacDir = await buildAnswerReadinessFixture("answer-suite-failed");
    writeAskFixture(almanacDir);
    await savePassingAnswer(almanacDir);
    writeAskSuiteRefresh(almanacDir, {
      refreshId: "refresh-2026-01-03T00-00-00-000Z-00000002",
      status: "failed",
      exitCode: 1,
      passed: 0,
      failed: 1,
    });

    const readiness = await getAnswerReadiness({ almanacDir });

    expect(readiness.status).toBe("needs-validation");
    expect(readiness.latestSuite.status).toBe("failed");
    expect(readiness.latestSuite.refreshId).toBe(
      "refresh-2026-01-03T00-00-00-000Z-00000002",
    );
    expect(readiness.issues.validation).toContain("latest ask suite failed");
  });

  test("reports ready when fixtures, latest suite, and latest quality pass exist", async () => {
    const almanacDir = await buildAnswerReadinessFixture("answer-ready");
    writeAskFixture(almanacDir);
    await savePassingAnswer(almanacDir);
    writeAskSuiteRefresh(almanacDir, {
      refreshId: "refresh-2026-01-03T00-00-00-000Z-00000003",
      status: "passed",
      exitCode: 0,
      passed: 1,
      failed: 0,
    });

    const readiness = await getAnswerReadiness({ almanacDir });

    expect(readiness.status).toBe("ready");
    expect(readiness.fixtures.count).toBe(1);
    expect(readiness.latestSuite.status).toBe("passed");
    expect(readiness.latestSuite.total).toBe(1);
    expect(readiness.latestAnswer?.status).toBe("ok");
    expect(readiness.qualityGate.status).toBe("pass");
  });
});

function writeAskFixture(almanacDir: string): void {
  mkdirSync(join(almanacDir, "tests"), { recursive: true });
  writeFileSync(
    join(almanacDir, "tests", "ask.jsonl"),
    '{"id":"sqlite-ok","question":"ok","toolCalls":[{"tool":"query_facts"}],"expectedStatus":"ok"}\n',
    "utf8",
  );
}

async function savePassingAnswer(almanacDir: string): Promise<void> {
  await saveAnswerArtifact({
    almanacDir,
    answerId: "answer-2026-01-02T00-00-00-000Z-00000001",
    question: "Are foreign keys supported?",
    status: "ok",
    exitCode: 0,
    startedAt: "2026-01-02T00:00:00.000Z",
    finishedAt: "2026-01-02T00:00:01.000Z",
    answer: "SQLite supports foreign key constraints.",
    toolCalls: [
      {
        toolName: "query_facts",
        input: { q: "foreign keys" },
        status: "ok",
        durationMs: 10,
        citationsCount: 1,
      },
    ],
    citations: [fixtureCitation()],
    trace: fixtureTrace(),
  });
}

function writeAskSuiteRefresh(
  almanacDir: string,
  options: {
    refreshId: string;
    status: "passed" | "failed" | "missing";
    exitCode: 0 | 1 | 2;
    passed?: number;
    failed?: number;
  },
): void {
  mkdirSync(join(almanacDir, ".runs"), { recursive: true });
  const artifact = RefreshArtifactSchema.parse({
    schemaVersion: "0.1.0",
    kind: "refresh",
    artifactRelPath: `.runs/${options.refreshId}.json`,
    refreshId: options.refreshId,
    startedAt: "2026-01-03T00:00:00.000Z",
    finishedAt: "2026-01-03T00:00:01.000Z",
    almanacId: "answer-ready",
    version: "0.1.0",
    status: options.exitCode === 0 ? "ok" : "failed",
    exitCode: options.exitCode,
    requestedFromStage: "12-benchmark-run",
    effectiveFromStage: "12-benchmark-run",
    dueDecision: {
      due: true,
      recommendedFromStage: "12-benchmark-run",
      reasonCodes: ["test"],
    },
    askSuite: {
      status: options.status,
      exitCode: options.exitCode,
      total: 1,
      passed: options.passed ?? 0,
      failed: options.failed ?? 0,
      errored: 0,
      citationRate: options.status === "passed" ? 1 : 0,
      unsupportedClaimCount: 0,
      staleCitationCount: 0,
      abstentionMismatchCount: 0,
      fixtureFiles: [{ relPath: "tests/ask.jsonl", count: 1 }],
    },
    durationMs: 1000,
  });
  writeFileSync(
    join(almanacDir, artifact.artifactRelPath),
    JSON.stringify(artifact, null, 2) + "\n",
    "utf8",
  );
}

async function buildAnswerReadinessFixture(almanacId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-answer-readiness-"));
  cleanup.push(root);
  const almanacDir = join(root, almanacId);
  await ensureAlmanacLayout(almanacDir);
  const boot = bootstrapAlmanac({
    almanacId,
    domain: "SQLite",
    displayName: almanacId,
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.8.0-test",
    options: {
      depth: "standard",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
  });
  await writeManifest(
    almanacDir,
    AlmanacManifestSchema.parse({
      ...boot.manifest,
      toolCount: 1,
      factCount: 1,
    }),
  );
  return almanacDir;
}

function fixtureCitation(): Citation {
  return {
    sourceId: "sqlite-docs",
    url: "https://www.sqlite.org/foreignkeys.html",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fixtureTrace(): AnswerTrace {
  return {
    schemaVersion: "0.1.0",
    planner: {
      promptVersion: "planner-v1",
      model: "test-model",
      calls: 1,
      stopReason: "planner-stop",
      maxToolCalls: 4,
      maxDurationMs: 120000,
      steps: [
        {
          stepIndex: 0,
          plannerCall: 1,
          action: "stop",
          outcome: "stopped",
          stopReason: "planner-stop",
        },
      ],
    },
    tools: {
      observations: [
        {
          callIndex: 0,
          toolName: "query_facts",
          input: { q: "foreign keys" },
          status: "ok",
          durationMs: 10,
          citationsCount: 1,
        },
      ],
    },
    citations: {
      observed: [
        {
          citationKey: "sqlite-docs|https://www.sqlite.org/foreignkeys.html",
          sourceId: "sqlite-docs",
          url: "https://www.sqlite.org/foreignkeys.html",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          observedInCallIndexes: [0],
          usedInAnswer: true,
          stale: false,
        },
      ],
      usedCount: 1,
      staleCount: 0,
    },
    synthesis: {
      promptVersion: "synthesis-v1",
      model: "test-model",
      calls: 1,
      status: "ok",
    },
    quality: {
      status: "pass",
      citationRate: 1,
      unsupportedClaimCount: 0,
      staleCitationCount: 0,
      abstention: {
        expected: false,
        actual: false,
        matches: true,
      },
      reasons: [],
    },
  };
}
