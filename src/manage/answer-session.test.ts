import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AlmanacRuntime } from "../core/runtime.ts";
import {
  bootstrapAlmanac,
} from "../compile/stages/s00-bootstrap.ts";
import {
  DEFAULT_TOOL_TEMPLATES,
} from "../compile/stages/s07/templates.ts";
import {
  synthesizeDefaultToolManifest,
} from "../compile/stages/s07/template-implementer.ts";
import {
  buildKnowledgeIndex,
} from "../compile/stages/s08-knowledge-index.ts";
import {
  ensureAlmanacLayout,
  writeManifest,
} from "../compile/storage.ts";
import {
  AlmanacManifestSchema,
  type FactRecord,
  type ToolManifest,
  type ToolResult,
} from "../core/types.ts";
import { createMockProvider } from "../llm/mock.ts";

import {
  ANSWER_PLANNER_PROMPT_STAGE_ID,
  ANSWER_PLANNER_PROMPT_VERSION,
  runAnswerToolPlanningSession,
} from "./answer-session.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runAnswerToolPlanningSession", () => {
  test("plans and executes compiled tools through AlmanacRuntime.execTool", async () => {
    const almanacDir = await buildAnswerSessionFixture("answer-plan-ok", true);
    let calls = 0;
    const provider = createMockProvider({
      defaultResponse: () => {
        calls += 1;
        return JSON.stringify(
          calls === 1
            ? {
                action: "call_tool",
                toolName: "query_facts",
                input: { q: "foreign" },
              }
            : { action: "stop", reason: "enough-evidence" },
        );
      },
    });

    const session = await runAnswerToolPlanningSession({
      almanacDir,
      question: "How do SQLite foreign keys work?",
      provider,
    });

    expect(session.status).toBe("ok");
    expect(session.stopReason).toBe("planner-stop");
    expect(session.plannerCalls).toBe(2);
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toEqual(
      expect.objectContaining({
        toolName: "query_facts",
        status: "ok",
        citationsCount: 1,
      }),
    );
    expect(session.toolCalls[0]?.result?.ok).toBe(true);
    expect(provider.callLog[0]?.request.callName).toBe(
      `${ANSWER_PLANNER_PROMPT_STAGE_ID}@${ANSWER_PLANNER_PROMPT_VERSION}`,
    );
    expect(provider.callLog[0]?.request.messages[1]?.content).toContain(
      "query_facts",
    );
  });

  test("does not execute unknown or disabled planner-selected tools", async () => {
    const almanacDir = await buildAnswerSessionFixture("answer-plan-unknown");
    let responses = 0;
    let execCount = 0;
    const runtime = fakeRuntime({
      tools: [queryFactsManifest()],
      execTool: async () => {
        execCount += 1;
        throw new Error("execTool should not be called");
      },
    });
    const provider = createMockProvider({
      defaultResponse: () => {
        responses += 1;
        return JSON.stringify(
          responses === 1
            ? {
                action: "call_tool",
                toolName: "disabled_tool",
                input: {},
              }
            : { action: "stop", reason: "no-tool" },
        );
      },
    });

    const session = await runAnswerToolPlanningSession({
      almanacDir,
      question: "Use the disabled tool",
      provider,
      runtime,
    });

    expect(session.status).toBe("ok");
    expect(execCount).toBe(0);
    expect(session.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "disabled_tool",
        status: "tool-not-found",
        citationsCount: 0,
      }),
    ]);
    expect(session.toolCalls[0]?.error?.code).toBe("tool-not-found");
  });

  test("turns invalid planner tool input into bad-tool-input without execution", async () => {
    const almanacDir = await buildAnswerSessionFixture("answer-plan-bad-input");
    let responses = 0;
    let execCount = 0;
    const runtime = fakeRuntime({
      tools: [queryFactsManifest()],
      execTool: async () => {
        execCount += 1;
        throw new Error("execTool should not be called");
      },
    });
    const provider = createMockProvider({
      defaultResponse: () => {
        responses += 1;
        return JSON.stringify(
          responses === 1
            ? {
                action: "call_tool",
                toolName: "query_facts",
                input: { q: 42 },
              }
            : { action: "stop", reason: "bad-input-observed" },
        );
      },
    });

    const session = await runAnswerToolPlanningSession({
      almanacDir,
      question: "Bad input",
      provider,
      runtime,
    });

    expect(session.status).toBe("ok");
    expect(execCount).toBe(0);
    expect(session.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "query_facts",
        status: "bad-tool-input",
        citationsCount: 0,
      }),
    ]);
    expect(session.toolCalls[0]?.error?.message).toContain("input.q");
  });

  test("enforces max tool call budget", async () => {
    const almanacDir = await buildAnswerSessionFixture("answer-plan-max-calls");
    let execCount = 0;
    const runtime = fakeRuntime({
      tools: [queryFactsManifest()],
      execTool: async () => {
        execCount += 1;
        return okToolResult();
      },
    });
    const provider = createMockProvider({
      defaultResponse: JSON.stringify({
        action: "call_tool",
        toolName: "query_facts",
        input: { q: "transactions" },
      }),
    });

    const session = await runAnswerToolPlanningSession({
      almanacDir,
      question: "Keep calling tools",
      provider,
      runtime,
      maxToolCalls: 2,
    });

    expect(session.status).toBe("budget-exhausted");
    expect(session.stopReason).toBe("max-tool-calls");
    expect(session.plannerCalls).toBe(2);
    expect(execCount).toBe(2);
    expect(session.toolCalls).toHaveLength(2);
  });

  test("enforces max duration budget before executing a planned call", async () => {
    const almanacDir = await buildAnswerSessionFixture("answer-plan-duration");
    let time = 0;
    let execCount = 0;
    const runtime = fakeRuntime({
      tools: [queryFactsManifest()],
      execTool: async () => {
        execCount += 1;
        return okToolResult();
      },
    });
    const provider = createMockProvider({
      defaultResponse: () => {
        time = 10;
        return JSON.stringify({
          action: "call_tool",
          toolName: "query_facts",
          input: { q: "transactions" },
        });
      },
    });

    const session = await runAnswerToolPlanningSession({
      almanacDir,
      question: "Time out before execution",
      provider,
      runtime,
      maxDurationMs: 5,
      now: () => time,
    });

    expect(session.status).toBe("budget-exhausted");
    expect(session.stopReason).toBe("max-duration");
    expect(session.plannerCalls).toBe(1);
    expect(execCount).toBe(0);
    expect(session.toolCalls).toEqual([]);
  });

  test("model planner parse failures become stable model-error sessions", async () => {
    const almanacDir = await buildAnswerSessionFixture("answer-plan-model-error");
    const provider = createMockProvider({
      defaultResponse: "not-json",
    });

    const session = await runAnswerToolPlanningSession({
      almanacDir,
      question: "Malformed planner response",
      provider,
      runtime: fakeRuntime({ tools: [queryFactsManifest()] }),
    });

    expect(session.status).toBe("model-error");
    expect(session.stopReason).toBe("model-error");
    expect(session.error?.code).toBe("model-error");
    expect(session.toolCalls).toEqual([]);
  });
});

async function buildAnswerSessionFixture(
  almanacId: string,
  withCompiledTool = false,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-answer-session-"));
  cleanup.push(root);
  const almanacDir = join(root, almanacId);
  await ensureAlmanacLayout(almanacDir);

  const boot = bootstrapAlmanac({
    almanacId,
    domain: "SQLite",
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
      toolCount: withCompiledTool ? 1 : 0,
      factCount: withCompiledTool ? 1 : 0,
    }),
  );

  if (withCompiledTool) {
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
  }

  return almanacDir;
}

function fakeRuntime(options: {
  tools: ToolManifest[];
  execTool?: (name: string, input: unknown) => Promise<ToolResult>;
}): AlmanacRuntime {
  return {
    async listTools() {
      return options.tools;
    },
    async execTool(name: string, input: unknown) {
      if (options.execTool === undefined) {
        throw new Error(`unexpected execTool call: ${name}`);
      }
      return options.execTool(name, input);
    },
    async listResources() {
      return [];
    },
    async readResource(uri: string) {
      throw new Error(`resource not found: ${uri}`);
    },
  };
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

function okToolResult(): ToolResult {
  return {
    ok: true,
    data: { hits: [{ text: "Transactions are atomic." }] },
    citations: [
      {
        sourceId: "sqlite-docs",
        url: "https://sqlite.org/lang_transaction.html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        excerpt: "Transactions are atomic.",
      },
    ],
    freshness: {
      class: "static",
      maxAge: null,
      staleness: "fresh",
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
