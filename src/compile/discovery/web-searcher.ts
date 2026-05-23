/**
 * `WebSearcher` adapters.
 *
 *   - `createNullWebSearcher`  : always returns []. The default when no search
 *                                backend is configured. Lets the discovery
 *                                executor degrade gracefully (it just emits no
 *                                `web-search` candidates).
 *   - `createBraveWebSearcher` : Brave Search API. Cheapest commercial option
 *                                with a free tier and a simple JSON contract.
 *                                Activated when `BRAVE_SEARCH_API_KEY` is set.
 *
 * Both adapters return an empty array on any error — the executor keeps
 * making progress with whatever it could discover from URL probes and GitHub.
 */

import type {
  WebSearchHit,
  WebSearchInput,
  WebSearcher,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Null
// ──────────────────────────────────────────────────────────────────────────────

/**
 * No-op searcher. Useful as the default when no real search backend is
 * configured — keeps Stage 2 functional (it'll just have no `web-search`
 * candidates to evaluate).
 */
export function createNullWebSearcher(): WebSearcher {
  return {
    name: "null",
    async search(_input: WebSearchInput): Promise<WebSearchHit[]> {
      return [];
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Brave Search
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateBraveWebSearcherOptions {
  /** Brave Search API key. Defaults to `process.env.BRAVE_SEARCH_API_KEY`. */
  apiKey?: string;
  /** `fetch`-compatible function. Defaults to global. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 8000. */
  timeoutMs?: number;
  /** Override the API base. Default `https://api.search.brave.com`. */
  baseUrl?: string;
  /** Logger for soft failures. Default no-op. */
  log?: (event: object) => void;
}

interface BraveSearchResultItem {
  url?: string;
  title?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveSearchResultItem[] };
}

/**
 * Brave Search API adapter. Returns up to `input.maxResults` hits per query.
 *
 * Honors `recencyDays` by mapping to Brave's `freshness` parameter
 * (`pd` = past day, `pw` = past week, `pm` = past month, `py` = past year);
 * any value > 365 falls back to no recency filter.
 *
 * Returns `[]` on missing key, network error, or non-2xx response.
 */
export function createBraveWebSearcher(
  opts: CreateBraveWebSearcherOptions = {},
): WebSearcher {
  const apiKey = opts.apiKey ?? process.env["BRAVE_SEARCH_API_KEY"];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const baseUrl = opts.baseUrl ?? "https://api.search.brave.com";
  const log = opts.log ?? (() => {});

  return {
    name: "brave",
    async search(input: WebSearchInput): Promise<WebSearchHit[]> {
      if (!apiKey) {
        log({ event: "web-searcher:no-api-key", backend: "brave" });
        return [];
      }
      const url = new URL("/res/v1/web/search", baseUrl);
      url.searchParams.set("q", input.query);
      url.searchParams.set("count", String(Math.min(input.maxResults, 20)));
      const freshness = mapBraveFreshness(input.recencyDays);
      if (freshness) url.searchParams.set("freshness", freshness);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchImpl(url.href, {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "x-subscription-token": apiKey,
            "user-agent": "almanac-discovery/0.1",
          },
        });
      } catch (e) {
        clearTimeout(timeout);
        log({
          event: "web-searcher:network-error",
          backend: "brave",
          message: (e as Error).message,
        });
        return [];
      }
      clearTimeout(timeout);

      if (!res.ok) {
        log({
          event: "web-searcher:http-error",
          backend: "brave",
          status: res.status,
          query: input.query,
        });
        return [];
      }

      let body: BraveSearchResponse;
      try {
        body = (await res.json()) as BraveSearchResponse;
      } catch (e) {
        log({
          event: "web-searcher:bad-json",
          backend: "brave",
          message: (e as Error).message,
        });
        return [];
      }

      const items = body.web?.results ?? [];
      const hits: WebSearchHit[] = [];
      for (const it of items.slice(0, input.maxResults)) {
        if (!it.url) continue;
        hits.push({
          url: it.url,
          title: it.title ?? null,
          snippet: it.description ?? null,
        });
      }
      return hits;
    },
  };
}

/** Map a recencyDays hint to Brave's coarse `freshness` enum. */
export function mapBraveFreshness(
  days: number | undefined,
): "pd" | "pw" | "pm" | "py" | undefined {
  if (days === undefined || days <= 0) return undefined;
  if (days <= 1) return "pd";
  if (days <= 7) return "pw";
  if (days <= 31) return "pm";
  if (days <= 365) return "py";
  return undefined;
}
