import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  formatPruneRunToolArtifactsHuman,
  formatRunToolArtifactHuman,
  formatRunToolArtifactListHuman,
  formatRunToolHuman,
  listRunToolArtifacts,
  pruneRunToolArtifacts,
  readRunToolArtifact,
  runTool,
  saveRunToolArtifact,
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

  test("saves schema-valid audit artifacts for successful and failed executions", async () => {
    const almanacDir = await buildRunToolFixture("run-save");

    const okExecution = await runTool({
      almanacDir,
      toolName: "query_facts",
      input: { q: "foreign" },
    });
    const okSaved = await saveRunToolArtifact({
      almanacDir,
      execution: okExecution,
      label: "release-smoke",
      note: "Validate query_facts before tagging v0.5.",
    });

    expect(okSaved.relPath).toBe(`.runs/${okExecution.runId}.json`);
    expect(existsSync(okSaved.path)).toBe(true);
    const okArtifact = JSON.parse(readFileSync(okSaved.path, "utf8")) as {
      schemaVersion: string;
      artifactRelPath: string;
      runId: string;
      status: string;
      exitCode: number;
      citationsCount: number;
      label?: string;
      note?: string;
    };
    expect(okArtifact.schemaVersion).toBe("0.1.0");
    expect(okArtifact.artifactRelPath).toBe(okSaved.relPath);
    expect(okArtifact.runId).toBe(okExecution.runId);
    expect(okArtifact.status).toBe("ok");
    expect(okArtifact.exitCode).toBe(0);
    expect(okArtifact.citationsCount).toBe(1);
    expect(okArtifact.label).toBe("release-smoke");
    expect(okArtifact.note).toBe("Validate query_facts before tagging v0.5.");

    const missingExecution = await runTool({
      almanacDir,
      toolName: "missing_tool",
      input: {},
    });
    const missingSaved = await saveRunToolArtifact({
      almanacDir,
      execution: missingExecution,
    });
    const missingArtifact = JSON.parse(
      readFileSync(missingSaved.path, "utf8"),
    ) as {
      status: string;
      exitCode: number;
      availableTools: string[];
    };
    expect(missingArtifact.status).toBe("tool-not-found");
    expect(missingArtifact.exitCode).toBe(2);
    expect(missingArtifact.availableTools).toEqual(["query_facts"]);

    const artifactList = await listRunToolArtifacts({ almanacDir });
    expect(artifactList.almanacId).toBe("run-save");
    expect(artifactList.runs.map((run) => run.runId).sort()).toEqual(
      [missingExecution.runId, okExecution.runId].sort(),
    );
    expect(formatRunToolArtifactListHuman(artifactList)).toContain(
      missingExecution.runId,
    );
    expect(
      artifactList.runs.find((run) => run.runId === okExecution.runId)?.label,
    ).toBe("release-smoke");
    expect(formatRunToolArtifactListHuman(artifactList)).toContain(
      "label=release-smoke",
    );

    const okStatusList = await listRunToolArtifacts({
      almanacDir,
      status: "ok",
    });
    expect(okStatusList.runs.map((run) => run.runId)).toEqual([
      okExecution.runId,
    ]);

    const labelList = await listRunToolArtifacts({
      almanacDir,
      label: "release-smoke",
    });
    expect(labelList.runs.map((run) => run.runId)).toEqual([
      okExecution.runId,
    ]);

    const noMatchList = await listRunToolArtifacts({
      almanacDir,
      status: "tool-not-found",
      label: "release-smoke",
    });
    expect(noMatchList.runs).toEqual([]);

    const limitedList = await listRunToolArtifacts({ almanacDir, limit: 1 });
    expect(limitedList.runs).toHaveLength(1);

    const readBack = await readRunToolArtifact({
      almanacDir,
      runId: okExecution.runId,
    });
    expect(readBack.relPath).toBe(okSaved.relPath);
    expect(readBack.artifact.runId).toBe(okExecution.runId);
    expect(readBack.artifact.result.ok).toBe(true);
    const formattedArtifact = formatRunToolArtifactHuman(readBack.artifact);
    expect(formattedArtifact).toContain("label: release-smoke");
    expect(formattedArtifact).toContain("note:");
    expect(formattedArtifact).toContain("data:");
  });

  test("prunes saved artifacts only when apply is enabled", async () => {
    const almanacDir = await buildRunToolFixture("run-prune");
    const execution = await runTool({
      almanacDir,
      toolName: "query_facts",
      input: { q: "foreign" },
    });
    const newest = await saveRunToolArtifact({
      almanacDir,
      execution: {
        ...execution,
        runId: "run-2026-01-03T00-00-00-000Z-00000003",
        invokedAt: "2026-01-03T00:00:00.000Z",
      },
    });
    const middle = await saveRunToolArtifact({
      almanacDir,
      execution: {
        ...execution,
        runId: "run-2026-01-02T00-00-00-000Z-00000002",
        invokedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const oldest = await saveRunToolArtifact({
      almanacDir,
      execution: {
        ...execution,
        runId: "run-2026-01-01T00-00-00-000Z-00000001",
        invokedAt: "2026-01-01T00:00:00.000Z",
      },
      label: "debug",
    });

    const dryRun = await pruneRunToolArtifacts({
      almanacDir,
      keepLatest: 1,
      apply: false,
    });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.deletedCount).toBe(0);
    expect(dryRun.runs.map((run) => run.runId)).toEqual([
      middle.artifact.runId,
      oldest.artifact.runId,
    ]);
    expect(formatPruneRunToolArtifactsHuman(dryRun)).toContain(
      "dry-run: no files deleted",
    );
    expect(existsSync(newest.path)).toBe(true);
    expect(existsSync(middle.path)).toBe(true);
    expect(existsSync(oldest.path)).toBe(true);

    const applied = await pruneRunToolArtifacts({
      almanacDir,
      keepLatest: 1,
      apply: true,
    });
    expect(applied.applied).toBe(true);
    expect(applied.deletedCount).toBe(2);
    expect(existsSync(newest.path)).toBe(true);
    expect(existsSync(middle.path)).toBe(false);
    expect(existsSync(oldest.path)).toBe(false);
    expect((await listRunToolArtifacts({ almanacDir })).runs).toHaveLength(1);
  });

  test("prunes artifacts by age after label and status filters", async () => {
    const almanacDir = await buildRunToolFixture("run-prune-filtered");
    const okExecution = await runTool({
      almanacDir,
      toolName: "query_facts",
      input: { q: "foreign" },
    });
    const missingExecution = await runTool({
      almanacDir,
      toolName: "missing_tool",
      input: {},
    });
    const oldOk = await saveRunToolArtifact({
      almanacDir,
      execution: {
        ...okExecution,
        runId: "run-2026-01-01T00-00-00-000Z-00000001",
        invokedAt: "2026-01-01T00:00:00.000Z",
      },
      label: "debug",
    });
    const recentOk = await saveRunToolArtifact({
      almanacDir,
      execution: {
        ...okExecution,
        runId: "run-2026-01-10T00-00-00-000Z-00000010",
        invokedAt: "2026-01-10T00:00:00.000Z",
      },
      label: "debug",
    });
    const oldToolNotFound = await saveRunToolArtifact({
      almanacDir,
      execution: {
        ...missingExecution,
        runId: "run-2026-01-01T00-00-00-000Z-00000002",
        invokedAt: "2026-01-01T00:00:00.000Z",
      },
      label: "debug",
    });

    const applied = await pruneRunToolArtifacts({
      almanacDir,
      label: "debug",
      status: "ok",
      olderThanMs: 24 * 60 * 60 * 1000,
      now: new Date("2026-01-11T00:00:00.000Z"),
      apply: true,
    });

    expect(applied.runs.map((run) => run.runId)).toEqual([
      oldOk.artifact.runId,
    ]);
    expect(applied.criteria.cutoffInvokedBefore).toBe(
      "2026-01-10T00:00:00.000Z",
    );
    expect(existsSync(oldOk.path)).toBe(false);
    expect(existsSync(recentOk.path)).toBe(true);
    expect(existsSync(oldToolNotFound.path)).toBe(true);
  });

  test("returns an empty artifact list when no runs were saved", async () => {
    const almanacDir = await buildRunToolFixture("run-empty-list");

    const artifactList = await listRunToolArtifacts({ almanacDir });

    expect(artifactList.almanacId).toBe("run-empty-list");
    expect(artifactList.runs).toEqual([]);
    expect(formatRunToolArtifactListHuman(artifactList)).toContain("(none)");
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
