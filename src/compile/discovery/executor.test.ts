/**
 * Tests for the discovery executor.
 *
 *   - direct probes: URL hint → prober; query hint → web search top-1 → prober
 *   - web search queries: rank, title/snippet fallback to engine values
 *   - github queries: meta carries stars/license/lastCommitAt; preview is null
 *   - dedup: identical canonical URLs across buckets count once
 *   - canonicalizeUrl: drops fragment, lowercases host, trims trailing slash
 *   - hard cap: never exceeds 200 candidates
 *   - failure isolation: thrown probers/searchers don't abort the run
 */
import { describe, expect, test } from "bun:test";

import {
  SourceDiscoveryPlanSchema,
  type SourceDiscoveryPlan,
} from "../../core/types.ts";
import {
  CANDIDATES_MAX,
  canonicalizeUrl,
  isUrl,
  runDiscoveryExecutor,
} from "./executor.ts";
import type {
  CommunitySearcher,
  GithubSearcher,
  ProbeResult,
  UrlProber,
  WebSearcher,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures + mock factories
// ──────────────────────────────────────────────────────────────────────────────

const NOW = () => new Date("2026-05-08T12:00:00.000Z");

function mockProber(
  responses: Record<string, Partial<ProbeResult>>,
): UrlProber & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "mock",
    calls,
    async probe(url: string): Promise<ProbeResult> {
      calls.push(url);
      const r = responses[url] ?? {};
      // Distinguish explicit null from "not specified" via the `in` check so
      // tests can force null title/snippet/preview through the mock.
      return {
        url,
        fetchStatus: r.fetchStatus ?? "ok",
        ...(r.finalUrl !== undefined ? { finalUrl: r.finalUrl } : {}),
        title: ("title" in r ? r.title : `Title of ${url}`) as string | null,
        snippet: ("snippet" in r ? r.snippet : `Snippet of ${url}`) as
          | string
          | null,
        preview: ("preview" in r ? r.preview : `Preview of ${url}`) as
          | string
          | null,
        meta: r.meta ?? { httpStatusCode: 200 },
      };
    },
  };
}

function mockWebSearcher(
  responses: Record<string, Array<{ url: string; title?: string; snippet?: string }>>,
): WebSearcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "mock-web",
    calls,
    async search(input) {
      calls.push(input.query);
      const hits = responses[input.query] ?? [];
      return hits
        .slice(0, input.maxResults)
        .map((h) => ({
          url: h.url,
          title: h.title ?? null,
          snippet: h.snippet ?? null,
        }));
    },
  };
}

function mockCommunitySearcher(
  name: string,
  responses: Record<string, Array<{
    url: string;
    title?: string;
    snippet?: string;
    preview?: string;
    author?: string;
    container?: string;
    publishedAt?: string;
    engagement?: Record<string, number>;
  }>>,
): CommunitySearcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async search(input) {
      calls.push(input.query);
      return (responses[input.query] ?? [])
        .slice(0, input.maxResults)
        .map((h) => ({
          url: h.url,
          title: h.title ?? null,
          snippet: h.snippet ?? null,
          ...(h.preview !== undefined ? { preview: h.preview } : {}),
          ...(h.author !== undefined ? { author: h.author } : {}),
          ...(h.container !== undefined ? { container: h.container } : {}),
          ...(h.publishedAt !== undefined ? { publishedAt: h.publishedAt } : {}),
          ...(h.engagement !== undefined ? { engagement: h.engagement } : {}),
        }));
    },
  };
}

function mockGithubSearcher(
  responses: Record<string, Array<{
    url: string;
    fullName: string;
    description?: string;
    stars?: number;
    license?: string;
    lastCommitAt?: string;
  }>>,
): GithubSearcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "mock-github",
    calls,
    async search(input) {
      calls.push(input.query);
      return (responses[input.query] ?? [])
        .slice(0, input.maxResults)
        .map((h) => ({
          url: h.url,
          fullName: h.fullName,
          description: h.description ?? null,
          stars: h.stars ?? 0,
          license: h.license ?? null,
          lastCommitAt: h.lastCommitAt ?? null,
        }));
    },
  };
}

function plan(overrides: Partial<SourceDiscoveryPlan>): SourceDiscoveryPlan {
  return SourceDiscoveryPlanSchema.parse({
    schemaVersion: "0.1.0",
    domain: { canonicalSlug: "k8s", displayName: "Kubernetes" },
    budgets: {
      maxWebSearchQueries: 4,
      maxGithubQueries: 4,
      maxUrlProbes: 12,
      maxCandidatesPerKind: 3,
      targetAcceptedSources: 8,
    },
    directProbes: [],
    webSearchQueries: [],
    githubQueries: [],
    coverageGoals: {
      docs: { min: 0, max: 4 },
      repo: { min: 0, max: 4 },
      news: { min: 0, max: 2 },
      community: { min: 0, max: 2 },
      academic: { min: 0, max: 1 },
      data: { min: 0, max: 2 },
      file: { min: 0, max: 0 },
      essay: { min: 0, max: 0 },
      book: { min: 0, max: 0 },
      talk: { min: 0, max: 0 },
    },
    ...overrides,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// canonicalizeUrl + isUrl
// ──────────────────────────────────────────────────────────────────────────────

describe("canonicalizeUrl", () => {
  test("drops fragment, lowercases host, trims trailing slash", () => {
    expect(canonicalizeUrl("https://Example.COM/foo/#section")).toBe(
      "https://example.com/foo",
    );
  });
  test("preserves root path", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });
  test("returns input on parse failure", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("isUrl", () => {
  test("accepts http/https", () => {
    expect(isUrl("http://x.com")).toBe(true);
    expect(isUrl("https://x.com")).toBe(true);
  });
  test("rejects bare strings and other schemes", () => {
    expect(isUrl("k8s operator best practices")).toBe(false);
    expect(isUrl("ftp://x.com")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runDiscoveryExecutor — direct probes
// ──────────────────────────────────────────────────────────────────────────────

describe("direct probes", () => {
  test("URL hint goes through the prober and produces a `direct-probe` candidate", async () => {
    const prober = mockProber({
      "https://kubernetes.io/docs/": { title: "Kubernetes Docs" },
    });
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "https://kubernetes.io/docs/", kind: "docs", rationale: "primary" },
        ],
      }),
      prober,
      webSearcher: mockWebSearcher({}),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(1);
    const c = out.candidates[0]!;
    expect(c.url).toBe("https://kubernetes.io/docs/");
    expect(c.kind).toBe("docs");
    expect(c.title).toBe("Kubernetes Docs");
    expect(c.fetchStatus).toBe("ok");
    expect(c.origin).toEqual({ type: "direct-probe", probeIndex: 0 });
    expect(prober.calls).toEqual(["https://kubernetes.io/docs/"]);
    expect(out.stats.directProbes).toEqual({ attempted: 1, produced: 1 });
  });

  test("query hint resolves through web-search top-1, then probes", async () => {
    const prober = mockProber({
      "https://example.com/k8s-best-practices": {},
    });
    const web = mockWebSearcher({
      "k8s best practices": [
        { url: "https://example.com/k8s-best-practices", title: "BP" },
      ],
    });
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "k8s best practices", kind: "community", rationale: "fallback search" },
        ],
      }),
      prober,
      webSearcher: web,
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(web.calls).toEqual(["k8s best practices"]);
    expect(prober.calls).toEqual(["https://example.com/k8s-best-practices"]);
    expect(out.candidates.length).toBe(1);
    expect(out.candidates[0]!.kind).toBe("community");
  });

  test("query hint with no search hits produces no candidate", async () => {
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "no results found", kind: "docs", rationale: "x" },
        ],
      }),
      prober: mockProber({}),
      webSearcher: mockWebSearcher({}),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(0);
    expect(out.stats.directProbes).toEqual({ attempted: 1, produced: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runDiscoveryExecutor — web search bucket
// ──────────────────────────────────────────────────────────────────────────────

describe("web search queries", () => {
  test("emits one candidate per result with rank, falling back to engine title/snippet", async () => {
    const prober = mockProber({
      "https://a.example.com": { title: null, snippet: null },
      "https://b.example.com": {},
    });
    const web = mockWebSearcher({
      "k8s news": [
        { url: "https://a.example.com", title: "A title from engine", snippet: "A snip" },
        { url: "https://b.example.com", title: "B title" },
      ],
    });
    const p = plan({
      webSearchQueries: [
        {
          query: "k8s news",
          targetKind: "news",
          rationale: "x",
          recencyDays: 30,
        },
      ],
    });
    const out = await runDiscoveryExecutor({
      plan: p,
      prober,
      webSearcher: web,
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(2);
    // First result keeps the engine title because the prober returned null.
    expect(out.candidates[0]!.title).toBe("A title from engine");
    expect(out.candidates[0]!.snippet).toBe("A snip");
    expect(out.candidates[0]!.origin).toEqual({
      type: "web-search",
      queryIndex: 0,
      rank: 0,
    });
    expect(out.candidates[1]!.origin).toEqual({
      type: "web-search",
      queryIndex: 0,
      rank: 1,
    });
    expect(out.candidates[1]!.kind).toBe("news");
  });

  test("targetKind=any maps to docs", async () => {
    const out = await runDiscoveryExecutor({
      plan: plan({
        webSearchQueries: [
          {
            query: "anything",
            targetKind: "any",
            rationale: "x",
            recencyDays: null,
          },
        ],
      }),
      prober: mockProber({ "https://x.com": {} }),
      webSearcher: mockWebSearcher({
        anything: [{ url: "https://x.com" }],
      }),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates[0]!.kind).toBe("docs");
  });

  test("clamps oversized title and snippet fallbacks before validation", async () => {
    const out = await runDiscoveryExecutor({
      plan: plan({
        webSearchQueries: [
          {
            query: "long enterprise ai result",
            targetKind: "any",
            rationale: "x",
            recencyDays: null,
          },
        ],
      }),
      prober: mockProber({
        "https://long.example.com": { title: null, snippet: null },
      }),
      webSearcher: mockWebSearcher({
        "long enterprise ai result": [
          {
            url: "https://long.example.com",
            title: "T".repeat(350),
            snippet: "S".repeat(700),
          },
        ],
      }),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });

    expect(out.candidates[0]!.title).toHaveLength(300);
    expect(out.candidates[0]!.snippet).toHaveLength(500);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runDiscoveryExecutor — community providers
// ──────────────────────────────────────────────────────────────────────────────

describe("community search providers", () => {
  test("runs HN/Reddit-style providers for community web queries without probing", async () => {
    const prober = mockProber({});
    const community = mockCommunitySearcher("hackernews", {
      "k8s operator discussion": [
        {
          url: "https://news.ycombinator.com/item?id=123",
          title: "K8s operator thread",
          snippet: "HN discussion",
          preview: "Discussion body",
          author: "alice",
          container: "news.ycombinator.com",
          publishedAt: "2026-05-07T18:24:11.000Z",
          engagement: { points: 120, comments: 42 },
        },
      ],
    });
    const out = await runDiscoveryExecutor({
      plan: plan({
        webSearchQueries: [
          {
            query: "k8s operator discussion",
            targetKind: "community",
            rationale: "x",
            recencyDays: 30,
          },
        ],
      }),
      prober,
      webSearcher: mockWebSearcher({}),
      communitySearchers: [community],
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });

    expect(prober.calls.length).toBe(0);
    expect(community.calls).toEqual(["k8s operator discussion"]);
    expect(out.candidates.length).toBe(1);
    const c = out.candidates[0]!;
    expect(c.kind).toBe("community");
    expect(c.origin).toEqual({
      type: "community-search",
      provider: "hackernews",
      inputType: "web-search",
      inputIndex: 0,
      rank: 0,
    });
    expect(c.meta.discoveryProvider).toBe("hackernews");
    expect(c.meta.engagement?.points).toBe(120);
    expect(out.stats.communitySearch).toEqual({
      queries: 1,
      providers: 1,
      produced: 1,
    });
  });

  test("falls back to community providers for non-URL community direct probes", async () => {
    const community = mockCommunitySearcher("reddit", {
      "site:reddit.com/r/kubernetes recent": [
        {
          url: "https://www.reddit.com/r/kubernetes/comments/abc/thread/",
          title: "r/kubernetes thread",
          snippet: "Reddit discussion",
          container: "r/kubernetes",
          engagement: { score: 20, numComments: 5 },
        },
      ],
    });
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          {
            hint: "site:reddit.com/r/kubernetes recent",
            kind: "community",
            rationale: "x",
          },
        ],
      }),
      prober: mockProber({}),
      webSearcher: mockWebSearcher({}),
      communitySearchers: [community],
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });

    expect(out.candidates.length).toBe(1);
    expect(out.candidates[0]!.origin).toEqual({
      type: "community-search",
      provider: "reddit",
      inputType: "direct-probe",
      inputIndex: 0,
      rank: 0,
    });
    expect(out.stats.directProbes).toEqual({ attempted: 1, produced: 1 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runDiscoveryExecutor — github bucket
// ──────────────────────────────────────────────────────────────────────────────

describe("github queries", () => {
  test("packs stars/license/lastCommitAt into meta and skips probing", async () => {
    const prober = mockProber({});
    const out = await runDiscoveryExecutor({
      plan: plan({
        githubQueries: [
          { query: "topic:kubernetes stars:>500", type: "repos", rationale: "x" },
        ],
      }),
      prober,
      webSearcher: mockWebSearcher({}),
      githubSearcher: mockGithubSearcher({
        "topic:kubernetes stars:>500": [
          {
            url: "https://github.com/foo/bar",
            fullName: "foo/bar",
            description: "Desc",
            stars: 1234,
            license: "Apache-2.0",
            lastCommitAt: "2026-04-01T00:00:00Z",
          },
        ],
      }),
      now: NOW,
    });
    expect(prober.calls.length).toBe(0);
    expect(out.candidates.length).toBe(1);
    const c = out.candidates[0]!;
    expect(c.kind).toBe("repo");
    expect(c.preview).toBeNull();
    expect(c.meta.githubStars).toBe(1234);
    expect(c.meta.githubLicense).toBe("Apache-2.0");
    expect(c.meta.githubLastCommitAt).toBe("2026-04-01T00:00:00Z");
    expect(c.origin).toEqual({ type: "github", queryIndex: 0, rank: 0 });
  });

  test("clamps oversized repo metadata before validation", async () => {
    const out = await runDiscoveryExecutor({
      plan: plan({
        githubQueries: [
          { query: "topic:enterprise-ai", type: "repos", rationale: "x" },
        ],
      }),
      prober: mockProber({}),
      webSearcher: mockWebSearcher({}),
      githubSearcher: mockGithubSearcher({
        "topic:enterprise-ai": [
          {
            url: "https://github.com/foo/enterprise-ai",
            fullName: `${"owner".repeat(80)}/enterprise-ai`,
            description: "D".repeat(700),
          },
        ],
      }),
      now: NOW,
    });

    expect(out.candidates[0]!.title).toHaveLength(300);
    expect(out.candidates[0]!.snippet).toHaveLength(500);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Dedup + cap + failure isolation
// ──────────────────────────────────────────────────────────────────────────────

describe("dedup + caps + failure isolation", () => {
  test("identical canonical URLs across buckets count once", async () => {
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "https://example.com/", kind: "docs", rationale: "x" },
        ],
        webSearchQueries: [
          {
            query: "ex",
            targetKind: "docs",
            rationale: "x",
            recencyDays: null,
          },
        ],
      }),
      prober: mockProber({ "https://example.com/": {} }),
      webSearcher: mockWebSearcher({
        ex: [{ url: "https://example.com/#fragment" }],
      }),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(1);
    expect(out.stats.deduped).toBe(1);
  });

  test("respects the 200-candidate hard cap", async () => {
    // 60 direct probes + 20 web queries × 32 hits/query = 700 attempts → cap.
    const directProbes = Array.from({ length: 60 }, (_, i) => ({
      hint: `https://example.com/p${i}`,
      kind: "docs" as const,
      rationale: "x",
    }));
    const probeResponses: Record<string, Partial<ProbeResult>> = {};
    for (const p of directProbes) probeResponses[p.hint] = {};

    const webHitsByQuery: Record<string, Array<{ url: string }>> = {};
    const webSearchQueries: Array<{
      query: string;
      targetKind: "any";
      rationale: string;
      recencyDays: null;
    }> = [];
    for (let q = 0; q < 20; q++) {
      const query = `q${q}`;
      const hits = Array.from({ length: 32 }, (_, i) => ({
        url: `https://example.com/q${q}-w${i}`,
      }));
      webHitsByQuery[query] = hits;
      for (const h of hits) probeResponses[h.url] = {};
      webSearchQueries.push({
        query,
        targetKind: "any",
        rationale: "x",
        recencyDays: null,
      });
    }

    const p = plan({
      budgets: {
        maxWebSearchQueries: 20,
        maxGithubQueries: 0,
        maxUrlProbes: 60,
        maxCandidatesPerKind: 32,
        targetAcceptedSources: 12,
      },
      directProbes,
      webSearchQueries,
    });
    const out = await runDiscoveryExecutor({
      plan: p,
      prober: mockProber(probeResponses),
      webSearcher: mockWebSearcher(webHitsByQuery),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(CANDIDATES_MAX);
  });

  test("a thrown prober yields a network-error candidate, not a crash", async () => {
    const prober: UrlProber = {
      name: "throwing",
      async probe() {
        throw new Error("simulated boom");
      },
    };
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "https://example.com/", kind: "docs", rationale: "x" },
        ],
      }),
      prober,
      webSearcher: mockWebSearcher({}),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(1);
    expect(out.candidates[0]!.fetchStatus).toBe("network-error");
    expect(out.candidates[0]!.preview).toBeNull();
  });

  test("clamps oversized probe metadata before validation", async () => {
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "https://long.example.com/", kind: "docs", rationale: "x" },
        ],
      }),
      prober: mockProber({
        "https://long.example.com/": {
          title: "T".repeat(350),
          snippet: "S".repeat(700),
          preview: "P".repeat(2500),
        },
      }),
      webSearcher: mockWebSearcher({}),
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });

    expect(out.candidates[0]!.title).toHaveLength(300);
    expect(out.candidates[0]!.snippet).toHaveLength(500);
    expect(out.candidates[0]!.preview).toHaveLength(2000);
  });

  test("a thrown searcher contributes zero candidates and does not abort", async () => {
    const web: WebSearcher = {
      name: "throwing",
      async search() {
        throw new Error("boom");
      },
    };
    const out = await runDiscoveryExecutor({
      plan: plan({
        directProbes: [
          { hint: "https://kept.example.com/", kind: "docs", rationale: "x" },
        ],
        webSearchQueries: [
          {
            query: "x",
            targetKind: "any",
            rationale: "x",
            recencyDays: null,
          },
        ],
      }),
      prober: mockProber({ "https://kept.example.com/": {} }),
      webSearcher: web,
      githubSearcher: mockGithubSearcher({}),
      now: NOW,
    });
    expect(out.candidates.length).toBe(1);
    expect(out.candidates[0]!.url).toBe("https://kept.example.com/");
  });
});
