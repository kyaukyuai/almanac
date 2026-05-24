/**
 * Tests for Stage 2 (source discovery) zod schemas.
 *
 * The first two tests are critical: they parse the worked examples embedded
 * in:
 *   src/compile/prompts/02-source-discovery/planner-v1.md
 *   src/compile/prompts/02-source-discovery/evaluator-v1.md
 *
 * If a prompt example fails to parse, fix the prompt or the schema.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  parseDraftSourcesFile,
  SourceDiscoveryPlanSchema,
  SourcesFileSchema,
  type SourceDiscoveryPlan,
  type SourcesFile,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Worked example: planner-v1.md (kubernetes / standard)
// ──────────────────────────────────────────────────────────────────────────────

const PLANNER_KUBERNETES: unknown = {
  schemaVersion: "0.1.0",
  domain: { canonicalSlug: "kubernetes", displayName: "Kubernetes" },
  budgets: {
    maxWebSearchQueries: 6,
    maxGithubQueries: 4,
    maxUrlProbes: 20,
    maxCandidatesPerKind: 8,
    targetAcceptedSources: 8,
  },
  directProbes: [
    {
      hint: "https://kubernetes.io/docs/",
      kind: "docs",
      rationale: "Canonical official documentation.",
    },
    {
      hint: "https://kubernetes.io/blog/",
      kind: "news",
      rationale: "Official release and feature announcements.",
    },
    {
      hint: "https://github.com/kubernetes/kubernetes/releases",
      kind: "repo",
      rationale:
        "Authoritative source for release notes and version diffs.",
    },
    {
      hint: "https://github.com/kubernetes/community",
      kind: "repo",
      rationale:
        "SIG meeting notes, design discussions, contributor docs.",
    },
    {
      hint: "https://github.com/kubernetes/enhancements",
      kind: "repo",
      rationale:
        "KEPs — authoritative source for upcoming features and rationales.",
    },
    {
      hint: "https://www.cncf.io/blog/",
      kind: "news",
      rationale: "Ecosystem-wide news touching the kubernetes project.",
    },
    {
      hint: "site:reddit.com/r/kubernetes recent",
      kind: "community",
      rationale: "Practitioner discussion and current pain points.",
    },
    {
      hint: "https://kubernetes.io/docs/reference/",
      kind: "docs",
      rationale: "API reference; complementary to the main docs root.",
    },
  ],
  webSearchQueries: [
    {
      query: "kubernetes operator best practices 2026",
      targetKind: "community",
      rationale: "Surface practitioner write-ups on operator design.",
      recencyDays: 90,
    },
    {
      query: "kubernetes deprecation timeline next minor",
      targetKind: "news",
      rationale: "Find the most recent deprecation tracker.",
      recencyDays: 30,
    },
  ],
  githubQueries: [
    {
      query: "kubernetes operator topic:operator stars:>500",
      type: "repos",
      rationale:
        "High-signal operator implementations to mine for patterns.",
    },
    {
      query: "kubernetes-sigs topic:sig stars:>200",
      type: "repos",
      rationale: "Official SIG-maintained repos covering subareas.",
    },
  ],
  coverageGoals: {
    docs: { min: 2, max: 3 },
    repo: { min: 2, max: 3 },
    news: { min: 1, max: 2 },
    community: { min: 1, max: 2 },
    academic: { min: 0, max: 1 },
    data: { min: 0, max: 2 },
    file: { min: 0, max: 0 },
    essay: { min: 0, max: 0 },
    book: { min: 0, max: 0 },
    talk: { min: 0, max: 0 },
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Worked example: evaluator-v1.md (kubernetes draft sources file)
// ──────────────────────────────────────────────────────────────────────────────

const EVALUATOR_KUBERNETES: unknown = {
  schemaVersion: "0.1.0",
  status: "draft",
  generatedAt: "2026-05-08T10:00:00Z",
  generatedBy: {
    stage: "02-source-discovery",
    evaluatorPromptVersion: "v1",
    candidateCount: 10,
    acceptedCount: 8,
  },
  coverage: {
    docs: 2,
    repo: 3,
    news: 2,
    community: 1,
    academic: 0,
    data: 0,
    file: 0,
    essay: 0,
    book: 0,
    talk: 0,
  },
  warnings: [],
  sources: [
    {
      id: "kubernetes-io-docs",
      url: "https://kubernetes.io/docs/",
      kind: "docs",
      trust: 0.98,
      volatility: "fast",
      rationale:
        "Canonical Kubernetes documentation; primary source for concepts and reference.",
      ingestion: {
        mode: "index-only",
        scope: ["concepts/*", "reference/*", "tasks/*", "setup/*"],
        refreshIntervalHours: 24,
      },
      notes: null,
    },
    {
      id: "kubernetes-io-docs-reference",
      url: "https://kubernetes.io/docs/reference/",
      kind: "docs",
      trust: 0.97,
      volatility: "fast",
      rationale:
        "API reference subtree; high-resolution complement to the main docs.",
      ingestion: {
        mode: "index-only",
        scope: ["**"],
        refreshIntervalHours: 24,
      },
      notes:
        "Subtree of kubernetes-io-docs; kept separate to allow finer-grained scoping.",
    },
    {
      id: "gh-kubernetes-releases",
      url: "https://github.com/kubernetes/kubernetes/releases",
      kind: "repo",
      trust: 0.99,
      volatility: "fast",
      rationale:
        "Authoritative source for release notes and version diffs.",
      ingestion: {
        mode: "snapshot",
        scope: ["releases/latest", "releases/tag/*"],
        refreshIntervalHours: 24,
      },
      notes: "Permissive (Apache-2.0); snapshot is appropriate.",
    },
    {
      id: "gh-kubernetes-community",
      url: "https://github.com/kubernetes/community",
      kind: "repo",
      trust: 0.92,
      volatility: "slow",
      rationale: "SIG meeting notes and community governance.",
      ingestion: {
        mode: "snapshot",
        scope: ["sig-*/README.md", "contributors/devel/*"],
        refreshIntervalHours: 168,
      },
      notes: null,
    },
    {
      id: "gh-kubernetes-enhancements",
      url: "https://github.com/kubernetes/enhancements",
      kind: "repo",
      trust: 0.95,
      volatility: "fast",
      rationale:
        "KEPs — authoritative source for upcoming features and rationales.",
      ingestion: {
        mode: "snapshot",
        scope: ["keps/**/README.md"],
        refreshIntervalHours: 24,
      },
      notes: null,
    },
    {
      id: "kubernetes-io-blog",
      url: "https://kubernetes.io/blog/",
      kind: "news",
      trust: 0.96,
      volatility: "fast",
      rationale: "Official release announcements and feature posts.",
      ingestion: {
        mode: "feed",
        scope: [],
        refreshIntervalHours: 24,
      },
      notes: "Has RSS feed; pipeline can subscribe.",
    },
    {
      id: "cncf-blog",
      url: "https://www.cncf.io/blog/",
      kind: "news",
      trust: 0.85,
      volatility: "fast",
      rationale: "Ecosystem-wide news touching the project.",
      ingestion: {
        mode: "feed",
        scope: ["topic:kubernetes"],
        refreshIntervalHours: 24,
      },
      notes: null,
    },
    {
      id: "reddit-r-kubernetes",
      url: "https://reddit.com/r/kubernetes",
      kind: "community",
      trust: 0.62,
      volatility: "fast",
      rationale:
        "Practitioner discussion; useful for surfacing current pain points.",
      ingestion: {
        mode: "index-only",
        scope: ["top.json?t=month"],
        refreshIntervalHours: 168,
      },
      notes: "Community quality varies; use for sentiment, not authority.",
    },
  ],
  rejected: [
    {
      url: "https://k8s-listicle-spam.example.com",
      reason: "ai-slop",
    },
    {
      url: "https://medium.com/@some-author/k8s-tutorial",
      reason: "low-trust",
    },
  ],
};

// ──────────────────────────────────────────────────────────────────────────────
// Stage 2a — SourceDiscoveryPlan worked example
// ──────────────────────────────────────────────────────────────────────────────

describe("SourceDiscoveryPlan — planner-v1 worked example", () => {
  test("kubernetes example parses", () => {
    const plan = SourceDiscoveryPlanSchema.parse(PLANNER_KUBERNETES);
    expect(plan.domain.canonicalSlug).toBe("kubernetes");
    expect(plan.budgets.targetAcceptedSources).toBe(8);
    expect(plan.directProbes.length).toBe(8);
    expect(plan.webSearchQueries.length).toBe(2);
    expect(plan.githubQueries.length).toBe(2);
  });
});

describe("SourceDiscoveryPlan — validation rejections", () => {
  function clone(): SourceDiscoveryPlan {
    return structuredClone(PLANNER_KUBERNETES) as SourceDiscoveryPlan;
  }

  test("rejects when directProbes exceeds budget.maxUrlProbes", () => {
    const bad = clone();
    bad.budgets.maxUrlProbes = 2; // current directProbes.length === 8
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects when webSearchQueries exceeds budget", () => {
    const bad = clone();
    bad.budgets.maxWebSearchQueries = 1;
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects when githubQueries exceeds budget", () => {
    const bad = clone();
    bad.budgets.maxGithubQueries = 1;
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects when a coverageGoal has min > max", () => {
    const bad = clone();
    bad.coverageGoals.docs = { min: 5, max: 1 };
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects targetAcceptedSources > 12 (v0.1 hard cap)", () => {
    const bad = clone();
    bad.budgets.targetAcceptedSources = 13;
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects unknown SourceKind in directProbe", () => {
    const bad = clone();
    bad.directProbes[0] = {
      ...bad.directProbes[0]!,
      kind: "podcast" as never,
    };
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("accepts targetKind 'any' in webSearchQuery", () => {
    const ok = clone();
    ok.webSearchQueries[0] = {
      ...ok.webSearchQueries[0]!,
      targetKind: "any",
    };
    expect(() => SourceDiscoveryPlanSchema.parse(ok)).not.toThrow();
  });

  test("rejects schemaVersion not equal to 0.1.0", () => {
    const bad = clone() as unknown as { schemaVersion: string };
    bad.schemaVersion = "0.2.0";
    expect(() => SourceDiscoveryPlanSchema.parse(bad)).toThrow(z.ZodError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Stage 2b — SourcesFile worked example + cross-field invariants
// ──────────────────────────────────────────────────────────────────────────────

describe("SourcesFile — evaluator-v1 worked example", () => {
  test("kubernetes draft example parses", () => {
    const file = SourcesFileSchema.parse(EVALUATOR_KUBERNETES);
    expect(file.status).toBe("draft");
    expect(file.sources.length).toBe(8);
    expect(file.coverage.docs).toBe(2);
    expect(file.coverage.repo).toBe(3);
    expect(file.coverage.news).toBe(2);
    expect(file.coverage.community).toBe(1);
    expect(file.rejected.length).toBe(2);
  });

  test("parseDraftSourcesFile passes draft through", () => {
    const file = parseDraftSourcesFile(EVALUATOR_KUBERNETES);
    expect(file.status).toBe("draft");
  });

  test("parseDraftSourcesFile rejects non-draft input", () => {
    const approved = structuredClone(EVALUATOR_KUBERNETES) as SourcesFile;
    approved.status = "approved";
    approved.approvedAt = "2026-05-08T10:05:00Z";
    approved.approvedBy = "auto";
    expect(() => parseDraftSourcesFile(approved)).toThrow(
      /must emit status="draft"/,
    );
  });

  test("parseDraftSourcesFile normalizes a wrong acceptedCount (regression)", () => {
    // Real smoke run: LLM emitted acceptedCount=12 for a sources array of
    // length 11. The parser should now recompute from sources.length rather
    // than crash on the schema invariant.
    const raw = structuredClone(EVALUATOR_KUBERNETES) as SourcesFile;
    raw.generatedBy.acceptedCount = 999;
    const file = parseDraftSourcesFile(raw);
    expect(file.generatedBy.acceptedCount).toBe(file.sources.length);
  });

  test("parseDraftSourcesFile normalizes wrong coverage counts (regression)", () => {
    const raw = structuredClone(EVALUATOR_KUBERNETES) as SourcesFile;
    raw.coverage.docs = 99;
    raw.coverage.repo = 77;
    const file = parseDraftSourcesFile(raw);
    let actualDocs = 0;
    let actualRepo = 0;
    for (const s of file.sources) {
      if (s.kind === "docs") actualDocs += 1;
      if (s.kind === "repo") actualRepo += 1;
    }
    expect(file.coverage.docs).toBe(actualDocs);
    expect(file.coverage.repo).toBe(actualRepo);
  });
});

describe("SourcesFile — validation rejections", () => {
  function clone(): SourcesFile {
    return structuredClone(EVALUATOR_KUBERNETES) as SourcesFile;
  }

  test("rejects acceptedCount mismatch with sources.length", () => {
    const bad = clone();
    bad.generatedBy.acceptedCount = 99;
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects coverage[kind] mismatch with actual sources", () => {
    const bad = clone();
    bad.coverage.docs = 99; // actual is 2
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects duplicate source ids", () => {
    const bad = clone();
    bad.sources[1] = {
      ...bad.sources[1]!,
      id: bad.sources[0]!.id,
    };
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects trust score outside 0..1", () => {
    const bad = clone();
    bad.sources[0]!.trust = 1.5;
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects status=approved without approvedAt/approvedBy", () => {
    const bad = clone();
    bad.status = "approved";
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("accepts status=approved when approvedAt + approvedBy are set", () => {
    const ok = clone();
    ok.status = "approved";
    ok.approvedAt = "2026-05-08T10:05:00Z";
    ok.approvedBy = "auto";
    expect(() => SourcesFileSchema.parse(ok)).not.toThrow();
  });

  test("rejects approvedAt set while status is draft", () => {
    const bad = clone();
    bad.approvedAt = "2026-05-08T10:05:00Z";
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects malformed generatedAt timestamp", () => {
    const bad = clone();
    bad.generatedAt = "yesterday";
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects unknown rejection reason", () => {
    const bad = clone();
    bad.rejected[0] = {
      url: "https://example.com",
      reason: "personal-dislike" as never,
    };
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects when sources exceed v0.1 hard cap of 12", () => {
    const bad = clone();
    const template = bad.sources[0]!;
    bad.sources = Array.from({ length: 13 }, (_, i) => ({
      ...template,
      id: `clone-${i}`,
      url: `https://example.com/${i}`,
    }));
    bad.generatedBy.acceptedCount = 13;
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects rejected[] over 50", () => {
    const bad = clone();
    bad.rejected = Array.from({ length: 51 }, (_, i) => ({
      url: `https://example.com/r${i}`,
      reason: "low-trust" as const,
    }));
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects invalid source URL", () => {
    const bad = clone();
    bad.sources[0]!.url = "not a url";
    expect(() => SourcesFileSchema.parse(bad)).toThrow(z.ZodError);
  });
});
