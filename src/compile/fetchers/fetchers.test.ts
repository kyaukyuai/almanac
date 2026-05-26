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
import {
  GithubRepoFetcher,
  matchesAny,
  mediaTypeForPath,
} from "./github-repo.ts";
import { HttpIndexOnlyFetcher } from "./http-index-only.ts";
import { LocalFileFetcher } from "./local-file.ts";
import { defaultFetchers } from "../stages/s04-source-fetch-runner.ts";
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
    // repo+index-only is still false because index-only is HttpIndexOnlyFetcher's
    // territory regardless of kind.
    expect(f.canHandle(repoSource("b", "https://github.com/x/x"))).toBe(false);
    expect(f.canHandle(fileSource("c", "file:///etc/hosts"))).toBe(false);
  });

  test("canHandle: kind=repo + mode=feed/snapshot is claimed (v0.3.2 fall-through)", () => {
    // mode=feed on a github.com path URL (e.g., /releases) is rejected by
    // GithubRepoFetcher's bare-repo regex AND its mode check, so the chain
    // used to drop the source as unknown-mode. Now GenericHttpFetcher picks
    // it up and at least fetches the page.
    const f = new GenericHttpFetcher();
    const feedRepo: ApprovedSource = {
      ...repoSource("rust-releases", "https://github.com/rust-lang/rust/releases"),
      ingestion: {
        mode: "feed",
        scope: ["releases/latest"],
        refreshIntervalHours: 24,
      },
    };
    expect(f.canHandle(feedRepo)).toBe(true);
    const snapshotRepo: ApprovedSource = {
      ...repoSource("something", "https://example.com/snapshot"),
      ingestion: { mode: "snapshot", scope: ["/"], refreshIntervalHours: 24 },
    };
    expect(f.canHandle(snapshotRepo)).toBe(true);
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
  test("canHandle: kind=repo + (index-only OR snapshot) + github.com URLs", () => {
    const f = new GithubRepoFetcher();
    // index-only — the historical default
    expect(f.canHandle(repoSource("a", "https://github.com/x/y"))).toBe(true);
    // snapshot — accepted post-fix, degraded to index-only behavior at runtime
    const snap: ApprovedSource = {
      ...repoSource("b", "https://github.com/x/y"),
      ingestion: { mode: "snapshot", scope: ["docs/**"], refreshIntervalHours: 24 },
    };
    expect(f.canHandle(snap)).toBe(true);
    expect(f.canHandle(repoSource("a", "https://gitlab.com/x/y"))).toBe(false);
    expect(f.canHandle(docsSource("a", "https://github.com/x/y"))).toBe(false);
  });

  test("snapshot mode: walks tree, fetches matching blobs, writes documents[]", async () => {
    const events: object[] = [];
    const dir = makeTmpDir("gh-snap-ok-");
    const sha = "abc123".padEnd(40, "0");
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
              sha,
              commit: { author: { date: "2026-04-15T10:00:00Z" } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/git/trees/${sha}`)) {
          return new Response(
            JSON.stringify({
              tree: [
                { path: "README.md", type: "blob", size: 200 },
                { path: "docs/intro.md", type: "blob", size: 400 },
                { path: "docs/api.md", type: "blob", size: 500 },
                { path: "src/main.ts", type: "blob", size: 1000 },
              ],
              truncated: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.startsWith("https://raw.githubusercontent.com/octo/repo/")) {
          return new Response(`# content of ${url.split("/").pop()}\n`, {
            status: 200,
            headers: { "content-type": "text/markdown" },
          });
        }
        return new Response("", { status: 404 });
      }),
      { log: (e) => events.push(e) },
    );
    const snap: ApprovedSource = {
      ...repoSource("octo-repo", "https://github.com/octo/repo"),
      ingestion: {
        mode: "snapshot",
        scope: ["docs/**", "README.md"],
        refreshIntervalHours: 24,
      },
    };
    const entry = await new GithubRepoFetcher().fetch(snap, ctx);
    expect(entry.status).toBe("fetched");
    if (entry.status === "fetched") {
      // README.md + docs/intro.md + docs/api.md, but NOT src/main.ts
      expect(entry.documents).toHaveLength(3);
      const paths = entry.documents.map((d) => d.title).sort();
      expect(paths).toEqual(["README.md", "docs/api.md", "docs/intro.md"]);
      for (const d of entry.documents) {
        expect(d.mediaType).toBe("text/markdown");
        expect(d.byteLength).toBeGreaterThan(0);
        expect(d.relPath).toMatch(/^sources\/raw\/[a-f0-9]{64}\.md$/);
        expect(d.sourceTimestamp).toBe("2026-04-15T10:00:00.000Z");
      }
    }
    const ok = events.find(
      (e) =>
        (e as { event?: string; mode?: string }).event === "fetcher:github:ok" &&
        (e as { mode?: string }).mode === "snapshot",
    );
    expect(ok).toBeDefined();
  });

  test("snapshot mode sorts matched paths descending before slicing to SNAPSHOT_MAX_FILES", async () => {
    // GitHub's tree API returns paths in ascending order; for repos with
    // numeric-prefixed paths (e.g. rust-lang/rfcs: `text/0001-...` ..
    // `text/3700-...`) a naive slice(0, 50) captures only the oldest 50.
    // We sort descending so the *newest* numeric paths win — RFC #2394
    // (async/await, 2019) was the motivating gap.
    const dir = makeTmpDir("gh-snap-desc-");
    const sha = "feed".padEnd(40, "0");
    const total = 70; // > SNAPSHOT_MAX_FILES (50)
    const tree = Array.from({ length: total }, (_, i) => ({
      path: `text/${String(i + 1).padStart(4, "0")}-rfc.md`,
      type: "blob" as const,
      size: 100,
    }));
    const fetchedPaths: string[] = [];
    const ctx = makeCtx(
      dir,
      asFetch((url) => {
        if (url.endsWith("/repos/octo/rfcs")) {
          return new Response(
            JSON.stringify({ full_name: "octo/rfcs", default_branch: "main" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/commits/main")) {
          return new Response(
            JSON.stringify({
              sha,
              commit: { author: { date: "2026-04-15T10:00:00Z" } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/git/trees/${sha}`)) {
          return new Response(
            JSON.stringify({ tree, truncated: false }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.startsWith("https://raw.githubusercontent.com/octo/rfcs/")) {
          fetchedPaths.push(url.split(`/${sha}/`)[1] ?? "");
          return new Response("# body\n", {
            status: 200,
            headers: { "content-type": "text/markdown" },
          });
        }
        return new Response("", { status: 404 });
      }),
    );
    const snap: ApprovedSource = {
      ...repoSource("octo-rfcs", "https://github.com/octo/rfcs"),
      ingestion: {
        mode: "snapshot",
        scope: ["text/**"],
        refreshIntervalHours: 24,
      },
    };
    const entry = await new GithubRepoFetcher().fetch(snap, ctx);
    expect(entry.status).toBe("fetched");
    if (entry.status === "fetched") {
      // Exactly SNAPSHOT_MAX_FILES (50) docs and they are the newest 50,
      // i.e. RFC numbers 0021..0070.
      expect(entry.documents).toHaveLength(50);
      expect(fetchedPaths).toHaveLength(50);
      expect(fetchedPaths[0]).toBe("text/0070-rfc.md");
      expect(fetchedPaths[fetchedPaths.length - 1]).toBe("text/0021-rfc.md");
      // RFC #0001 (the oldest) must have been excluded.
      expect(fetchedPaths).not.toContain("text/0001-rfc.md");
    }
  });

  test("snapshot mode with empty scope match falls back to index-only", async () => {
    const events: object[] = [];
    const dir = makeTmpDir("gh-snap-empty-");
    const sha = "def456".padEnd(40, "0");
    const ctx = makeCtx(
      dir,
      asFetch((url) => {
        if (url.endsWith("/repos/octo/repo")) {
          return new Response(
            JSON.stringify({ full_name: "octo/repo", default_branch: "main" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/commits/main")) {
          return new Response(
            JSON.stringify({
              sha,
              commit: { author: { date: "2026-04-15T10:00:00Z" } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/git/trees/${sha}`)) {
          return new Response(
            JSON.stringify({
              tree: [{ path: "src/main.ts", type: "blob", size: 100 }],
              truncated: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("", { status: 404 });
      }),
      { log: (e) => events.push(e) },
    );
    // Scope only matches things under docs/, but tree has only src/main.ts.
    const snap: ApprovedSource = {
      ...repoSource("octo-repo", "https://github.com/octo/repo"),
      ingestion: { mode: "snapshot", scope: ["docs/**"], refreshIntervalHours: 24 },
    };
    const entry = await new GithubRepoFetcher().fetch(snap, ctx);
    expect(entry.status).toBe("index-only");
    if (entry.status === "index-only") {
      expect(entry.indexMeta.commitSha).toBe(sha);
    }
    const empty = events.find(
      (e) =>
        (e as { event?: string }).event === "fetcher:github:snapshot-empty",
    );
    expect(empty).toBeDefined();
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
// HttpIndexOnlyFetcher
// ──────────────────────────────────────────────────────────────────────────────

function indexOnlySource(
  id: string,
  url: string,
  kind: ApprovedSource["kind"] = "essay",
): ApprovedSource {
  return {
    id,
    url,
    kind,
    trust: 0.85,
    volatility: "slow",
    rationale: "test fixture",
    ingestion: { mode: "index-only", scope: [], refreshIntervalHours: 24 },
    notes: null,
  };
}

describe("HttpIndexOnlyFetcher", () => {
  test("canHandle: HTTP url + index-only + any non-file kind", () => {
    const f = new HttpIndexOnlyFetcher();
    expect(
      f.canHandle(indexOnlySource("a", "https://example.com", "essay")),
    ).toBe(true);
    expect(
      f.canHandle(indexOnlySource("b", "https://example.com", "community")),
    ).toBe(true);
    expect(
      f.canHandle(indexOnlySource("c", "https://example.com", "academic")),
    ).toBe(true);
    // wrong mode
    expect(f.canHandle(docsSource("d", "https://example.com"))).toBe(false);
    // kind=file always rejected (LocalFileFetcher claims those)
    const fileKind = {
      ...indexOnlySource("e", "https://example.com", "essay"),
      kind: "file" as const,
    };
    expect(f.canHandle(fileKind)).toBe(false);
    // non-http
    expect(
      f.canHandle(indexOnlySource("f", "file:///tmp/x", "essay")),
    ).toBe(false);
  });

  test("default chain routes bare github.com to GithubRepoFetcher (precedence preserved)", () => {
    // Sanity check that the v0.3.2 fall-through change does not regress the
    // happy path: a bare github.com URL with kind=repo + mode=snapshot must
    // still pick up GithubRepoFetcher even though HttpIndexOnlyFetcher /
    // GenericHttpFetcher would also claim it.
    const chain = defaultFetchers();
    const bareRepo: ApprovedSource = {
      ...repoSource("kube", "https://github.com/kubernetes/kubernetes"),
      ingestion: { mode: "snapshot", scope: ["/"], refreshIntervalHours: 168 },
    };
    const claimed = chain.find((f) => f.canHandle(bareRepo));
    expect(claimed?.name).toBe("github-repo");
  });

  test("canHandle: kind=repo + non-github.com URL is claimed (v0.3.2 fall-through)", () => {
    // GithubRepoFetcher rejects github.io URLs (bare-repo regex). With the
    // kind=repo exclusion removed, HttpIndexOnlyFetcher now claims those so
    // they no longer fail unknown-mode at Stage 4. Chain ordering still puts
    // GithubRepoFetcher first for bare github.com URLs, so the change is
    // additive — bare github.com repos continue to route to the API path.
    const f = new HttpIndexOnlyFetcher();
    const githubIo = {
      ...indexOnlySource("api-guidelines", "https://rust-lang.github.io/api-guidelines/", "docs"),
      kind: "repo" as const,
    };
    expect(f.canHandle(githubIo)).toBe(true);
    const githubPath = {
      ...indexOnlySource("rust-releases", "https://github.com/rust-lang/rust/releases", "docs"),
      kind: "repo" as const,
    };
    expect(f.canHandle(githubPath)).toBe(true);
  });

  test("HEAD 200 → status: index-only with finalUrl + lastUpdatedAt label", async () => {
    const dir = makeTmpDir("hio-head-");
    let sawMethod = "";
    const ctx = makeCtx(
      dir,
      asFetch((_url, init) => {
        sawMethod = (init.method ?? "GET").toUpperCase();
        return new Response("", {
          status: 200,
          headers: { "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" },
        });
      }),
    );
    const entry = await new HttpIndexOnlyFetcher().fetch(
      indexOnlySource("openai-research", "https://openai.com/research/"),
      ctx,
    );
    expect(sawMethod).toBe("HEAD");
    expect(entry.status).toBe("index-only");
    if (entry.status === "index-only") {
      expect(entry.finalUrl).toBe("https://openai.com/research/");
      expect(entry.indexMeta.lastUpdatedAt).toBe("2026-10-21T07:28:00.000Z");
      expect(entry.indexMeta.label).toBe("https://openai.com/research/");
    }
  });

  test("HEAD 405 → falls back to ranged GET", async () => {
    const dir = makeTmpDir("hio-405-");
    const methods: string[] = [];
    const ctx = makeCtx(
      dir,
      asFetch((_url, init) => {
        const m = (init.method ?? "GET").toUpperCase();
        methods.push(m);
        if (m === "HEAD") return new Response("", { status: 405 });
        return new Response("partial", { status: 206 });
      }),
    );
    const entry = await new HttpIndexOnlyFetcher().fetch(
      indexOnlySource("a16z", "https://a16z.com/ai/"),
      ctx,
    );
    expect(methods).toEqual(["HEAD", "GET"]);
    expect(entry.status).toBe("index-only");
  });

  test("HEAD 404 → status: failed (no fallback, http-error)", async () => {
    const dir = makeTmpDir("hio-404-");
    const ctx = makeCtx(
      dir,
      asFetch(() => new Response("", { status: 404 })),
    );
    const entry = await new HttpIndexOnlyFetcher().fetch(
      indexOnlySource("missing", "https://example.com/missing"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("http-error");
      expect(entry.error.httpStatusCode).toBe(404);
    }
  });

  test("network error → status: failed with network-error code", async () => {
    const dir = makeTmpDir("hio-net-");
    const ctx = makeCtx(
      dir,
      (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    );
    const entry = await new HttpIndexOnlyFetcher().fetch(
      indexOnlySource("nope", "https://nope.example.com"),
      ctx,
    );
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.error.code).toBe("network-error");
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

// ──────────────────────────────────────────────────────────────────────────────
// Pure helpers in github-repo.ts (matchesAny + mediaTypeForPath)
// ──────────────────────────────────────────────────────────────────────────────

describe("matchesAny (github-repo glob matcher)", () => {
  test("exact filename matches", () => {
    expect(matchesAny("README.md", ["README.md"])).toBe(true);
    expect(matchesAny("readme.md", ["README.md"])).toBe(false);
  });

  test("globstar matches subtrees", () => {
    expect(matchesAny("docs/intro.md", ["docs/**"])).toBe(true);
    expect(matchesAny("docs/api/v1/users.md", ["docs/**"])).toBe(true);
    expect(matchesAny("src/main.ts", ["docs/**"])).toBe(false);
  });

  test("bare directory name implies a /** suffix", () => {
    expect(matchesAny("examples/getting-started.md", ["examples"])).toBe(true);
    expect(matchesAny("examples/nested/file.md", ["examples"])).toBe(true);
    expect(matchesAny("test/example.ts", ["examples"])).toBe(false);
  });

  test("trailing slash implies globstar", () => {
    expect(matchesAny("docs/intro.md", ["docs/"])).toBe(true);
  });

  test("multiple patterns: any-match semantics", () => {
    expect(
      matchesAny("docs/intro.md", ["README.md", "src/**", "docs/**"]),
    ).toBe(true);
    expect(
      matchesAny("CHANGELOG.txt", ["README.md", "docs/**"]),
    ).toBe(false);
  });

  test("empty patterns array → never matches", () => {
    expect(matchesAny("anything", [])).toBe(false);
  });
});

describe("mediaTypeForPath", () => {
  test("known extensions", () => {
    expect(mediaTypeForPath("README.md")).toBe("text/markdown");
    expect(mediaTypeForPath("data.json")).toBe("application/json");
    expect(mediaTypeForPath("config.yaml")).toBe("text/yaml");
    expect(mediaTypeForPath("config.yml")).toBe("text/yaml");
    expect(mediaTypeForPath("page.html")).toBe("text/html");
    expect(mediaTypeForPath("src/foo.ts")).toBe("text/plain");
    expect(mediaTypeForPath("script.py")).toBe("text/plain");
  });

  test("unknown extensions fall back to octet-stream", () => {
    expect(mediaTypeForPath("image.png")).toBe("application/octet-stream");
    expect(mediaTypeForPath("noext")).toBe("application/octet-stream");
    expect(mediaTypeForPath("archive.tar.gz")).toBe("application/octet-stream");
  });

  test("case-insensitive on the extension", () => {
    expect(mediaTypeForPath("README.MD")).toBe("text/markdown");
    expect(mediaTypeForPath("CONFIG.YAML")).toBe("text/yaml");
  });
});
