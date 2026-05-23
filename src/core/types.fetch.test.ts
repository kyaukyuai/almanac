/**
 * Tests for the Stage 4 (source fetch) schemas:
 *   - `FetchedDocumentSchema`, `RawRelPathSchema`, `MediaTypeSchema`
 *   - `SourceFetchEntrySchema` (discriminated union: fetched / index-only / failed)
 *   - `SourceFetchManifestSchema` cross-field invariants
 *   - `buildSourceFetchManifest()` summary derivation
 */

import { describe, expect, test } from "bun:test";

import {
  FetchedDocumentSchema,
  MediaTypeSchema,
  RawRelPathSchema,
  SourceFetchEntrySchema,
  SourceFetchManifestSchema,
  buildSourceFetchManifest,
  isFailedEntry,
  isFetchedEntry,
  isIndexOnlyEntry,
  type FetchedDocument,
  type SourceFetchEntry,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Reusable fixtures
// ──────────────────────────────────────────────────────────────────────────────

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const exampleDoc = (hash = HASH_A, ext = "md"): FetchedDocument => ({
  contentHash: hash,
  relPath: `sources/raw/${hash}.${ext}`,
  url: "https://kubernetes.io/docs/concepts/",
  mediaType: "text/markdown",
  byteLength: 4096,
  fetchedAt: "2026-05-08T12:00:00.000Z",
  sourceTimestamp: "2026-05-01T00:00:00.000Z",
  title: "Concepts",
});

const fetchedEntry = (
  sourceId: string,
  docs: FetchedDocument[] = [exampleDoc()],
): SourceFetchEntry => ({
  sourceId,
  status: "fetched",
  fetchedAt: "2026-05-08T12:00:01.000Z",
  finalUrl: docs[0]!.url,
  fetcher: "html",
  documents: docs,
});

const indexOnlyEntry = (sourceId: string): SourceFetchEntry => ({
  sourceId,
  status: "index-only",
  fetchedAt: "2026-05-08T12:00:01.000Z",
  finalUrl: "https://github.com/kubernetes/kubernetes",
  fetcher: "github-repo",
  indexMeta: {
    commitSha: "deadbeefcafebabedeadbeefcafebabedeadbeef",
    lastUpdatedAt: "2026-05-07T08:00:00.000Z",
    label: "v1.31.0",
  },
});

const failedEntry = (sourceId: string): SourceFetchEntry => ({
  sourceId,
  status: "failed",
  attemptedAt: "2026-05-08T12:00:01.000Z",
  fetcher: "html",
  error: {
    code: "http-error",
    message: "503 Service Unavailable",
    httpStatusCode: 503,
    retryable: true,
    attempts: 3,
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// MediaType / RawRelPath
// ──────────────────────────────────────────────────────────────────────────────

describe("MediaTypeSchema", () => {
  test("accepts common MIME types", () => {
    for (const m of [
      "text/html",
      "text/markdown",
      "text/plain",
      "application/pdf",
      "application/json",
      "application/atom+xml",
      "application/rss+xml",
      "application/octet-stream",
    ]) {
      expect(() => MediaTypeSchema.parse(m)).not.toThrow();
    }
  });

  test("rejects uppercase or malformed types", () => {
    expect(() => MediaTypeSchema.parse("Text/HTML")).toThrow();
    expect(() => MediaTypeSchema.parse("text")).toThrow();
    expect(() => MediaTypeSchema.parse("text/")).toThrow();
  });
});

describe("RawRelPathSchema", () => {
  test("accepts hash-based names with or without extension", () => {
    expect(() =>
      RawRelPathSchema.parse(`sources/raw/${HASH_A}.md`),
    ).not.toThrow();
    expect(() => RawRelPathSchema.parse(`sources/raw/${HASH_A}`)).not.toThrow();
    expect(() =>
      RawRelPathSchema.parse(`sources/raw/${HASH_A}.pdf`),
    ).not.toThrow();
  });

  test("rejects absolute paths or wrong basename", () => {
    expect(() => RawRelPathSchema.parse(`/sources/raw/${HASH_A}.md`)).toThrow();
    expect(() => RawRelPathSchema.parse("sources/raw/something.md")).toThrow();
    expect(() =>
      RawRelPathSchema.parse(`sources/other/${HASH_A}.md`),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// FetchedDocument
// ──────────────────────────────────────────────────────────────────────────────

describe("FetchedDocumentSchema", () => {
  test("accepts a complete document", () => {
    const parsed = FetchedDocumentSchema.parse(exampleDoc());
    expect(parsed.byteLength).toBe(4096);
    expect(parsed.title).toBe("Concepts");
  });

  test("accepts minimal document (no title, no sourceTimestamp)", () => {
    const parsed = FetchedDocumentSchema.parse({
      contentHash: HASH_A,
      relPath: `sources/raw/${HASH_A}.html`,
      url: "https://example.com/",
      mediaType: "text/html",
      byteLength: 0,
      fetchedAt: "2026-05-08T12:00:00.000Z",
    });
    expect(parsed.title).toBeUndefined();
  });

  test("rejects mismatched contentHash format", () => {
    expect(() =>
      FetchedDocumentSchema.parse({
        ...exampleDoc(),
        contentHash: "not-a-sha",
      }),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SourceFetchEntry — discriminated union
// ──────────────────────────────────────────────────────────────────────────────

describe("SourceFetchEntrySchema", () => {
  test("parses a fetched entry", () => {
    const parsed = SourceFetchEntrySchema.parse(fetchedEntry("k8s-docs"));
    expect(parsed.status).toBe("fetched");
    if (parsed.status === "fetched") {
      expect(parsed.documents).toHaveLength(1);
    }
  });

  test("parses an index-only entry", () => {
    const parsed = SourceFetchEntrySchema.parse(
      indexOnlyEntry("k8s-releases"),
    );
    expect(parsed.status).toBe("index-only");
    if (parsed.status === "index-only") {
      expect(parsed.indexMeta.commitSha).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  test("parses a failed entry", () => {
    const parsed = SourceFetchEntrySchema.parse(failedEntry("flaky-source"));
    expect(parsed.status).toBe("failed");
    if (parsed.status === "failed") {
      expect(parsed.error.httpStatusCode).toBe(503);
      expect(parsed.error.retryable).toBe(true);
    }
  });

  test("rejects fetched entry with empty documents", () => {
    expect(() =>
      SourceFetchEntrySchema.parse({
        ...fetchedEntry("x"),
        documents: [],
      }),
    ).toThrow();
  });

  test("rejects failed entry with unknown error code", () => {
    expect(() =>
      SourceFetchEntrySchema.parse({
        ...failedEntry("x"),
        error: {
          code: "made-up-code",
          message: "x",
          retryable: false,
          attempts: 1,
        },
      }),
    ).toThrow();
  });

  test("rejects bad git-sha in indexMeta.commitSha", () => {
    expect(() =>
      SourceFetchEntrySchema.parse({
        ...indexOnlyEntry("x"),
        indexMeta: { commitSha: "not-a-sha" },
      }),
    ).toThrow();
  });
});

describe("SourceFetchEntry — type guards", () => {
  test("isFetchedEntry / isIndexOnlyEntry / isFailedEntry narrow correctly", () => {
    const f = SourceFetchEntrySchema.parse(fetchedEntry("a"));
    const i = SourceFetchEntrySchema.parse(indexOnlyEntry("b"));
    const x = SourceFetchEntrySchema.parse(failedEntry("c"));
    expect(isFetchedEntry(f)).toBe(true);
    expect(isIndexOnlyEntry(i)).toBe(true);
    expect(isFailedEntry(x)).toBe(true);
    expect(isFetchedEntry(i)).toBe(false);
    expect(isFailedEntry(f)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SourceFetchManifest + buildSourceFetchManifest
// ──────────────────────────────────────────────────────────────────────────────

describe("buildSourceFetchManifest", () => {
  test("computes correct summary for a mixed run", () => {
    const m = buildSourceFetchManifest({
      almanacId: "kubernetes",
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
      finishedAt: new Date("2026-05-08T12:05:00.000Z"),
      entries: [
        fetchedEntry("k8s-docs", [
          exampleDoc(HASH_A, "md"),
          { ...exampleDoc(HASH_B, "html"), byteLength: 8192 },
        ]),
        indexOnlyEntry("k8s-releases"),
        failedEntry("flaky-source"),
        fetchedEntry("k8s-blog", [
          { ...exampleDoc(HASH_C, "html"), byteLength: 1024 },
        ]),
      ],
    });
    expect(m.summary).toEqual({
      total: 4,
      fetched: 2,
      indexOnly: 1,
      failed: 1,
      totalDocuments: 3,
      totalBytes: 4096 + 8192 + 1024,
    });
  });

  test("rejects when finishedAt < startedAt", () => {
    expect(() =>
      buildSourceFetchManifest({
        almanacId: "x",
        startedAt: new Date("2026-05-08T12:00:00.000Z"),
        finishedAt: new Date("2026-05-08T11:59:00.000Z"),
        entries: [],
      }),
    ).toThrow(/finishedAt must be >= startedAt/);
  });

  test("rejects duplicate sourceId across entries", () => {
    expect(() =>
      buildSourceFetchManifest({
        almanacId: "x",
        startedAt: new Date("2026-05-08T12:00:00.000Z"),
        finishedAt: new Date("2026-05-08T12:00:01.000Z"),
        entries: [fetchedEntry("dup"), failedEntry("dup")],
      }),
    ).toThrow(/duplicate sourceId/);
  });
});

describe("SourceFetchManifestSchema", () => {
  test("rejects manifest whose summary disagrees with entries", () => {
    expect(() =>
      SourceFetchManifestSchema.parse({
        schemaVersion: "0.1.0",
        almanacId: "x",
        startedAt: "2026-05-08T12:00:00.000Z",
        finishedAt: "2026-05-08T12:00:01.000Z",
        summary: {
          total: 1,
          fetched: 5, // wrong
          indexOnly: 0,
          failed: 0,
          totalDocuments: 1,
          totalBytes: 4096,
        },
        entries: [fetchedEntry("only-one")],
      }),
    ).toThrow(/summary\.fetched.*!== actual/);
  });

  test("accepts a valid empty manifest", () => {
    const parsed = SourceFetchManifestSchema.parse({
      schemaVersion: "0.1.0",
      almanacId: "empty",
      startedAt: "2026-05-08T12:00:00.000Z",
      finishedAt: "2026-05-08T12:00:00.000Z",
      summary: {
        total: 0,
        fetched: 0,
        indexOnly: 0,
        failed: 0,
        totalDocuments: 0,
        totalBytes: 0,
      },
      entries: [],
    });
    expect(parsed.entries).toHaveLength(0);
  });
});
