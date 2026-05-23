/**
 * End-to-end tests for the four default tools:
 *
 *   - `synthesizeDefaultToolManifest` produces schema-valid manifests
 *   - `TemplateImplementer` writes both `<name>.ts` and `<name>.test.ts`
 *     to disk and returns a single-attempt success `ToolImplementationResult`
 *   - The four template smoke tests, when run via `bun test`, all pass
 *   - The runtime can `loadTool` and `execTool` each generated default
 *     tool against a fixture knowledge index / mocked context
 */

import {
  afterAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_TOOL_NAMES,
  type DefaultToolName,
  type FactRecord,
  type ToolImplementationResult,
  type ToolManifest,
} from "../../../core/types.ts";
import {
  synthesizeAllDefaultManifests,
  synthesizeDefaultToolManifest,
  TemplateImplementer,
} from "./template-implementer.ts";
import {
  writeFinalManifest,
  writeToolFiles,
} from "./file-writer.ts";
import { DEFAULT_TOOL_TEMPLATES } from "./templates.ts";
import type { ImplementationContext } from "../s07-tool-impl.ts";
import { buildKnowledgeIndex } from "../s08-knowledge-index.ts";
import { createAlmanacRuntimeAsync } from "../../../serve/runtime.ts";
import { bootstrapAlmanac } from "../s00-bootstrap.ts";
import {
  AlmanacManifestSchema,
  type AlmanacManifest,
} from "../../../core/types.ts";
import { ensureAlmanacLayout, writeManifest } from "../../storage.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────────────

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_ROOTS.push(dir);
  return dir;
}

function makeCtx(almanacDir: string): ImplementationContext {
  return {
    almanacDir,
    llm: {
      model: "n/a",
      promptVersion: "n/a",
      generate: async () => ({ code: "", testCode: "" }),
    },
    tsc: { check: async () => ({ ok: true }) },
    smoke: { test: async () => ({ ok: true }) },
    writeToolFiles: async ({ toolName, code, testCode }) =>
      writeToolFiles({ almanacDir, toolName, code, testCode }),
    now: () => new Date("2026-05-09T12:00:00.000Z"),
    log: () => undefined,
  };
}

async function buildAlmanacDirWithTools(
  almanacId: string,
  manifests: ToolManifest[],
  results: ToolImplementationResult[],
  facts: FactRecord[] = [],
): Promise<string> {
  const root = makeTmpDir("almanac-template-");
  const dir = join(root, almanacId);
  const { manifest: bs } = bootstrapAlmanac({
    almanacId,
    domain: almanacId,
    displayName: almanacId,
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.0.0-test",
    options: {
      depth: "standard",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
  });
  await ensureAlmanacLayout(dir);
  const persisted: AlmanacManifest = AlmanacManifestSchema.parse({
    ...bs,
    toolCount: manifests.length,
    factCount: facts.length,
  });
  await writeManifest(dir, persisted);

  // Write final manifests + impl/test files via the implementer.
  const ctx = makeCtx(dir);
  const impl = new TemplateImplementer();
  for (const m of manifests) {
    const r = await impl.implement(m, ctx);
    results.push(r);
    await writeFinalManifest({ almanacDir: dir, manifest: r.finalManifest });
  }

  if (facts.length > 0) {
    const dbPath = join(dir, "knowledge", "almanac.sqlite");
    const built = buildKnowledgeIndex({ almanacId, facts, dbPath });
    built.db.close();
    writeFileSync(
      join(dir, "knowledge", "index-manifest.json"),
      JSON.stringify(built.manifest, null, 2),
      "utf8",
    );
  }
  return dir;
}

// ──────────────────────────────────────────────────────────────────────────────
// synthesizeDefaultToolManifest
// ──────────────────────────────────────────────────────────────────────────────

describe("synthesizeDefaultToolManifest", () => {
  test("produces a schema-valid manifest for every default tool name", () => {
    for (const name of DEFAULT_TOOL_NAMES) {
      const m = synthesizeDefaultToolManifest(name);
      expect(m.name).toBe(name);
      expect(m.disabled).toBe(false);
      expect(m.implementedBy).toBeUndefined();
      expect(m.designedBy.model).toBe("template");
    }
  });

  test("query_facts uses knowledgeUsage.facts=true and no network", () => {
    const m = synthesizeDefaultToolManifest("query_facts");
    expect(m.knowledgeUsage.facts).toBe(true);
    expect(m.capabilities.network).toEqual([]);
    expect(m.volatilityClass).toBe("slow");
  });

  test("latest_releases declares api.github.com + GITHUB_TOKEN", () => {
    const m = synthesizeDefaultToolManifest("latest_releases");
    expect(m.capabilities.network).toEqual(["api.github.com"]);
    expect(m.capabilities.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(m.volatilityClass).toBe("fast");
  });

  test("supports overriding the network allowlist", () => {
    const m = synthesizeDefaultToolManifest("fetch_official_docs", {
      networkAllowlist: ["docs.example.com", "api.example.com"],
    });
    expect(m.capabilities.network).toEqual([
      "docs.example.com",
      "api.example.com",
    ]);
  });

  test("synthesizeAllDefaultManifests returns all four in canonical order", () => {
    const all = synthesizeAllDefaultManifests();
    expect(all.map((m) => m.name)).toEqual([...DEFAULT_TOOL_NAMES]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// TemplateImplementer.implement — file emission
// ──────────────────────────────────────────────────────────────────────────────

describe("TemplateImplementer.implement", () => {
  test("writes <name>.ts + <name>.test.ts and returns implemented result", async () => {
    const root = makeTmpDir("template-impl-");
    const ctx = makeCtx(root);
    const impl = new TemplateImplementer();
    const m = synthesizeDefaultToolManifest("query_facts");
    const r = await impl.implement(m, ctx);

    expect(r.toolName).toBe("query_facts");
    expect(r.status).toBe("implemented");
    expect(r.attempts.length).toBe(1);
    expect(r.attempts[0]!.outcome).toBe("success");
    expect(r.finalManifest.implementedBy).toBeDefined();
    expect(r.finalManifest.implementedBy?.model).toBe("template");

    // Files exist on disk with the canonical template content.
    const implPath = join(root, "tools", "query_facts.ts");
    const testPath = join(root, "tools", "query_facts.test.ts");
    expect(readFileSync(implPath, "utf8")).toBe(
      DEFAULT_TOOL_TEMPLATES.query_facts!.implCode,
    );
    expect(readFileSync(testPath, "utf8")).toBe(
      DEFAULT_TOOL_TEMPLATES.query_facts!.testCode,
    );
  });

  test("writes all four default tools without error", async () => {
    const root = makeTmpDir("template-impl-all-");
    const ctx = makeCtx(root);
    const impl = new TemplateImplementer();
    for (const name of DEFAULT_TOOL_NAMES) {
      const r = await impl.implement(synthesizeDefaultToolManifest(name), ctx);
      expect(r.status).toBe("implemented");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// `bun test` against the generated smoke tests
// ──────────────────────────────────────────────────────────────────────────────

describe("default tool smoke tests", () => {
  test("all four generated <name>.test.ts files pass `bun test`", async () => {
    const root = makeTmpDir("template-smoke-");
    mkdirSync(join(root, "tools"), { recursive: true });
    for (const name of DEFAULT_TOOL_NAMES) {
      const tpl = DEFAULT_TOOL_TEMPLATES[name as DefaultToolName]!;
      writeFileSync(join(root, "tools", `${name}.ts`), tpl.implCode, "utf8");
      writeFileSync(
        join(root, "tools", `${name}.test.ts`),
        tpl.testCode,
        "utf8",
      );
    }
    const result = spawnSync(
      "bun",
      ["test", "tools/"],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status !== 0) {
      // Surface bun's stderr so failures are debuggable.
      throw new Error(
        `bun test exited with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    // Sanity check on output count.
    expect(result.stderr).toContain("pass");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runtime integration — load each default tool through the runtime
// ──────────────────────────────────────────────────────────────────────────────

describe("default tools are loadable + invocable via the runtime", () => {
  test("query_facts runs against a real knowledge index", async () => {
    const facts: FactRecord[] = [
      {
        id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        text: "Pasta cooks faster in salted boiling water.",
        type: "fact",
        entities: ["pasta"],
        source: {
          sourceId: "src-cooking-001",
          contentHash: "a".repeat(64),
          url: "https://example.com/pasta",
          excerpt: "Salt the water before adding pasta.",
        },
        freshnessClass: "static",
        validUntil: null,
        confidence: 0.95,
        extractedAt: "2026-01-01T00:00:00.000Z",
        extractor: { model: "test", promptVersion: "v1" },
      },
    ];
    const m = synthesizeDefaultToolManifest("query_facts");
    const results: ToolImplementationResult[] = [];
    const dir = await buildAlmanacDirWithTools("rt-query-facts", [m], results, facts);

    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("query_facts", { q: "pasta" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { hits: Array<{ text: string }> };
      expect(data.hits.length).toBe(1);
      expect(data.hits[0]!.text).toContain("Pasta");
      expect(r.citations[0]!.sourceId).toBe("src-cooking-001");
      // The fact is static, so the envelope (and runtime stamp) should be static.
      expect(r.freshness.class).toBe("static");
    }
  });

  test("fetch_official_docs runs end-to-end with allowlisted host", async () => {
    const m = synthesizeDefaultToolManifest("fetch_official_docs", {
      networkAllowlist: ["example.com"],
    });
    const results: ToolImplementationResult[] = [];
    const dir = await buildAlmanacDirWithTools(
      "rt-fetch-docs",
      [m],
      results,
    );

    // Inject a stub fetch via the runtime's `fetchImpl` option — clean and
    // doesn't depend on monkey-patching globals.
    let captured = "";
    const rt = await createAlmanacRuntimeAsync({
      almanacDir: dir,
      fetchImpl: async (url) => {
        captured = String(url);
        return new Response("<html>doc body</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    const r = await rt.execTool("fetch_official_docs", {
      url: "https://example.com/page",
    });
    expect(captured).toBe("https://example.com/page");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { status: number; body: string };
      expect(data.status).toBe(200);
      expect(data.body).toContain("doc body");
    }
  });

  test("fetch_official_docs is blocked by allowlist for off-list hosts", async () => {
    const m = synthesizeDefaultToolManifest("fetch_official_docs", {
      networkAllowlist: ["docs.example.com"],
    });
    const results: ToolImplementationResult[] = [];
    const dir = await buildAlmanacDirWithTools(
      "rt-fetch-blocked",
      [m],
      results,
    );

    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("fetch_official_docs", {
      url: "https://evil.invalid/x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("network-not-allowed");
    }
  });

  test("listTools surfaces every implemented default", async () => {
    const manifests = synthesizeAllDefaultManifests({
      fetch_official_docs: { networkAllowlist: ["example.com"] },
    });
    const results: ToolImplementationResult[] = [];
    const dir = await buildAlmanacDirWithTools(
      "rt-list-defaults",
      manifests,
      results,
    );
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const list = await rt.listTools();
    expect(list.map((t) => t.name).sort()).toEqual(
      [...DEFAULT_TOOL_NAMES].sort(),
    );
  });
});
