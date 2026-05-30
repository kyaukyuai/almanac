import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
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
} from "../core/types.ts";

import {
  RunToolSetupError,
  exitCodeForRunTool,
  formatRunToolHuman,
  runTool,
} from "./run-tool.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runTool", () => {
  test("invokes a compiled query_facts tool and returns citations", async () => {
    const almanacDir = await buildRunToolFixture("run-ok");

    const execution = await runTool({
      almanacDir,
      toolName: "query_facts",
      input: { q: "foreign" },
    });

    expect(execution.almanacId).toBe("run-ok");
    expect(execution.version).toBe("0.1.0");
    expect(execution.toolName).toBe("query_facts");
    expect(execution.status).toBe("ok");
    expect(exitCodeForRunTool(execution)).toBe(0);
    expect(execution.citationsCount).toBe(1);
    expect(execution.result.ok).toBe(true);
    if (execution.result.ok) {
      const hits = (execution.result.data as { hits: Array<{ text: string }> })
        .hits;
      expect(hits[0]?.text).toContain("Foreign key constraints");
      expect(execution.result.citations[0]?.sourceId).toBe("sqlite-docs");
      expect(execution.result.freshness.class).toBe("static");
    }
  });

  test("normalizes missing tools into a stable result", async () => {
    const almanacDir = await buildRunToolFixture("run-missing");

    const execution = await runTool({
      almanacDir,
      toolName: "missing_tool",
      input: {},
    });

    expect(execution.status).toBe("tool-not-found");
    expect(exitCodeForRunTool(execution)).toBe(2);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error.code).toBe("tool-not-found");
      expect(execution.result.error.message).toContain("missing_tool");
    }
    expect(execution.availableTools).toEqual(["query_facts"]);
  });

  test("normalizes non-object input before invoking runtime", async () => {
    const almanacDir = await buildRunToolFixture("run-bad-input");

    const execution = await runTool({
      almanacDir,
      toolName: "query_facts",
      input: "not-json-object",
    });

    expect(execution.status).toBe("bad-input");
    expect(execution.input).toBeNull();
    expect(exitCodeForRunTool(execution)).toBe(2);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error.code).toBe("bad-input");
      expect(execution.result.error.message).toContain("JSON object");
    }
  });

  test("preserves tool-level ok:false envelopes and formats human output", async () => {
    const almanacDir = await buildRunToolFixture("run-tool-error");

    const execution = await runTool({
      almanacDir,
      toolName: "query_facts",
      input: { q: "souffle" },
    });

    expect(execution.status).toBe("tool-error");
    expect(exitCodeForRunTool(execution)).toBe(1);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error.code).toBe("no-results");
    }
    const formatted = formatRunToolHuman(execution);
    expect(formatted).toContain("tool: query_facts");
    expect(formatted).toContain("status: tool-error");
    expect(formatted).toContain("error: no-results");
  });

  test("rejects relative almanac dirs with a setup error", async () => {
    await expect(
      runTool({
        almanacDir: "relative/path",
        toolName: "query_facts",
        input: {},
      }),
    ).rejects.toMatchObject({
      name: "RunToolSetupError",
      code: "bad-almanac-dir",
    } satisfies Partial<RunToolSetupError>);
  });
});

async function buildRunToolFixture(almanacId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "almanac-run-tool-"));
  cleanup.push(root);
  const almanacDir = join(root, almanacId);
  await ensureAlmanacLayout(almanacDir);

  const boot = bootstrapAlmanac({
    almanacId,
    domain: almanacId,
    displayName: almanacId,
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.5.0-test",
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

  const fact = fixtureFact();
  const built = buildKnowledgeIndex({
    almanacId,
    facts: [fact],
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
    JSON.stringify(synthesizeDefaultToolManifest("query_facts"), null, 2),
    "utf8",
  );
  writeFileSync(
    join(toolsDir, "query_facts.ts"),
    DEFAULT_TOOL_TEMPLATES.query_facts!.implCode,
    "utf8",
  );

  return almanacDir;
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
