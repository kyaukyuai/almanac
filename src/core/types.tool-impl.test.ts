/**
 * Tests for the Stage 7 (tool implementation) schemas:
 *   - `ImplementationAttemptSchema` (success ↔ no diagnostics, monotonic time)
 *   - `ToolImplementationResultSchema` cross-field invariants
 *     (status ↔ last attempt, status ↔ finalManifest fields, name match)
 *   - `Stage07OutputSchema` summary derivation + uniqueness
 *   - `buildStage07Output()` builder
 */

import { describe, expect, test } from "bun:test";

import {
  ImplementationAttemptSchema,
  Stage07OutputSchema,
  ToolImplementationResultSchema,
  ToolManifestSchema,
  buildStage07Output,
  type ImplementationAttempt,
  type ToolImplementationResult,
  type ToolManifest,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const baseManifest = (overrides: Partial<ToolManifest> = {}): ToolManifest =>
  ToolManifestSchema.parse({
    name: "ingredient_substitute",
    version: "0.1.0",
    description: "Suggest substitutes for an ingredient with notes on flavor.",
    whenToUse: "When the user asks for an alternative to a specific ingredient.",
    returnsSummary: "Ranked list of substitute ingredients with notes.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    capabilities: { network: [], fs: "read", subprocess: [], secrets: [] },
    volatilityClass: "static",
    freshness: { cachePolicy: "manual-refresh", ttlSeconds: null, sourceTimestamp: false },
    knowledgeUsage: { facts: true, ftsQuery: "{q}", embeddings: false },
    examples: [
      {
        description: "smoke",
        input: { ingredient: "buttermilk" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
    disabled: false,
    ...overrides,
  });

const successAttempt = (n: number): ImplementationAttempt => ({
  attemptNumber: n,
  model: "claude-sonnet-4",
  promptVersion: "07-tool-impl/v1",
  startedAt: "2026-05-08T12:00:00.000Z",
  finishedAt: "2026-05-08T12:00:30.000Z",
  outcome: "success",
  diagnostics: null,
});

const failedAttempt = (
  n: number,
  outcome: ImplementationAttempt["outcome"] = "tsc-failed",
): ImplementationAttempt => ({
  attemptNumber: n,
  model: "claude-sonnet-4",
  promptVersion: "07-tool-impl/v1",
  startedAt: "2026-05-08T12:00:00.000Z",
  finishedAt: "2026-05-08T12:00:25.000Z",
  outcome,
  diagnostics: "TS2322: Type 'string' is not assignable to type 'number'.",
});

const implementedManifest = (overrides: Partial<ToolManifest> = {}): ToolManifest =>
  baseManifest({
    implementedBy: {
      model: "claude-sonnet-4",
      promptVersion: "07-tool-impl/v1",
      tscPassed: true,
      smokePassed: true,
      attempts: 1,
    },
    ...overrides,
  });

const disabledManifest = (overrides: Partial<ToolManifest> = {}): ToolManifest =>
  baseManifest({
    disabled: true,
    disabledReason: "Stage 7 exhausted 3 attempts; tsc kept failing.",
    ...overrides,
  });

// ──────────────────────────────────────────────────────────────────────────────
// ImplementationAttemptSchema
// ──────────────────────────────────────────────────────────────────────────────

describe("ImplementationAttemptSchema", () => {
  test("accepts success with diagnostics=null", () => {
    expect(() => ImplementationAttemptSchema.parse(successAttempt(1))).not.toThrow();
  });

  test("rejects success with diagnostics set", () => {
    expect(() =>
      ImplementationAttemptSchema.parse({
        ...successAttempt(1),
        diagnostics: "any text",
      }),
    ).toThrow(/diagnostics must be null when outcome is 'success'/);
  });

  test("rejects failure with diagnostics=null", () => {
    expect(() =>
      ImplementationAttemptSchema.parse({
        ...failedAttempt(1, "smoke-failed"),
        diagnostics: null,
      }),
    ).toThrow(/diagnostics is required/);
  });

  test("rejects finishedAt < startedAt", () => {
    expect(() =>
      ImplementationAttemptSchema.parse({
        ...successAttempt(1),
        startedAt: "2026-05-08T12:00:30.000Z",
        finishedAt: "2026-05-08T12:00:00.000Z",
      }),
    ).toThrow(/finishedAt must be >= startedAt/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ToolImplementationResultSchema
// ──────────────────────────────────────────────────────────────────────────────

describe("ToolImplementationResultSchema", () => {
  test("happy: implemented after 2 attempts", () => {
    const r = ToolImplementationResultSchema.parse({
      toolName: "ingredient_substitute",
      status: "implemented",
      attempts: [failedAttempt(1, "tsc-failed"), successAttempt(2)],
      finalManifest: implementedManifest(),
    });
    expect(r.attempts).toHaveLength(2);
    expect(r.finalManifest.implementedBy?.attempts).toBe(1);
  });

  test("happy: disabled after 3 failed attempts", () => {
    const r = ToolImplementationResultSchema.parse({
      toolName: "ingredient_substitute",
      status: "disabled",
      attempts: [
        failedAttempt(1, "tsc-failed"),
        failedAttempt(2, "smoke-failed"),
        failedAttempt(3, "tsc-failed"),
      ],
      finalManifest: disabledManifest(),
    });
    expect(r.status).toBe("disabled");
    expect(r.finalManifest.disabledReason).toContain("3 attempts");
  });

  test("rejects status=implemented when last attempt failed", () => {
    expect(() =>
      ToolImplementationResultSchema.parse({
        toolName: "ingredient_substitute",
        status: "implemented",
        attempts: [failedAttempt(1, "tsc-failed")],
        finalManifest: implementedManifest(),
      }),
    ).toThrow(/last attempt's outcome to be/);
  });

  test("rejects status=disabled when last attempt succeeded", () => {
    expect(() =>
      ToolImplementationResultSchema.parse({
        toolName: "ingredient_substitute",
        status: "disabled",
        attempts: [successAttempt(1)],
        finalManifest: disabledManifest(),
      }),
    ).toThrow(/disabled.*requires the last attempt to be a failure/);
  });

  test("rejects status=implemented without finalManifest.implementedBy", () => {
    expect(() =>
      ToolImplementationResultSchema.parse({
        toolName: "ingredient_substitute",
        status: "implemented",
        attempts: [successAttempt(1)],
        finalManifest: baseManifest(), // no implementedBy
      }),
    ).toThrow(/implementedBy must be set/);
  });

  test("rejects status=disabled when finalManifest.disabled is false", () => {
    expect(() =>
      ToolImplementationResultSchema.parse({
        toolName: "ingredient_substitute",
        status: "disabled",
        attempts: [failedAttempt(1, "tsc-failed")],
        finalManifest: baseManifest(), // disabled:false
      }),
    ).toThrow(/disabled must be true/);
  });

  test("rejects toolName / finalManifest.name mismatch", () => {
    expect(() =>
      ToolImplementationResultSchema.parse({
        toolName: "different_name",
        status: "implemented",
        attempts: [successAttempt(1)],
        finalManifest: implementedManifest(),
      }),
    ).toThrow(/does not match toolName/);
  });

  test("rejects non-sequential attemptNumbers", () => {
    expect(() =>
      ToolImplementationResultSchema.parse({
        toolName: "ingredient_substitute",
        status: "implemented",
        attempts: [successAttempt(2)],
        finalManifest: implementedManifest(),
      }),
    ).toThrow(/sequential starting at 1/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Stage07OutputSchema + buildStage07Output
// ──────────────────────────────────────────────────────────────────────────────

describe("buildStage07Output", () => {
  test("aggregates summary across mixed results", () => {
    const r1: ToolImplementationResult = {
      toolName: "ingredient_substitute",
      status: "implemented",
      attempts: [failedAttempt(1, "tsc-failed"), successAttempt(2)],
      finalManifest: implementedManifest(),
    };
    const r2: ToolImplementationResult = {
      toolName: "query_facts",
      status: "implemented",
      attempts: [successAttempt(1)],
      finalManifest: implementedManifest({ name: "query_facts" }),
    };
    const r3: ToolImplementationResult = {
      toolName: "version_diff",
      status: "disabled",
      attempts: [
        failedAttempt(1, "tsc-failed"),
        failedAttempt(2, "smoke-failed"),
        failedAttempt(3, "tsc-failed"),
      ],
      finalManifest: disabledManifest({ name: "version_diff" }),
    };

    const out = buildStage07Output({
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
      finishedAt: new Date("2026-05-08T12:10:00.000Z"),
      results: [r1, r2, r3],
    });

    expect(out.summary).toEqual({
      total: 3,
      implemented: 2,
      disabled: 1,
      totalAttempts: 6,
    });
  });

  test("rejects duplicate toolName across results", () => {
    expect(() =>
      buildStage07Output({
        startedAt: new Date("2026-05-08T12:00:00.000Z"),
        finishedAt: new Date("2026-05-08T12:10:00.000Z"),
        results: [
          {
            toolName: "ingredient_substitute",
            status: "implemented",
            attempts: [successAttempt(1)],
            finalManifest: implementedManifest(),
          },
          {
            toolName: "ingredient_substitute",
            status: "implemented",
            attempts: [successAttempt(1)],
            finalManifest: implementedManifest(),
          },
        ],
      }),
    ).toThrow(/duplicate toolName/);
  });
});

describe("Stage07OutputSchema", () => {
  test("rejects manifest whose summary disagrees with results", () => {
    expect(() =>
      Stage07OutputSchema.parse({
        schemaVersion: "0.1.0",
        startedAt: "2026-05-08T12:00:00.000Z",
        finishedAt: "2026-05-08T12:10:00.000Z",
        summary: { total: 1, implemented: 99, disabled: 0, totalAttempts: 1 },
        results: [
          {
            toolName: "ingredient_substitute",
            status: "implemented",
            attempts: [successAttempt(1)],
            finalManifest: implementedManifest(),
          },
        ],
      }),
    ).toThrow(/summary\.implemented.*!== actual/);
  });
});
