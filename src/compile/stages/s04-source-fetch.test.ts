/**
 * Tests for `src/compile/stages/s04-source-fetch.ts`:
 *   - `selectFetcher` priority + miss
 *   - `runSourceFetch` refuses drafts, dispatches to fetchers, and records
 *     `failed` entries when no fetcher matches
 */

import { describe, expect, test } from "bun:test";

import {
  buildSourceFetchManifest,
  type ApprovedSource,
  type SourceFetchEntry,
  type SourcesFile,
} from "../../core/types.ts";
import {
  NoFetcherForSourceError,
  type FetchContext,
  type Fetcher,
} from "../fetchers/types.ts";
import {
  SourcesNotApprovedError,
  runSourceFetch,
  selectFetcher,
} from "./s04-source-fetch.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const docsSource = (id: string, url: string): ApprovedSource => ({
  id,
  url,
  kind: "docs",
  trust: 0.9,
  volatility: "slow",
  rationale: "official documentation",
  ingestion: { mode: "snapshot", scope: ["/"], refreshIntervalHours: 24 },
  notes: null,
});

const repoSource = (id: string, url: string): ApprovedSource => ({
  id,
  url,
  kind: "repo",
  trust: 0.95,
  volatility: "fast",
  rationale: "canonical repository",
  ingestion: { mode: "index-only", scope: ["releases"], refreshIntervalHours: 6 },
  notes: null,
});

const draftSourcesFile: SourcesFile = {
  schemaVersion: "0.1.0",
  generatedAt: "2026-05-08T12:00:00.000Z",
  status: "draft",
  generatedBy: {
    stage: "02-source-discovery",
    evaluatorPromptVersion: "02-source-discovery/evaluator-v1",
    candidateCount: 0,
    acceptedCount: 0,
  },
  coverage: {
    docs: 0,
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
  sources: [],
  rejected: [],
};

const approvedSourcesFile = (sources: ApprovedSource[] = []): SourcesFile => {
  const coverage = {
    docs: 0,
    repo: 0,
    news: 0,
    community: 0,
    academic: 0,
    data: 0,
    file: 0,
    essay: 0,
    book: 0,
    talk: 0,
  };
  for (const s of sources) coverage[s.kind] += 1;
  return {
    schemaVersion: "0.1.0",
    generatedAt: "2026-05-08T12:00:00.000Z",
    status: "approved",
    approvedAt: "2026-05-08T12:00:01.000Z",
    approvedBy: "auto",
    generatedBy: {
      stage: "02-source-discovery",
      evaluatorPromptVersion: "02-source-discovery/evaluator-v1",
      candidateCount: sources.length,
      acceptedCount: sources.length,
    },
    coverage,
    warnings: [],
    sources,
    rejected: [],
  };
};

// Lightweight stub fetcher used purely for routing tests.
const stubFetcher = (
  name: string,
  predicate: (s: ApprovedSource) => boolean,
): Fetcher => ({
  name,
  canHandle: predicate,
  fetch: async (s) => {
    const entry: SourceFetchEntry = {
      sourceId: s.id,
      status: "fetched",
      fetchedAt: "2026-05-08T12:00:02.000Z",
      finalUrl: s.url,
      fetcher: name,
      documents: [
        {
          contentHash: "0".repeat(64),
          relPath: `sources/raw/${"0".repeat(64)}.bin`,
          url: s.url,
          mediaType: "application/octet-stream",
          byteLength: 0,
          fetchedAt: "2026-05-08T12:00:02.000Z",
        },
      ],
    };
    return entry;
  },
});

const stubCtx = (): Omit<FetchContext, "almanacDir"> => ({
  fetch: globalThis.fetch,
  now: () => new Date("2026-05-08T12:00:00.000Z"),
  hashContent: () => "0".repeat(64),
  log: () => undefined,
  maxBytes: 5_000_000,
  timeoutMs: 30_000,
  writeRaw: async () => ({
    contentHash: "0".repeat(64),
    relPath: `sources/raw/${"0".repeat(64)}.bin`,
    byteLength: 0,
  }),
});

// ──────────────────────────────────────────────────────────────────────────────
// selectFetcher
// ──────────────────────────────────────────────────────────────────────────────

describe("selectFetcher", () => {
  const html = stubFetcher("html", (s) => s.kind === "docs");
  const github = stubFetcher(
    "github-repo",
    (s) => s.kind === "repo" && s.url.startsWith("https://github.com/"),
  );

  test("returns the first matching fetcher", () => {
    expect(
      selectFetcher(docsSource("a", "https://k8s.io"), [github, html]).name,
    ).toBe("html");
    expect(
      selectFetcher(repoSource("b", "https://github.com/k8s/k8s"), [
        github,
        html,
      ]).name,
    ).toBe("github-repo");
  });

  test("priority is registration order (specific before generic)", () => {
    const generic = stubFetcher("generic", () => true);
    expect(selectFetcher(docsSource("a", "https://x.com"), [html, generic]).name).toBe(
      "html",
    );
    expect(
      selectFetcher(repoSource("b", "https://x.com/x/x"), [html, generic]).name,
    ).toBe("generic");
  });

  test("throws NoFetcherForSourceError when none match", () => {
    expect(() =>
      selectFetcher(repoSource("z", "https://gitlab.com/x/x"), [html, github]),
    ).toThrow(NoFetcherForSourceError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runSourceFetch
// ──────────────────────────────────────────────────────────────────────────────

describe("runSourceFetch", () => {
  test("refuses to run on a draft SourcesFile", async () => {
    await expect(
      runSourceFetch({
        sourcesFile: draftSourcesFile,
        almanacDir: "/tmp/x",
        fetchers: [],
        ctx: stubCtx(),
      }),
    ).rejects.toBeInstanceOf(SourcesNotApprovedError);
  });

  test("returns an empty manifest for an approved file with no sources", async () => {
    const m = await runSourceFetch({
      sourcesFile: approvedSourcesFile([]),
      almanacDir: "/tmp/x",
      fetchers: [stubFetcher("html", () => true)],
      ctx: stubCtx(),
    });
    expect(m.entries).toHaveLength(0);
    expect(m.summary.total).toBe(0);
    expect(m.almanacId).toBe("x");
  });

  test("routes one source to a matching fetcher and records a fetched entry", async () => {
    const m = await runSourceFetch({
      sourcesFile: approvedSourcesFile([
        docsSource("k8s-docs", "https://kubernetes.io/docs/"),
      ]),
      almanacDir: "/tmp/x",
      fetchers: [stubFetcher("html", (s) => s.kind === "docs")],
      ctx: stubCtx(),
    });
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.status).toBe("fetched");
    expect(m.summary.fetched).toBe(1);
    expect(m.summary.failed).toBe(0);
  });

  test("records a failed entry with code 'unknown-mode' when no fetcher matches", async () => {
    const m = await runSourceFetch({
      sourcesFile: approvedSourcesFile([
        repoSource("orphan", "https://gitlab.com/x/x"),
      ]),
      almanacDir: "/tmp/x",
      fetchers: [stubFetcher("html-only", (s) => s.kind === "docs")],
      ctx: stubCtx(),
    });
    expect(m.summary.failed).toBe(1);
    const e = m.entries[0]!;
    expect(e.status).toBe("failed");
    if (e.status === "failed") {
      expect(e.error.code).toBe("unknown-mode");
    }
  });

  test("emits stage4:fetch:failed for unknown-mode (no fetcher matched)", async () => {
    const events: Array<Record<string, unknown>> = [];
    const ctx = { ...stubCtx(), log: (e: object) => events.push(e as Record<string, unknown>) };
    await runSourceFetch({
      sourcesFile: approvedSourcesFile([
        repoSource("orphan", "https://gitlab.com/x/x"),
      ]),
      almanacDir: "/tmp/x",
      fetchers: [stubFetcher("html-only", (s) => s.kind === "docs")],
      ctx,
    });
    const failure = events.find((e) => e.event === "stage4:fetch:failed");
    expect(failure).toBeDefined();
    expect(failure!.sourceId).toBe("orphan");
    expect(failure!.errorCode).toBe("unknown-mode");
    expect(typeof failure!.message).toBe("string");
  });

  test("emits stage4:fetch:failed when a fetcher returns status=\"failed\"", async () => {
    const events: Array<Record<string, unknown>> = [];
    const ctx = { ...stubCtx(), log: (e: object) => events.push(e as Record<string, unknown>) };
    // Fetcher claims it can handle but returns a failed entry (e.g., HTTP 404).
    const flaky: Fetcher = {
      name: "flaky-http",
      canHandle: () => true,
      fetch: async (s) => ({
        sourceId: s.id,
        status: "failed",
        attemptedAt: "2026-05-08T12:00:00.000Z",
        fetcher: "flaky-http",
        error: {
          code: "http-error",
          message: "HTTP 404 from somewhere",
          httpStatusCode: 404,
          retryable: false,
          attempts: 1,
        },
      }),
    };
    await runSourceFetch({
      sourcesFile: approvedSourcesFile([
        repoSource("dead", "https://github.com/x/y"),
      ]),
      almanacDir: "/tmp/x",
      fetchers: [flaky],
      ctx,
    });
    const failure = events.find((e) => e.event === "stage4:fetch:failed");
    expect(failure).toBeDefined();
    expect(failure!.sourceId).toBe("dead");
    expect(failure!.fetcher).toBe("flaky-http");
    expect(failure!.errorCode).toBe("http-error");
  });

  test("does not emit stage4:fetch:failed for successful entries", async () => {
    const events: Array<Record<string, unknown>> = [];
    const ctx = { ...stubCtx(), log: (e: object) => events.push(e as Record<string, unknown>) };
    await runSourceFetch({
      sourcesFile: approvedSourcesFile([
        docsSource("k8s-docs", "https://kubernetes.io/docs/"),
      ]),
      almanacDir: "/tmp/x",
      fetchers: [stubFetcher("html", (s) => s.kind === "docs")],
      ctx,
    });
    expect(events.find((e) => e.event === "stage4:fetch:failed")).toBeUndefined();
  });

  test("continueOnError=false rethrows on the first failure", async () => {
    await expect(
      runSourceFetch({
        sourcesFile: approvedSourcesFile([
          repoSource("orphan", "https://gitlab.com/x/x"),
          docsSource("ok", "https://kubernetes.io/"),
        ]),
        almanacDir: "/tmp/x",
        fetchers: [stubFetcher("html", (s) => s.kind === "docs")],
        ctx: stubCtx(),
        continueOnError: false,
      }),
    ).rejects.toThrow(/aborted/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Sanity check that buildSourceFetchManifest interoperates with the fixtures
// the orchestrator will eventually emit.
// ──────────────────────────────────────────────────────────────────────────────

describe("buildSourceFetchManifest — orchestrator output shape", () => {
  test("a single fetched entry produces a valid manifest", async () => {
    const entry = await stubFetcher("html", () => true).fetch(
      docsSource("k8s-docs", "https://kubernetes.io/docs/"),
      { ...stubCtx(), almanacDir: "/tmp/x" },
    );
    const m = buildSourceFetchManifest({
      almanacId: "kubernetes",
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
      finishedAt: new Date("2026-05-08T12:00:03.000Z"),
      entries: [entry],
    });
    expect(m.summary.fetched).toBe(1);
    expect(m.entries[0]?.sourceId).toBe("k8s-docs");
  });
});
