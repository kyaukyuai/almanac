/**
 * End-to-end tests for the concrete `AlmanacRuntime`.
 *
 * Builds a tiny on-disk almanac fixture (manifest + DOMAIN.md + one tool +
 * an in-memory knowledge index materialized to disk) and exercises every
 * branch of the 4-operation contract.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import {
  ensureAlmanacLayout,
  writeManifest,
} from "../compile/storage.ts";
import {
  buildKnowledgeIndex,
} from "../compile/stages/s08-knowledge-index.ts";
import { createDeterministicEmbeddingProvider } from "../embeddings/provider.ts";
import {
  KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH,
  KNOWLEDGE_VECTOR_INDEX_REL_PATH,
  type VectorIndexRecord,
} from "../embeddings/vector-index.ts";
import {
  AlmanacManifestSchema,
  CitationSchema,
  type FactRecord,
  type ToolManifest,
  type ToolResult,
} from "../core/types.ts";
import {
  NetworkNotAllowedError,
  ToolNotFoundError,
} from "../core/runtime.ts";

import { createAlmanacRuntimeAsync } from "./runtime.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────────────

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "almanac-runtime-"));
  TMP_ROOTS.push(root);
  return root;
}

function baseToolManifest(name: string, overrides: Partial<ToolManifest> = {}): ToolManifest {
  const m: ToolManifest = {
    name,
    version: "0.1.0",
    description: `Test tool ${name} for runtime fixtures.`,
    whenToUse: `When testing ${name} runtime behavior.`,
    returnsSummary: `Returns a small structured object for ${name}.`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    outputSchema: { type: "object" },
    capabilities: { network: [], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: "slow",
    freshness: { cachePolicy: "ttl", ttlSeconds: 3600, sourceTimestamp: false },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    sourceDependencies: [],
    sampleUrls: [],
    examples: [
      {
        description: "smoke",
        input: { q: "x" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "test", promptVersion: "v1" },
    disabled: false,
    ...overrides,
  };
  return m;
}

function citationFor(secondsAgo: number) {
  const now = Date.now();
  return CitationSchema.parse({
    sourceId: "src-test-001",
    url: "https://example.com/page",
    fetchedAt: new Date(now - secondsAgo * 1000).toISOString(),
  });
}

interface BuildAlmanacInput {
  almanacId: string;
  tools: Array<{ manifest: ToolManifest; implTs: string }>;
  /** When provided, materialize knowledge/almanac.sqlite from these facts. */
  facts?: FactRecord[];
  /** Optional vector records to pair with the materialized knowledge index. */
  vectorRecords?: VectorIndexRecord[];
  /** Extra contract files to drop into the almanac dir. */
  extras?: Record<string, string>;
}

async function buildFixtureAlmanac(input: BuildAlmanacInput): Promise<string> {
  const root = makeTmpRoot();
  const almanacDir = join(root, input.almanacId);

  const { manifest } = bootstrapAlmanac({
    almanacId: input.almanacId,
    domain: input.almanacId,
    displayName: input.almanacId,
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

  await ensureAlmanacLayout(almanacDir);
  // Bump tool/fact counts so the persisted manifest matches the fixture.
  const persisted = AlmanacManifestSchema.parse({
    ...manifest,
    toolCount: input.tools.filter((t) => !t.manifest.disabled).length,
    factCount: input.facts?.length ?? 0,
  });
  await writeManifest(almanacDir, persisted);

  // Drop tool pairs.
  const toolsDir = join(almanacDir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  for (const t of input.tools) {
    writeFileSync(
      join(toolsDir, `${t.manifest.name}.json`),
      JSON.stringify(t.manifest, null, 2),
      "utf8",
    );
    writeFileSync(join(toolsDir, `${t.manifest.name}.ts`), t.implTs, "utf8");
  }

  // Optional knowledge index.
  if (input.facts && input.facts.length > 0) {
    const dbPath = join(almanacDir, "knowledge", "almanac.sqlite");
    const built = buildKnowledgeIndex({
      almanacId: input.almanacId,
      facts: input.facts,
      dbPath,
    });
    built.db.close();
    const vectorIndex =
      input.vectorRecords === undefined
        ? undefined
        : {
            schemaVersion: "0.1.0" as const,
            status: "built" as const,
            provider: "deterministic" as const,
            model: "deterministic-hash-v1",
            dimensions: 2,
            factCount: input.facts.length,
            vectorCount: input.vectorRecords.length,
            sourceFactCorpusHash: built.manifest.factCorpusHash,
            vectorsRelPath: KNOWLEDGE_VECTOR_INDEX_REL_PATH,
            manifestRelPath: KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH,
            vectorsHash: "c".repeat(64),
            builtAt: new Date("2026-05-08T12:00:00.000Z").toISOString(),
          };
    if (input.vectorRecords !== undefined) {
      writeFileSync(
        join(almanacDir, KNOWLEDGE_VECTOR_INDEX_REL_PATH),
        input.vectorRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        join(almanacDir, KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH),
        JSON.stringify(vectorIndex, null, 2),
        "utf8",
      );
    }
    writeFileSync(
      join(almanacDir, "knowledge", "index-manifest.json"),
      JSON.stringify({ ...built.manifest, vectorIndex }, null, 2),
      "utf8",
    );
  }

  // Drop optional contract files.
  for (const [rel, body] of Object.entries(input.extras ?? {})) {
    writeFileSync(join(almanacDir, rel), body, "utf8");
  }

  return almanacDir;
}

// Build a tool .ts module that exports a named manifest + a default-exported
// implementation. Bun resolves `.ts` natively at import time.
function toolModuleSource(opts: {
  emit: ToolResult | "throw" | "bad-envelope";
  citationAgeSeconds?: number;
}): string {
  if (opts.emit === "throw") {
    return `
      export const manifest = { stub: true };
      export default async function() {
        throw new Error("intentional failure");
      }
    `;
  }
  if (opts.emit === "bad-envelope") {
    return `
      export const manifest = { stub: true };
      export default async function() {
        return { not: "an envelope" };
      }
    `;
  }
  // Static result. We embed the citation `fetchedAt` and freshness as JSON;
  // the runtime overwrites `staleness` from manifest class + citation age.
  return `
    export const manifest = { stub: true };
    export default async function() {
      return ${JSON.stringify(opts.emit)};
    }
  `;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("createAlmanacRuntimeAsync — listTools", () => {
  test("returns enabled manifests sorted by name; excludes disabled", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-list",
      tools: [
        {
          manifest: baseToolManifest("zeta_tool"),
          implTs: toolModuleSource({
            emit: { ok: false, error: { code: "noop", message: "x", retryable: false } },
          }),
        },
        {
          manifest: baseToolManifest("alpha_tool"),
          implTs: toolModuleSource({
            emit: { ok: false, error: { code: "noop", message: "x", retryable: false } },
          }),
        },
        {
          manifest: baseToolManifest("disabled_tool", {
            disabled: true,
            disabledReason: "test fixture",
          }),
          implTs: toolModuleSource({
            emit: { ok: false, error: { code: "noop", message: "x", retryable: false } },
          }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const list = await rt.listTools();
    expect(list.map((t) => t.name)).toEqual(["alpha_tool", "zeta_tool"]);
  });
});

describe("createAlmanacRuntimeAsync — execTool", () => {
  test("throws ToolNotFoundError for unknown name", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-unknown",
      tools: [
        {
          manifest: baseToolManifest("only_tool"),
          implTs: toolModuleSource({
            emit: { ok: false, error: { code: "noop", message: "x", retryable: false } },
          }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    await expect(rt.execTool("does_not_exist", {})).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
  });

  test("returns 'tool-disabled' for a disabled tool", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-disabled",
      tools: [
        {
          manifest: baseToolManifest("dead_tool", {
            disabled: true,
            disabledReason: "fixture: dead",
          }),
          implTs: toolModuleSource({
            emit: { ok: false, error: { code: "noop", message: "x", retryable: false } },
          }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("dead_tool", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("tool-disabled");
      expect(r.error.message).toContain("fixture: dead");
    }
  });

  test("captures thrown errors as 'tool-threw'", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-throw",
      tools: [
        {
          manifest: baseToolManifest("boom_tool"),
          implTs: toolModuleSource({ emit: "throw" }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("boom_tool", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("tool-threw");
      expect(r.error.message).toContain("intentional failure");
    }
  });

  test("rejects bad envelopes with 'tool-bad-envelope'", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-bad",
      tools: [
        {
          manifest: baseToolManifest("bad_tool"),
          implTs: toolModuleSource({ emit: "bad-envelope" }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("bad_tool", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("tool-bad-envelope");
  });

  test("re-stamps freshness.staleness from citation age + manifest maxAge", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-staleness",
      tools: [
        {
          manifest: baseToolManifest("warm_tool", {
            volatilityClass: "slow",
          }),
          implTs: toolModuleSource({
            emit: {
              ok: true,
              data: { hello: "world" },
              citations: [citationFor(7200)], // 2h ago
              // Tool lies and says fresh; runtime should overwrite.
              freshness: { class: "slow", maxAge: 3600, staleness: "fresh" },
            },
          }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("warm_tool", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2h with maxAge 1h → in (maxAge, 2*maxAge] → "warm"
      expect(r.freshness.class).toBe("slow");
      expect(r.freshness.maxAge).toBe(3600);
      expect(r.freshness.staleness).toBe("warm");
    }
  });

  test("envelope with class='static' stays 'fresh' regardless of citation age", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-static",
      tools: [
        {
          manifest: baseToolManifest("static_tool", {
            volatilityClass: "static",
            freshness: {
              cachePolicy: "manual-refresh",
              ttlSeconds: null,
              sourceTimestamp: false,
            },
          }),
          implTs: toolModuleSource({
            emit: {
              ok: true,
              data: { ok: 1 },
              // Citation from 3+ years ago — irrelevant for static envelopes.
              citations: [citationFor(99_999_999)],
              freshness: { class: "static", maxAge: null, staleness: "fresh" },
            },
          }),
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("static_tool", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.freshness.class).toBe("static");
      expect(r.freshness.maxAge).toBeNull();
      expect(r.freshness.staleness).toBe("fresh");
    }
  });

  test("capability-gated fetch rejects non-allowlisted hosts", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-fetch",
      tools: [
        {
          manifest: baseToolManifest("net_tool", {
            capabilities: {
              network: ["api.example.com"],
              fs: "none",
              subprocess: [],
              secrets: [],
            },
          }),
          implTs: `
            export const manifest = { stub: true };
            export default async function(_input, ctx) {
              if (typeof ctx.fetch !== "function") {
                throw new Error("expected ctx.fetch to be present");
              }
              try {
                await ctx.fetch("https://evil.invalid/x");
                return { ok: false, error: { code: "should-have-thrown", message: "no", retryable: false } };
              } catch (e) {
                if (e && e.name === "NetworkNotAllowedError") {
                  return {
                    ok: false,
                    error: { code: "blocked-as-expected", message: e.message.slice(0, 120), retryable: false },
                  };
                }
                throw e;
              }
            }
          `,
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("net_tool", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("blocked-as-expected");
    }
  });

  test("secrets are filtered to declared env vars only", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-secrets",
      tools: [
        {
          manifest: baseToolManifest("secret_tool", {
            capabilities: {
              network: [],
              fs: "none",
              subprocess: [],
              secrets: ["FIXTURE_TOKEN"],
            },
          }),
          implTs: `
            export const manifest = { stub: true };
            export default async function(_input, ctx) {
              const declared = ctx.secrets["FIXTURE_TOKEN"] ?? "MISSING";
              const leaked = ctx.secrets["NOT_DECLARED"];
              return {
                ok: false,
                error: {
                  code: "report",
                  message: declared + "/" + (leaked === undefined ? "no-leak" : "LEAKED"),
                  retryable: false,
                },
              };
            }
          `,
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({
      almanacDir: dir,
      resolveSecret: (name) =>
        name === "FIXTURE_TOKEN"
          ? "abc123"
          : name === "NOT_DECLARED"
            ? "should-not-leak"
            : undefined,
    });
    const r = await rt.execTool("secret_tool", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe("abc123/no-leak");
    }
  });
});

describe("createAlmanacRuntimeAsync — resources", () => {
  test("listResources includes canonical files + tool manifests", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-resources",
      tools: [
        {
          manifest: baseToolManifest("alpha_tool"),
          implTs: toolModuleSource({
            emit: { ok: false, error: { code: "x", message: "y", retryable: false } },
          }),
        },
      ],
      extras: {
        "DOMAIN.md": "# Domain\nhello\n",
        "AGENTS.md": "# Agents\nhello\n",
        "SKILLS.md": "# Skills\nhello\n",
      },
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const list = await rt.listResources();
    const uris = list.map((r) => r.uri).sort();
    expect(uris).toEqual([
      "almanac://rt-resources/AGENTS.md",
      "almanac://rt-resources/DOMAIN.md",
      "almanac://rt-resources/SKILLS.md",
      "almanac://rt-resources/manifest.json",
      "almanac://rt-resources/tools/alpha_tool.json",
    ]);
    // Spot-check a mime type.
    const md = list.find((r) => r.uri.endsWith("DOMAIN.md"));
    expect(md?.mimeType).toBe("text/markdown");
  });

  test("readResource returns file contents", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-read",
      tools: [],
      extras: { "DOMAIN.md": "# Hello\nfixture body\n" },
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.readResource("almanac://rt-read/DOMAIN.md");
    expect(r.contents).toBe("# Hello\nfixture body\n");
    expect(r.mimeType).toBe("text/markdown");
  });

  test("readResource rejects path-traversal", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-traversal",
      tools: [],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    await expect(
      rt.readResource("almanac://rt-traversal/../../etc/passwd"),
    ).rejects.toThrow(/resource not found/);
  });

  test("readResource rejects mismatched almanacId", async () => {
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-mismatch",
      tools: [],
      extras: { "DOMAIN.md": "x" },
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    await expect(
      rt.readResource("almanac://other-almanac/DOMAIN.md"),
    ).rejects.toThrow(/resource not found/);
  });
});

describe("createAlmanacRuntimeAsync — knowledge integration", () => {
  test("tools that declare knowledgeUsage.facts get a working KnowledgeReader", async () => {
    const facts: FactRecord[] = [
      {
        id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        text: "The capital of testland is Test City.",
        type: "fact",
        entities: ["Test City", "Testland"],
        source: {
          sourceId: "src-test-001",
          contentHash: "a".repeat(64),
          url: "https://example.com/page",
          excerpt: "Test City is the capital.",
        },
        freshnessClass: "static",
        validUntil: null,
        confidence: 0.95,
        extractedAt: "2026-01-01T00:00:00.000Z",
        extractor: { model: "test", promptVersion: "v1" },
      },
    ];
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-knowledge",
      facts,
      tools: [
        {
          manifest: baseToolManifest("query_facts", {
            volatilityClass: "static",
            freshness: {
              cachePolicy: "manual-refresh",
              ttlSeconds: null,
              sourceTimestamp: false,
            },
            knowledgeUsage: { facts: true, ftsQuery: null, embeddings: false },
          }),
          implTs: `
            export const manifest = { stub: true };
            export default async function(input, ctx) {
              if (!ctx.knowledge) {
                return { ok: false, error: { code: "no-knowledge", message: "x", retryable: false } };
              }
              const hits = await ctx.knowledge.searchFacts("Test City");
              return {
                ok: true,
                data: { hits: hits.length, first: hits[0]?.text ?? null },
                citations: [{
                  sourceId: "src-test-001",
                  url: "https://example.com/page",
                  fetchedAt: new Date().toISOString(),
                }],
                freshness: { class: "static", maxAge: null, staleness: "fresh" },
              };
            }
          `,
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("query_facts", { q: "Test City" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { hits: number }).hits).toBe(1);
      expect((r.data as { first: string }).first).toContain("Test City");
    }
  });

  test("runtime loads vector artifacts for hybrid KnowledgeReader search", async () => {
    const provider = createDeterministicEmbeddingProvider({
      model: "deterministic-hash-v1",
      dimensions: 2,
    });
    const queryVector = (
      await provider.embed({ inputs: [{ id: "__query__", text: "Test City" }] })
    ).vectors[0]!;
    const facts: FactRecord[] = [
      {
        id: "01HZZZZZZZZZZZZZZZZZZZZZZA",
        text: "The capital of testland is Test City.",
        type: "fact",
        entities: ["Test City", "Testland"],
        source: {
          sourceId: "src-test-001",
          contentHash: "a".repeat(64),
          url: "https://example.com/page-a",
          excerpt: "Test City is the capital.",
        },
        freshnessClass: "static",
        validUntil: null,
        confidence: 0.95,
        extractedAt: "2026-01-01T00:00:00.000Z",
        extractor: { model: "test", promptVersion: "v1" },
      },
      {
        id: "01HZZZZZZZZZZZZZZZZZZZZZZB",
        text: "Vector-only fixture fact with no lexical city token.",
        type: "fact",
        entities: ["Vector Fixture"],
        source: {
          sourceId: "src-test-002",
          contentHash: "b".repeat(64),
          url: "https://example.com/page-b",
          excerpt: "Vector fixture fact.",
        },
        freshnessClass: "static",
        validUntil: null,
        confidence: 0.9,
        extractedAt: "2026-01-01T00:00:00.000Z",
        extractor: { model: "test", promptVersion: "v1" },
      },
    ];
    const dir = await buildFixtureAlmanac({
      almanacId: "rt-hybrid",
      facts,
      vectorRecords: [
        {
          factId: facts[1]!.id,
          dimensions: 2,
          values: queryVector.values,
        },
      ],
      tools: [
        {
          manifest: baseToolManifest("query_facts", {
            volatilityClass: "static",
            freshness: {
              cachePolicy: "manual-refresh",
              ttlSeconds: null,
              sourceTimestamp: false,
            },
            knowledgeUsage: { facts: true, ftsQuery: null, embeddings: false },
          }),
          implTs: `
            export const manifest = { stub: true };
            export default async function(input, ctx) {
              const hits = await ctx.knowledge.searchFacts("Test City", { limit: 2 });
              return {
                ok: true,
                data: { ids: hits.map((h) => h.id) },
                citations: [{
                  sourceId: "src-test-001",
                  url: "https://example.com/page-a",
                  fetchedAt: new Date().toISOString(),
                }],
                freshness: { class: "static", maxAge: null, staleness: "fresh" },
              };
            }
          `,
        },
      ],
    });
    const rt = await createAlmanacRuntimeAsync({ almanacDir: dir });
    const r = await rt.execTool("query_facts", { q: "Test City" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { ids: string[] }).ids).toContain(facts[0]!.id);
      expect((r.data as { ids: string[] }).ids).toContain(facts[1]!.id);
    }
  });
});

describe("NetworkNotAllowedError", () => {
  test("constructs with host + allowlist", () => {
    const e = new NetworkNotAllowedError("evil.invalid", ["a.com", "b.com"]);
    expect(e.message).toContain("evil.invalid");
    expect(e.message).toContain("a.com");
    expect(e.allowedHosts).toEqual(["a.com", "b.com"]);
  });
});
