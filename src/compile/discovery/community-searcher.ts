/**
 * Public community-source discovery adapters.
 *
 * These adapters intentionally return lightweight candidates only. They use
 * public JSON endpoints, attach native engagement metrics as metadata, and
 * never throw on routine upstream failures so Stage 2 discovery can keep
 * progressing with other sources.
 */

import type {
  CommunitySearchHit,
  CommunitySearchInput,
  CommunitySearcher,
} from "./types.ts";

export interface CreateCommunitySearcherOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: (event: object) => void;
}

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = "almanac-discovery/0.1";

// ──────────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────────

export function createDefaultCommunitySearchers(
  opts: CreateCommunitySearcherOptions = {},
): CommunitySearcher[] {
  return [
    createHackerNewsCommunitySearcher(opts),
    createRedditCommunitySearcher(opts),
  ];
}

function allowsCommunity(input: CommunitySearchInput): boolean {
  return input.targetKind === undefined ||
    input.targetKind === "any" ||
    input.targetKind === "community";
}

// ──────────────────────────────────────────────────────────────────────────────
// Hacker News (Algolia public API)
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateHackerNewsCommunitySearcherOptions
  extends CreateCommunitySearcherOptions {
  baseUrl?: string;
}

interface HnAlgoliaHit {
  objectID?: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
}

interface HnAlgoliaResponse {
  hits?: HnAlgoliaHit[];
}

export function createHackerNewsCommunitySearcher(
  opts: CreateHackerNewsCommunitySearcherOptions = {},
): CommunitySearcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const baseUrl = opts.baseUrl ?? "https://hn.algolia.com";

  return {
    name: "hackernews",
    async search(input: CommunitySearchInput): Promise<CommunitySearchHit[]> {
      if (!allowsCommunity(input)) return [];
      if (isRedditIntent(input.query)) return [];

      const query = normalizeCommunityQuery(input.query);
      if (!query) return [];
      const url = new URL("/api/v1/search", baseUrl);
      url.searchParams.set("query", query);
      url.searchParams.set("tags", "story");
      url.searchParams.set("hitsPerPage", String(Math.min(input.maxResults, 30)));
      const numericFilters = hnNumericFilters(input.recencyDays, now());
      if (numericFilters) url.searchParams.set("numericFilters", numericFilters);

      const body = await fetchJson<HnAlgoliaResponse>({
        fetchImpl,
        url: url.href,
        timeoutMs,
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        log,
        provider: "hackernews",
      });
      if (!body) return [];

      const hits = Array.isArray(body.hits) ? body.hits : [];
      const out: CommunitySearchHit[] = [];
      for (const hit of hits) {
        if (out.length >= input.maxResults) break;
        if (!hit.objectID) continue;
        const title = hit.title ?? hit.story_title ?? null;
        if (!title) continue;
        const previewText = stripHtml(hit.story_text ?? hit.comment_text ?? "");
        const externalUrl = hit.url ? ` External URL: ${hit.url}` : "";
        const snippetText = [
          title,
          hit.url ?? "",
          previewText,
        ].join(" ");
        if (!matchesQueryTokens(input.query, snippetText)) continue;
        const points = numberOrUndefined(hit.points);
        const comments = numberOrUndefined(hit.num_comments);
        const publishedAt = normalizeIsoTimestamp(hit.created_at ?? undefined);
        out.push({
          url: `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`,
          title,
          snippet: [
            `Hacker News discussion`,
            hit.author ? `by ${hit.author}` : null,
            points !== undefined ? `${points} points` : null,
            comments !== undefined ? `${comments} comments` : null,
          ].filter(Boolean).join("; ") + externalUrl,
          preview: previewText.slice(0, 2000) || null,
          ...(hit.author ? { author: hit.author } : {}),
          container: "news.ycombinator.com",
          ...(publishedAt ? { publishedAt } : {}),
          engagement: {
            ...(points !== undefined ? { points } : {}),
            ...(comments !== undefined ? { comments } : {}),
          },
        });
      }
      return out;
    },
  };
}

function hnNumericFilters(
  recencyDays: number | undefined,
  now: Date,
): string | undefined {
  if (recencyDays === undefined || recencyDays <= 0) return undefined;
  const from = Math.floor((now.getTime() - recencyDays * 86_400_000) / 1000);
  const to = Math.floor(now.getTime() / 1000);
  return `created_at_i>${from},created_at_i<${to}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Reddit public JSON
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateRedditCommunitySearcherOptions
  extends CreateCommunitySearcherOptions {
  baseUrl?: string;
}

interface RedditListingChild {
  kind?: string;
  data?: {
    title?: string;
    permalink?: string;
    url?: string;
    subreddit?: string;
    author?: string;
    selftext?: string;
    score?: number;
    num_comments?: number;
    upvote_ratio?: number;
    created_utc?: number;
  };
}

interface RedditListingResponse {
  data?: { children?: RedditListingChild[] };
}

export function createRedditCommunitySearcher(
  opts: CreateRedditCommunitySearcherOptions = {},
): CommunitySearcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const baseUrl = opts.baseUrl ?? "https://www.reddit.com";

  return {
    name: "reddit",
    async search(input: CommunitySearchInput): Promise<CommunitySearchHit[]> {
      if (!allowsCommunity(input)) return [];
      if (!isRedditIntent(input.query)) return [];

      const parsed = parseRedditQuery(input.query);
      const url = new URL(
        parsed.subreddit
          ? `/r/${encodeURIComponent(parsed.subreddit)}/search.json`
          : "/search.json",
        baseUrl,
      );
      url.searchParams.set("q", parsed.query);
      url.searchParams.set("sort", "relevance");
      url.searchParams.set("t", redditTimeWindow(input.recencyDays));
      url.searchParams.set("limit", String(Math.min(input.maxResults, 25)));
      url.searchParams.set("raw_json", "1");
      if (parsed.subreddit) url.searchParams.set("restrict_sr", "on");

      const body = await fetchJson<RedditListingResponse>({
        fetchImpl,
        url: url.href,
        timeoutMs,
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
        },
        log,
        provider: "reddit",
      });
      if (!body) return [];

      const children = body.data?.children ?? [];
      const out: CommunitySearchHit[] = [];
      const seen = new Set<string>();
      for (const child of children) {
        if (out.length >= input.maxResults) break;
        if (child.kind !== "t3") continue;
        const post = child.data;
        if (!post?.title || !post.permalink || !post.permalink.includes("/comments/")) {
          continue;
        }
        const url = absolutizeRedditUrl(post.permalink, baseUrl);
        if (seen.has(url)) continue;
        seen.add(url);

        const score = numberOrUndefined(post.score);
        const comments = numberOrUndefined(post.num_comments);
        const upvoteRatio = numberOrUndefined(post.upvote_ratio);
        const publishedAt = typeof post.created_utc === "number"
          ? new Date(post.created_utc * 1000).toISOString()
          : undefined;
        const subreddit = post.subreddit ? `r/${post.subreddit}` : undefined;
        out.push({
          url,
          title: post.title,
          snippet: [
            subreddit ? `Reddit ${subreddit}` : "Reddit discussion",
            post.author ? `by ${post.author}` : null,
            score !== undefined ? `${score} upvotes` : null,
            comments !== undefined ? `${comments} comments` : null,
          ].filter(Boolean).join("; "),
          preview: post.selftext ? post.selftext.slice(0, 2000) : null,
          ...(post.author ? { author: post.author } : {}),
          ...(subreddit ? { container: subreddit } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          engagement: {
            ...(score !== undefined ? { score } : {}),
            ...(comments !== undefined ? { numComments: comments } : {}),
            ...(upvoteRatio !== undefined ? { upvoteRatio } : {}),
          },
        });
      }
      return out;
    },
  };
}

export function parseRedditQuery(raw: string): {
  query: string;
  subreddit?: string;
} {
  const subreddit =
    /(?:^|\s)(?:site:)?(?:https?:\/\/)?(?:www\.)?reddit\.com\/r\/([A-Za-z0-9_]+)/i.exec(raw)?.[1] ??
    /(?:^|\s)r\/([A-Za-z0-9_]+)/i.exec(raw)?.[1];
  const query = normalizeCommunityQuery(
    raw
      .replace(/site:(?:www\.)?reddit\.com(?:\/r\/[A-Za-z0-9_]+)?/gi, " ")
      .replace(/https?:\/\/(?:www\.)?reddit\.com\/r\/[A-Za-z0-9_]+/gi, " ")
      .replace(/\br\/[A-Za-z0-9_]+\b/gi, " ")
      .replace(/\breddit\b/gi, " "),
  );
  return {
    query: query || subreddit || raw,
    ...(subreddit ? { subreddit } : {}),
  };
}

export function isRedditIntent(raw: string): boolean {
  return /(?:^|\s)(?:site:)?(?:https?:\/\/)?(?:www\.)?reddit\.com(?:\/r\/[A-Za-z0-9_]+)?/i.test(raw) ||
    /(?:^|\s)r\/[A-Za-z0-9_]+\b/i.test(raw) ||
    /\breddit\b/i.test(raw);
}

function redditTimeWindow(days: number | undefined): string {
  if (days === undefined || days <= 0) return "all";
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 365) return "year";
  return "all";
}

function absolutizeRedditUrl(permalink: string, baseUrl: string): string {
  return new URL(permalink, baseUrl).href;
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────────

async function fetchJson<T>(input: {
  fetchImpl: typeof fetch;
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
  log: (event: object) => void;
  provider: string;
}): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let res: Response;
  try {
    res = await input.fetchImpl(input.url, {
      method: "GET",
      signal: controller.signal,
      headers: input.headers,
    });
  } catch (e) {
    clearTimeout(timeout);
    input.log({
      event: "community-searcher:network-error",
      provider: input.provider,
      message: (e as Error).message,
    });
    return null;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    input.log({
      event: "community-searcher:http-error",
      provider: input.provider,
      status: res.status,
    });
    return null;
  }

  try {
    return (await res.json()) as T;
  } catch (e) {
    input.log({
      event: "community-searcher:bad-json",
      provider: input.provider,
      message: (e as Error).message,
    });
    return null;
  }
}

function normalizeCommunityQuery(raw: string): string {
  return raw
    .replace(/\bsite:\S+/gi, " ")
    .replace(/\b(recent|latest)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesQueryTokens(rawQuery: string, text: string): boolean {
  const tokens = normalizeCommunityQuery(rawQuery)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9.+#-]/g, ""))
    .filter((token) => token.length >= 4 && !QUERY_STOPWORDS.has(token));
  if (tokens.length === 0) return true;
  const haystack = text.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

const QUERY_STOPWORDS = new Set([
  "discussion",
  "discussions",
  "recent",
  "latest",
  "best",
  "practices",
]);

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
