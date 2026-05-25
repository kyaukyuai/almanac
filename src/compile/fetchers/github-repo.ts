/**
 * GitHub repository fetcher — handles `kind: repo`.
 *
 * Two ingestion modes are supported:
 *
 *   - `index-only` — record only the HEAD commit SHA + repo metadata.
 *     No blobs are downloaded. The runtime advertises the repo via
 *     `indexMeta.label`; downstream stages cite it but cannot ground
 *     answers in its file contents.
 *
 *   - `snapshot` — walk the repo's HEAD tree, filter file paths against
 *     `ingestion.scope` minimatch globs, fetch each matching file via
 *     `raw.githubusercontent.com`, write the bytes to `sources/raw/`,
 *     and emit a `FetchedDocument` per file. Used for permissively-
 *     licensed repos that we're allowed to mirror verbatim.
 *
 *     Caps:
 *       - at most `SNAPSHOT_MAX_FILES` files per repo
 *       - at most `SNAPSHOT_MAX_TOTAL_BYTES` total across all files
 *       - per-file size capped at `ctx.maxBytes`
 *     When `ingestion.scope` matches zero files we fall back to
 *     `index-only` rather than fail the stage — the repo is still
 *     citable, just thinner.
 *
 * Authentication: if `process.env.GITHUB_TOKEN` is set, it is forwarded as a
 * `Bearer` header. The orchestrator does not inject secrets per source for
 * v0.1; this is the simplest place for the token to land.
 */

import { Glob } from "bun";

import {
  FetcherMisroutedError,
  type FetchContext,
  type Fetcher,
} from "./types.ts";
import type {
  ApprovedSource,
  FetchedDocument,
  SourceFetchEntry,
  SourceFetchError,
} from "../../core/types.ts";

const REPO_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:\.git)?\/?$/i;

/** Hard caps for the snapshot path. */
export const SNAPSHOT_MAX_FILES = 50;
export const SNAPSHOT_MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MiB

export class GithubRepoFetcher implements Fetcher {
  readonly name = "github-repo";

  canHandle(source: ApprovedSource): boolean {
    return (
      source.kind === "repo" &&
      (source.ingestion.mode === "index-only" ||
        source.ingestion.mode === "snapshot") &&
      REPO_URL_RE.test(source.url)
    );
  }

  async fetch(
    source: ApprovedSource,
    ctx: FetchContext,
  ): Promise<SourceFetchEntry> {
    if (!this.canHandle(source)) {
      throw new FetcherMisroutedError(this.name, source.id);
    }

    const m = REPO_URL_RE.exec(source.url)!;
    const owner = m[1]!;
    const repo = m[2]!.replace(/\.git$/i, "");
    const attemptedAt = ctx.now().toISOString();
    const headers = makeHeaders();

    // 1. repo metadata — gives us the default branch + the canonical label.
    const repoApiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const repoRes = await safeJsonFetch(ctx, repoApiUrl, headers);
    if (!repoRes.ok) {
      return failed(source.id, this.name, attemptedAt, repoRes.error);
    }
    const repoJson = repoRes.value as {
      default_branch?: unknown;
      pushed_at?: unknown;
      full_name?: unknown;
    };
    const defaultBranch =
      typeof repoJson.default_branch === "string"
        ? repoJson.default_branch
        : "main";

    // 2. HEAD commit on the default branch — sha + author timestamp.
    const commitUrl = `${repoApiUrl}/commits/${encodeURIComponent(defaultBranch)}`;
    const commitRes = await safeJsonFetch(ctx, commitUrl, headers);
    if (!commitRes.ok) {
      return failed(source.id, this.name, attemptedAt, commitRes.error);
    }
    const commitJson = commitRes.value as {
      sha?: unknown;
      commit?: { author?: { date?: unknown } };
    };
    const sha = typeof commitJson.sha === "string" ? commitJson.sha : null;
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
      return failed(source.id, this.name, attemptedAt, {
        code: "parse-error",
        message: `expected sha-1 commit SHA from ${commitUrl}, got ${typeof commitJson.sha}`,
        retryable: false,
        attempts: 1,
      });
    }
    const lastUpdatedRaw =
      typeof commitJson.commit?.author?.date === "string"
        ? commitJson.commit.author.date
        : typeof repoJson.pushed_at === "string"
          ? repoJson.pushed_at
          : null;
    const lastUpdatedAt =
      lastUpdatedRaw && Number.isFinite(Date.parse(lastUpdatedRaw))
        ? new Date(Date.parse(lastUpdatedRaw)).toISOString()
        : undefined;

    const labelParts: string[] = [];
    if (typeof repoJson.full_name === "string") labelParts.push(repoJson.full_name);
    labelParts.push(`@${defaultBranch}`);
    labelParts.push(sha.slice(0, 7));
    const label = labelParts.join(" ").slice(0, 200);

    if (source.ingestion.mode === "index-only") {
      ctx.log({
        event: "fetcher:github:ok",
        sourceId: source.id,
        sha,
        defaultBranch,
        mode: "index-only",
      });
      return buildIndexOnly(source.id, this.name, ctx.now(), source.url, {
        sha,
        ...(lastUpdatedAt !== undefined ? { lastUpdatedAt } : {}),
        label,
      });
    }

    // 3. snapshot: list the tree at HEAD, filter, fetch each file.
    const treeUrl = `${repoApiUrl}/git/trees/${sha}?recursive=1`;
    const treeRes = await safeJsonFetch(ctx, treeUrl, headers);
    if (!treeRes.ok) {
      return failed(source.id, this.name, attemptedAt, treeRes.error);
    }
    const treeJson = treeRes.value as {
      tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }>;
      truncated?: unknown;
    };
    const tree = Array.isArray(treeJson.tree) ? treeJson.tree : [];
    const blobs = tree.filter(
      (t) =>
        t.type === "blob" &&
        typeof t.path === "string" &&
        typeof t.size === "number",
    ) as Array<{ path: string; type: "blob"; size: number }>;

    const patterns =
      source.ingestion.scope.length > 0 ? source.ingestion.scope : ["/"];
    const matched = blobs
      .filter((b) => matchesAny(b.path, patterns))
      .filter((b) => b.size <= ctx.maxBytes)
      .slice(0, SNAPSHOT_MAX_FILES);

    if (matched.length === 0) {
      ctx.log({
        event: "fetcher:github:snapshot-empty",
        sourceId: source.id,
        reason:
          "no files in HEAD tree matched ingestion.scope; falling back to index-only",
        patterns,
        blobsInTree: blobs.length,
      });
      return buildIndexOnly(source.id, this.name, ctx.now(), source.url, {
        sha,
        ...(lastUpdatedAt !== undefined ? { lastUpdatedAt } : {}),
        label,
      });
    }

    const fetchedAt = ctx.now().toISOString();
    const documents: FetchedDocument[] = [];
    let totalBytes = 0;
    for (const blob of matched) {
      if (totalBytes >= SNAPSHOT_MAX_TOTAL_BYTES) {
        ctx.log({
          event: "fetcher:github:snapshot-total-bytes-cap-hit",
          sourceId: source.id,
          totalBytes,
          remainingFiles: matched.length - documents.length,
        });
        break;
      }
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${blob.path}`;
      const blobRes = await safeBytesFetch(ctx, rawUrl, {
        "user-agent": "almanac/0.1 (compile pipeline)",
        accept: "*/*",
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      });
      if (!blobRes.ok) {
        ctx.log({
          event: "fetcher:github:snapshot-blob-skipped",
          sourceId: source.id,
          path: blob.path,
          code: blobRes.error.code,
          message: blobRes.error.message,
        });
        continue;
      }
      const mediaType = mediaTypeForPath(blob.path);
      const written = await ctx.writeRaw({
        bytes: blobRes.bytes,
        mediaType,
      });
      const doc: FetchedDocument = {
        contentHash: written.contentHash,
        relPath: written.relPath,
        url: rawUrl,
        mediaType,
        byteLength: written.byteLength,
        fetchedAt,
        ...(lastUpdatedAt !== undefined ? { sourceTimestamp: lastUpdatedAt } : {}),
        title: blob.path.slice(0, 300),
      };
      documents.push(doc);
      totalBytes += written.byteLength;
    }

    if (documents.length === 0) {
      // All blobs we tried to fetch errored. Fall back to index-only — same
      // as the "no files matched" branch above.
      ctx.log({
        event: "fetcher:github:snapshot-empty",
        sourceId: source.id,
        reason: "all matched blobs failed to fetch; falling back to index-only",
        patterns,
        matchedInTree: matched.length,
      });
      return buildIndexOnly(source.id, this.name, ctx.now(), source.url, {
        sha,
        ...(lastUpdatedAt !== undefined ? { lastUpdatedAt } : {}),
        label,
      });
    }

    ctx.log({
      event: "fetcher:github:ok",
      sourceId: source.id,
      sha,
      defaultBranch,
      mode: "snapshot",
      documents: documents.length,
      totalBytes,
      truncated: treeJson.truncated === true,
    });

    return {
      sourceId: source.id,
      status: "fetched",
      fetchedAt,
      finalUrl: source.url,
      fetcher: this.name,
      documents,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "almanac/0.1 (compile pipeline)",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function failed(
  sourceId: string,
  fetcher: string,
  attemptedAt: string,
  error: SourceFetchError,
): SourceFetchEntry {
  return { sourceId, status: "failed", attemptedAt, fetcher, error };
}

function buildIndexOnly(
  sourceId: string,
  fetcher: string,
  now: Date,
  finalUrl: string,
  indexMeta: { sha: string; lastUpdatedAt?: string; label: string },
): SourceFetchEntry {
  return {
    sourceId,
    status: "index-only",
    fetchedAt: now.toISOString(),
    finalUrl,
    fetcher,
    indexMeta: {
      commitSha: indexMeta.sha,
      ...(indexMeta.lastUpdatedAt !== undefined
        ? { lastUpdatedAt: indexMeta.lastUpdatedAt }
        : {}),
      label: indexMeta.label,
    },
  };
}

/**
 * Match a path against ANY of the supplied patterns. Patterns ending with
 * `/` or `/**` are treated as directory matches (so `docs/` is equivalent to
 * `docs/**`). Exact filenames match exactly (e.g., `README.md`).
 *
 * Uses Bun's built-in `Glob`; no extra dependency.
 */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    if (raw.length === 0) continue;
    let pattern = raw;
    // Normalize "docs/" → "docs/**", "docs" (no slash, no glob) stays as exact.
    if (pattern.endsWith("/")) pattern = pattern + "**";
    // Strip a leading "./".
    pattern = pattern.replace(/^\.?\/+/, "");
    if (pattern.length === 0) continue;
    const g = new Glob(pattern);
    if (g.match(path)) return true;
    // A bare directory name with no glob magic (e.g., "examples") matches
    // anything under it as well — convenience shorthand.
    if (!/[*?[\]{}]/.test(pattern) && !pattern.includes("/")) {
      const dirGlob = new Glob(`${pattern}/**`);
      if (dirGlob.match(path)) return true;
    }
  }
  return false;
}

/**
 * Crude media-type inference from a file extension. Conservative — anything
 * we don't recognize falls back to `application/octet-stream` so writeRaw's
 * EXT_BY_MIME table maps it to `.bin`.
 */
export function mediaTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "text/yaml";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".rst")) return "text/plain";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rb") ||
    lower.endsWith(".go") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".java") ||
    lower.endsWith(".c") ||
    lower.endsWith(".h") ||
    lower.endsWith(".cpp") ||
    lower.endsWith(".sh")
  ) {
    return "text/plain";
  }
  return "application/octet-stream";
}

type SafeJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: SourceFetchError };

async function safeJsonFetch(
  ctx: FetchContext,
  url: string,
  headers: Record<string, string>,
): Promise<SafeJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (e) {
    clearTimeout(timeout);
    const isTimeout = (e as { name?: string }).name === "AbortError";
    return {
      ok: false,
      error: {
        code: isTimeout ? "timeout" : "network-error",
        message: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
        retryable: true,
        attempts: 1,
      },
    };
  }
  clearTimeout(timeout);
  if (res.status === 429 || res.status === 403) {
    return {
      ok: false,
      error: {
        code: "rate-limited",
        message: `GitHub returned HTTP ${res.status} for ${url}`,
        httpStatusCode: res.status,
        retryable: true,
        attempts: 1,
      },
    };
  }
  if (res.status >= 400) {
    return {
      ok: false,
      error: {
        code: "http-error",
        message: `HTTP ${res.status} from ${url}`,
        httpStatusCode: res.status,
        retryable: res.status >= 500,
        attempts: 1,
      },
    };
  }
  let value: unknown;
  try {
    value = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "parse-error",
        message: `JSON parse error from ${url}: ${(e as Error).message}`.slice(
          0,
          2000,
        ),
        retryable: false,
        attempts: 1,
      },
    };
  }
  return { ok: true, value };
}

type SafeBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: SourceFetchError };

async function safeBytesFetch(
  ctx: FetchContext,
  url: string,
  headers: Record<string, string>,
): Promise<SafeBytesResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (e) {
    clearTimeout(timeout);
    const isTimeout = (e as { name?: string }).name === "AbortError";
    return {
      ok: false,
      error: {
        code: isTimeout ? "timeout" : "network-error",
        message: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
        retryable: true,
        attempts: 1,
      },
    };
  }
  clearTimeout(timeout);
  if (res.status === 429 || res.status === 403) {
    return {
      ok: false,
      error: {
        code: "rate-limited",
        message: `raw.githubusercontent.com returned HTTP ${res.status}`,
        httpStatusCode: res.status,
        retryable: true,
        attempts: 1,
      },
    };
  }
  if (res.status >= 400) {
    return {
      ok: false,
      error: {
        code: "http-error",
        message: `HTTP ${res.status} from ${url}`,
        httpStatusCode: res.status,
        retryable: res.status >= 500,
        attempts: 1,
      },
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "parse-error",
        message: `failed to read body from ${url}: ${(e as Error).message}`.slice(
          0,
          2000,
        ),
        retryable: true,
        attempts: 1,
      },
    };
  }
  if (bytes.byteLength > ctx.maxBytes) {
    return {
      ok: false,
      error: {
        code: "too-large",
        message: `body exceeds maxBytes (${bytes.byteLength} > ${ctx.maxBytes})`,
        retryable: false,
        attempts: 1,
      },
    };
  }
  return { ok: true, bytes };
}
