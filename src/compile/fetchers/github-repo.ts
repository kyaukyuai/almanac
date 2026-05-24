/**
 * GitHub repository fetcher — handles `kind: repo`.
 *
 * Strategy:
 *   - Parse `https://github.com/<owner>/<repo>` from `source.url`.
 *   - Hit `https://api.github.com/repos/<owner>/<repo>` for the default
 *     branch and metadata.
 *   - Hit `https://api.github.com/repos/<owner>/<repo>/commits/<branch>` for
 *     the HEAD commit SHA + author timestamp.
 *   - Returns an `index-only` entry whose `indexMeta` carries the SHA.
 *
 * No raw bytes are written. v0.1 supports the `index-only` mode end-to-end;
 * when the evaluator picks `mode: "snapshot"` for a permissively-licensed
 * repo (per `evaluator-v1.md`), this fetcher still produces only the
 * index-only metadata above and emits a `degraded-to-index-only` log event.
 * Implementing real repo snapshot — walking `ingestion.scope` globs via the
 * GitHub Trees / Contents API — is tracked for v0.2.
 *
 * Authentication: if `process.env.GITHUB_TOKEN` is set, it is forwarded as a
 * `Bearer` header. The orchestrator does not inject secrets per source for
 * v0.1; this is the simplest place for the token to land.
 */

import {
  FetcherMisroutedError,
  type FetchContext,
  type Fetcher,
} from "./types.ts";
import type {
  ApprovedSource,
  SourceFetchEntry,
} from "../../core/types.ts";

const REPO_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:\.git)?\/?$/i;

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
    if (source.ingestion.mode === "snapshot") {
      ctx.log({
        event: "fetcher:github:degraded-to-index-only",
        sourceId: source.id,
        reason:
          "snapshot mode not implemented for repos in v0.1; emitting index-only metadata",
      });
    }
    const m = REPO_URL_RE.exec(source.url)!;
    const owner = m[1]!;
    const repo = m[2]!.replace(/\.git$/i, "");

    const attemptedAt = ctx.now().toISOString();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "almanac/0.1 (compile pipeline)",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token && token.length > 0) {
      headers.authorization = `Bearer ${token}`;
    }

    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const repoRes = await safeJsonFetch(ctx, repoUrl, headers);
    if (!repoRes.ok) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: repoRes.error,
      };
    }
    const repoJson = repoRes.value as {
      default_branch?: unknown;
      pushed_at?: unknown;
      name?: unknown;
      full_name?: unknown;
      stargazers_count?: unknown;
    };
    const defaultBranch =
      typeof repoJson.default_branch === "string"
        ? repoJson.default_branch
        : "main";

    const commitUrl = `${repoUrl}/commits/${encodeURIComponent(defaultBranch)}`;
    const commitRes = await safeJsonFetch(ctx, commitUrl, headers);
    if (!commitRes.ok) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: commitRes.error,
      };
    }
    const commitJson = commitRes.value as {
      sha?: unknown;
      commit?: { author?: { date?: unknown } };
    };
    const sha = typeof commitJson.sha === "string" ? commitJson.sha : null;
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "parse-error",
          message: `expected sha-1 commit SHA from ${commitUrl}, got ${typeof commitJson.sha}`,
          retryable: false,
          attempts: 1,
        },
      };
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

    ctx.log({
      event: "fetcher:github:ok",
      sourceId: source.id,
      sha,
      defaultBranch,
    });

    const fetchedAt = ctx.now().toISOString();
    return {
      sourceId: source.id,
      status: "index-only",
      fetchedAt,
      finalUrl: source.url,
      fetcher: this.name,
      indexMeta: {
        commitSha: sha,
        ...(lastUpdatedAt !== undefined ? { lastUpdatedAt } : {}),
        label,
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────────

type SafeJsonResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: import("../../core/types.ts").SourceFetchError;
    };

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
        message:
          (e instanceof Error ? e.message : String(e)).slice(0, 2000),
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
        message:
          `JSON parse error from ${url}: ${(e as Error).message}`.slice(0, 2000),
        retryable: false,
        attempts: 1,
      },
    };
  }
  return { ok: true, value };
}
