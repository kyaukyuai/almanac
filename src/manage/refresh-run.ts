/**
 * Manual refresh execution boundary.
 *
 * This wraps the existing update pipeline with deterministic due detection,
 * a per-almanac lock, and optional refresh artifact persistence.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  resetStagesForUpdate,
  runPipeline,
  type RunPipelineResult,
  type StageRunners,
} from "../compile/pipeline.ts";
import {
  readCompileState,
  readManifest,
  writeCompileState,
  writeManifest,
} from "../compile/storage.ts";
import {
  RefreshArtifactSchema,
  STAGE_IDS,
  type AlmanacManifest,
  type CompileState,
  type RefreshArtifact,
  type RefreshArtifactStatus,
  type RunToolExitCode,
  type StageId,
} from "../core/types.ts";
import {
  getRefreshDueStatus,
  type RefreshBenchmarkSummary,
  type RefreshDueStatus,
} from "./refresh-status.ts";

export const REFRESH_LOCK_REL_PATH = ".compile/refresh.lock";

export interface RefreshRunLockHolder {
  path: string;
  pid?: number;
  command?: string;
  acquiredAt?: string;
  raw?: string;
}

export interface RefreshRunOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Explicit stage boundary. Omitted means use refresh due recommendation. */
  fromStage?: StageId;
  /** Stage runners to execute. CLI passes the normal compile runners. */
  runners: StageRunners;
  /** Forger version string to stamp into the manifest for this run. */
  forgerVersion: string;
  /** Persist the final manifest; CLI injects actual count reconciliation. */
  persistManifest?: (manifest: AlmanacManifest) => Promise<void>;
  /** Optional structured pipeline log sink. */
  log?: (event: object) => void;
  /** Clock override for deterministic tests. */
  now?: () => Date;
  /** Save a `.runs/refresh-*.json` artifact. */
  save?: boolean;
  /** Optional short label for saved artifact lookup. */
  label?: string;
  /** Optional human note for the saved artifact. */
  note?: string;
}

export interface SavedRefreshArtifact {
  artifact: RefreshArtifact;
  path: string;
  relPath: string;
}

export interface RefreshRunResult {
  schemaVersion: "0.1.0";
  refreshId: string;
  almanacId: string;
  version: string;
  status: RefreshArtifactStatus;
  exitCode: RunToolExitCode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  requestedFromStage: StageId | null;
  effectiveFromStage: StageId;
  dueDecision: RefreshDueStatus;
  stageSummary: {
    succeeded: StageId[];
    skipped: StageId[];
    failed: StageId[];
    notReached: StageId[];
  };
  benchmark: RefreshBenchmarkSummary;
  health: "ok" | "attention" | "failed";
  error?: {
    code: string;
    message: string;
  };
  lock?: RefreshRunLockHolder;
  savedArtifact?: {
    path: string;
    relPath: string;
  };
}

export class RefreshRunError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "bad-from-stage"
      | "bad-refresh-artifact",
    message: string,
  ) {
    super(message);
    this.name = "RefreshRunError";
  }
}

export async function runRefresh(
  options: RefreshRunOptions,
): Promise<RefreshRunResult> {
  validateAlmanacDir(options.almanacDir);
  const requestedFromStage = validateFromStage(options.fromStage);
  const clock = options.now ?? (() => new Date());
  const started = clock();
  const startedAt = started.toISOString();
  const refreshId = generateRefreshRunId(started);
  const manifest = await readManifest(options.almanacDir);
  const dueDecision = await getRefreshDueStatus({
    almanacDir: options.almanacDir,
    now: started,
  });
  const effectiveFromStage =
    requestedFromStage ?? dueDecision.recommendedFromStage;

  const lock = await acquireRefreshLock(options.almanacDir, started);
  if (!lock.acquired) {
    const result = buildBaseResult({
      refreshId,
      manifest,
      startedAt,
      finishedAt: clock().toISOString(),
      status: "locked",
      exitCode: 2,
      requestedFromStage,
      effectiveFromStage,
      dueDecision,
      benchmark: dueDecision.benchmark,
      health: "failed",
      error: {
        code: "locked",
        message: `refresh lock already exists: ${lock.holder.path}`,
      },
      lock: lock.holder,
    });
    return maybeSaveRefreshArtifact(options, result);
  }

  try {
    if (!dueDecision.due && requestedFromStage === null) {
      const result = buildBaseResult({
        refreshId,
        manifest,
        startedAt,
        finishedAt: clock().toISOString(),
        status: "not-due",
        exitCode: 0,
        requestedFromStage,
        effectiveFromStage,
        dueDecision,
        benchmark: dueDecision.benchmark,
        health: "ok",
      });
      return await maybeSaveRefreshArtifact(options, result);
    }

    const pipelineResult = await runUpdatePipeline({
      options,
      manifest,
      effectiveFromStage,
      started,
      clock,
    });
    const finishedAt = clock().toISOString();
    const postRunDue = await getRefreshDueStatus({
      almanacDir: options.almanacDir,
      now: new Date(finishedAt),
    });
    const benchmark = postRunDue.benchmark;
    const failed =
      pipelineResult.failed.length > 0 || benchmark.status === "failed";
    const result = buildBaseResult({
      refreshId,
      manifest: pipelineResult.manifest,
      startedAt,
      finishedAt,
      status: failed ? "failed" : "ok",
      exitCode: failed ? 1 : 0,
      requestedFromStage,
      effectiveFromStage,
      dueDecision,
      stageSummary: {
        succeeded: pipelineResult.succeeded,
        skipped: pipelineResult.skipped,
        failed: pipelineResult.failed,
        notReached: pipelineResult.notReached,
      },
      benchmark,
      health:
        pipelineResult.failed.length > 0
          ? "failed"
          : postRunDue.due
            ? "attention"
            : "ok",
      ...(failed
        ? {
            error: refreshRunFailureError(pipelineResult, benchmark),
          }
        : {}),
    });
    return await maybeSaveRefreshArtifact(options, result);
  } catch (e) {
    const finishedAt = clock().toISOString();
    const result = buildBaseResult({
      refreshId,
      manifest,
      startedAt,
      finishedAt,
      status: "failed",
      exitCode: 1,
      requestedFromStage,
      effectiveFromStage,
      dueDecision,
      benchmark: dueDecision.benchmark,
      health: "failed",
      error: {
        code: "refresh-run-failed",
        message: e instanceof Error ? e.message : String(e),
      },
    });
    return await maybeSaveRefreshArtifact(options, result);
  } finally {
    await releaseRefreshLock(lock.path);
  }
}

export function formatRefreshRunHuman(result: RefreshRunResult): string {
  const lines = [
    `refresh run: ${result.almanacId} (${result.version})`,
    `status: ${result.status}`,
    `exit: ${result.exitCode}`,
    `refresh: ${result.refreshId}`,
    `started: ${result.startedAt}`,
    `finished: ${result.finishedAt}`,
    `duration: ${result.durationMs}ms`,
    `from-stage: ${result.effectiveFromStage}`,
    `requested-from-stage: ${result.requestedFromStage ?? "(auto)"}`,
    `due: ${result.dueDecision.due}`,
    `recommended-from-stage: ${result.dueDecision.recommendedFromStage}`,
    `benchmark: ${formatBenchmark(result.benchmark)}`,
    `health: ${result.health}`,
    `stages: succeeded=${result.stageSummary.succeeded.length}, skipped=${result.stageSummary.skipped.length}, failed=${result.stageSummary.failed.length}, notReached=${result.stageSummary.notReached.length}`,
  ];
  if (result.dueDecision.reasons.length > 0) {
    lines.push(
      `reasons: ${result.dueDecision.reasons.map((reason) => reason.code).join(", ")}`,
    );
  }
  if (result.lock !== undefined) {
    lines.push(`lock: ${result.lock.path}`);
    if (result.lock.pid !== undefined) lines.push(`lock-pid: ${result.lock.pid}`);
    if (result.lock.command !== undefined) {
      lines.push(`lock-command: ${result.lock.command}`);
    }
    if (result.lock.acquiredAt !== undefined) {
      lines.push(`lock-acquired: ${result.lock.acquiredAt}`);
    }
  }
  if (result.error !== undefined) {
    lines.push(`error: ${result.error.code}: ${result.error.message}`);
  }
  if (result.savedArtifact !== undefined) {
    lines.push(`artifact: ${result.savedArtifact.path}`);
  }
  return lines.join("\n") + "\n";
}

function validateAlmanacDir(almanacDir: string): void {
  if (!isAbsolute(almanacDir)) {
    throw new RefreshRunError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new RefreshRunError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
}

function validateFromStage(fromStage: StageId | undefined): StageId | null {
  if (fromStage === undefined) return null;
  if (!STAGE_IDS.includes(fromStage)) {
    throw new RefreshRunError(
      "bad-from-stage",
      `unknown stage id "${fromStage}". valid: ${STAGE_IDS.join(", ")}`,
    );
  }
  if (fromStage === "00-bootstrap") {
    throw new RefreshRunError(
      "bad-from-stage",
      "fromStage=00-bootstrap is not supported for refresh runs",
    );
  }
  return fromStage;
}

async function runUpdatePipeline(input: {
  options: RefreshRunOptions;
  manifest: AlmanacManifest;
  effectiveFromStage: StageId;
  started: Date;
  clock: () => Date;
}): Promise<RunPipelineResult> {
  const prevState = await readCompileState(input.options.almanacDir);
  const nextManifest: AlmanacManifest = {
    ...input.manifest,
    forgerVersion: input.options.forgerVersion,
  };
  const resetState = resetStagesForUpdate(prevState, input.effectiveFromStage, {
    runId: generateCompileRunId(input.started),
    now: input.started,
  });
  await writeManifest(input.options.almanacDir, nextManifest);
  await writeCompileState(input.options.almanacDir, resetState);

  return runPipeline({
    almanacDir: input.options.almanacDir,
    state: resetState,
    manifest: nextManifest,
    runners: input.options.runners,
    skipStages: stagesBefore(input.effectiveFromStage, resetState),
    persistState: (state) => writeCompileState(input.options.almanacDir, state),
    persistManifest:
      input.options.persistManifest ??
      ((manifest) => writeManifest(input.options.almanacDir, manifest)),
    log: input.options.log,
    now: input.clock,
  });
}

function stagesBefore(
  fromStage: StageId,
  state: CompileState,
): ReadonlySet<StageId> {
  const idx = STAGE_IDS.indexOf(fromStage);
  return new Set(
    STAGE_IDS.slice(0, idx).filter(
      (stageId) => state.stages[stageId].status !== "completed",
    ),
  );
}

function buildBaseResult(args: {
  refreshId: string;
  manifest: AlmanacManifest;
  startedAt: string;
  finishedAt: string;
  status: RefreshArtifactStatus;
  exitCode: RunToolExitCode;
  requestedFromStage: StageId | null;
  effectiveFromStage: StageId;
  dueDecision: RefreshDueStatus;
  stageSummary?: RefreshRunResult["stageSummary"];
  benchmark: RefreshBenchmarkSummary;
  health: RefreshRunResult["health"];
  error?: RefreshRunResult["error"];
  lock?: RefreshRunLockHolder;
}): RefreshRunResult {
  return {
    schemaVersion: "0.1.0",
    refreshId: args.refreshId,
    almanacId: args.manifest.almanacId,
    version: args.manifest.version,
    status: args.status,
    exitCode: args.exitCode,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    durationMs: Math.max(
      0,
      Date.parse(args.finishedAt) - Date.parse(args.startedAt),
    ),
    requestedFromStage: args.requestedFromStage,
    effectiveFromStage: args.effectiveFromStage,
    dueDecision: args.dueDecision,
    stageSummary: args.stageSummary ?? {
      succeeded: [],
      skipped: [],
      failed: [],
      notReached: [],
    },
    benchmark: args.benchmark,
    health: args.health,
    ...(args.error === undefined ? {} : { error: args.error }),
    ...(args.lock === undefined ? {} : { lock: args.lock }),
  };
}

async function maybeSaveRefreshArtifact(
  options: RefreshRunOptions,
  result: RefreshRunResult,
): Promise<RefreshRunResult> {
  if (options.save !== true) return result;
  const saved = await saveRefreshArtifact({
    almanacDir: options.almanacDir,
    result,
    label: options.label,
    note: options.note,
  });
  return {
    ...result,
    savedArtifact: {
      path: saved.path,
      relPath: saved.relPath,
    },
  };
}

async function saveRefreshArtifact(input: {
  almanacDir: string;
  result: RefreshRunResult;
  label?: string;
  note?: string;
}): Promise<SavedRefreshArtifact> {
  const relPath = `.runs/${input.result.refreshId}.json`;
  const path = join(input.almanacDir, relPath);
  const artifact = RefreshArtifactSchema.parse({
    schemaVersion: "0.1.0",
    kind: "refresh",
    artifactRelPath: relPath,
    refreshId: input.result.refreshId,
    startedAt: input.result.startedAt,
    finishedAt: input.result.finishedAt,
    almanacId: input.result.almanacId,
    version: input.result.version,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.note === undefined ? {} : { note: input.note }),
    status: input.result.status,
    exitCode: input.result.exitCode,
    requestedFromStage:
      input.result.requestedFromStage ?? input.result.effectiveFromStage,
    effectiveFromStage: input.result.effectiveFromStage,
    dueDecision: {
      due: input.result.dueDecision.due,
      recommendedFromStage: input.result.dueDecision.recommendedFromStage,
      reasonCodes: input.result.dueDecision.reasons.map((reason) => reason.code),
      checkedAt: input.result.dueDecision.checkedAt,
    },
    stageSummary: {
      succeeded: input.result.stageSummary.succeeded,
      skipped: input.result.stageSummary.skipped,
      failed: input.result.stageSummary.failed,
    },
    benchmark: input.result.benchmark,
    durationMs: input.result.durationMs,
    ...(input.result.error === undefined ? {} : { error: input.result.error }),
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { artifact, path, relPath };
}

async function acquireRefreshLock(
  almanacDir: string,
  started: Date,
): Promise<
  | { acquired: true; path: string }
  | { acquired: false; path: string; holder: RefreshRunLockHolder }
> {
  const path = join(almanacDir, REFRESH_LOCK_REL_PATH);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    schemaVersion: "0.1.0",
    pid: process.pid,
    command: process.argv.join(" "),
    acquiredAt: started.toISOString(),
  };
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8");
    } finally {
      await handle.close();
    }
    return { acquired: true, path };
  } catch (e) {
    if (errorCode(e) !== "EEXIST") throw e;
    return {
      acquired: false,
      path,
      holder: await readRefreshLockHolder(path),
    };
  }
}

async function readRefreshLockHolder(path: string): Promise<RefreshRunLockHolder> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      command?: unknown;
      acquiredAt?: unknown;
    };
    return {
      path,
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(typeof parsed.command === "string"
        ? { command: parsed.command }
        : {}),
      ...(typeof parsed.acquiredAt === "string"
        ? { acquiredAt: parsed.acquiredAt }
        : {}),
      raw,
    };
  } catch {
    return { path };
  }
}

async function releaseRefreshLock(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* best effort */
  }
}

function refreshRunFailureError(
  pipelineResult: RunPipelineResult,
  benchmark: RefreshBenchmarkSummary,
): { code: string; message: string } {
  if (pipelineResult.failed.length > 0) {
    return {
      code: "pipeline-failed",
      message: `pipeline failed at: ${pipelineResult.failed.join(", ")}`,
    };
  }
  if (benchmark.status === "failed") {
    return {
      code: "benchmark-failed",
      message:
        `benchmark has ${benchmark.failed ?? 0} failed and ` +
        `${benchmark.errored ?? 0} errored fixture(s)`,
    };
  }
  return {
    code: "refresh-failed",
    message: "refresh failed",
  };
}

function formatBenchmark(benchmark: RefreshBenchmarkSummary): string {
  if (benchmark.status === "missing") return "missing";
  return (
    `${benchmark.status}, ${benchmark.passed}/${benchmark.total} passed` +
    `, failed=${benchmark.failed}, errored=${benchmark.errored}`
  );
}

function generateRefreshRunId(started: Date): string {
  return (
    `refresh-${started.toISOString().replace(/[:.]/g, "-")}-` +
    randomBytes(4).toString("hex")
  );
}

function generateCompileRunId(started: Date): string {
  return (
    `run-${started.toISOString().replace(/[:.]/g, "-")}-` +
    randomBytes(4).toString("hex")
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
