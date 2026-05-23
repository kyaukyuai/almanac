/**
 * Concrete-fetcher tests.
 *
 *   - `createWriteRaw` writes content-addressed files and is idempotent
 *   - `GenericHttpFetcher` handles 200, 404, 5xx, timeout, oversized,
 *     extracts <title> and Last-Modified
 *   - `GithubRepoFetcher` produces an `index-only` entry from the repo +
 *     commit endpoints; rejects non-github URLs; surfaces 404
 *   - `LocalFileFetcher` reads file:// URLs and rejects non-files
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createWriteRaw,
  sha256HexBytes,
} from "./raw-writer.ts";
import {
  GenericHttpFetcher,
  extractTitleIfHtml,
  normalizeMediaType,
  parseHttpDate,
} from "./generic-http.ts";
import { GithubRepoFetcher } from "./github-repo.ts";
import { LocalFileFetcher } from "./local-file.ts";
import type { ApprovedSource } from "../../core/types.ts";
import type { FetchContext } from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────────────

const TMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}

function makeCtx(
  almanacDir: string,
  fetchImpl?: typeof fetch,
  overrides: Partial<FetchContext> = {},
): FetchContext {
  return {
    almanacDir,
    fetch: (fetchImpl ?? globalThis.fetch) as typeof fetch,
    now: () => new Date("2026-05-09T12:00:00.000Z"),
    hashContent: sha256HexBytes,
    log: () => undefined,
    maxBytes: 1_000_000,
    timeoutMs: 5_000,
    writeRaw: createWriteRaw(almanacDir),
    ...overrides,
  };
}

function docsSource(id: string, url: string): ApprovedSource {
  return {
    id,
    url,
    kind: "docs",
    trust: 0.9,
    volatility: "slow",
    rationale: "official",
    ingestion: { mode: "snapshot", scope: ["/"], refreshIntervalHours: 24 },
    notes: null,
  };
}

function repoSource(id: string, url: string): ApprovedSource {
  return {
    id,
    url,
    kind: "repo",
    trust: 0.95,
    volatility: "fast",
    rationale: "canonical",
    ingestion: { mode: "index-only", scope: ["releases"], refreshIntervalHours: 6 },
    notes: null,
  };
}

function fileSource(id: string, url: string): ApprovedSource {
  return {
    id,
    url,
    kind: "file",
    trust: 1,
    volatility: "static",
    rationale: "local",
    ingestion: { mode: "snapshot", scope: ["/"], refreshIntervalHours: 24 },
    notes: null,
  };
}

function asFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: any, init: any) => Promise.resolve(handler(String(url), init ?? {}))) as unknown as typeof fetch;
}

// ──────────────────────────────────────────────────────────────────────────────
// raw-writer
// ──────────────────────────────────────────────────────────────────────────────

describe("createWriteRaw", () => {
  test("writes bytes content-addressed and returns relPath", async () => {
    const dir = makeTmpDir("raw-");
    const writeRaw = createWriteRaw(dir);
    const bytes = new TextEncoder().encode("hello");
    const r = await writeRaw({ bytes, mediaType: "text/plain" });
    expect(r.contentHash).toBe(sha256HexBytes(bytes));
    expect(r.relPath).toMatch(
      /^sources\/raw\/[a-f0-9]{64}\.txt$/,
    );
    expect(r.byteLength).toBe(5);
    const onDisk = readFileSync(join(dir, r.relPath));
    expect(onDisk.toString()).toBe("hello");
  });

  test("is idempotent (second write does not error)", async () => {
    const dir = makeTmpDir("raw-idempotent-");
    const writeRaw = createWriteRaw(dir);
    const bytes = new TextEncoder().encode("idempotent");
    const a = await writeRaw({ bytes, mediaType: "text/plain" });
    const b = await writeRaw({ bytes, mediaType: "text/plain" });
    expect(a.relPath).toBe(b.relPath);
    expect(readdirSync(join(dir, "sources", "raw"))).toHaveLength(1);
  });

  test("uses extension override when supplied", async () => {
    const dir = makeTmpDir("raw-ext-");
    const writeRaw = createWriteRaw(dir);
    const r = await writeRaw({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "application/octet-stream",
      extension: "custom",
    });
    expect(r.relPath).toMatch(/\.custom$/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GenericHttpFetcher
// ──────────────────────────────────────────────────────────────────────────────

describe("GenericHttpFetcher", () => {
  test("canHandle: docs+snapshot=yes, repo+index-only=no, file=no", () => {
    const f = new GenericHttpFetcher();
    expect(f.canHandle(docsSource("a", "https://x.com"))).toBe(true);
    expect(f.canHandle(repoSource("b", "https://github.com/x/x"))).toBe(false);
    expect(f.canHandle(fileSource("c", "file:///etc/hosts"))).toBe(false);
  });

  test("200 OK with HTML extracts <title> and writes raw bytes", async () => {
    const dir = makeTmpDir("http-");
    const ctx = makeCtx(
      dir,
      asFetch(() =>
        new Response("<html><head><title>Hello &amp; World</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" },
        }),
      ),
    );
    const entry = await new GenericHttpFetcher().fetch(
      docsSource("k8s", "https://k8s.io/"),
      ctx,
    );
    expect(entry.status).toBe("fetched");
    if (entry.status === "fetched") {
      const d = entry.documents[0]!;
      expect(d.mediaType).toBe("text/html");
      expect(d.title).toBe("Hello & World");
      expect(d.sourceTimestamp).toBe("2026-10-21T07:28:00.000Z");
      expect(readFileSync(join(dir, d.relPath)).toString()).toContain("Hello");
    }
  });

  test("HTTP 404 returns failed entry with http-error", async () => {
    const dir = makeTmpDir("http-404-");
    const ctx = makeCtx(dir, asFetch(() => new Response("", { status: 404 })));
    const entry = await new GenericHttpFetcher().fetch(
      docsSource("a", "https://example.com/missing"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("http-error");
      expect(entry.error.httpStatusCode).toBe(404);
      expect(entry.error.retryable).toBe(false);
    }
  });

  test("HTTP 503 is retryable", async () => {
    const dir = makeTmpDir("http-503-");
    const ctx = makeCtx(dir, asFetch(() => new Response("", { status: 503 })));
    const entry = await new GenericHttpFetcher().fetch(
      docsSource("a", "https://example.com/down"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("http-error");
      expect(entry.error.retryable).toBe(true);
    }
  });

  test("network error is captured as failed network-error", async () => {
    const dir = makeTmpDir("http-net-");
    const ctx = makeCtx(
      dir,
      asFetch(() => {
        throw new TypeError("getaddrinfo ENOTFOUND");
      }),
    );
    const entry = await new GenericHttpFetcher().fetch(
      docsSource("a", "https://nx.invalid/"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("network-error");
      expect(entry.error.message).toContain("ENOTFOUND");
    }
  });

  test("response larger than maxBytes is failed with too-large", async () => {
    const dir = makeTmpDir("http-large-");
    const big = new Uint8Array(2_000_000); // 2MB
    const ctx = makeCtx(
      dir,
      asFetch(() => new Response(big, { status: 200, headers: { "content-type": "application/octet-stream" } })),
    );
    const entry = await new GenericHttpFetcher().fetch(
      docsSource("a", "https://example.com/big"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("too-large");
    }
  });

  test("normalizeMediaType strips parameters", () => {
    expect(normalizeMediaType("text/html; charset=utf-8")).toBe("text/html");
    expect(normalizeMediaType("APPLICATION/JSON")).toBe("application/json");
    expect(normalizeMediaType("nonsense")).toBe("application/octet-stream");
  });

  test("parseHttpDate handles RFC 1123", () => {
    expect(parseHttpDate("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(
      "2026-10-21T07:28:00.000Z",
    );
    expect(parseHttpDate("garbage")).toBeUndefined();
  });

  test("extractTitleIfHtml ignores non-HTML media types", () => {
    expect(extractTitleIfHtml(new Uint8Array(), "application/json")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GithubRepoFetcher
// ──────────────────────────────────────────────────────────────────────────────

describe("GithubRepoFetcher", () => {
  test("canHandle: only kind=repo + index-only + github.com URLs", () => {
    const f = new GithubRepoFetcher();
    expect(f.canHandle(repoSource("a", "https://github.com/x/y"))).toBe(true);
    expect(f.canHandle(repoSource("a", "https://gitlab.com/x/y"))).toBe(false);
    expect(f.canHandle(docsSource("a", "https://github.com/x/y"))).toBe(false);
  });

  test("produces an index-only entry from /repos and /commits", async () => {
    const dir = makeTmpDir("gh-");
    const ctx = makeCtx(
      dir,
      asFetch((url) => {
        if (url.endsWith("/repos/octo/repo")) {
          return new Response(
            JSON.stringify({
              full_name: "octo/repo",
              default_branch: "main",
              pushed_at: "2026-04-01T00:00:00Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/commits/main")) {
          return new Response(
            JSON.stringify({
              sha: "deadbeef".repeat(5),
              commit: { author: { date: "2026-04-15T10:00:00Z" } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("", { status: 404 });
      }),
    );
    const entry = await new GithubRepoFetcher().fetch(
      repoSource("octo-repo", "https://github.com/octo/repo"),
      ctx,
    );
    expect(entry.status).toBe("index-only");
    if (entry.status === "index-only") {
      expect(entry.indexMeta.commitSha).toBe("deadbeef".repeat(5));
      expect(entry.indexMeta.lastUpdatedAt).toBe("2026-04-15T10:00:00.000Z");
      expect(entry.indexMeta.label).toContain("octo/repo");
      expect(entry.indexMeta.label).toContain("@main");
    }
  });

  test("404 from /repos surfaces as http-error failed entry", async () => {
    const dir = makeTmpDir("gh-404-");
    const ctx = makeCtx(dir, asFetch(() => new Response("", { status: 404 })));
    const entry = await new GithubRepoFetcher().fetch(
      repoSource("missing", "https://github.com/none/missing"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("http-error");
      expect(entry.error.httpStatusCode).toBe(404);
    }
  });

  test("rate limit (403/429) maps to retryable rate-limited", async () => {
    const dir = makeTmpDir("gh-rl-");
    const ctx = makeCtx(dir, asFetch(() => new Response("", { status: 403 })));
    const entry = await new GithubRepoFetcher().fetch(
      repoSource("rl", "https://github.com/octo/rl"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("rate-limited");
      expect(entry.error.retryable).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// LocalFileFetcher
// ──────────────────────────────────────────────────────────────────────────────

describe("LocalFileFetcher", () => {
  test("canHandle: kind=file + file:// URL", () => {
    const f = new LocalFileFetcher();
    expect(f.canHandle(fileSource("a", "file:///tmp/x"))).toBe(true);
    expect(f.canHandle(fileSource("a", "https://x.com"))).toBe(false);
    expect(f.canHandle(docsSource("a", "file:///tmp/x"))).toBe(false);
  });

  test("reads a real file and writes to sources/raw with mtime as sourceTimestamp", async () => {
    const dir = makeTmpDir("local-");
    const tmp = join(dir, "fixture.md");
    writeFileSync(tmp, "# fixture\nhello\n", "utf8");
    const ctx = makeCtx(dir);
    const entry = await new LocalFileFetcher().fetch(
      fileSource("local-md", pathToFileURL(tmp).href),
      ctx,
    );
    expect(entry.status).toBe("fetched");
    if (entry.status === "fetched") {
      const d = entry.documents[0]!;
      expect(d.mediaType).toBe("text/markdown");
      expect(d.byteLength).toBe(statSync(tmp).size);
      expect(d.sourceTimestamp).toBeDefined();
      expect(readFileSync(join(dir, d.relPath)).toString()).toContain("# fixture");
    }
  });

  test("missing file returns failed network-error", async () => {
    const dir = makeTmpDir("local-missing-");
    const ctx = makeCtx(dir);
    const entry = await new LocalFileFetcher().fetch(
      fileSource("nope", pathToFileURL(join(dir, "nope.md")).href),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("network-error");
    }
  });

  test("directory path is rejected with parse-error", async () => {
    const dir = makeTmpDir("local-dir-");
    const ctx = makeCtx(dir);
    const entry = await new LocalFileFetcher().fetch(
      fileSource("dir", pathToFileURL(dir).href),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("parse-error");
    }
  });
});
