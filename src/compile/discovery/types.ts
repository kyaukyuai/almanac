/**
 * Discovery executor — strategy interfaces.
 *
 * The deterministic step that sits between Stage 2a (planner) and Stage 2b
 * (evaluator) consumes a `SourceDiscoveryPlan` and emits `Candidate[]`. It
 * does this by fanning each plan item out through injectable
 * strategies:
 *
 *   - `UrlProber`        : HEAD/GET a URL → title + snippet + preview + meta
 *   - `WebSearcher`      : query string → ordered list of search hits
 *   - `CommunitySearcher`: query string → ordered public community hits
 *   - `GithubSearcher`   : query string → ordered list of github repo hits
 *
 * Concrete adapters live alongside this file:
 *
 *   - `./url-prober.ts`        — `createHttpUrlProber`     (real HTTP)
 *   - `./web-searcher.ts`      — `createNullWebSearcher`   (no-op for keyless dev)
 *                              — `createBraveWebSearcher`  (Brave Search API)
 *   - `./community-searcher.ts` — HN + Reddit public JSON adapters
 *   - `./github-searcher.ts`   — `createGithubSearcher`    (REST search API)
 *
 * The executor itself has no network code; this lets unit tests stub every
 * I/O surface and run the orchestration logic in milliseconds.
 */

import type {
  CandidateMeta,
  FetchStatus,
  SourceKind,
} from "../../core/types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// UrlProber
// ──────────────────────────────────────────────────────────────────────────────

/** A single probed URL's metadata, ready to fold into a `Candidate`. */
export interface ProbeResult {
  /** The URL initially probed (before any redirect). */
  url: string;
  fetchStatus: FetchStatus;
  /** Set when fetchStatus === "redirect"; the URL after the redirect chain. */
  finalUrl?: string;
  /** Page <title>; null when the page didn't return one or fetch failed. */
  title: string | null;
  /** Meta description / OG snippet; null if absent. */
  snippet: string | null;
  /** First ~2000 chars of the body for HTML-ish pages; null otherwise. */
  preview: string | null;
  /** Subset of `CandidateMeta` extractable from the response. */
  meta: CandidateMeta;
}

/**
 * Probes a URL and returns lightweight metadata. Probers MUST never throw
 * for routine network failures; categorize them via `fetchStatus`.
 */
export interface UrlProber {
  readonly name: string;
  probe(url: string): Promise<ProbeResult>;
}

// ──────────────────────────────────────────────────────────────────────────────
// WebSearcher
// ──────────────────────────────────────────────────────────────────────────────

export interface WebSearchHit {
  url: string;
  /** Search-engine title (may be undefined for some engines). */
  title: string | null;
  /** Search-engine snippet, when present. */
  snippet: string | null;
}

export interface WebSearchInput {
  query: string;
  /** Maximum hits to return. The searcher may return fewer. */
  maxResults: number;
  /**
   * Recency hint in days, when the planner asked for "freshest first". The
   * searcher is free to ignore this if its backend lacks a recency knob.
   */
  recencyDays?: number;
  /**
   * Hint about the desired source kind (e.g., the planner expects `news`).
   * Most engines ignore this; some support `site:`-style filters.
   */
  targetKind?: SourceKind | "any";
}

/**
 * Performs a generic web search. Returning an empty array is a valid outcome
 * (e.g., the `NullWebSearcher` always returns []); the executor will simply
 * yield no `web-search` candidates for that query.
 */
export interface WebSearcher {
  readonly name: string;
  search(input: WebSearchInput): Promise<WebSearchHit[]>;
}

// ──────────────────────────────────────────────────────────────────────────────
// CommunitySearcher
// ──────────────────────────────────────────────────────────────────────────────

export interface CommunitySearchInput extends WebSearchInput {
  /**
   * Source of the query in the planner. Providers do not need this for HTTP
   * requests, but the executor uses it to produce precise provenance.
   */
  origin: { type: "direct-probe" | "web-search"; index: number };
}

export interface CommunitySearchHit {
  url: string;
  title: string | null;
  snippet: string | null;
  /**
   * Optional lightweight body text returned by the public API. It is still
   * capped by the executor before becoming `Candidate.preview`.
   */
  preview?: string | null;
  author?: string;
  container?: string;
  publishedAt?: string;
  engagement?: Record<string, number>;
}

/**
 * Performs provider-specific public community search. Implementations should
 * return [] for non-community target kinds and on routine HTTP failures.
 */
export interface CommunitySearcher {
  readonly name: string;
  search(input: CommunitySearchInput): Promise<CommunitySearchHit[]>;
}

// ──────────────────────────────────────────────────────────────────────────────
// GithubSearcher
// ──────────────────────────────────────────────────────────────────────────────

export interface GithubSearchHit {
  /** Canonical repo URL (e.g., `https://github.com/owner/repo`). */
  url: string;
  /** `owner/repo` form. */
  fullName: string;
  description: string | null;
  /** Star count on the date of the search. */
  stars: number;
  /** SPDX id when available (e.g., "Apache-2.0"). */
  license: string | null;
  /** ISO-8601 timestamp of the last commit on the default branch. */
  lastCommitAt: string | null;
}

export interface GithubSearchInput {
  query: string;
  /** v0.1: `repos`. `code` and `issues` are reserved. */
  type: "repos" | "code" | "issues";
  maxResults: number;
}

export interface GithubSearcher {
  readonly name: string;
  search(input: GithubSearchInput): Promise<GithubSearchHit[]>;
}
