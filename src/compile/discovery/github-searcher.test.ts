/**
 * Tests for `createGithubSearcher` against a stub fetch.
 */
import { describe, expect, test } from "bun:test";

import { createGithubSearcher } from "./github-searcher.ts";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("createGithubSearcher", () => {
  test("happy path: maps API items to GithubSearchHit + caps maxResults", async () => {
    const calls: string[] = [];
    const searcher = createGithubSearcher({
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return jsonFetch({
          items: [
            {
              full_name: "foo/bar",
              html_url: "https://github.com/foo/bar",
              description: "demo repo",
              stargazers_count: 200,
              pushed_at: "2026-04-01T00:00:00Z",
              license: { spdx_id: "MIT" },
            },
            {
              full_name: "foo/baz",
              html_url: "https://github.com/foo/baz",
              description: null,
              stargazers_count: 50,
              pushed_at: "2026-03-01T00:00:00Z",
              license: null,
            },
          ],
        })(url, undefined);
      }) as unknown as typeof fetch,
    });

    const hits = await searcher.search({
      query: "topic:k8s",
      type: "repos",
      maxResults: 1,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.fullName).toBe("foo/bar");
    expect(hits[0]!.stars).toBe(200);
    expect(hits[0]!.license).toBe("MIT");
    expect(hits[0]!.lastCommitAt).toBe("2026-04-01T00:00:00Z");
    expect(calls[0]).toContain("/search/repositories");
    expect(calls[0]).toContain("q=topic%3Ak8s");
  });

  test("clamps oversized repo description to 500 chars (regression)", async () => {
    const oversized = "x".repeat(800);
    const searcher = createGithubSearcher({
      fetchImpl: jsonFetch({
        items: [
          {
            full_name: "foo/big-desc",
            html_url: "https://github.com/foo/big-desc",
            description: oversized,
            stargazers_count: 1,
            pushed_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    });
    const hits = await searcher.search({
      query: "anything",
      type: "repos",
      maxResults: 1,
    });
    expect(hits[0]!.description).not.toBeNull();
    expect(hits[0]!.description!.length).toBe(500);
  });

  test("empty-string description normalizes to null", async () => {
    const searcher = createGithubSearcher({
      fetchImpl: jsonFetch({
        items: [
          {
            full_name: "foo/empty-desc",
            html_url: "https://github.com/foo/empty-desc",
            description: "",
            stargazers_count: 1,
            pushed_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    });
    const hits = await searcher.search({
      query: "anything",
      type: "repos",
      maxResults: 1,
    });
    expect(hits[0]!.description).toBeNull();
  });

  test("non-2xx → empty array", async () => {
    const searcher = createGithubSearcher({ fetchImpl: jsonFetch({}, 422) });
    const hits = await searcher.search({
      query: "x",
      type: "repos",
      maxResults: 5,
    });
    expect(hits).toEqual([]);
  });

  test("network error → empty array", async () => {
    const searcher = createGithubSearcher({
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(
      await searcher.search({ query: "x", type: "repos", maxResults: 5 }),
    ).toEqual([]);
  });

  test("unsupported type → empty array (no API call)", async () => {
    const calls: string[] = [];
    const searcher = createGithubSearcher({
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return jsonFetch({}, 200)(url, undefined);
      }) as unknown as typeof fetch,
    });
    expect(
      await searcher.search({ query: "x", type: "code", maxResults: 5 }),
    ).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("attaches Authorization header when token is provided", async () => {
    const seen: { auth?: string } = {};
    const searcher = createGithubSearcher({
      token: "ghp_test",
      fetchImpl: (async (_url: string, init: RequestInit | undefined) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seen.auth = headers?.["authorization"];
        return jsonFetch({ items: [] })(_url, undefined);
      }) as unknown as typeof fetch,
    });
    await searcher.search({ query: "x", type: "repos", maxResults: 1 });
    expect(seen.auth).toBe("Bearer ghp_test");
  });
});
