/**
 * Tests for Stage 0 — bootstrap.
 *
 *   - happy path: produces a validated `AlmanacManifest` + `CompileState`
 *   - both artifacts share the same `almanacId`, `domain`, and timestamp
 *   - all 15 stages start in `pending`
 *   - layout constant lists the canonical subdirectories
 */

import { describe, expect, test } from "bun:test";

import {
  AlmanacManifestSchema,
  STAGE_IDS,
  type CompileOptions,
} from "../../core/types.ts";
import {
  ALMANAC_SUBDIRECTORIES,
  bootstrapAlmanac,
} from "./s00-bootstrap.ts";

const baseOpts: CompileOptions = {
  depth: "standard",
  sourcesHint: [],
  target: "both",
  autoApprove: true,
  language: "ts",
};

describe("bootstrapAlmanac", () => {
  test("produces a validated manifest and a fresh compile state", () => {
    const r = bootstrapAlmanac({
      almanacId: "kubernetes",
      domain: "kubernetes",
      displayName: "Kubernetes",
      freshnessProfileId: "mixed",
      runId: "run-2026-05-08-abc",
      forgerVersion: "0.0.1",
      options: baseOpts,
      now: new Date("2026-05-08T12:00:00.000Z"),
    });

    // manifest re-parses through the schema (defensive)
    expect(() => AlmanacManifestSchema.parse(r.manifest)).not.toThrow();

    expect(r.manifest.almanacId).toBe("kubernetes");
    expect(r.manifest.toolCount).toBe(0);
    expect(r.manifest.factCount).toBe(0);
    expect(r.manifest.bootstrappedAt).toBe("2026-05-08T12:00:00.000Z");
    expect(r.manifest.compiledAt).toBe(r.manifest.bootstrappedAt);
    expect(r.manifest.version).toBe("0.1.0");
  });

  test("manifest and compileState agree on almanacId / domain / forgerVersion", () => {
    const r = bootstrapAlmanac({
      almanacId: "cooking",
      domain: "cooking",
      displayName: "Cooking",
      freshnessProfileId: "static-heavy",
      runId: "run-1",
      forgerVersion: "0.0.1",
      options: baseOpts,
      now: new Date("2026-05-08T12:00:00.000Z"),
    });
    expect(r.compileState.almanacId).toBe(r.manifest.almanacId);
    expect(r.compileState.domain).toBe(r.manifest.domain);
    expect(r.compileState.forgerVersion).toBe(r.manifest.forgerVersion);
    expect(r.compileState.startedAt).toBe(r.manifest.bootstrappedAt);
  });

  test("every stage starts as 'pending' with no timestamps", () => {
    const r = bootstrapAlmanac({
      almanacId: "x",
      domain: "x",
      displayName: "X",
      freshnessProfileId: "mixed",
      runId: "run-1",
      forgerVersion: "0.0.1",
      options: baseOpts,
    });
    for (const id of STAGE_IDS) {
      const s = r.compileState.stages[id];
      expect(s.status).toBe("pending");
      expect(s.startedAt).toBeNull();
      expect(s.finishedAt).toBeNull();
      expect(s.attempt).toBe(0);
    }
    expect(r.compileState.currentStageId).toBeNull();
  });

  test("rejects malformed almanacId", () => {
    expect(() =>
      bootstrapAlmanac({
        almanacId: "Has Capitals",
        domain: "x",
        displayName: "X",
        freshnessProfileId: "mixed",
        runId: "run-1",
        forgerVersion: "0.0.1",
        options: baseOpts,
      }),
    ).toThrow();
  });

  test("uses new Date() when `now` is omitted", () => {
    const before = Date.now();
    const r = bootstrapAlmanac({
      almanacId: "x",
      domain: "x",
      displayName: "X",
      freshnessProfileId: "mixed",
      runId: "run-1",
      forgerVersion: "0.0.1",
      options: baseOpts,
    });
    const after = Date.now();
    const ts = Date.parse(r.manifest.bootstrappedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("ALMANAC_SUBDIRECTORIES", () => {
  test("lists the canonical layout", () => {
    expect(ALMANAC_SUBDIRECTORIES).toEqual([
      "sources",
      "sources/raw",
      "extracted",
      "knowledge",
      "tools",
      "adapters",
      "adapters/skill",
      "tests",
      ".runs",
      ".compile",
    ]);
  });
});
