/**
 * Concrete `GithubSearcher` backed by GitHub's REST search API.
 *
 * v0.1: only `type: "repos"` is supported (the planner schema accepts
 * `code`/`issues` for forward-compat but the executor only emits `repos`).
 *
 * The repo search response carries stars, license, and `pushed_at` directly,
 * so a single search call yields everything we need to populate
 * `CandidateMeta.{githubStars, githubLicense, githubLastCommitAt}` without a
 * second round-trip per repo.
 *
 * Auth: uses `GITHUB_TOKEN` from env when present (rate limit 30/min →
 * higher) and falls back to anonymous (10/min). Returning an empty array on
 * 401/403/422 errors lets the executor proceed with whatever it could find;
 * routine network errors yield empty too (logged).
 */

import type {
  GithubSearchHit,
  GithubSearchInput,
  GithubSearcher,
} from "./types.ts";

export interface CreateGithubSearcherOptions {
  /** `fetch`-compatible function. Defaults to global. */
  fetchImpl?: typeof fetch;
  /** GitHub PAT for higher rate limits. Default: `process.env.GITHUB_TOKEN`. */
  token?: string;
  /** Per-request timeout (ms). Default 8000. */
  timeoutMs?: number;
  /** Override the API base. Default `https://api.github.com`. */
  baseUrl?: string;
  /** Logger for soft failures. Default no-op. */
  log?: (event: object) => void;
}

interface GithubSearchRepoItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  license?: { spdx_id?: string | null } | null;
}

interface GithubSearchRepoResponse {
  items?: GithubSearchRepoItem[];
}

/**
 * Build a GitHub-API-backed searcher. Returns an empty result list (rather
 * than throwing) on auth failures, rate limits, and network errors so the
 * executor degrades gracefully.
 */
export function createGithubSearcher(
  opts: CreateGithubSearcherOptions = {},
): GithubSearcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token ?? process.env["GITHUB_TOKEN"];
  const timeoutMs = opts.timeoutMs ?? 8000;
  const baseUrl = opts.baseUrl ?? "https://api.github.com";
  const log = opts.log ?? (() => {});

  return {
    name: "github",
    async search(input: GithubSearchInput): Promise<GithubSearchHit[]> {
      if (input.type !== "repos") {
        log({
          event: "github-searcher:unsupported-type",
          type: input.type,
        });
        return [];
      }
      const perPage = Math.min(Math.max(input.maxResults, 1), 30);
      const url = new URL("/search/repositories", baseUrl);
      url.searchParams.set("q", input.query);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("sort", "stars");
      url.searchParams.set("order", "desc");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchImpl(url.href, {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "almanac-discovery/0.1",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
      } catch (e) {
        clearTimeout(timeout);
        log({
          event: "github-searcher:network-error",
          message: (e as Error).message,
        });
        return [];
      }
      clearTimeout(timeout);

      if (!res.ok) {
        log({
          event: "github-searcher:http-error",
          status: res.status,
          query: input.query,
        });
        return [];
      }

      let body: GithubSearchRepoResponse;
      try {
        body = (await res.json()) as GithubSearchRepoResponse;
      } catch (e) {
        log({
          event: "github-searcher:bad-json",
          message: (e as Error).message,
        });
        return [];
      }

      const items = Array.isArray(body.items) ? body.items : [];
      const hits: GithubSearchHit[] = [];
      for (const it of items.slice(0, input.maxResults)) {
        if (!it.html_url || !it.full_name) continue;
        hits.push({
          url: it.html_url,
          fullName: it.full_name,
          description: it.description ?? null,
          stars: typeof it.stargazers_count === "number" ? it.stargazers_count : 0,
          license: it.license?.spdx_id ?? null,
          lastCommitAt: it.pushed_at ?? null,
        });
      }
      return hits;
    },
  };
}
