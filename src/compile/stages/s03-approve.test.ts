/**
 * Tests for Stage 3 (source approval gate).
 */

import { describe, expect, test } from "bun:test";

import type { SourcesFile } from "../../core/types.ts";
import {
  AlreadyApprovedError,
  approveSources,
} from "./s03-approve.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Minimal draft fixture (smaller than the Stage 2b worked example; just enough
// to satisfy schema invariants).
// ──────────────────────────────────────────────────────────────────────────────

function buildDraft(): SourcesFile {
  return {
    schemaVersion: "0.1.0",
    status: "draft",
    generatedAt: "2026-05-08T10:00:00Z",
    generatedBy: {
      stage: "02-source-discovery",
      evaluatorPromptVersion: "v1",
      candidateCount: 3,
      acceptedCount: 2,
    },
    coverage: {
      docs: 1,
      repo: 1,
      news: 0,
      community: 0,
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
        rationale: "Canonical Kubernetes documentation.",
        ingestion: {
          mode: "index-only",
          scope: ["concepts/*"],
          refreshIntervalHours: 24,
        },
        notes: null,
      },
      {
        id: "gh-kubernetes-releases",
        url: "https://github.com/kubernetes/kubernetes/releases",
        kind: "repo",
        trust: 0.99,
        volatility: "fast",
        rationale: "Authoritative release notes.",
        ingestion: {
          mode: "snapshot",
          scope: ["releases/latest"],
          refreshIntervalHours: 24,
        },
        notes: null,
      },
    ],
    rejected: [
      { url: "https://example.com/dead", reason: "dead-link" },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("Stage 3 — approveSources (happy paths)", () => {
  test("flips draft to approved with by=auto and explicit at", () => {
    const draft = buildDraft();
    const at = new Date("2026-05-08T10:05:00Z");
    const approved = approveSources(draft, { by: "auto", at });

    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBe("2026-05-08T10:05:00.000Z");
    expect(approved.approvedBy).toBe("auto");
    // Non-approval fields are preserved
    expect(approved.sources.length).toBe(2);
    expect(approved.coverage.docs).toBe(1);
    expect(approved.generatedAt).toBe(draft.generatedAt);
  });

  test("flips draft to approved with by=human", () => {
    const draft = buildDraft();
    const approved = approveSources(draft, { by: "human" });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("human");
  });

  test("does not mutate the input", () => {
    const draft = buildDraft();
    const snapshot = structuredClone(draft);
    approveSources(draft, { by: "auto" });
    expect(draft).toEqual(snapshot);
  });

  test("uses new Date() when `at` is omitted", () => {
    const draft = buildDraft();
    const before = Date.now();
    const approved = approveSources(draft, { by: "auto" });
    const after = Date.now();
    const ts = Date.parse(approved.approvedAt!);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("approvedAt is ISO 8601 UTC with Z suffix", () => {
    const draft = buildDraft();
    const approved = approveSources(draft, { by: "auto" });
    expect(approved.approvedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );
  });

  test("approves an empty-sources draft (rare but valid)", () => {
    const draft = buildDraft();
    draft.sources = [];
    draft.coverage = {
      docs: 0,
      repo: 0,
      news: 0,
      community: 0,
      academic: 0,
      data: 0,
      file: 0,
      essay: 0,
      book: 0,
      talk: 0,
    };
    draft.generatedBy.acceptedCount = 0;
    const approved = approveSources(draft, { by: "auto" });
    expect(approved.status).toBe("approved");
    expect(approved.sources.length).toBe(0);
  });
});

describe("Stage 3 — approveSources (rejections)", () => {
  test("throws AlreadyApprovedError when input is already approved", () => {
    const draft = buildDraft();
    const once = approveSources(draft, { by: "auto" });
    expect(() => approveSources(once, { by: "auto" })).toThrow(
      AlreadyApprovedError,
    );
  });

  test("AlreadyApprovedError exposes the offending file", () => {
    const draft = buildDraft();
    const once = approveSources(draft, {
      by: "human",
      at: new Date("2026-05-08T10:05:00Z"),
    });
    try {
      approveSources(once, { by: "auto" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AlreadyApprovedError);
      expect((err as AlreadyApprovedError).file.approvedBy).toBe("human");
      expect((err as AlreadyApprovedError).file.approvedAt).toBe(
        "2026-05-08T10:05:00.000Z",
      );
    }
  });
});
