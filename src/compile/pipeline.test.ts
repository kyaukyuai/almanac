/**
 * Tests for the pipeline orchestrator.
 *
 *   - happy path: a single registered runner moves its stage to "completed"
 *   - missing runners are recorded as `skipped: no-runner-registered`
 *   - throwing runner produces `failed` with `code: stage-threw`
 *   - stopOnError stops the pipeline at the first failure (`notReached`)
 *   - persistState is invoked after every transition
 *   - state-transition helpers enforce schema invariants
 */

import { describe, expect, test } from "bun:test";

import {
  bumpSemver,
  markStageCompleted,
  markStageFailed,
  markStageRunning,
  markStageSkipped,
  resetStagesForUpdate,
  runPipeline,
  sha256Hex,
  type StageRunner,
} from "./pipeline.ts";
import { bootstrapAlmanac } from "./stages/s00-bootstrap.ts";
import { STAGE_IDS, type CompileOptions, type StageId } from "../core/types.ts";

const baseOpts: CompileOptions = {
  depth: "standard",
  sourcesHint: [],
  target: "both",
  autoApprove: true,
  language: "ts",
};

function freshFixture() {
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "k8s",
    domain: "kubernetes",
    displayName: "Kubernetes",
    freshnessProfileId: "mixed",
    runId: "run-1",
    forgerVersion: "0.0.0",
    options: baseOpts,
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
  return { manifest, compileState };
}

const TEST_TIME = new Date("2026-05-08T12:00:01.000Z");
const constNow = () => TEST_TIME;

// ──────────────────────────────────────────────────────────────────────────────
// State-transition helpers
// ──────────────────────────────────────────────────────────────────────────────

describe("markStageRunning", () => {
  test("transitions pending → running and bumps attempt", () => {
    const { compileState } = freshFixture();
    const next = markStageRunning(compileState, "01-domain-analysis", TEST_TIME, "v1");
    const entry = next.stages["01-domain-analysis"];
    expect(entry.status).toBe("running");
    expect(entry.startedAt).toBe(TEST_TIME.toISOString());
    expect(entry.finishedAt).toBeNull();
    expect(entry.attempt).toBe(1);
    expect(entry.promptVersion).toBe("v1");
    expect(next.currentStageId).toBe("01-domain-analysis");
    expect(next.updatedAt).toBe(TEST_TIME.toISOString());
  });

  test("rejects when another stage is already running", () => {
    const { compileState } = freshFixture();
    const s1 = markStageRunning(compileState, "01-domain-analysis", TEST_TIME, "v1");
    expect(() =>
      markStageRunning(s1, "02a-source-discovery-planner", TEST_TIME, "v1"),
    ).toThrow();
  });
});

describe("markStageCompleted", () => {
  test("transitions running → completed with hash and clears currentStageId", () => {
    const { compileState } = freshFixture();
    const s1 = markStageRunning(compileState, "01-domain-analysis", TEST_TIME, "v1");
    const s2 = markStageCompleted(s1, "01-domain-analysis", TEST_TIME, {
      outputHash: "a".repeat(64),
      llmCalls: 2,
      cost: { tokens: { input: 10, output: 5 }, usd: 0.001 },
    });
    const entry = s2.stages["01-domain-analysis"];
    expect(entry.status).toBe("completed");
    expect(entry.finishedAt).toBe(TEST_TIME.toISOString());
    expect(entry.outputHash).toBe("a".repeat(64));
    expect(entry.llmCalls).toBe(2);
    expect(entry.cost?.usd).toBe(0.001);
    expect(s2.currentStageId).toBeNull();
  });

  test("synthesizes startedAt for stages that never went through 'running' (e.g., Stage 0 at bootstrap)", () => {
    const { compileState } = freshFixture();
    const s1 = markStageCompleted(compileState, "00-bootstrap", TEST_TIME, {
      outputHash: "b".repeat(64),
    });
    const entry = s1.stages["00-bootstrap"];
    expect(entry.status).toBe("completed");
    expect(entry.startedAt).toBe(TEST_TIME.toISOString());
    expect(entry.finishedAt).toBe(TEST_TIME.toISOString());
  });
});

describe("markStageFailed", () => {
  test("records error fields and clears currentStageId", () => {
    const { compileState } = freshFixture();
    const s1 = markStageRunning(compileState, "01-domain-analysis", TEST_TIME, "v1");
    const s2 = markStageFailed(s1, "01-domain-analysis", TEST_TIME, {
      code: "boom",
      message: "kaboom",
    });
    const entry = s2.stages["01-domain-analysis"];
    expect(entry.status).toBe("failed");
    expect(entry.error?.code).toBe("boom");
    expect(entry.error?.message).toBe("kaboom");
    expect(entry.error?.attempt).toBe(1);
    expect(s2.currentStageId).toBeNull();
  });

  test("truncates over-long error messages to schema limit", () => {
    const { compileState } = freshFixture();
    const s1 = markStageRunning(compileState, "01-domain-analysis", TEST_TIME, "v1");
    const s2 = markStageFailed(s1, "01-domain-analysis", TEST_TIME, {
      code: "boom",
      message: "x".repeat(5000),
    });
    expect(s2.stages["01-domain-analysis"].error?.message.length).toBe(2000);
  });
});

describe("markStageSkipped", () => {
  test("transitions to skipped with a reason", () => {
    const { compileState } = freshFixture();
    const s1 = markStageSkipped(
      compileState,
      "11-benchmark-gen",
      TEST_TIME,
      "no-runner-registered",
    );
    const entry = s1.stages["11-benchmark-gen"];
    expect(entry.status).toBe("skipped");
    expect(entry.skipReason).toBe("no-runner-registered");
    expect(s1.currentStageId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runPipeline
// ──────────────────────────────────────────────────────────────────────────────

function fakeRunner(opts: {
  hash?: string;
  promptVersion?: string | null;
  throws?: Error;
  skipReason?: string;
  llmCalls?: number;
}): StageRunner {
  return {
    promptVersion: opts.promptVersion ?? null,
    async run() {
      if (opts.throws) throw opts.throws;
      if (opts.skipReason) return { kind: "skipped", reason: opts.skipReason };
      return {
        kind: "success",
        outputHash: opts.hash ?? "c".repeat(64),
        llmCalls: opts.llmCalls,
      };
    },
  };
}

describe("runPipeline", () => {
  test("missing runners → all subsequent stages 'skipped: no-runner-registered'", async () => {
    const { manifest, compileState } = freshFixture();
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {},
      now: constNow,
    });
    expect(r.failed).toEqual([]);
    expect(r.skipped.length).toBe(STAGE_IDS.length);
    for (const id of STAGE_IDS) {
      expect(r.state.stages[id].status).toBe("skipped");
      expect(r.state.stages[id].skipReason).toBe("no-runner-registered");
    }
  });

  test("treats already-completed stages as success without re-running", async () => {
    const { manifest, compileState } = freshFixture();
    // Pre-mark Stage 0 as completed (mirrors the CLI's bootstrap flow).
    const seeded = markStageCompleted(compileState, "00-bootstrap", TEST_TIME, {
      outputHash: "d".repeat(64),
    });
    let calls = 0;
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: seeded,
      manifest,
      runners: {
        "00-bootstrap": {
          promptVersion: null,
          async run() {
            calls += 1;
            return { kind: "success", outputHash: "x".repeat(64) };
          },
        },
      },
      now: constNow,
    });
    expect(calls).toBe(0);
    expect(r.succeeded).toContain("00-bootstrap");
    expect(r.state.stages["00-bootstrap"].outputHash).toBe("d".repeat(64));
  });

  test("a successful runner moves its stage to completed", async () => {
    const { manifest, compileState } = freshFixture();
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {
        "00-bootstrap": fakeRunner({ hash: "e".repeat(64), llmCalls: 0 }),
      },
      now: constNow,
    });
    expect(r.succeeded).toContain("00-bootstrap");
    expect(r.state.stages["00-bootstrap"].status).toBe("completed");
    expect(r.state.stages["00-bootstrap"].outputHash).toBe("e".repeat(64));
  });

  test("runner returning skipped is recorded with the supplied reason", async () => {
    const { manifest, compileState } = freshFixture();
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {
        "00-bootstrap": fakeRunner({ skipReason: "no-data-yet" }),
      },
      now: constNow,
    });
    expect(r.skipped).toContain("00-bootstrap");
    expect(r.state.stages["00-bootstrap"].skipReason).toBe("no-data-yet");
  });

  test("throwing runner ⇒ failed entry with code 'stage-threw'", async () => {
    const { manifest, compileState } = freshFixture();
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {
        "00-bootstrap": fakeRunner({ throws: new Error("kaboom") }),
        "01-domain-analysis": fakeRunner({}),
      },
      now: constNow,
    });
    expect(r.failed).toEqual(["00-bootstrap"]);
    expect(r.state.stages["00-bootstrap"].error?.code).toBe("stage-threw");
    expect(r.state.stages["00-bootstrap"].error?.message).toBe("kaboom");
    // stopOnError defaults true → 01 onward are notReached
    expect(r.notReached).toContain("01-domain-analysis");
  });

  test("stopOnError=false continues the pipeline after failure", async () => {
    const { manifest, compileState } = freshFixture();
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {
        "00-bootstrap": fakeRunner({ throws: new Error("kaboom") }),
        "01-domain-analysis": fakeRunner({ hash: "f".repeat(64) }),
      },
      stopOnError: false,
      now: constNow,
    });
    expect(r.failed).toEqual(["00-bootstrap"]);
    expect(r.notReached).toEqual([]);
    expect(r.state.stages["01-domain-analysis"].status).toBe("completed");
  });

  test("persistState is invoked after every transition", async () => {
    const { manifest, compileState } = freshFixture();
    const persisted: StageId[] = [];
    await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {
        "00-bootstrap": fakeRunner({ hash: "g".repeat(64) }),
      },
      persistState: async (s) => {
        if (s.currentStageId !== null) persisted.push(s.currentStageId);
      },
      now: constNow,
    });
    // Stage 0 transitioned through running once, plus skipped writes for the
    // remaining stages (currentStageId is null for those, so they're not
    // pushed). We expect at least one running entry for 00-bootstrap.
    expect(persisted).toContain("00-bootstrap");
  });

  test("persistManifest is invoked once with refreshed compiledAt", async () => {
    const { manifest, compileState } = freshFixture();
    let captured: typeof manifest | null = null;
    await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {},
      persistManifest: async (m) => {
        captured = m;
      },
      now: constNow,
    });
    expect(captured).not.toBeNull();
    expect(captured!.compiledAt).toBe(TEST_TIME.toISOString());
    expect(captured!.almanacId).toBe(manifest.almanacId);
  });

  test("skipStages forces the listed stages to 'user-requested-skip'", async () => {
    const { manifest, compileState } = freshFixture();
    const r = await runPipeline({
      almanacDir: "/tmp/k8s",
      state: compileState,
      manifest,
      runners: {
        "01-domain-analysis": fakeRunner({}),
      },
      skipStages: new Set<StageId>(["01-domain-analysis"]),
      now: constNow,
    });
    expect(r.skipped).toContain("01-domain-analysis");
    expect(r.state.stages["01-domain-analysis"].skipReason).toBe(
      "user-requested-skip",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sha256Hex
// ──────────────────────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  test("known vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  test("UTF-8 encoded", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resetStagesForUpdate
// ──────────────────────────────────────────────────────────────────────────────

describe("resetStagesForUpdate", () => {
  /** Drive a fixture through Stages 0, 1, 4 so the reset has work to undo. */
  function compiledFixture() {
    const { compileState } = freshFixture();
    let s = markStageCompleted(compileState, "00-bootstrap", TEST_TIME, {
      outputHash: "a".repeat(64),
    });
    s = markStageRunning(s, "01-domain-analysis", TEST_TIME, "v1");
    s = markStageCompleted(s, "01-domain-analysis", TEST_TIME, {
      outputHash: "b".repeat(64),
      llmCalls: 1,
    });
    s = markStageRunning(s, "04-source-fetch", TEST_TIME, null);
    s = markStageCompleted(s, "04-source-fetch", TEST_TIME, {
      outputHash: "c".repeat(64),
    });
    return s;
  }

  test("resets the named stage and everything after it to pending", () => {
    const state = compiledFixture();
    const next = resetStagesForUpdate(state, "04-source-fetch", {
      runId: "run-2",
      now: TEST_TIME,
    });

    // Strictly-before stays completed.
    expect(next.stages["00-bootstrap"].status).toBe("completed");
    expect(next.stages["01-domain-analysis"].status).toBe("completed");
    expect(next.stages["01-domain-analysis"].outputHash).toBe("b".repeat(64));

    // From the named stage onwards, every entry is freshly pending.
    const fromIdx = STAGE_IDS.indexOf("04-source-fetch");
    for (let i = fromIdx; i < STAGE_IDS.length; i++) {
      const e = next.stages[STAGE_IDS[i]!];
      expect(e.status).toBe("pending");
      expect(e.startedAt).toBeNull();
      expect(e.finishedAt).toBeNull();
      expect(e.outputHash).toBeNull();
      expect(e.attempt).toBe(0);
      expect(e.llmCalls).toBe(0);
    }
  });

  test("stamps a fresh runId and bumps timestamps", () => {
    const state = compiledFixture();
    const next = resetStagesForUpdate(state, "04-source-fetch", {
      runId: "run-2",
      now: TEST_TIME,
    });
    expect(next.runId).toBe("run-2");
    expect(next.currentStageId).toBeNull();
    expect(next.startedAt).toBe(TEST_TIME.toISOString());
    expect(next.updatedAt).toBe(TEST_TIME.toISOString());
  });

  test("throws on unknown stage id", () => {
    const state = compiledFixture();
    expect(() =>
      resetStagesForUpdate(state, "99-nope" as StageId, {
        runId: "run-2",
        now: TEST_TIME,
      }),
    ).toThrow(/unknown stageId/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// bumpSemver
// ──────────────────────────────────────────────────────────────────────────────

describe("bumpSemver", () => {
  test("patch bumps the patch number", () => {
    expect(bumpSemver("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
  });
  test("minor bumps minor and zeros patch", () => {
    expect(bumpSemver("0.1.5", "minor")).toBe("0.2.0");
  });
  test("major bumps major and zeros minor+patch", () => {
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
  });
  test("strips pre-release and build metadata", () => {
    expect(bumpSemver("1.2.3-rc.1", "patch")).toBe("1.2.4");
    expect(bumpSemver("1.2.3+build.42", "minor")).toBe("1.3.0");
  });
  test("throws on malformed input", () => {
    expect(() => bumpSemver("not-semver", "patch")).toThrow(/not a semver/);
  });
});
