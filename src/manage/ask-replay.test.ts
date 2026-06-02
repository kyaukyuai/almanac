import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_TEMPLATES,
} from "../compile/stages/s07/templates.ts";
import {
  synthesizeDefaultToolManifest,
} from "../compile/stages/s07/template-implementer.ts";
import {
  buildKnowledgeIndex,
} from "../compile/stages/s08-knowledge-index.ts";
import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import {
  ensureAlmanacLayout,
  writeManifest,
} from "../compile/storage.ts";
import {
  AlmanacManifestSchema,
  type Citation,
  type FactRecord,
  type ToolManifest,
} from "../core/types.ts";
import { saveAnswerArtifact } from "./answer-artifacts.ts";

import {
  AskReplaySetupError,
  exitCodeForAskReplay,
  formatAskReplayHuman,
  parseAskReplayFixtureJsonl,
  runAskReplayFromFixtures,
  runAskReplayFromSavedRuns,
} from "./ask-replay.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ask replay fixtures", () => {
  test("parses JSONL fixtures and rejects malformed rows with line context", () => {
    const fixtures = parseAskReplayFixtureJsonl(`
{"id":"sqlite-ok","question":"Are foreign keys supported?","toolCalls":[{"tool":"query_facts","input":{"q":"foreign keys"},"expectedStatus":"ok"}],"expectedStatus":"ok","minCitations":1,"maxStaleCitations":0}

`);

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toEqual(
      expect.objectContaining({
        id: "sqlite-ok",
        expectedStatus: "ok",
        minCitations: 1,
      }),
    );

    expect(() => parseAskReplayFixtureJsonl("{not-json}")).toThrow(
      AskReplaySetupError,
    );
  });

  test("replays fixture-declared tool calls without an LLM provider", async () => {
    const almanacDir = await buildAskReplayFixture("ask-replay-fixture");
    const [fixture] = parseAskReplayFixtureJsonl(
      JSON.stringify({
        id: "sqlite-foreign-keys",
        question: "Are foreign keys supported?",
        toolCalls: [
          {
            tool: "query_facts",
            input: { q: "foreign keys" },
            expectedStatus: "ok",
          },
        ],
        expectedStatus: "ok",
        minCitations: 1,
        maxStaleCitations: 0,
      }) + "\n",
    );

    const report = await runAskReplayFromFixtures({
      almanacDir,
      fixtures: [fixture!],
    });

    expect(report.mode).toBe("fixture");
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.quality).toEqual(
      expect.objectContaining({
        status: "pass",
        unsupportedClaimCount: 0,
        staleCitationCount: 0,
      }),
    );
    expect(report.results[0]).toEqual(
      expect.objectContaining({
        fixtureId: "sqlite-foreign-keys",
        status: "pass",
        quality: expect.objectContaining({
          status: "pass",
          citationRate: 1,
        }),
        observed: expect.objectContaining({
          status: "ok",
          citationsCount: 1,
          staleCitationCount: 0,
        }),
      }),
    );
    expect(exitCodeForAskReplay(report)).toBe(0);
    expect(formatAskReplayHuman(report)).toContain("sqlite-foreign-keys  pass");
  });

  test("compares abstention expectations for no-evidence fixtures", async () => {
    const almanacDir = await buildAskReplayFixture("ask-replay-abstain");
    const report = await runAskReplayFromFixtures({
      almanacDir,
      fixtures: [
        {
          id: "sqlite-no-evidence",
          question: "Who won an unrelated tournament?",
          toolCalls: [
            {
              tool: "query_facts",
              input: { q: "unrelated tournament winner" },
              expectedStatus: "tool-error",
            },
          ],
          expectedStatus: "abstained",
          expectedAbstentionReason: "tool-errors-only",
        },
      ],
    });

    expect(report.passed).toBe(1);
    expect(report.results[0]?.observed).toEqual(
      expect.objectContaining({
        status: "abstained",
        abstentionReason: "tool-errors-only",
      }),
    );
  });

  test("fails quality gates for unsupported claims", async () => {
    const almanacDir = await buildAskReplayFixture("ask-replay-quality");
    const report = await runAskReplayFromFixtures({
      almanacDir,
      fixtures: [
        {
          id: "sqlite-unsupported-claim",
          question: "Does SQLite encrypt every page by default?",
          toolCalls: [
            {
              tool: "query_facts",
              input: { q: "foreign keys" },
              expectedStatus: "ok",
            },
          ],
          expectedStatus: "ok",
          minCitations: 1,
          unsupportedClaims: ["SQLite encrypts every page by default."],
        },
      ],
    });

    expect(report.failed).toBe(1);
    expect(report.quality.status).toBe("fail");
    expect(report.results[0]).toEqual(
      expect.objectContaining({
        status: "fail",
        quality: expect.objectContaining({
          status: "fail",
          unsupportedClaimCount: 1,
        }),
      }),
    );
    expect(exitCodeForAskReplay(report)).toBe(1);
    expect(formatAskReplayHuman(report)).toContain("quality=fail");
  });
});

describe("ask replay saved artifacts", () => {
  test("replays saved answer artifacts selected by label", async () => {
    const almanacDir = await buildAskReplayFixture("ask-replay-saved");
    const saved = await saveAnswerArtifact({
      almanacDir,
      answerId: "answer-2026-01-02T00-00-00-000Z-00000001",
      question: "Are foreign keys supported?",
      status: "ok",
      exitCode: 0,
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:01.000Z",
      label: "rc-answer",
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
      freshness: {
        class: "static",
        maxAge: null,
        staleness: "fresh",
      },
    });

    const report = await runAskReplayFromSavedRuns({
      almanacDir,
      label: "rc-answer",
    });

    expect(report.mode).toBe("saved-runs");
    expect(report.passed).toBe(1);
    expect(report.quality.status).toBe("pass");
    expect(report.results[0]).toEqual(
      expect.objectContaining({
        fixtureId: saved.artifact.answerId,
        source: expect.objectContaining({
          kind: "answer-artifact",
          label: "rc-answer",
        }),
        expected: expect.objectContaining({
          status: "ok",
          minCitations: 1,
        }),
        observed: expect.objectContaining({
          status: "ok",
          citationsCount: 1,
        }),
      }),
    );
  });

  test("replays saved abstentions against the recorded final answer status", async () => {
    const almanacDir = await buildAskReplayFixture("ask-replay-saved-abstain");
    const saved = await saveAnswerArtifact({
      almanacDir,
      answerId: "answer-2026-01-02T00-00-00-000Z-00000002",
      question: "What governance checks should precede rollout?",
      status: "abstained",
      exitCode: 1,
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:01.000Z",
      label: "rc-real-provider",
      abstentionReason: "no-citations",
      toolCalls: [
        {
          toolName: "query_facts",
          input: { q: "foreign keys" },
          status: "ok",
          durationMs: 10,
          citationsCount: 1,
        },
      ],
      citations: [],
      freshness: {
        class: "static",
        maxAge: null,
        staleness: "fresh",
      },
    });

    const report = await runAskReplayFromSavedRuns({
      almanacDir,
      label: "rc-real-provider",
    });

    expect(report.mode).toBe("saved-runs");
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.quality.status).toBe("pass");
    expect(report.results[0]).toEqual(
      expect.objectContaining({
        fixtureId: saved.artifact.answerId,
        status: "pass",
        expected: expect.objectContaining({
          status: "abstained",
          abstentionReason: "no-citations",
        }),
        observed: expect.objectContaining({
          status: "abstained",
          citationsCount: 0,
          abstentionReason: "no-citations",
          toolCalls: [
            expect.objectContaining({
              toolName: "query_facts",
              status: "ok",
              citationsCount: 1,
            }),
          ],
        }),
        quality: expect.objectContaining({
          status: "pass",
        }),
      }),
    );
  });
});

async function buildAskReplayFixture(almanacId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-ask-replay-"));
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

  const built = buildKnowledgeIndex({
    almanacId,
    facts: [fixtureFact()],
    dbPath: join(almanacDir, "knowledge", "almanac.sqlite"),
  });
  built.db.close();
  writeFileSync(
    join(almanacDir, "knowledge", "index-manifest.json"),
    JSON.stringify({ ...built.manifest, vectorIndex: undefined }, null, 2),
    "utf8",
  );

  const toolsDir = join(almanacDir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(
    join(toolsDir, "query_facts.json"),
    JSON.stringify(queryFactsManifest(), null, 2),
    "utf8",
  );
  writeFileSync(
    join(toolsDir, "query_facts.ts"),
    DEFAULT_TOOL_TEMPLATES.query_facts!.implCode,
    "utf8",
  );

  return almanacDir;
}

function queryFactsManifest(): ToolManifest {
  return {
    ...synthesizeDefaultToolManifest("query_facts"),
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
      },
      required: ["q"],
    },
  };
}

function fixtureFact(): FactRecord {
  return {
    id: "01J00000000000000000000001",
    text: "Foreign key constraints can be enabled in SQLite with PRAGMA foreign_keys.",
    type: "fact",
    entities: ["SQLite", "foreign keys"],
    source: {
      sourceId: "sqlite-docs",
      contentHash: "a".repeat(64),
      url: "https://sqlite.org/foreignkeys.html",
      excerpt: "Foreign key constraints are disabled by default.",
    },
    freshnessClass: "static",
    validUntil: null,
    confidence: 0.95,
    extractedAt: "2026-01-01T00:00:00.000Z",
    extractor: { model: "test", promptVersion: "v1" },
  };
}

function fixtureCitation(): Citation {
  return {
    sourceId: "sqlite-docs",
    url: "https://sqlite.org/foreignkeys.html",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    excerpt: "Foreign key constraints are disabled by default.",
  };
}
