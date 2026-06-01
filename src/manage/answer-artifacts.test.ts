import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import {
  ensureAlmanacLayout,
  writeManifest,
} from "../compile/storage.ts";
import {
  AlmanacManifestSchema,
  AnswerArtifactSchema,
  RefreshArtifactSchema,
  RunArtifactEnvelopeSchema,
  RunToolArtifactSchema,
  type AnswerTrace,
  type Citation,
  type ToolResultFreshness,
} from "../core/types.ts";

import {
  answerArtifactRelPath,
  saveAnswerArtifact,
} from "./answer-artifacts.ts";
import {
  formatPruneRunToolArtifactsHuman,
  formatRunToolArtifactHuman,
  formatRunToolArtifactListHuman,
  listRunToolArtifacts,
  pruneRunToolArtifacts,
  readRunToolArtifact,
} from "./run-tool.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("answer artifacts", () => {
  test("saves schema-valid answer artifacts and exposes them through run internals", async () => {
    const almanacDir = await buildAnswerArtifactFixture("answer-save");
    const startedAt = "2026-01-02T00:00:00.000Z";
    const answerId = "answer-2026-01-02T00-00-00-000Z-00000001";

    const saved = await saveAnswerArtifact({
      almanacDir,
      answerId,
      question: "How do SQLite transactions behave?",
      status: "ok",
      exitCode: 0,
      startedAt,
      finishedAt: "2026-01-02T00:00:01.250Z",
      label: "rc-answer",
      note: "Release candidate answer smoke.",
      model: "test-model",
      promptVersions: {
        planner: "planner-v1",
        synthesis: "synthesis-v1",
      },
      answer: "SQLite transactions are atomic units of work.",
      toolCalls: [
        {
          toolName: "query_facts",
          input: { q: "transactions" },
          status: "ok",
          durationMs: 25,
          citationsCount: 1,
        },
      ],
      citations: [fixtureCitation()],
      freshness: fixtureFreshness(),
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      trace: fixtureAnswerTrace(),
    });

    expect(saved.relPath).toBe(answerArtifactRelPath(answerId));
    expect(saved.artifact.kind).toBe("answer");
    expect(saved.artifact.forgerVersion).toBe("0.7.0-test");
    expect(saved.artifact.durationMs).toBe(1250);
    expect(existsSync(saved.path)).toBe(true);

    const raw = JSON.parse(readFileSync(saved.path, "utf8")) as unknown;
    expect(AnswerArtifactSchema.safeParse(raw).success).toBe(true);
    expect(RunArtifactEnvelopeSchema.parse(raw).kind).toBe("answer");

    const list = await listRunToolArtifacts({
      almanacDir,
      kind: "answer",
    });
    expect(list.runs).toEqual([
      expect.objectContaining({
        kind: "answer",
        runId: answerId,
        status: "ok",
        citationsCount: 1,
        question: "How do SQLite transactions behave?",
        label: "rc-answer",
      }),
    ]);
    expect(formatRunToolArtifactListHuman(list)).toContain("answer");
    expect(formatRunToolArtifactListHuman(list)).toContain("label=rc-answer");

    const readBack = await readRunToolArtifact({ almanacDir, runId: answerId });
    expect(readBack.relPath).toBe(saved.relPath);
    expect(readBack.artifact.kind).toBe("answer");
    if (readBack.artifact.kind !== "answer") {
      throw new Error(`expected answer artifact, got ${readBack.artifact.kind}`);
    }
    expect(readBack.artifact.answer).toContain("atomic");
    expect(readBack.artifact.trace?.planner.stopReason).toBe("planner-stop");
    expect(readBack.artifact.trace?.citations.usedCount).toBe(1);

    const formatted = formatRunToolArtifactHuman(readBack.artifact);
    expect(formatted).toContain("answer:");
    expect(formatted).toContain("question:");
    expect(formatted).toContain("citations: 1");
    expect(formatted).toContain("label: rc-answer");
    expect(formatted).toContain("trace: planner=2 stop=planner-stop");
    expect(formatted).toContain("planner trace:");
    expect(formatted).toContain("citation trace:");
  });

  test("validates answer status invariants independently", async () => {
    const base = validAnswerArtifactPayload({
      answerId: "answer-2026-01-03T00-00-00-000Z-00000002",
    });

    expect(
      AnswerArtifactSchema.safeParse({
        ...base,
        citations: [],
      }).success,
    ).toBe(false);

    expect(
      AnswerArtifactSchema.safeParse({
        ...base,
        status: "abstained",
        answer: undefined,
        citations: [],
        abstentionReason: "no-citations",
      }).success,
    ).toBe(true);

    expect(
      AnswerArtifactSchema.safeParse({
        ...base,
        status: "model-error",
        answer: undefined,
        citations: [],
        error: undefined,
      }).success,
    ).toBe(false);
  });

  test("lists legacy tool, refresh, and answer artifacts without cross-kind pruning", async () => {
    const almanacDir = await buildAnswerArtifactFixture("answer-mixed");
    const savedAnswer = await saveAnswerArtifact({
      almanacDir,
      answerId: "answer-2026-01-05T00-00-00-000Z-00000005",
      question: "When should I cite sources?",
      status: "abstained",
      exitCode: 0,
      startedAt: "2026-01-05T00:00:00.000Z",
      finishedAt: "2026-01-05T00:00:00.500Z",
      abstentionReason: "no-citations",
    });
    const legacyTool = writeLegacyToolArtifact(almanacDir, "answer-mixed");
    const refresh = writeRefreshArtifact(almanacDir, "answer-mixed");

    const all = await listRunToolArtifacts({ almanacDir });
    expect(all.runs.map((run) => run.kind).sort()).toEqual([
      "answer",
      "refresh",
      "tool",
    ]);

    const readTool = await readRunToolArtifact({
      almanacDir,
      runId: legacyTool.runId,
    });
    expect(readTool.artifact.kind).toBe("tool");

    const readRefresh = await readRunToolArtifact({
      almanacDir,
      runId: refresh.refreshId,
    });
    expect(readRefresh.artifact.kind).toBe("refresh");

    const applied = await pruneRunToolArtifacts({
      almanacDir,
      kind: "answer",
      keepLatest: 0,
      apply: true,
    });

    expect(applied.applied).toBe(true);
    expect(applied.deletedCount).toBe(1);
    expect(applied.runs.map((run) => run.runId)).toEqual([
      savedAnswer.artifact.answerId,
    ]);
    expect(formatPruneRunToolArtifactsHuman(applied)).toContain("answer");
    expect(existsSync(savedAnswer.path)).toBe(false);
    expect(existsSync(legacyTool.path)).toBe(true);
    expect(existsSync(refresh.path)).toBe(true);
    expect(
      (await listRunToolArtifacts({ almanacDir, kind: "answer" })).runs,
    ).toEqual([]);
  });
});

async function buildAnswerArtifactFixture(almanacId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-answer-artifact-"));
  cleanup.push(root);
  const almanacDir = join(root, almanacId);
  await ensureAlmanacLayout(almanacDir);

  const boot = bootstrapAlmanac({
    almanacId,
    domain: almanacId,
    displayName: almanacId,
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.7.0-test",
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

function validAnswerArtifactPayload(overrides: { answerId: string }) {
  return {
    schemaVersion: "0.1.0",
    kind: "answer",
    artifactRelPath: answerArtifactRelPath(overrides.answerId),
    answerId: overrides.answerId,
    startedAt: "2026-01-03T00:00:00.000Z",
    finishedAt: "2026-01-03T00:00:00.250Z",
    almanacId: "answer-schema",
    version: "0.1.0",
    forgerVersion: "0.7.0-test",
    question: "How do transactions behave?",
    status: "ok",
    exitCode: 0,
    answer: "Transactions are atomic.",
    toolCalls: [
      {
        toolName: "query_facts",
        input: { q: "transactions" },
        status: "ok",
        durationMs: 10,
        citationsCount: 1,
      },
    ],
    citations: [fixtureCitation()],
    freshness: fixtureFreshness(),
    durationMs: 250,
  };
}

function writeLegacyToolArtifact(almanacDir: string, almanacId: string) {
  const runId = "run-2026-01-04T00-00-00-000Z-00000004";
  const artifact = RunToolArtifactSchema.parse({
    schemaVersion: "0.1.0",
    kind: "tool",
    artifactRelPath: `.runs/${runId}.json`,
    runId,
    invokedAt: "2026-01-04T00:00:00.000Z",
    almanacId,
    version: "0.1.0",
    toolName: "query_facts",
    input: { q: "transactions" },
    status: "ok",
    exitCode: 0,
    result: {
      ok: true,
      data: { hits: [{ text: "Transactions are atomic." }] },
      citations: [fixtureCitation()],
      freshness: fixtureFreshness(),
    },
    durationMs: 40,
    citationsCount: 1,
  });
  const persisted = { ...artifact } as Record<string, unknown>;
  delete persisted.kind;
  const path = join(almanacDir, artifact.artifactRelPath);
  writeFileSync(path, JSON.stringify(persisted, null, 2) + "\n", "utf8");
  return { artifact, path, runId };
}

function writeRefreshArtifact(almanacDir: string, almanacId: string) {
  const refreshId = "refresh-2026-01-06T00-00-00-000Z-00000006";
  const artifact = RefreshArtifactSchema.parse({
    schemaVersion: "0.1.0",
    kind: "refresh",
    artifactRelPath: `.runs/${refreshId}.json`,
    refreshId,
    startedAt: "2026-01-06T00:00:00.000Z",
    finishedAt: "2026-01-06T00:00:05.000Z",
    almanacId,
    version: "0.1.0",
    status: "ok",
    exitCode: 0,
    requestedFromStage: "04-source-fetch",
    effectiveFromStage: "04-source-fetch",
    dueDecision: {
      due: true,
      recommendedFromStage: "04-source-fetch",
      reasonCodes: ["source-expired"],
    },
    durationMs: 5000,
  });
  const path = join(almanacDir, artifact.artifactRelPath);
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { artifact, path, refreshId };
}

function fixtureCitation(): Citation {
  return {
    sourceId: "sqlite-docs",
    url: "https://sqlite.org/lang_transaction.html",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    excerpt: "Transactions are atomic.",
  };
}

function fixtureFreshness(): ToolResultFreshness {
  return {
    class: "static",
    maxAge: null,
    staleness: "fresh",
  };
}

function fixtureAnswerTrace(): AnswerTrace {
  const citation = fixtureCitation();
  return {
    schemaVersion: "0.1.0",
    planner: {
      promptVersion: "planner-v1",
      model: "test-model",
      calls: 2,
      stopReason: "planner-stop",
      maxToolCalls: 4,
      maxDurationMs: 120_000,
      steps: [
        {
          stepIndex: 0,
          plannerCall: 1,
          action: "call_tool",
          outcome: "executed",
          toolName: "query_facts",
          input: { q: "transactions" },
        },
        {
          stepIndex: 1,
          plannerCall: 2,
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
          input: { q: "transactions" },
          status: "ok",
          durationMs: 25,
          citationsCount: 1,
          freshness: fixtureFreshness(),
        },
      ],
    },
    citations: {
      observed: [
        {
          citationKey: `${citation.sourceId}\n${citation.url}`,
          sourceId: citation.sourceId,
          url: citation.url,
          fetchedAt: citation.fetchedAt,
          observedInCallIndexes: [0],
          usedInAnswer: true,
          stale: false,
          freshness: fixtureFreshness(),
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
  };
}
