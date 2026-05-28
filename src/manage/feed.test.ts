/**
 * Tests for `almanac feed` — the incremental single-source add command.
 *
 * Pure-helper tests pin the URL → source-id mapping and the
 * append-and-renormalize logic. The integration test exercises the full
 * runFeed flow against a tmp almanac with stubbed fetcher + mocked LLM:
 * sources.json is appended, facts.jsonl grows, the knowledge index gets
 * rebuilt, and the manifest's factCount + version bump.
 */
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
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  ExtractionResultSchema,
  KnowledgeIndexManifestSchema,
  SourceFetchManifestSchema,
  SourcesFileSchema,
  buildSourceFetchManifest,
  type ApprovedSource,
  type ExtractionResult,
  type SourceFetchEntry,
  type SourceKind,
  type SourcesFile,
} from "../core/types.ts";
import { createMockProvider } from "../llm/mock.ts";
import { bootstrapAlmanac } from "../compile/stages/s00-bootstrap.ts";
import { ensureAlmanacLayout, writeManifest } from "../compile/storage.ts";
import { approvedSourcesPath } from "../compile/stages/s03-approve-runner.ts";
import { sourceFetchManifestPath } from "../compile/stages/s04-source-fetch-runner.ts";
import { factsJsonlPath } from "../compile/stages/s05-fact-extraction.ts";
import { knowledgeIndexManifestPath } from "../compile/storage.ts";
import { domainSpecPath } from "../compile/stages/s01-domain-analysis.ts";
import type { FetchContext, Fetcher } from "../compile/fetchers/types.ts";

import {
  appendSourceToSourcesFile,
  buildApprovedSource,
  deriveSourceId,
  removeFactsForSource,
  replaceSourceInSourcesFile,
  runFeed,
} from "./feed.ts";

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

// ──────────────────────────────────────────────────────────────────────────────
// deriveSourceId
// ──────────────────────────────────────────────────────────────────────────────

describe("deriveSourceId", () => {
  test("github repo: gh-<owner>-<repo>", () => {
    expect(deriveSourceId("https://github.com/sqlite/sqlite", "repo")).toBe(
      "gh-sqlite-sqlite",
    );
    expect(deriveSourceId("https://github.com/asg017/sqlite-vec", "repo")).toBe(
      "gh-asg017-sqlite-vec",
    );
  });

  test("docs URL: hostname (sans www.) + first path segment without extension", () => {
    expect(
      deriveSourceId("https://www.sqlite.org/whentouse.html", "docs"),
    ).toBe("sqlite-org-whentouse");
    expect(deriveSourceId("https://kubernetes.io/docs/", "docs")).toBe(
      "kubernetes-io-docs",
    );
  });

  test("falls back to host-only when path is empty", () => {
    expect(deriveSourceId("https://example.com/", "docs")).toBe("example-com");
  });

  test("falls back to sha256 when URL is malformed", () => {
    const id = deriveSourceId("not a url", "docs");
    expect(id).toMatch(/^src-[a-f0-9]{8}$/);
  });

  test("result is always lowercase kebab-case (matches SOURCE_ID regex)", () => {
    const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    for (const url of [
      "https://Kubernetes.io/Docs/Setup/",
      "https://github.com/User_Name/Project-Name",
      "https://www.example.org/",
    ]) {
      expect(SOURCE_ID.test(deriveSourceId(url, "docs"))).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildApprovedSource
// ──────────────────────────────────────────────────────────────────────────────

describe("buildApprovedSource", () => {
  function baseInput(overrides: Partial<Parameters<typeof buildApprovedSource>[0]> = {}) {
    return {
      almanacDir: "/tmp/almanac/x",
      url: "https://www.sqlite.org/whentouse.html",
      apply: false,
      llm: createMockProvider({ defaultResponse: "{}" }),
      fetchers: [] as Fetcher[],
      ...overrides,
    } as Parameters<typeof buildApprovedSource>[0];
  }

  test("smart defaults: kind=docs, trust=0.85, mode=snapshot, scope=['/']", () => {
    const s = buildApprovedSource(baseInput());
    expect(s.kind).toBe("docs");
    expect(s.trust).toBe(0.85);
    expect(s.ingestion.mode).toBe("snapshot");
    expect(s.ingestion.scope).toEqual(["/"]);
    expect(s.volatility).toBe("slow");
    expect(s.notes).toBeNull();
  });

  test("kind=repo flips defaults: scope to docs+README, refresh 168h", () => {
    const s = buildApprovedSource(
      baseInput({ url: "https://github.com/sqlite/sqlite", kind: "repo" }),
    );
    expect(s.ingestion.scope).toEqual(["docs/**", "README.md"]);
    expect(s.ingestion.refreshIntervalHours).toBe(168);
    expect(s.volatility).toBe("slow");
  });

  test("kind=news → volatility fast + refresh 24h", () => {
    const s = buildApprovedSource(baseInput({ kind: "news" }));
    expect(s.volatility).toBe("fast");
    expect(s.ingestion.refreshIntervalHours).toBe(24);
  });

  test("--source-id wins over derived id", () => {
    const s = buildApprovedSource(baseInput({ sourceId: "custom-id-here" }));
    expect(s.id).toBe("custom-id-here");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// appendSourceToSourcesFile
// ──────────────────────────────────────────────────────────────────────────────

describe("appendSourceToSourcesFile", () => {
  function blankFile(): SourcesFile {
    return SourcesFileSchema.parse({
      schemaVersion: "0.1.0",
      status: "approved",
      generatedAt: "2026-05-08T12:00:00.000Z",
      approvedAt: "2026-05-08T12:00:01.000Z",
      approvedBy: "auto",
      generatedBy: {
        stage: "02-source-discovery",
        evaluatorPromptVersion: "evaluator-v1",
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
        sourceLiteral("doc-1", "https://a.example/", "docs"),
      ],
      rejected: [],
    });
  }

  test("incrementing acceptedCount + coverage[kind] both update", () => {
    const next = appendSourceToSourcesFile(
      blankFile(),
      sourceLiteral("repo-1", "https://github.com/x/y", "repo"),
    );
    expect(next.sources).toHaveLength(2);
    expect(next.generatedBy.acceptedCount).toBe(2);
    expect(next.coverage.docs).toBe(1);
    expect(next.coverage.repo).toBe(1);
  });
});

describe("replaceSourceInSourcesFile", () => {
  function twoKindFile(): SourcesFile {
    return SourcesFileSchema.parse({
      schemaVersion: "0.1.0",
      status: "approved",
      generatedAt: "2026-05-08T12:00:00.000Z",
      approvedAt: "2026-05-08T12:00:01.000Z",
      approvedBy: "auto",
      generatedBy: {
        stage: "02-source-discovery",
        evaluatorPromptVersion: "evaluator-v1",
        candidateCount: 2,
        acceptedCount: 2,
      },
      coverage: {
        docs: 1,
        repo: 1,
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
        sourceLiteral("doc-1", "https://a.example/", "docs"),
        sourceLiteral("repo-1", "https://github.com/x/y", "repo"),
      ],
      rejected: [],
    });
  }

  test("replaces by id and recomputes coverage without changing source count", () => {
    const next = replaceSourceInSourcesFile(
      twoKindFile(),
      sourceLiteral("doc-1", "https://a.example/replacement.pdf", "repo"),
    );

    expect(next.sources).toHaveLength(2);
    expect(next.sources[0]!.url).toBe("https://a.example/replacement.pdf");
    expect(next.generatedBy.acceptedCount).toBe(2);
    expect(next.coverage.docs).toBe(0);
    expect(next.coverage.repo).toBe(2);
  });

  test("throws when the source id is not present", () => {
    expect(() =>
      replaceSourceInSourcesFile(
        twoKindFile(),
        sourceLiteral("missing-source", "https://a.example/", "docs"),
      ),
    ).toThrow(/not found/);
  });
});

describe("removeFactsForSource", () => {
  test("drops only facts attributed to the replaced source id", () => {
    const body = [
      EXISTING_FACTS_BODY.trimEnd(),
      JSON.stringify({
        id: "01H8Q5Z2QJK4VXNTRWP3M7XYZ1",
        text: "Other source fact.",
        type: "fact",
        entities: ["other"],
        source: {
          sourceId: "other-docs",
          contentHash: "c".repeat(64),
          url: "https://other.example/",
          excerpt: "Other source fact.",
        },
        freshnessClass: "static",
        validUntil: null,
        confidence: 0.9,
        extractedAt: "2026-05-08T12:00:00.000Z",
        extractor: { model: "x", promptVersion: "v1" },
      }),
    ].join("\n");

    const next = removeFactsForSource(body, "tinytool-docs");

    expect(next).not.toContain("Tinytool is configured");
    expect(next).toContain("Other source fact");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runFeed — integration: tmp almanac + stub fetcher + mock LLM
// ──────────────────────────────────────────────────────────────────────────────

const EXISTING_DOMAIN_SPEC = {
  domain: "tinytool",
  canonicalSlug: "tinytool",
  displayName: "Tinytool",
  summary:
    "Compact synthetic domain used by the feed integration test only.",
  subareas: ["api", "cli"],
  intents: [
    { kind: "lookup", example: "what does foo do?" },
    { kind: "howto", example: "how do I install tinytool?" },
  ],
  verbs: ["install", "configure", "run"],
  entityTypes: ["command", "flag", "config-key"],
  freshnessProfile: {
    profileId: "mixed",
    defaultClass: "slow",
    classes: {
      static: { examples: ["command syntax"] },
      slow: { examples: ["release cadence"], maxAgeDays: 30 },
      fast: { examples: ["latest features"], maxAgeHours: 24 },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://tinytool.example/docs/", kind: "docs" },
    { hint: "https://github.com/tiny/tool", kind: "repo" },
    { hint: "https://tinytool.example/blog/", kind: "news" },
  ],
  suggestedTools: [],
  cautions: [],
};

const EXISTING_FACTS_BODY = JSON.stringify({
  id: "01H8Q5Z2QJK4VXNTRWP3M7XYZ0",
  text: "Tinytool is configured via a single TOML file.",
  type: "fact",
  entities: ["tinytool", "toml"],
  source: {
    sourceId: "tinytool-docs",
    contentHash: "a".repeat(64),
    url: "https://tinytool.example/docs/",
    excerpt: "Tinytool is configured via a single TOML file.",
  },
  freshnessClass: "static",
  validUntil: null,
  confidence: 0.95,
  extractedAt: "2026-05-08T12:00:00.000Z",
  extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
}) + "\n";

const NEW_FETCH_BODY = "# Tinytool extras\n\nThe `--verbose` flag enables debug logging.\n";

async function freshFeedFixture() {
  const root = mkdtempSync(join(tmpdir(), "almanac-feed-"));
  cleanup.push(root);
  const almanacDir = join(root, "tinytool");
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "tinytool",
    domain: "tinytool",
    displayName: "Tinytool",
    freshnessProfileId: "mixed",
    runId: "run-feed-test",
    forgerVersion: "0.0.0",
    options: {
      depth: "standard",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
  await ensureAlmanacLayout(almanacDir);
  // Bump factCount to match what we'll seed below so the start-state is
  // internally consistent.
  const manifestWithCount = AlmanacManifestSchema.parse({
    ...manifest,
    factCount: 1,
    toolCount: 4,
  });
  await writeManifest(almanacDir, manifestWithCount);

  // Seed domain-spec.json, sources/sources.json, extracted/facts.jsonl.
  const dsPath = domainSpecPath(almanacDir);
  await mkdir(dirname(dsPath), { recursive: true });
  writeFileSync(dsPath, JSON.stringify(EXISTING_DOMAIN_SPEC, null, 2), "utf8");

  const initialSources: SourcesFile = SourcesFileSchema.parse({
    schemaVersion: "0.1.0",
    status: "approved",
    generatedAt: "2026-05-08T12:00:00.000Z",
    approvedAt: "2026-05-08T12:00:01.000Z",
    approvedBy: "auto",
    generatedBy: {
      stage: "02-source-discovery",
      evaluatorPromptVersion: "evaluator-v1",
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
      sourceLiteral("tinytool-docs", "https://tinytool.example/docs/", "docs"),
    ],
    rejected: [],
  });
  const sp = approvedSourcesPath(almanacDir);
  await mkdir(dirname(sp), { recursive: true });
  writeFileSync(sp, JSON.stringify(initialSources, null, 2), "utf8");

  const fp = factsJsonlPath(almanacDir);
  await mkdir(dirname(fp), { recursive: true });
  writeFileSync(fp, EXISTING_FACTS_BODY, "utf8");

  // Seed the fetch manifest with the prior source as "fetched" so the
  // schema-consistent merge has at least one entry.
  const initialFetch = buildSourceFetchManifest({
    almanacId: "tinytool",
    startedAt: new Date("2026-05-08T12:00:00.000Z"),
    finishedAt: new Date("2026-05-08T12:00:00.500Z"),
    entries: [
      {
        sourceId: "tinytool-docs",
        status: "fetched",
        fetchedAt: "2026-05-08T12:00:00.500Z",
        finalUrl: "https://tinytool.example/docs/",
        fetcher: "stub",
        documents: [
          {
            contentHash: "b".repeat(64),
            relPath: `sources/raw/${"b".repeat(64)}.html`,
            url: "https://tinytool.example/docs/",
            mediaType: "text/html",
            byteLength: 12,
            fetchedAt: "2026-05-08T12:00:00.500Z",
            title: "Tinytool Docs",
          },
        ],
      },
    ],
  });
  const sfm = sourceFetchManifestPath(almanacDir);
  await mkdir(dirname(sfm), { recursive: true });
  writeFileSync(sfm, JSON.stringify(initialFetch, null, 2), "utf8");

  // Compile state isn't read by feed, so no need to write it here.
  void compileState;

  return { almanacDir };
}

function stubFetcher(): Fetcher {
  return {
    name: "stub-feed-fetcher",
    canHandle() {
      return true;
    },
    async fetch(source, ctx: FetchContext) {
      const bytes = new TextEncoder().encode(NEW_FETCH_BODY);
      const meta = await ctx.writeRaw({
        bytes,
        mediaType: "text/markdown",
        extension: "md",
      });
      const entry: SourceFetchEntry = {
        sourceId: source.id,
        status: "fetched",
        fetchedAt: ctx.now().toISOString(),
        finalUrl: source.url,
        fetcher: "stub-feed-fetcher",
        documents: [
          {
            contentHash: meta.contentHash,
            relPath: meta.relPath,
            url: source.url,
            mediaType: "text/markdown",
            byteLength: meta.byteLength,
            fetchedAt: ctx.now().toISOString(),
            title: "Tinytool extras",
          },
        ],
      };
      return entry;
    },
  };
}

const FACT_EXTRACTION_RESPONSE: ExtractionResult = ExtractionResultSchema.parse({
  schemaVersion: "0.1.0",
  status: "extracted",
  skipReason: null,
  coverage: {
    extractable: "verbose flag documentation",
    nonExtractable: "n/a",
  },
  facts: [
    {
      text: "The --verbose flag enables debug logging in Tinytool.",
      type: "fact",
      entities: ["tinytool", "verbose", "logging"],
      excerpt: "The `--verbose` flag enables debug logging.",
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.9,
    },
  ],
});

describe("runFeed (integration)", () => {
  test("dry-run: no disk changes; returns dry-run with derived source", async () => {
    const fx = await freshFeedFixture();
    const before = readFileSync(approvedSourcesPath(fx.almanacDir), "utf8");
    const provider = createMockProvider({ defaultResponse: "{}" });
    const result = await runFeed({
      almanacDir: fx.almanacDir,
      url: "https://tinytool.example/extras",
      apply: false,
      llm: provider,
      fetchers: [stubFetcher()],
    });
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.newSource.id).toBe("tinytool-example-extras");
      expect(result.existingSourcesCount).toBe(1);
    }
    // Verify the on-disk sources.json was not touched.
    expect(readFileSync(approvedSourcesPath(fx.almanacDir), "utf8")).toBe(before);
  });

  test("duplicate URL: skipped without LLM call", async () => {
    const fx = await freshFeedFixture();
    const provider = createMockProvider({ defaultResponse: "{}" });
    const result = await runFeed({
      almanacDir: fx.almanacDir,
      url: "https://tinytool.example/docs/", // already present
      apply: true,
      llm: provider,
      fetchers: [stubFetcher()],
    });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toContain("already exists");
    }
    // LLM should not have been called.
    expect(provider.callLog).toHaveLength(0);
  });

  test("apply path: appends source, fetches, extracts facts, reindexes, bumps version", async () => {
    const fx = await freshFeedFixture();
    const provider = createMockProvider({
      responses: {
        "05-fact-extraction@v1": JSON.stringify(FACT_EXTRACTION_RESPONSE),
      },
    });

    const events: object[] = [];
    const result = await runFeed({
      almanacDir: fx.almanacDir,
      url: "https://tinytool.example/extras",
      apply: true,
      llm: provider,
      fetchers: [stubFetcher()],
      log: (e) => events.push(e),
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");

    // 1. sources.json grew + counters recomputed.
    const sourcesAfter = SourcesFileSchema.parse(
      JSON.parse(readFileSync(approvedSourcesPath(fx.almanacDir), "utf8")),
    );
    expect(sourcesAfter.sources).toHaveLength(2);
    expect(sourcesAfter.generatedBy.acceptedCount).toBe(2);
    expect(sourcesAfter.coverage.docs).toBe(2);

    // 2. manifest.summary.json grew.
    const fetchManifest = SourceFetchManifestSchema.parse(
      JSON.parse(readFileSync(sourceFetchManifestPath(fx.almanacDir), "utf8")),
    );
    expect(fetchManifest.entries).toHaveLength(2);
    expect(fetchManifest.summary.fetched).toBe(2);

    // 3. facts.jsonl gained the new fact (existing fact still present).
    const factsBody = readFileSync(factsJsonlPath(fx.almanacDir), "utf8");
    const lines = factsBody.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { text: string });
    expect(parsed.some((p) => p.text.includes("TOML"))).toBe(true);
    expect(parsed.some((p) => p.text.includes("verbose"))).toBe(true);
    expect(result.factsAdded).toBe(1);
    expect(result.newFactCount).toBe(2);

    // 4. knowledge/index-manifest.json regenerated with factCount=2.
    const km = KnowledgeIndexManifestSchema.parse(
      JSON.parse(readFileSync(knowledgeIndexManifestPath(fx.almanacDir), "utf8")),
    );
    expect(km.factCount).toBe(2);

    // 5. manifest factCount + version bumped.
    const m = AlmanacManifestSchema.parse(
      JSON.parse(readFileSync(join(fx.almanacDir, "manifest.json"), "utf8")),
    );
    expect(m.factCount).toBe(2);
    expect(m.version).toBe("0.1.1"); // bootstrap defaults to 0.1.0; patch bumped.

    // 6. The structured-log trail mentions the milestones.
    const eventTypes = events.map((e) => (e as { event?: string }).event);
    expect(eventTypes).toContain("feed:sources-updated");
    expect(eventTypes).toContain("feed:fetched");
    expect(eventTypes).toContain("feed:facts-merged");
    expect(eventTypes).toContain("feed:done");
  });

  test("replace path: promotes an existing source without increasing source count or keeping stale facts", async () => {
    const fx = await freshFeedFixture();
    const provider = createMockProvider({
      responses: {
        "05-fact-extraction@v1": JSON.stringify(FACT_EXTRACTION_RESPONSE),
      },
    });

    const result = await runFeed({
      almanacDir: fx.almanacDir,
      url: "https://tinytool.example/reference.pdf",
      sourceId: "tinytool-docs",
      mode: "snapshot",
      apply: true,
      replaceExisting: true,
      llm: provider,
      fetchers: [stubFetcher()],
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.operation).toBe("replace");
    expect(result.replacedSource?.id).toBe("tinytool-docs");

    const sourcesAfter = SourcesFileSchema.parse(
      JSON.parse(readFileSync(approvedSourcesPath(fx.almanacDir), "utf8")),
    );
    expect(sourcesAfter.sources).toHaveLength(1);
    expect(sourcesAfter.sources[0]!.id).toBe("tinytool-docs");
    expect(sourcesAfter.sources[0]!.url).toBe(
      "https://tinytool.example/reference.pdf",
    );

    const fetchManifest = SourceFetchManifestSchema.parse(
      JSON.parse(readFileSync(sourceFetchManifestPath(fx.almanacDir), "utf8")),
    );
    expect(fetchManifest.entries).toHaveLength(1);
    expect(fetchManifest.entries[0]!.sourceId).toBe("tinytool-docs");
    expect(fetchManifest.summary.fetched).toBe(1);

    const factsBody = readFileSync(factsJsonlPath(fx.almanacDir), "utf8");
    expect(factsBody).not.toContain("single TOML file");
    expect(factsBody).toContain("--verbose flag enables debug logging");
    expect(result.factsAdded).toBe(1);
    expect(result.newFactCount).toBe(1);
  });

  test("malformed LLM output: existing facts preserved, factsAdded=0", async () => {
    const fx = await freshFeedFixture();
    // Stage 5 is lenient — malformed JSON gets logged and skipped, not
    // thrown. The feed should still complete; it just adds 0 facts.
    const provider = createMockProvider({ defaultResponse: "not json at all" });
    const factsBefore = readFileSync(factsJsonlPath(fx.almanacDir), "utf8");

    const result = await runFeed({
      almanacDir: fx.almanacDir,
      url: "https://tinytool.example/extras",
      apply: true,
      llm: provider,
      fetchers: [stubFetcher()],
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.factsAdded).toBe(0);
      expect(result.newFactCount).toBe(1); // existing fact preserved
    }
    // facts.jsonl still has the original fact verbatim.
    expect(readFileSync(factsJsonlPath(fx.almanacDir), "utf8")).toBe(factsBefore);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function sourceLiteral(
  id: string,
  url: string,
  kind: SourceKind,
): ApprovedSource {
  return {
    id,
    url,
    kind,
    trust: 0.85,
    volatility: kind === "news" ? "fast" : "slow",
    rationale: "test fixture",
    ingestion: { mode: "snapshot", scope: ["/"], refreshIntervalHours: 168 },
    notes: null,
  };
}
