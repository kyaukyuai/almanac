/**
 * Tests for `createNullWebSearcher` + `createBraveWebSearcher`.
 */
import { describe, expect, test } from "bun:test";

import {
  createBraveWebSearcher,
  createNullWebSearcher,
  mapBraveFreshness,
} from "./web-searcher.ts";

describe("createNullWebSearcher", () => {
  test("always returns []", async () => {
    const s = createNullWebSearcher();
    expect(await s.search({ query: "anything", maxResults: 10 })).toEqual([]);
  });
});

describe("mapBraveFreshness", () => {
  test("buckets days into pd/pw/pm/py", () => {
    expect(mapBraveFreshness(undefined)).toBeUndefined();
    expect(mapBraveFreshness(0)).toBeUndefined();
    expect(mapBraveFreshness(1)).toBe("pd");
    expect(mapBraveFreshness(7)).toBe("pw");
    expect(mapBraveFreshness(30)).toBe("pm");
    expect(mapBraveFreshness(200)).toBe("py");
    expect(mapBraveFreshness(2000)).toBeUndefined();
  });
});

describe("createBraveWebSearcher", () => {
  test("missing api key → []", async () => {
    const s = createBraveWebSearcher({
      apiKey: undefined,
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    expect(await s.search({ query: "x", maxResults: 5 })).toEqual([]);
  });

  test("happy path: maps results and respects maxResults", async () => {
    const calls: string[] = [];
    const s = createBraveWebSearcher({
      apiKey: "key",
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            web: {
              results: [
                { url: "https://a.com", title: "A", description: "a desc" },
                { url: "https://b.com", title: "B" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const hits = await s.search({
      query: "k8s",
      maxResults: 1,
      recencyDays: 7,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.url).toBe("https://a.com");
    expect(hits[0]!.snippet).toBe("a desc");
    expect(calls[0]).toContain("freshness=pw");
    expect(calls[0]).toContain("q=k8s");
    expect(calls[0]).toContain("count=1");
  });

  test("non-2xx → []", async () => {
    const s = createBraveWebSearcher({
      apiKey: "key",
      fetchImpl: (async () =>
        new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    expect(await s.search({ query: "x", maxResults: 5 })).toEqual([]);
  });

  test("attaches X-Subscription-Token header", async () => {
    const seen: { token?: string } = {};
    const s = createBraveWebSearcher({
      apiKey: "secret",
      fetchImpl: (async (_url: string, init: RequestInit | undefined) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seen.token = headers?.["x-subscription-token"];
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await s.search({ query: "x", maxResults: 1 });
    expect(seen.token).toBe("secret");
  });
});
