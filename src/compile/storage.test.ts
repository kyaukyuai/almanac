/**
 * Tests for `storage.ts` — filesystem layer for almanac directories.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  defaultAlmanacRoot,
  almanacDirPath,
  ensureAlmanacLayout,
  knowledgeIndexManifestPath,
  listAlmanacs,
  manifestPath,
  readCompileState,
  readImplementedToolCount,
  readKnowledgeIndexManifest,
  readManifest,
  writeCompileState,
  writeManifest,
} from "./storage.ts";
import { bootstrapAlmanac } from "./stages/s00-bootstrap.ts";
import type { CompileOptions } from "../core/types.ts";

const baseOpts: CompileOptions = {
  depth: "standard",
  sourcesHint: [],
  target: "both",
  autoApprove: true,
  language: "ts",
};

function bootstrap(slug: string, displayName: string) {
  return bootstrapAlmanac({
    almanacId: slug,
    domain: slug,
    displayName,
    freshnessProfileId: "mixed",
    runId: `run-${slug}`,
    forgerVersion: "0.0.0",
    options: baseOpts,
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
}

let workDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  originalEnv = process.env.ALMANAC_ROOT;
  workDir = await mkdtemp(join(tmpdir(), "almanac-storage-test-"));
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env.ALMANAC_ROOT;
  } else {
    process.env.ALMANAC_ROOT = originalEnv;
  }
  await rm(workDir, { recursive: true, force: true });
});

describe("defaultAlmanacRoot", () => {
  test("honors $ALMANAC_ROOT when set", () => {
    process.env.ALMANAC_ROOT = "/tmp/explicit-root";
    expect(defaultAlmanacRoot()).toBe("/tmp/explicit-root");
  });

  test("falls back to ~/.almanac/almanacs when env is unset", () => {
    delete process.env.ALMANAC_ROOT;
    const root = defaultAlmanacRoot();
    expect(root.endsWith("/.almanac/almanacs")).toBe(true);
  });
});

describe("ensureAlmanacLayout", () => {
  test("creates the root and every canonical subdirectory", async () => {
    const dir = almanacDirPath(workDir, "kubernetes");
    await ensureAlmanacLayout(dir);
    for (const sub of [
      "sources",
      "sources/raw",
      "extracted",
      "knowledge",
      "tools",
      "adapters",
      "adapters/skill",
      "tests",
      ".compile",
    ]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  test("is idempotent", async () => {
    const dir = almanacDirPath(workDir, "x");
    await ensureAlmanacLayout(dir);
    await ensureAlmanacLayout(dir); // must not throw
  });
});

describe("write/readManifest", () => {
  test("round-trips a validated manifest", async () => {
    const { manifest } = bootstrap("cooking", "Cooking");
    const dir = almanacDirPath(workDir, "cooking");
    await ensureAlmanacLayout(dir);
    await writeManifest(dir, manifest);
    const reread = await readManifest(dir);
    expect(reread).toEqual(manifest);
  });

  test("readManifest throws on missing file", async () => {
    const dir = almanacDirPath(workDir, "nope");
    await expect(readManifest(dir)).rejects.toThrow();
  });

  test("readManifest throws on schema violation", async () => {
    const dir = almanacDirPath(workDir, "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ schemaVersion: "0.1.0", almanacId: "Has Capitals" }),
      "utf8",
    );
    await expect(readManifest(dir)).rejects.toThrow();
  });
});

describe("write/readCompileState", () => {
  test("round-trips a fresh compile state", async () => {
    const { compileState } = bootstrap("kubernetes", "Kubernetes");
    const dir = almanacDirPath(workDir, "kubernetes");
    await ensureAlmanacLayout(dir);
    await writeCompileState(dir, compileState);
    const reread = await readCompileState(dir);
    expect(reread).toEqual(compileState);
  });
});

describe("listAlmanacs", () => {
  test("returns [] when the root does not exist", async () => {
    const out = await listAlmanacs(join(workDir, "missing"));
    expect(out).toEqual([]);
  });

  test("enumerates valid almanac directories sorted by id", async () => {
    for (const slug of ["zebra", "apple", "mango"]) {
      const { manifest } = bootstrap(slug, slug);
      const dir = almanacDirPath(workDir, slug);
      await ensureAlmanacLayout(dir);
      await writeManifest(dir, manifest);
    }
    const out = await listAlmanacs(workDir);
    expect(out.map((it) => it.almanacId)).toEqual(["apple", "mango", "zebra"]);
  });

  test("silently skips directories without manifest.json", async () => {
    await mkdir(join(workDir, "stray"), { recursive: true });
    const { manifest } = bootstrap("kept", "Kept");
    const dir = almanacDirPath(workDir, "kept");
    await ensureAlmanacLayout(dir);
    await writeManifest(dir, manifest);
    const out = await listAlmanacs(workDir);
    expect(out.map((it) => it.almanacId)).toEqual(["kept"]);
  });

  test("skips directories whose manifest fails validation", async () => {
    const dir = almanacDirPath(workDir, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ schemaVersion: "0.1.0" }), // missing required fields
      "utf8",
    );
    const out = await listAlmanacs(workDir);
    expect(out).toEqual([]);
  });
});

describe("path helpers", () => {
  test("knowledgeIndexManifestPath joins under knowledge/", () => {
    const dir = almanacDirPath(workDir, "k8s");
    expect(knowledgeIndexManifestPath(dir)).toBe(
      join(dir, "knowledge", "index-manifest.json"),
    );
  });
});

describe("readKnowledgeIndexManifest", () => {
  test("fills v0.2/v0.3 legacy byType counters added later", async () => {
    const dir = almanacDirPath(workDir, "legacy");
    await ensureAlmanacLayout(dir);
    await writeFile(
      knowledgeIndexManifestPath(dir),
      JSON.stringify(
        {
          schemaVersion: "0.1.0",
          almanacId: "legacy",
          dbRelPath: "knowledge/almanac.sqlite",
          factCount: 2,
          counts: {
            byClass: { static: 1, slow: 1 },
            byType: {
              fact: 1,
              definition: 1,
              procedure: 0,
              opinion: 0,
              reference: 0,
            },
          },
          builtAt: "2026-05-08T12:00:00.000Z",
          sqliteVersion: "3.51.0",
          factCorpusHash: "a".repeat(64),
        },
        null,
        2,
      ),
      "utf8",
    );

    const manifest = await readKnowledgeIndexManifest(dir);
    expect(manifest?.counts.byType).toEqual({
      fact: 1,
      definition: 1,
      procedure: 0,
      opinion: 0,
      reference: 0,
      principle: 0,
      heuristic: 0,
      tradeoff: 0,
      framework: 0,
    });
  });
});

describe("readImplementedToolCount", () => {
  test("counts enabled tool manifest/impl pairs and ignores tests/disabled/incomplete", async () => {
    const dir = almanacDirPath(workDir, "tools");
    await ensureAlmanacLayout(dir);
    const toolsDir = join(dir, "tools");
    await writeFile(
      join(toolsDir, "query_facts.json"),
      JSON.stringify({ disabled: false }),
      "utf8",
    );
    await writeFile(join(toolsDir, "query_facts.ts"), "export default {}", "utf8");
    await writeFile(
      join(toolsDir, "disabled_tool.json"),
      JSON.stringify({ disabled: true }),
      "utf8",
    );
    await writeFile(join(toolsDir, "disabled_tool.ts"), "export default {}", "utf8");
    await writeFile(
      join(toolsDir, "manifest_only.json"),
      JSON.stringify({ disabled: false }),
      "utf8",
    );
    await writeFile(join(toolsDir, "impl_only.ts"), "export default {}", "utf8");
    await writeFile(join(toolsDir, "query_facts.test.ts"), "test()", "utf8");

    await expect(readImplementedToolCount(dir)).resolves.toBe(1);
  });
});
