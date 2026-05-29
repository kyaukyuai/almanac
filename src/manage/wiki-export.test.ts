import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCompileState, type AlmanacManifest } from "../core/types.ts";
import {
  ensureAlmanacLayout,
  writeCompileState,
  writeManifest,
} from "../compile/storage.ts";

import { defaultWikiExportDir, runWikiExport } from "./wiki-export.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("defaultWikiExportDir", () => {
  test("produces almanac-<id>-<version>-wiki under cwd", () => {
    expect(
      defaultWikiExportDir({
        almanacId: "sqlite",
        version: "0.4.0",
        cwd: "/tmp/out",
      }),
    ).toBe("/tmp/out/almanac-sqlite-0.4.0-wiki");
  });
});

describe("runWikiExport", () => {
  test("writes a Markdown inspection bundle and artifacts manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-wiki-"));
    cleanup.push(root);
    const almanacDir = join(root, "tinytool");
    await ensureAlmanacLayout(almanacDir);
    await mkdir(join(almanacDir, "extracted"), { recursive: true });

    const now = "2026-05-29T00:00:00.000Z";
    const manifest: AlmanacManifest = {
      schemaVersion: "0.1.0",
      almanacId: "tinytool",
      version: "0.4.0",
      domain: "Tiny tool",
      displayName: "Tiny Tool",
      freshnessProfileId: "mixed",
      toolCount: 0,
      factCount: 1,
      bootstrappedAt: now,
      compiledAt: now,
      forgerVersion: "0.4.0-test",
    };
    await writeManifest(almanacDir, manifest);
    await writeCompileState(
      almanacDir,
      initCompileState({
        almanacId: "tinytool",
        domain: "Tiny tool",
        runId: "run-test",
        forgerVersion: "0.4.0-test",
        options: {
          depth: "quick",
          sourcesHint: [],
          target: "both",
          autoApprove: true,
          language: "ts",
        },
        now: new Date(now),
      }),
    );

    writeFileSync(
      join(almanacDir, "sources", "sources.json"),
      JSON.stringify(
        {
          schemaVersion: "0.1.0",
          status: "approved",
          generatedAt: now,
          approvedAt: now,
          approvedBy: "auto",
          generatedBy: {
            stage: "02-source-discovery",
            evaluatorPromptVersion: "test",
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
              id: "tiny-docs",
              url: "https://example.com/docs",
              kind: "docs",
              trust: 0.95,
              volatility: "slow",
              rationale: "Primary tiny docs.",
              ingestion: {
                mode: "snapshot",
                scope: ["docs"],
                refreshIntervalHours: 168,
              },
              notes: null,
            },
          ],
          rejected: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    writeFileSync(
      join(almanacDir, "extracted", "facts.jsonl"),
      JSON.stringify({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        text: "Tiny Tool facts can be exported into a Markdown wiki bundle.",
        type: "fact",
        entities: ["Tiny Tool"],
        source: {
          sourceId: "tiny-docs",
          contentHash:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          url: "https://example.com/docs",
          excerpt: "Tiny Tool facts can be exported.",
        },
        freshnessClass: "slow",
        validUntil: "2026-06-05T00:00:00.000Z",
        confidence: 0.9,
        extractedAt: now,
        extractor: { model: "test", promptVersion: "v1" },
      }) + "\n",
      "utf8",
    );

    const outputDir = join(root, "wiki");
    const result = await runWikiExport({ almanacDir, outputDir });

    expect(result.files.map((file) => file.name)).toEqual([
      "README.md",
      "sources.md",
      "facts.md",
      "tools.md",
      "benchmark.md",
      "artifacts.json",
    ]);
    expect(existsSync(join(outputDir, "README.md"))).toBe(true);
    expect(readFileSync(join(outputDir, "README.md"), "utf8")).toContain(
      "# Tiny Tool",
    );
    expect(readFileSync(join(outputDir, "sources.md"), "utf8")).toContain(
      "tiny-docs",
    );
    expect(readFileSync(join(outputDir, "facts.md"), "utf8")).toContain(
      "Markdown wiki bundle",
    );
    const artifacts = JSON.parse(
      readFileSync(join(outputDir, "artifacts.json"), "utf8"),
    ) as { almanacId: string; files: Array<{ name: string }> };
    expect(artifacts.almanacId).toBe("tinytool");
    expect(artifacts.files.map((file) => file.name)).toContain("README.md");
  });

  test("rejects relative paths", async () => {
    await expect(
      runWikiExport({ almanacDir: "relative", outputDir: "/tmp/wiki" }),
    ).rejects.toThrow(/almanacDir must be absolute/);
    await expect(
      runWikiExport({ almanacDir: "/tmp/missing", outputDir: "relative" }),
    ).rejects.toThrow(/outputDir must be absolute/);
  });
});
