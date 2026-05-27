/**
 * Pipeline orchestrator — drives `CompileState` through `STAGE_IDS` in order.
 *
 * The orchestrator owns all `CompileState` transitions (pending → running →
 * completed | failed | skipped). Stages are pluggable: the caller registers
 * a `StageRunner` per `StageId`. Stages with no registered runner are
 * marked `skipped` with a `no-runner-registered` reason — this is what
 * lets the CLI run deterministic stages even when optional LLM-backed
 * stages are unavailable in the current environment.
 *
 * State is persisted via the injected `persist` callback after every
 * transition so a crash mid-pipeline leaves a recoverable on-disk state.
 *
 * Pure orchestration: stage logic, fs I/O, and LLM calls live in
 * `stages/sNN-*.ts` and `storage.ts`.
 */

import { createHash } from "node:crypto";

import {
  CompileStateSchema,
  STAGE_IDS,
  type AlmanacManifest,
  type CompileState,
  type StageEntry,
  type StageId,
} from "../core/types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// StageRunner contract
// ──────────────────────────────────────────────────────────────────────────────

/** Per-call context passed to every `StageRunner`. */
export interface StageContext {
  /** Absolute path to the almanac on disk. */
  almanacDir: string;
  /** Snapshot of the compile state as of the start of this stage. */
  state: Readonly<CompileState>;
  /** Snapshot of the almanac manifest. */
  manifest: Readonly<AlmanacManifest>;
  /** Stage id this runner is being invoked for (for log correlation). */
  stageId: StageId;
  /** Structured event sink (defaults to a no-op). */
  log: (event: object) => void;
  /** Wall-clock provider. Tests can inject a deterministic one. */
  now: () => Date;
}

/** Outcome reported back to the orchestrator on success/skip. Failure throws. */
export type StageOutcome =
  | {
      kind: "success";
      /** sha256 hex over the canonicalized output artifacts. */
      outputHash: string;
      /** Optional accounting; folded into `StageEntry.cost`. */
      cost?: { tokens: { input: number; output: number }; usd: number };
      /** Number of LLM API calls this stage made. Defaults to 0. */
      llmCalls?: number;
    }
  | {
      kind: "skipped";
      reason: string;
    };

/**
 * One pluggable stage. Throwing from `run` is the failure signal — the
 * orchestrator records the error on the `StageEntry` and (by default) stops.
 */
export interface StageRunner {
  /** `null` for deterministic stages; e.g., `"v1"` for LLM-driven ones. */
  promptVersion: string | null;
  run(ctx: StageContext): Promise<StageOutcome>;
}

// ──────────────────────────────────────────────────────────────────────────────
// State transitions — pure helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Mark `stageId` as `running` and bump its attempt counter. Returns a fresh,
 * schema-validated `CompileState`. Throws if any other stage is already
 * `running`.
 */
export function markStageRunning(
  state: CompileState,
  stageId: StageId,
  now: Date,
  promptVersion: string | null,
): CompileState {
  const ts = now.toISOString();
  const prev = state.stages[stageId];
  const nextEntry: StageEntry = {
    ...prev,
    status: "running",
    startedAt: ts,
    finishedAt: null,
    attempt: prev.attempt + 1,
    promptVersion,
  };
  const next: CompileState = {
    ...state,
    updatedAt: ts,
    currentStageId: stageId,
    stages: { ...state.stages, [stageId]: nextEntry },
  };
  return CompileStateSchema.parse(next);
}

export function markStageCompleted(
  state: CompileState,
  stageId: StageId,
  now: Date,
  outcome: { outputHash: string; cost?: StageEntry["cost"]; llmCalls?: number },
): CompileState {
  const ts = now.toISOString();
  const prev = state.stages[stageId];
  // For stages not previously transitioned through `running` (e.g., Stage 0
  // marked completed at bootstrap time), synthesize a `startedAt`.
  const startedAt = prev.startedAt ?? ts;
  const nextEntry: StageEntry = {
    ...prev,
    status: "completed",
    startedAt,
    finishedAt: ts,
    outputHash: outcome.outputHash,
    llmCalls: prev.llmCalls + (outcome.llmCalls ?? 0),
    ...(outcome.cost !== undefined ? { cost: outcome.cost } : {}),
  };
  // Strip `error` if it was set on a prior failed attempt.
  delete (nextEntry as { error?: unknown }).error;
  const next: CompileState = {
    ...state,
    updatedAt: ts,
    currentStageId: null,
    stages: { ...state.stages, [stageId]: nextEntry },
  };
  return CompileStateSchema.parse(next);
}

export function markStageFailed(
  state: CompileState,
  stageId: StageId,
  now: Date,
  error: { code: string; message: string },
): CompileState {
  const ts = now.toISOString();
  const prev = state.stages[stageId];
  const nextEntry: StageEntry = {
    ...prev,
    status: "failed",
    startedAt: prev.startedAt ?? ts,
    finishedAt: ts,
    error: {
      code: error.code,
      // Truncate to schema's 2000-char limit.
      message: error.message.slice(0, 2000),
      attempt: Math.max(prev.attempt, 1),
      occurredAt: ts,
    },
  };
  const next: CompileState = {
    ...state,
    updatedAt: ts,
    currentStageId: null,
    stages: { ...state.stages, [stageId]: nextEntry },
  };
  return CompileStateSchema.parse(next);
}

export function markStageSkipped(
  state: CompileState,
  stageId: StageId,
  now: Date,
  reason: string,
): CompileState {
  const ts = now.toISOString();
  const prev = state.stages[stageId];
  const nextEntry: StageEntry = {
    ...prev,
    status: "skipped",
    finishedAt: ts,
    skipReason: reason.slice(0, 200),
  };
  const next: CompileState = {
    ...state,
    updatedAt: ts,
    currentStageId: null,
    stages: { ...state.stages, [stageId]: nextEntry },
  };
  return CompileStateSchema.parse(next);
}

// ──────────────────────────────────────────────────────────────────────────────
// Pipeline runner
// ──────────────────────────────────────────────────────────────────────────────

export type StageRunners = Partial<Record<StageId, StageRunner>>;

export interface RunPipelineInput {
  almanacDir: string;
  /** Initial state. The orchestrator returns the final state. */
  state: CompileState;
  /** Initial manifest. Returned (possibly mutated) at the end. */
  manifest: AlmanacManifest;
  /** Per-stage runners. Missing entries are recorded as `skipped`. */
  runners: StageRunners;
  /**
   * Persist updated `CompileState` after every transition. Defaults to a
   * no-op so unit tests can run without touching disk.
   */
  persistState?: (state: CompileState) => Promise<void>;
  /**
   * Persist the updated `AlmanacManifest`. Called once at the end of the
   * run with `compiledAt` bumped to "now". Defaults to a no-op.
   */
  persistManifest?: (manifest: AlmanacManifest) => Promise<void>;
  /**
   * Stop the pipeline at the first failed stage. Default `true`. When
   * `false`, the orchestrator keeps going so subsequent (independent)
   * stages can still record their state.
   */
  stopOnError?: boolean;
  /** Stages whose runners should be ignored (recorded as `skipped`). */
  skipStages?: ReadonlySet<StageId>;
  /**
   * If set, the orchestrator stops after this stage finishes — successfully,
   * skipped, or failed. Subsequent stages stay `pending` (NOT marked as
   * `skipped` or `notReached`), so a follow-up call to `runPipeline` can
   * pick them up. Used by `almanac new --review` to pause for human
   * approval between Stage 1 and Stage 2.
   */
  stopAfterStageId?: StageId;
  /** Structured event sink (defaults to a no-op). */
  log?: (event: object) => void;
  /** Wall-clock provider. */
  now?: () => Date;
}

export interface RunPipelineResult {
  state: CompileState;
  manifest: AlmanacManifest;
  succeeded: StageId[];
  failed: StageId[];
  skipped: StageId[];
  /** Stages that never ran because a prior stage failed and stopOnError=true. */
  notReached: StageId[];
}

/**
 * Run every stage in `STAGE_IDS` order. Stage 0 is treated specially: if it
 * is already `completed` (the CLI runs `bootstrapAlmanac` before invoking
 * the pipeline), the orchestrator skips re-running it and moves on.
 */
export async function runPipeline(
  input: RunPipelineInput,
): Promise<RunPipelineResult> {
  const log = input.log ?? (() => {});
  const now = input.now ?? (() => new Date());
  const persistState = input.persistState ?? (async () => {});
  const persistManifest = input.persistManifest ?? (async () => {});
  const stopOnError = input.stopOnError ?? true;
  const skipStages = input.skipStages ?? new Set<StageId>();

  let state = input.state;
  const succeeded: StageId[] = [];
  const failed: StageId[] = [];
  const skipped: StageId[] = [];
  const notReached: StageId[] = [];

  let aborted = false;

  for (const stageId of STAGE_IDS) {
    const entry = state.stages[stageId];

    if (aborted) {
      notReached.push(stageId);
      continue;
    }

    // Already completed (e.g., Stage 0 from bootstrap, or a prior partial run).
    if (entry.status === "completed") {
      log({ event: "stage:already-completed", stageId });
      succeeded.push(stageId);
      continue;
    }

    // Caller-requested skip.
    if (skipStages.has(stageId)) {
      state = markStageSkipped(state, stageId, now(), "user-requested-skip");
      await persistState(state);
      log({ event: "stage:skipped", stageId, reason: "user-requested-skip" });
      skipped.push(stageId);
      continue;
    }

    const runner = input.runners[stageId];
    if (!runner) {
      state = markStageSkipped(state, stageId, now(), "no-runner-registered");
      await persistState(state);
      log({ event: "stage:skipped", stageId, reason: "no-runner-registered" });
      skipped.push(stageId);
      continue;
    }

    // running
    state = markStageRunning(state, stageId, now(), runner.promptVersion);
    await persistState(state);
    log({ event: "stage:running", stageId, attempt: state.stages[stageId].attempt });

    try {
      const outcome = await runner.run({
        almanacDir: input.almanacDir,
        state,
        manifest: input.manifest,
        stageId,
        log,
        now,
      });
      if (outcome.kind === "skipped") {
        state = markStageSkipped(state, stageId, now(), outcome.reason);
        await persistState(state);
        log({ event: "stage:skipped", stageId, reason: outcome.reason });
        skipped.push(stageId);
      } else {
        state = markStageCompleted(state, stageId, now(), {
          outputHash: outcome.outputHash,
          cost: outcome.cost,
          llmCalls: outcome.llmCalls,
        });
        await persistState(state);
        log({
          event: "stage:completed",
          stageId,
          outputHash: outcome.outputHash,
          llmCalls: outcome.llmCalls ?? 0,
        });
        succeeded.push(stageId);
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? "stage-threw";
      const message =
        e instanceof Error ? e.message : `non-Error thrown: ${String(e)}`;
      state = markStageFailed(state, stageId, now(), { code, message });
      await persistState(state);
      log({ event: "stage:failed", stageId, code, message });
      failed.push(stageId);
      if (stopOnError) {
        aborted = true;
      }
    }

    if (input.stopAfterStageId === stageId) {
      log({ event: "pipeline:stop-after", stageId });
      break;
    }
  }

  // Update the manifest's `compiledAt`. Counts are updated by individual
  // stages (or their callers) and persisted via `persistManifest`.
  const finalManifest: AlmanacManifest = {
    ...input.manifest,
    compiledAt: now().toISOString(),
  };
  await persistManifest(finalManifest);

  return {
    state,
    manifest: finalManifest,
    succeeded,
    failed,
    skipped,
    notReached,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Hashing helper for runners
// ──────────────────────────────────────────────────────────────────────────────

/** sha256 hex of UTF-8 string. Convenience for runners computing outputHash. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ──────────────────────────────────────────────────────────────────────────────
// Update helpers — used by `almanac update`
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Reset every stage from `fromStageId` (inclusive) onwards back to `pending`,
 * also stamping a new `runId` and `startedAt` so the new run is distinguishable
 * from the prior one in logs. Stages strictly before `fromStageId` are kept as-is.
 *
 * Returned state is fresh, schema-validated, and ready to feed into
 * `runPipeline`. Throws if `fromStageId` is not a known stage id.
 */
export function resetStagesForUpdate(
  state: CompileState,
  fromStageId: StageId,
  args: { runId: string; now: Date },
): CompileState {
  const idx = STAGE_IDS.indexOf(fromStageId);
  if (idx < 0) {
    throw new Error(`resetStagesForUpdate: unknown stageId "${fromStageId}"`);
  }
  const ts = args.now.toISOString();
  const blank: StageEntry = {
    status: "pending",
    startedAt: null,
    finishedAt: null,
    inputHash: null,
    outputHash: null,
    promptVersion: null,
    llmCalls: 0,
    attempt: 0,
  };
  const stages = { ...state.stages };
  for (let i = idx; i < STAGE_IDS.length; i++) {
    stages[STAGE_IDS[i]!] = { ...blank };
  }
  const next: CompileState = {
    ...state,
    runId: args.runId,
    startedAt: ts,
    updatedAt: ts,
    currentStageId: null,
    stages,
  };
  return CompileStateSchema.parse(next);
}

/**
 * Bump a semver string. Pre-release / build metadata are stripped — `update`
 * always produces a clean release version. Throws on malformed input.
 */
export function bumpSemver(
  version: string,
  kind: "major" | "minor" | "patch",
): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    throw new Error(`bumpSemver: not a semver string: "${version}"`);
  }
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (kind) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
  }
  return `${major}.${minor}.${patch}`;
}
