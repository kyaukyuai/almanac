import { describe, expect, test } from "bun:test";

import {
  createDefaultCommunitySearchers,
  createHackerNewsCommunitySearcher,
  createRedditCommunitySearcher,
  isRedditIntent,
  parseRedditQuery,
} from "./community-searcher.ts";

describe("createDefaultCommunitySearchers", () => {
  test("registers Hacker News and Reddit", () => {
    expect(createDefaultCommunitySearchers().map((s) => s.name)).toEqual([
      "hackernews",
      "reddit",
    ]);
  });
});

describe("createHackerNewsCommunitySearcher", () => {
  test("maps Algolia hits to community search hits", async () => {
    const seen: string[] = [];
    const searcher = createHackerNewsCommunitySearcher({
      baseUrl: "https://hn.test",
      now: () => new Date("2026-05-08T12:00:00.000Z"),
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(
          JSON.stringify({
            hits: [
              {
                objectID: "999",
                title: "Unrelated Postgres launch",
                url: "https://example.com/postgres",
                author: "mallory",
                points: 1,
                num_comments: 0,
                created_at: "2026-05-07T09:00:00Z",
              },
              {
                objectID: "123",
                title: "Show HN: K8s operator",
                url: "https://example.com/operator",
                author: "alice",
                points: 42,
                num_comments: 9,
                created_at: "2026-05-07T10:00:00Z",
                story_text: "<p>useful thread</p>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    const hits = await searcher.search({
      query: "k8s operator",
      maxResults: 5,
      recencyDays: 30,
      targetKind: "community",
      origin: { type: "web-search", index: 0 },
    });

    expect(seen[0]).toContain("/api/v1/search");
    expect(seen[0]).toContain("query=k8s+operator");
    expect(seen[0]).toContain("numericFilters=");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe("https://news.ycombinator.com/item?id=123");
    expect(hits[0]!.container).toBe("news.ycombinator.com");
    expect(hits[0]!.engagement).toEqual({ points: 42, comments: 9 });
    expect(hits[0]!.preview).toBe("useful thread");
  });

  test("ignores non-community target kinds", async () => {
    const searcher = createHackerNewsCommunitySearcher({
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    const hits = await searcher.search({
      query: "k8s",
      maxResults: 5,
      targetKind: "docs",
      origin: { type: "web-search", index: 0 },
    });
    expect(hits).toEqual([]);
  });

  test("ignores reddit-specific queries", async () => {
    const searcher = createHackerNewsCommunitySearcher({
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    const hits = await searcher.search({
      query: "site:reddit.com/r/kubernetes operator recent",
      maxResults: 5,
      targetKind: "community",
      origin: { type: "direct-probe", index: 0 },
    });
    expect(hits).toEqual([]);
  });
});

describe("parseRedditQuery", () => {
  test("extracts subreddit and strips site syntax", () => {
    expect(parseRedditQuery("site:reddit.com/r/kubernetes recent")).toEqual({
      subreddit: "kubernetes",
      query: "kubernetes",
    });
  });
});

describe("isRedditIntent", () => {
  test("requires an explicit reddit signal", () => {
    expect(isRedditIntent("kubernetes operator discussion")).toBe(false);
    expect(isRedditIntent("reddit kubernetes operator")).toBe(true);
    expect(isRedditIntent("site:reddit.com/r/kubernetes recent")).toBe(true);
    expect(isRedditIntent("r/kubernetes operator")).toBe(true);
  });
});

describe("createRedditCommunitySearcher", () => {
  test("skips generic community queries with no reddit intent", async () => {
    const searcher = createRedditCommunitySearcher({
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    const hits = await searcher.search({
      query: "kubernetes operator discussion",
      maxResults: 5,
      recencyDays: 30,
      targetKind: "community",
      origin: { type: "web-search", index: 0 },
    });
    expect(hits).toEqual([]);
  });

  test("maps public JSON posts to community search hits", async () => {
    const seen: string[] = [];
    const searcher = createRedditCommunitySearcher({
      baseUrl: "https://reddit.test",
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(
          JSON.stringify({
            data: {
              children: [
                {
                  kind: "t3",
                  data: {
                    title: "Kubernetes operator question",
                    permalink: "/r/kubernetes/comments/abc/thread/",
                    subreddit: "kubernetes",
                    author: "bob",
                    selftext: "How should I design this operator?",
                    score: 20,
                    num_comments: 5,
                    upvote_ratio: 0.9,
                    created_utc: 1778155200,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    const hits = await searcher.search({
      query: "site:reddit.com/r/kubernetes recent",
      maxResults: 5,
      recencyDays: 30,
      targetKind: "community",
      origin: { type: "direct-probe", index: 0 },
    });

    expect(seen[0]).toContain("/r/kubernetes/search.json");
    expect(seen[0]).toContain("restrict_sr=on");
    expect(seen[0]).toContain("t=month");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe(
      "https://reddit.test/r/kubernetes/comments/abc/thread/",
    );
    expect(hits[0]!.container).toBe("r/kubernetes");
    expect(hits[0]!.engagement).toEqual({
      score: 20,
      numComments: 5,
      upvoteRatio: 0.9,
    });
  });
});
