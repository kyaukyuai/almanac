/**
 * Discovery executor — between Stage 2a (planner) and Stage 2b (evaluator).
 *
 * Reads a `SourceDiscoveryPlan` and produces `Candidate[]` by:
 *
 *   1. Probing every `directProbes[i].hint` (URL or search query). HTTP URLs
 *      are passed to `UrlProber`; non-URL hints are routed through the
 *      `WebSearcher` (the executor takes the top-1 hit and probes it). The
 *      origin is `direct-probe` either way.
 *
 *   2. Running every `webSearchQueries[i].query` through `WebSearcher`,
 *      taking up to `budgets.maxCandidatesPerKind` results, and probing
 *      each. Origin: `web-search` with `rank`.
 *
 *   3. Running community-targeted queries through public community providers
 *      (Hacker News, Reddit). Provider results already come from JSON APIs, so
 *      they become candidates directly. Origin: `community-search`.
 *
 *   4. Running every `githubQueries[i].query` through `GithubSearcher`,
 *      keeping up to `budgets.maxCandidatesPerKind` repos. GitHub repos are
 *      NOT URL-probed (the search response already carries title /
 *      description / stars / license / pushed_at). Origin: `github` with
 *      `rank`.
 *
 * Cross-cutting:
 *   - Deduplicates candidates by canonical URL across the three buckets;
 *     duplicates from later sources are dropped silently.
 *   - Hard-caps the total at 200 candidates (matches `CandidatesSchema`).
 *   - Pure orchestration; all I/O comes through the injected strategies.
 */

import {
  CandidatesSchema,
  type Candidate,
  type Candidates,
  type SourceDiscoveryPlan,
  type SourceKind,
} from "../../core/types.ts";
import type {
  CommunitySearchHit,
  CommunitySearcher,
  GithubSearcher,
  ProbeResult,
  UrlProber,
  WebSearcher,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────────────

export interface DiscoveryExecutorInput {
  plan: SourceDiscoveryPlan;
  prober: UrlProber;
  webSearcher: WebSearcher;
  communitySearchers?: CommunitySearcher[];
  githubSearcher: GithubSearcher;
  /** Wall-clock provider; injected for deterministic tests. */
  now?: () => Date;
  /** Structured event sink. Default no-op. */
  log?: (event: object) => void;
}

export interface DiscoveryExecutorResult {
  candidates: Candidates;
  /** Per-bucket counts for telemetry / debugging. */
  stats: {
    directProbes: { attempted: number; produced: number };
    webSearch: { queries: number; produced: number };
    communitySearch: { queries: number; providers: number; produced: number };
    github: { queries: number; produced: number };
    deduped: number;
  };
}

/** Hard cap from `CandidatesSchema`. */
export const CANDIDATES_MAX = 200;
const CANDIDATE_TITLE_MAX_CHARS = 300;
const CANDIDATE_SNIPPET_MAX_CHARS = 500;
const CANDIDATE_PREVIEW_MAX_CHARS = 2000;

/**
 * Run the discovery executor end-to-end. The returned `candidates` array is
 * already validated against `CandidatesSchema`.
 */
export async function runDiscoveryExecutor(
  input: DiscoveryExecutorInput,
): Promise<DiscoveryExecutorResult> {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => {});
  const {
    plan,
    prober,
    webSearcher,
    githubSearcher,
    communitySearchers = [],
  } = input;

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let deduped = 0;

  const tryPush = (c: Candidate): boolean => {
    if (candidates.length >= CANDIDATES_MAX) return false;
    const key = canonicalizeUrl(c.url);
    if (seen.has(key)) {
      deduped += 1;
      return false;
    }
    seen.add(key);
    candidates.push(c);
    return true;
  };

  // ── 1. Direct probes ─────────────────────────────────────────────────────
  let directProduced = 0;
  let communityProduced = 0;
  let communityQueries = 0;
  for (let i = 0; i < plan.directProbes.length; i++) {
    if (candidates.length >= CANDIDATES_MAX) break;
    const probe = plan.directProbes[i]!;
    if (!isUrl(probe.hint) && probe.kind === "community") {
      communityQueries += 1;
      for (const searcher of communitySearchers) {
        if (candidates.length >= CANDIDATES_MAX) break;
        const communityHits = await safeCommunitySearch(searcher, log, {
          query: probe.hint,
          maxResults: 1,
          targetKind: probe.kind,
          origin: { type: "direct-probe", index: i },
        });
        const produced = pushCommunityHits({
          hits: communityHits,
          provider: searcher.name,
          origin: { type: "direct-probe", index: i },
          now,
          tryPush,
        });
        communityProduced += produced;
        directProduced += produced;
      }
    }
    let url: string | null;
    if (isUrl(probe.hint)) {
      url = probe.hint;
    } else {
      // Hint is a search query — let the web searcher resolve it; take the
      // top hit so we still surface ONE candidate per direct probe.
      const hits = await safeWebSearch(webSearcher, log, {
        query: probe.hint,
        maxResults: 1,
        targetKind: probe.kind,
      });
      url = hits[0]?.url ?? null;
    }
    if (url === null) continue;
    const result = await safeProbe(prober, log, url);
    const candidate = buildCandidate({
      probeResult: result,
      kind: probe.kind,
      origin: { type: "direct-probe", probeIndex: i },
      now,
    });
    if (tryPush(candidate)) directProduced += 1;
  }

  // ── 2. Web search queries ────────────────────────────────────────────────
  let webProduced = 0;
  const perQuery = Math.max(1, plan.budgets.maxCandidatesPerKind);
  for (let i = 0; i < plan.webSearchQueries.length; i++) {
    if (candidates.length >= CANDIDATES_MAX) break;
    const wq = plan.webSearchQueries[i]!;
    const hits = await safeWebSearch(webSearcher, log, {
      query: wq.query,
      maxResults: perQuery,
      ...(wq.recencyDays !== null ? { recencyDays: wq.recencyDays } : {}),
      targetKind: wq.targetKind,
    });
    for (let rank = 0; rank < hits.length; rank++) {
      if (candidates.length >= CANDIDATES_MAX) break;
      const hit = hits[rank]!;
      const result = await safeProbe(prober, log, hit.url);
      // Web search results carry their own title/snippet which are usually
      // BETTER than what the page returns; prefer them when present.
      const merged: ProbeResult = {
        ...result,
        title: result.title ?? hit.title ?? null,
        snippet: result.snippet ?? hit.snippet ?? null,
      };
      const kind: SourceKind =
        wq.targetKind === "any" ? "docs" : wq.targetKind;
      const candidate = buildCandidate({
        probeResult: merged,
        kind,
        origin: { type: "web-search", queryIndex: i, rank },
        now,
      });
      if (tryPush(candidate)) webProduced += 1;
    }

    if (wq.targetKind === "community" || wq.targetKind === "any") {
      communityQueries += 1;
      for (const searcher of communitySearchers) {
        if (candidates.length >= CANDIDATES_MAX) break;
        const communityHits = await safeCommunitySearch(searcher, log, {
          query: wq.query,
          maxResults: perQuery,
          ...(wq.recencyDays !== null ? { recencyDays: wq.recencyDays } : {}),
          targetKind: wq.targetKind,
          origin: { type: "web-search", index: i },
        });
        communityProduced += pushCommunityHits({
          hits: communityHits,
          provider: searcher.name,
          origin: { type: "web-search", index: i },
          now,
          tryPush,
        });
      }
    }
  }

  // ── 3. GitHub queries ────────────────────────────────────────────────────
  let githubProduced = 0;
  for (let i = 0; i < plan.githubQueries.length; i++) {
    if (candidates.length >= CANDIDATES_MAX) break;
    const gq = plan.githubQueries[i]!;
    const hits = await safeGithubSearch(githubSearcher, log, {
      query: gq.query,
      type: gq.type,
      maxResults: perQuery,
    });
    for (let rank = 0; rank < hits.length; rank++) {
      if (candidates.length >= CANDIDATES_MAX) break;
      const hit = hits[rank]!;
      const candidate: Candidate = {
        url: hit.url,
        kind: "repo",
        title: clampNullableText(hit.fullName, CANDIDATE_TITLE_MAX_CHARS),
        snippet: clampNullableText(hit.description, CANDIDATE_SNIPPET_MAX_CHARS),
        // Repos don't get an HTML preview — see CandidateSchema docs.
        preview: null,
        fetchedAt: now().toISOString(),
        fetchStatus: "ok",
        origin: { type: "github", queryIndex: i, rank },
        meta: {
          githubStars: hit.stars,
          ...(hit.license !== null ? { githubLicense: hit.license } : {}),
          ...(hit.lastCommitAt !== null
            ? { githubLastCommitAt: hit.lastCommitAt }
            : {}),
        },
      };
      if (tryPush(candidate)) githubProduced += 1;
    }
  }

  // Validate before returning so downstream stages can trust the shape.
  const validated = CandidatesSchema.parse(candidates);

  return {
    candidates: validated,
    stats: {
      directProbes: {
        attempted: plan.directProbes.length,
        produced: directProduced,
      },
      webSearch: {
        queries: plan.webSearchQueries.length,
        produced: webProduced,
      },
      communitySearch: {
        queries: communityQueries,
        providers: communitySearchers.length,
        produced: communityProduced,
      },
      github: {
        queries: plan.githubQueries.length,
        produced: githubProduced,
      },
      deduped,
    },
  };
}

function pushCommunityHits(input: {
  hits: CommunitySearchHit[];
  provider: string;
  origin: { type: "direct-probe" | "web-search"; index: number };
  now: () => Date;
  tryPush: (candidate: Candidate) => boolean;
}): number {
  let produced = 0;
  for (let rank = 0; rank < input.hits.length; rank++) {
    const hit = input.hits[rank]!;
    const candidate: Candidate = {
      url: hit.url,
      kind: "community",
      title: clampNullableText(hit.title, CANDIDATE_TITLE_MAX_CHARS),
      snippet: clampNullableText(hit.snippet, CANDIDATE_SNIPPET_MAX_CHARS),
      preview: clampNullableText(hit.preview ?? null, CANDIDATE_PREVIEW_MAX_CHARS),
      fetchedAt: input.now().toISOString(),
      fetchStatus: "ok",
      origin: {
        type: "community-search",
        provider: input.provider,
        inputType: input.origin.type,
        inputIndex: input.origin.index,
        rank,
      },
      meta: {
        discoveryProvider: input.provider,
        ...(hit.author !== undefined ? { author: hit.author } : {}),
        ...(hit.container !== undefined ? { container: hit.container } : {}),
        ...(hit.publishedAt !== undefined ? { publishedAt: hit.publishedAt } : {}),
        ...(hit.engagement !== undefined ? { engagement: hit.engagement } : {}),
      },
    };
    if (input.tryPush(candidate)) produced += 1;
  }
  return produced;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert a `ProbeResult` plus origin metadata into a `Candidate`. Pure;
 * does not mutate the result. The `kind` is supplied by the caller because
 * it depends on the planner's intent (per-bucket).
 */
function buildCandidate(input: {
  probeResult: ProbeResult;
  kind: SourceKind;
  origin: Candidate["origin"];
  now: () => Date;
}): Candidate {
  const { probeResult: r, kind, origin, now } = input;
  // CandidateSchema requires preview === null when fetchStatus is not
  // "ok"/"redirect"; clamp here so the orchestrator never produces a body
  // that fails validation.
  const preview =
    r.fetchStatus === "ok" || r.fetchStatus === "redirect" ? r.preview : null;
  return {
    url: r.url,
    kind,
    title: clampNullableText(r.title, CANDIDATE_TITLE_MAX_CHARS),
    snippet: clampNullableText(r.snippet, CANDIDATE_SNIPPET_MAX_CHARS),
    preview: clampNullableText(preview, CANDIDATE_PREVIEW_MAX_CHARS),
    fetchedAt: now().toISOString(),
    fetchStatus: r.fetchStatus,
    ...(r.finalUrl !== undefined ? { finalUrl: r.finalUrl } : {}),
    origin,
    meta: r.meta,
  };
}

function clampNullableText(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * Canonicalize a URL for deduplication. Drops the fragment, lowercases the
 * host, and strips a trailing slash on the path. Bad URLs return their raw
 * input as a fallback so we still dedupe on string equality.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function safeProbe(
  prober: UrlProber,
  log: (e: object) => void,
  url: string,
): Promise<ProbeResult> {
  try {
    return await prober.probe(url);
  } catch (e) {
    log({
      event: "discovery:probe:threw",
      url,
      message: (e as Error).message,
    });
    // Fabricate a network-error probe so the executor still produces a
    // candidate; the evaluator can reject it later.
    return {
      url,
      fetchStatus: "network-error",
      title: null,
      snippet: null,
      preview: null,
      meta: {},
    };
  }
}

async function safeWebSearch(
  searcher: WebSearcher,
  log: (e: object) => void,
  input: Parameters<WebSearcher["search"]>[0],
) {
  try {
    return await searcher.search(input);
  } catch (e) {
    log({
      event: "discovery:web-search:threw",
      query: input.query,
      message: (e as Error).message,
    });
    return [];
  }
}

async function safeCommunitySearch(
  searcher: CommunitySearcher,
  log: (e: object) => void,
  input: Parameters<CommunitySearcher["search"]>[0],
) {
  try {
    return await searcher.search(input);
  } catch (e) {
    log({
      event: "discovery:community-search:threw",
      provider: searcher.name,
      query: input.query,
      message: (e as Error).message,
    });
    return [];
  }
}

async function safeGithubSearch(
  searcher: GithubSearcher,
  log: (e: object) => void,
  input: Parameters<GithubSearcher["search"]>[0],
) {
  try {
    return await searcher.search(input);
  } catch (e) {
    log({
      event: "discovery:github-search:threw",
      query: input.query,
      message: (e as Error).message,
    });
    return [];
  }
}
