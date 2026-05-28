/**
 * Tests for `Candidate` and `Candidates` zod schemas — the input contract for
 * Stage 2b (evaluator). The first test parses a representative candidate set
 * covering all origin types (direct-probe, web-search, community-search,
 * github) plus a
 * few non-ok fetch statuses.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  CandidateSchema,
  CandidatesSchema,
  type Candidate,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Representative candidates — one per origin type + edge cases
// ──────────────────────────────────────────────────────────────────────────────

const REPRESENTATIVE_SET: unknown[] = [
  // 1. direct-probe / ok
  {
    url: "https://kubernetes.io/docs/",
    kind: "docs",
    title: "Kubernetes Documentation",
    snippet:
      "Production-Grade Container Orchestration. The Kubernetes documentation for users, contributors, and operators.",
    preview:
      "Kubernetes Documentation\n\nKubernetes is an open-source system for automating deployment, scaling, and management of containerized applications. It groups containers ...",
    fetchedAt: "2026-05-08T10:00:00Z",
    fetchStatus: "ok",
    origin: { type: "direct-probe", probeIndex: 0 },
    meta: {
      contentType: "text/html; charset=utf-8",
      contentLengthBytes: 48211,
      httpStatusCode: 200,
      languageDetected: "en",
    },
  },
  // 2. direct-probe / redirect
  {
    url: "https://k8s.io/",
    kind: "docs",
    title: "Kubernetes",
    snippet: "Production-grade orchestration",
    preview: null,
    fetchedAt: "2026-05-08T10:00:01Z",
    fetchStatus: "redirect",
    finalUrl: "https://kubernetes.io/",
    origin: { type: "direct-probe", probeIndex: 7 },
    meta: { httpStatusCode: 301 },
  },
  // 3. web-search / ok with rss feed detected
  {
    url: "https://www.cncf.io/blog/",
    kind: "news",
    title: "CNCF Blog",
    snippet:
      "Cloud Native Computing Foundation: news, technical articles, and ecosystem updates.",
    preview:
      "Welcome to the CNCF blog. Recent posts include Kubernetes 1.30 release rundown, ...",
    fetchedAt: "2026-05-08T10:00:02Z",
    fetchStatus: "ok",
    origin: { type: "web-search", queryIndex: 1, rank: 0 },
    meta: {
      contentType: "text/html",
      httpStatusCode: 200,
      rssUrl: "https://www.cncf.io/feed/",
    },
  },
  // 4. community-search / ok with native engagement metadata
  {
    url: "https://news.ycombinator.com/item?id=123",
    kind: "community",
    title: "Show HN: Kubernetes thing",
    snippet: "Hacker News discussion; 120 points; 42 comments",
    preview: "Discussion text",
    fetchedAt: "2026-05-08T10:00:03Z",
    fetchStatus: "ok",
    origin: {
      type: "community-search",
      provider: "hackernews",
      inputType: "web-search",
      inputIndex: 0,
      rank: 1,
    },
    meta: {
      discoveryProvider: "hackernews",
      author: "alice",
      container: "news.ycombinator.com",
      publishedAt: "2026-05-07T18:24:11Z",
      engagement: { points: 120, comments: 42 },
    },
  },
  // 5. github / ok with stars + license
  {
    url: "https://github.com/kubernetes-sigs/cluster-api",
    kind: "repo",
    title: "kubernetes-sigs/cluster-api",
    snippet:
      "Home for Cluster API, a subproject of sig-cluster-lifecycle.",
    preview: null,
    fetchedAt: "2026-05-08T10:00:04Z",
    fetchStatus: "ok",
    origin: { type: "github", queryIndex: 0, rank: 2 },
    meta: {
      githubStars: 3490,
      githubLicense: "Apache-2.0",
      githubLastCommitAt: "2026-05-07T18:24:11Z",
    },
  },
  // 6. web-search / 404 (dead link) — preview must be null
  {
    url: "https://example.com/dead-link",
    kind: "community",
    title: null,
    snippet: "Some old result still in the index",
    preview: null,
    fetchedAt: "2026-05-08T10:00:05Z",
    fetchStatus: "client-error",
    origin: { type: "web-search", queryIndex: 0, rank: 5 },
    meta: { httpStatusCode: 404 },
  },
  // 7. direct-probe / blocked
  {
    url: "https://www.example-paywalled.com/article",
    kind: "news",
    title: null,
    snippet: null,
    preview: null,
    fetchedAt: "2026-05-08T10:00:06Z",
    fetchStatus: "blocked",
    origin: { type: "direct-probe", probeIndex: 5 },
    meta: {},
  },
];

describe("Candidate / Candidates — representative set", () => {
  test("all representative candidates parse", () => {
    const parsed = CandidatesSchema.parse(REPRESENTATIVE_SET);
    expect(parsed.length).toBe(7);

    // discriminator narrowing sanity
    const githubCandidate = parsed.find((c) => c.origin.type === "github");
    expect(githubCandidate).toBeDefined();
    if (githubCandidate?.origin.type === "github") {
      expect(githubCandidate.origin.queryIndex).toBe(0);
      expect(githubCandidate.origin.rank).toBe(2);
    }
    expect(githubCandidate?.meta.githubLicense).toBe("Apache-2.0");

    const communityCandidate = parsed.find(
      (c) => c.origin.type === "community-search",
    );
    expect(communityCandidate?.meta.engagement?.points).toBe(120);

    const redirectCandidate = parsed.find(
      (c) => c.fetchStatus === "redirect",
    );
    expect(redirectCandidate?.finalUrl).toBe("https://kubernetes.io/");
  });
});

describe("Candidate — validation rejections", () => {
  function clone(idx: number): Candidate {
    return structuredClone(REPRESENTATIVE_SET[idx]) as Candidate;
  }

  test("rejects invalid URL", () => {
    const bad = clone(0);
    (bad as { url: string }).url = "not a url";
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects malformed fetchedAt", () => {
    const bad = clone(0);
    bad.fetchedAt = "yesterday";
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects fetchStatus=redirect without finalUrl", () => {
    const bad = clone(1);
    delete (bad as { finalUrl?: string }).finalUrl;
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects finalUrl set when fetchStatus !== redirect", () => {
    const bad = clone(0);
    (bad as { finalUrl?: string }).finalUrl = "https://kubernetes.io/";
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects non-null preview when fetchStatus is client-error", () => {
    const bad = clone(5); // dead-link
    bad.preview = "this should not be allowed";
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects unknown SourceKind", () => {
    const bad = clone(0);
    (bad as { kind: string }).kind = "videocast" as never;
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects unknown origin discriminator", () => {
    const bad = clone(0);
    (bad as { origin: unknown }).origin = {
      type: "telegram",
      probeIndex: 0,
    };
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects negative probeIndex", () => {
    const bad = clone(0);
    if (bad.origin.type === "direct-probe") {
      bad.origin.probeIndex = -1;
    }
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects snippet over 500 chars", () => {
    const bad = clone(0);
    bad.snippet = "a".repeat(501);
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects preview over 2000 chars", () => {
    const bad = clone(0);
    bad.preview = "a".repeat(2001);
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects HTTP status code outside valid range", () => {
    const bad = clone(0);
    bad.meta = { ...bad.meta, httpStatusCode: 99 };
    expect(() => CandidateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects when CandidatesSchema array exceeds cap of 200", () => {
    const template = REPRESENTATIVE_SET[0];
    const tooMany = Array.from({ length: 201 }, () =>
      structuredClone(template),
    );
    expect(() => CandidatesSchema.parse(tooMany)).toThrow(z.ZodError);
  });

  test("accepts minimal valid candidate (only required fields)", () => {
    const minimal: unknown = {
      url: "https://example.com/a",
      kind: "docs",
      title: null,
      snippet: null,
      preview: null,
      fetchedAt: "2026-05-08T10:00:00Z",
      fetchStatus: "ok",
      origin: { type: "direct-probe", probeIndex: 0 },
      // meta omitted → defaulted to {}
    };
    const parsed = CandidateSchema.parse(minimal);
    expect(parsed.meta).toEqual({});
  });
});
