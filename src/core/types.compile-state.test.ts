/**
 * Tests for `CompileState` zod schema and `initCompileState()`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  CompileStateSchema,
  initCompileState,
  STAGE_IDS,
  StageEntrySchema,
  type CompileOptions,
  type CompileState,
  type StageEntry,
  type StageId,
} from "./types.ts";

const SHA = "a".repeat(64);

const DEFAULT_OPTIONS: CompileOptions = {
  depth: "standard",
  sourcesHint: [],
  target: "both",
  autoApprove: true,
  language: "ts",
};

function buildInitInput() {
  return {
    runId: "01H8Q5Z2QJK4VXNTRWP3M7XYZ0",
    almanacId: "kubernetes",
    domain: "kubernetes",
    forgerVersion: "0.0.1",
    options: DEFAULT_OPTIONS,
    now: new Date("2026-05-08T10:00:00Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// initCompileState
// ──────────────────────────────────────────────────────────────────────────────

describe("initCompileState", () => {
  test("produces a valid blank state with every stage pending", () => {
    const state = initCompileState(buildInitInput());
    expect(state.schemaVersion).toBe("0.1.0");
    expect(state.runId).toBe("01H8Q5Z2QJK4VXNTRWP3M7XYZ0");
    expect(state.startedAt).toBe("2026-05-08T10:00:00.000Z");
    expect(state.updatedAt).toBe(state.startedAt);
    expect(state.currentStageId).toBeNull();

    for (const id of STAGE_IDS) {
      const entry = state.stages[id];
      expect(entry.status).toBe("pending");
      expect(entry.startedAt).toBeNull();
      expect(entry.finishedAt).toBeNull();
      expect(entry.inputHash).toBeNull();
      expect(entry.outputHash).toBeNull();
      expect(entry.llmCalls).toBe(0);
      expect(entry.attempt).toBe(0);
    }
  });

  test("contains every STAGE_ID as a key", () => {
    const state = initCompileState(buildInitInput());
    const keys = Object.keys(state.stages).sort();
    const expected = [...STAGE_IDS].sort();
    expect(keys).toEqual(expected);
  });

  test("uses new Date() when `now` is omitted", () => {
    const before = Date.now();
    const state = initCompileState({
      ...buildInitInput(),
      now: undefined,
    });
    const after = Date.now();
    const ts = Date.parse(state.startedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("rejects malformed almanacId", () => {
    expect(() =>
      initCompileState({
        ...buildInitInput(),
        almanacId: "Bad ID",
      }),
    ).toThrow(z.ZodError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// StageEntry — per-status invariants
// ──────────────────────────────────────────────────────────────────────────────

describe("StageEntry — status invariants", () => {
  function pending(): StageEntry {
    return {
      status: "pending",
      startedAt: null,
      finishedAt: null,
      inputHash: null,
      outputHash: null,
      promptVersion: null,
      llmCalls: 0,
      attempt: 0,
    };
  }

  test("pending: rejects startedAt set", () => {
    const bad = pending();
    bad.startedAt = "2026-05-08T10:00:00Z";
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);
  });

  test("running: requires startedAt, forbids finishedAt", () => {
    const bad: StageEntry = {
      ...pending(),
      status: "running",
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);
    bad.startedAt = "2026-05-08T10:00:00Z";
    expect(() => StageEntrySchema.parse(bad)).not.toThrow();

    bad.finishedAt = "2026-05-08T10:00:00Z";
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);
  });

  test("completed: requires startedAt, finishedAt, outputHash", () => {
    const bad: StageEntry = {
      ...pending(),
      status: "completed",
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);

    const ok: StageEntry = {
      status: "completed",
      startedAt: "2026-05-08T10:00:00Z",
      finishedAt: "2026-05-08T10:00:01Z",
      inputHash: SHA,
      outputHash: SHA,
      promptVersion: "v1",
      llmCalls: 1,
      attempt: 1,
    };
    expect(() => StageEntrySchema.parse(ok)).not.toThrow();
  });

  test("completed: rejects outputHash null", () => {
    const bad: StageEntry = {
      status: "completed",
      startedAt: "2026-05-08T10:00:00Z",
      finishedAt: "2026-05-08T10:00:01Z",
      inputHash: SHA,
      outputHash: null,
      promptVersion: "v1",
      llmCalls: 1,
      attempt: 1,
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);
  });

  test("failed: requires error", () => {
    const bad: StageEntry = {
      ...pending(),
      status: "failed",
      startedAt: "2026-05-08T10:00:00Z",
      finishedAt: "2026-05-08T10:00:01Z",
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);

    const ok: StageEntry = {
      ...bad,
      error: {
        code: "LLM_TIMEOUT",
        message: "request timed out after 120s",
        attempt: 2,
        occurredAt: "2026-05-08T10:00:01Z",
      },
    };
    expect(() => StageEntrySchema.parse(ok)).not.toThrow();
  });

  test("skipped: requires skipReason", () => {
    const bad: StageEntry = {
      ...pending(),
      status: "skipped",
      startedAt: "2026-05-08T10:00:00Z",
      finishedAt: "2026-05-08T10:00:01Z",
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);

    const ok: StageEntry = {
      ...bad,
      skipReason: "auto-approved (--auto-approve default)",
    };
    expect(() => StageEntrySchema.parse(ok)).not.toThrow();
  });

  test("rejects finishedAt earlier than startedAt", () => {
    const bad: StageEntry = {
      status: "completed",
      startedAt: "2026-05-08T10:00:01Z",
      finishedAt: "2026-05-08T10:00:00Z", // earlier than startedAt
      inputHash: SHA,
      outputHash: SHA,
      promptVersion: "v1",
      llmCalls: 1,
      attempt: 1,
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects malformed sha256 hash", () => {
    const bad: StageEntry = {
      status: "completed",
      startedAt: "2026-05-08T10:00:00Z",
      finishedAt: "2026-05-08T10:00:01Z",
      inputHash: "abc",
      outputHash: SHA,
      promptVersion: "v1",
      llmCalls: 1,
      attempt: 1,
    };
    expect(() => StageEntrySchema.parse(bad)).toThrow(z.ZodError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CompileState — top-level invariants
// ──────────────────────────────────────────────────────────────────────────────

describe("CompileState — top-level invariants", () => {
  function setStageRunning(state: CompileState, id: StageId): CompileState {
    return {
      ...state,
      currentStageId: id,
      stages: {
        ...state.stages,
        [id]: {
          ...state.stages[id],
          status: "running",
          startedAt: state.startedAt,
        },
      },
    };
  }

  test("baseline (init) parses through schema", () => {
    const state = initCompileState(buildInitInput());
    expect(() => CompileStateSchema.parse(state)).not.toThrow();
  });

  test("rejects updatedAt earlier than startedAt", () => {
    const state = initCompileState(buildInitInput());
    const bad = { ...state, updatedAt: "2026-05-07T10:00:00.000Z" };
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects two simultaneously running stages", () => {
    const state = initCompileState(buildInitInput());
    let bad = setStageRunning(state, "01-domain-analysis");
    bad = {
      ...bad,
      stages: {
        ...bad.stages,
        "04-source-fetch": {
          ...bad.stages["04-source-fetch"],
          status: "running",
          startedAt: bad.startedAt,
        },
      },
    };
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects currentStageId pointing to a non-running entry", () => {
    const state = initCompileState(buildInitInput());
    const bad = { ...state, currentStageId: "01-domain-analysis" as StageId };
    // stages["01-domain-analysis"].status is still "pending"
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects currentStageId=null when a stage is actually running", () => {
    const state = initCompileState(buildInitInput());
    const bad: CompileState = {
      ...state,
      currentStageId: null,
      stages: {
        ...state.stages,
        "01-domain-analysis": {
          ...state.stages["01-domain-analysis"],
          status: "running",
          startedAt: state.startedAt,
        },
      },
    };
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("accepts a valid running snapshot", () => {
    const state = initCompileState(buildInitInput());
    const ok = setStageRunning(state, "01-domain-analysis");
    expect(() => CompileStateSchema.parse(ok)).not.toThrow();
  });

  test("rejects when stages map is missing a key", () => {
    const state = initCompileState(buildInitInput());
    // Drop one required key (cast to bypass the typed Stages shape).
    const partial = { ...state.stages } as Record<string, StageEntry>;
    delete partial["12-benchmark-run"];
    const bad = { ...state, stages: partial };
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects schemaVersion not equal to 0.1.0", () => {
    const state = initCompileState(buildInitInput());
    const bad = { ...state, schemaVersion: "0.2.0" as never };
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects malformed canonicalSlug in almanacId", () => {
    const state = initCompileState(buildInitInput());
    const bad = { ...state, almanacId: "BadSlug" };
    expect(() => CompileStateSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("STAGE_IDS contains exactly 15 entries (compile-time check)", () => {
    expect(STAGE_IDS.length).toBe(15);
  });
});
