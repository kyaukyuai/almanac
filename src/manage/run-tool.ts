/**
 * Management-layer boundary for local runtime invocation.
 *
 * `almanac run` will be a CLI wrapper over this module. Keeping the runtime
 * invocation here avoids coupling Commander parsing to `AlmanacRuntime` and
 * gives tests one deterministic place to pin status / exit-code semantics.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
  AlmanacRuntimeOptions,
  ToolLogger,
} from "../core/runtime.ts";
import {
  createAlmanacRuntime,
  ToolNotFoundError,
} from "../core/runtime.ts";
import {
  AnswerArtifactSchema,
  RefreshArtifactSchema,
  RunArtifactIdSchema,
  RunToolArtifactSchema,
  ToolResultSchema,
  type AnswerArtifact,
  type RefreshArtifact,
  type RunArtifactEnvelope,
  type RunArtifactKind,
  type RunArtifactStatus,
  type RunToolArtifact,
  type RunToolExitCode,
  type RunToolStatus,
  type StageId,
  type ToolManifest,
  type ToolResult,
} from "../core/types.ts";
import { readManifest } from "../compile/storage.ts";

export type {
  AnswerArtifactStatus,
  RefreshArtifactStatus,
  RunArtifactKind,
  RunArtifactStatus,
  RunToolExitCode,
  RunToolStatus,
} from "../core/types.ts";

export interface RunToolOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Tool manifest name, e.g. `query_facts`. */
  toolName: string;
  /** Parsed JSON object supplied to the tool. */
  input: unknown;
  /** Optional runtime dependency overrides, mainly for tests. */
  resolveSecret?: AlmanacRuntimeOptions["resolveSecret"];
  fetchImpl?: AlmanacRuntimeOptions["fetchImpl"];
  log?: ToolLogger;
}

export interface RunToolExecution {
  runId: string;
  invokedAt: string;
  almanacId: string;
  version: string;
  toolName: string;
  input: Record<string, unknown> | null;
  status: RunToolStatus;
  result: ToolResult;
  durationMs: number;
  citationsCount: number;
  availableTools?: string[];
}

export interface ListRunToolsOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Optional runtime dependency overrides, mainly for tests. */
  resolveSecret?: AlmanacRuntimeOptions["resolveSecret"];
  fetchImpl?: AlmanacRuntimeOptions["fetchImpl"];
  log?: ToolLogger;
}

export interface RunToolList {
  almanacId: string;
  version: string;
  tools: ToolManifest[];
}

export interface SaveRunToolArtifactOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  execution: RunToolExecution;
  /** Optional short human label for later audit lookup. */
  label?: string;
  /** Optional human note describing why this run was saved. */
  note?: string;
}

export interface SaveRunToolArtifactResult {
  artifact: RunToolArtifact;
  path: string;
  relPath: string;
}

export interface ListRunToolArtifactsOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Keep only artifacts of this kind. Omitted means all known kinds. */
  kind?: RunArtifactKind;
  /** Keep only artifacts with this status. */
  status?: RunArtifactStatus;
  /** Keep only artifacts with this exact label. */
  label?: string;
  /** Maximum number of newest artifacts to return. */
  limit?: number;
}

export interface PruneRunToolArtifactsOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Keep only artifacts of this kind before applying retention criteria. */
  kind?: RunArtifactKind;
  /** Keep only artifacts with this status before applying retention criteria. */
  status?: RunArtifactStatus;
  /** Keep only artifacts with this exact label before applying retention criteria. */
  label?: string;
  /** Preserve this many newest matching artifacts. */
  keepLatest?: number;
  /** Delete matching artifacts older than this age, in milliseconds. */
  olderThanMs?: number;
  /** Clock override, mainly for tests. */
  now?: Date;
  /** Delete files when true; otherwise only report candidates. */
  apply?: boolean;
}

export interface RunToolArtifactSummary {
  kind: RunArtifactKind;
  artifactRelPath: string;
  runId: string;
  invokedAt: string;
  toolName?: string;
  label?: string;
  status: RunArtifactStatus;
  exitCode: RunToolExitCode;
  durationMs: number;
  citationsCount?: number;
  fromStage?: StageId;
  benchmarkStatus?: "missing" | "passed" | "failed";
  askSuiteStatus?: "missing" | "passed" | "failed";
  askSuiteTotal?: number;
  question?: string;
  answer?: string;
  abstentionReason?: string;
}

export interface RunToolArtifactList {
  almanacId: string;
  version: string;
  artifactsDir: string;
  runs: RunToolArtifactSummary[];
}

export interface PruneRunToolArtifactsResult {
  almanacId: string;
  version: string;
  artifactsDir: string;
  applied: boolean;
  criteria: {
    kind?: RunArtifactKind;
    status?: RunArtifactStatus;
    label?: string;
    keepLatest?: number;
    olderThanMs?: number;
    cutoffInvokedBefore?: string;
  };
  deletedCount: number;
  runs: RunToolArtifactSummary[];
}

export interface ReadRunToolArtifactOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  runId: string;
}

export interface ReadRunToolArtifactResult {
  artifact: RunArtifactEnvelope;
  path: string;
  relPath: string;
}

export class RunToolSetupError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "bad-run-id"
      | "run-artifact-not-found"
      | "run-artifact-invalid",
    message: string,
  ) {
    super(message);
    this.name = "RunToolSetupError";
  }
}

/**
 * Invoke one compiled almanac tool and normalize expected command-facing
 * failures into a stable `RunToolExecution`.
 */
export async function runTool(
  options: RunToolOptions,
): Promise<RunToolExecution> {
  const startedAt = Date.now();
  const invokedAt = new Date(startedAt).toISOString();
  const runId = generateRunToolRunId(invokedAt);
  const manifest = await readRunToolManifest(options.almanacDir);
  const input = normalizeToolInput(options.input);
  if (input === null) {
    return {
      runId,
      invokedAt,
      almanacId: manifest.almanacId,
      version: manifest.version,
      toolName: options.toolName,
      input: null,
      status: "bad-input",
      result: errorResult(
        "bad-input",
        "tool input must be a JSON object",
      ),
      durationMs: Date.now() - startedAt,
      citationsCount: 0,
    };
  }

  const runtime = await createAlmanacRuntime({
    almanacDir: options.almanacDir,
    resolveSecret: options.resolveSecret,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });

  try {
    const result = await runtime.execTool(options.toolName, input);
    return {
      runId,
      invokedAt,
      almanacId: manifest.almanacId,
      version: manifest.version,
      toolName: options.toolName,
      input,
      status: classifyToolResult(result),
      result,
      durationMs: Date.now() - startedAt,
      citationsCount: result.ok ? result.citations.length : 0,
    };
  } catch (cause) {
    if (cause instanceof ToolNotFoundError) {
      const availableTools = (await runtime.listTools()).map(
        (tool) => tool.name,
      );
      return {
        runId,
        invokedAt,
        almanacId: manifest.almanacId,
        version: manifest.version,
        toolName: options.toolName,
        input,
        status: "tool-not-found",
        result: errorResult(
          "tool-not-found",
          `tool not found: "${options.toolName}"`,
        ),
        durationMs: Date.now() - startedAt,
        citationsCount: 0,
        availableTools,
      };
    }
    throw cause;
  } finally {
    closeRuntime(runtime);
  }
}

export async function saveRunToolArtifact(
  options: SaveRunToolArtifactOptions,
): Promise<SaveRunToolArtifactResult> {
  await readRunToolManifest(options.almanacDir);
  const relPath = runToolArtifactRelPath(options.execution.runId);
  const path = join(options.almanacDir, relPath);
  const artifact = RunToolArtifactSchema.parse({
    schemaVersion: "0.1.0",
    artifactRelPath: relPath,
    ...options.execution,
    ...runToolArtifactMetadata(options),
    exitCode: exitCodeForRunTool(options.execution),
  });

  await mkdir(runToolArtifactsDirPath(options.almanacDir), { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { artifact, path, relPath };
}

export function runToolArtifactsDirPath(almanacDir: string): string {
  return join(almanacDir, ".runs");
}

export function runToolArtifactRelPath(runId: string): string {
  return `.runs/${runId}.json`;
}

export async function listRunToolArtifacts(
  options: ListRunToolArtifactsOptions,
): Promise<RunToolArtifactList> {
  const manifest = await readRunToolManifest(options.almanacDir);
  const { artifactsDir, artifacts } = await loadRunToolArtifacts(
    options.almanacDir,
  );
  const filteredArtifacts = filterRunToolArtifacts(artifacts, options);
  filteredArtifacts.sort(compareRunToolArtifactsNewestFirst);

  const limit = options.limit ?? filteredArtifacts.length;
  return {
    almanacId: manifest.almanacId,
    version: manifest.version,
    artifactsDir,
    runs: filteredArtifacts.slice(0, limit).map(summarizeRunToolArtifact),
  };
}

export async function pruneRunToolArtifacts(
  options: PruneRunToolArtifactsOptions,
): Promise<PruneRunToolArtifactsResult> {
  const manifest = await readRunToolManifest(options.almanacDir);
  const { artifactsDir, artifacts } = await loadRunToolArtifacts(
    options.almanacDir,
  );
  const filteredArtifacts = filterRunToolArtifacts(artifacts, options);
  filteredArtifacts.sort(compareRunToolArtifactsNewestFirst);

  const now = options.now ?? new Date();
  const cutoff =
    options.olderThanMs === undefined
      ? undefined
      : new Date(now.getTime() - options.olderThanMs);
  const candidates = filteredArtifacts.filter((artifact, index) => {
    if (
      options.keepLatest !== undefined &&
      index < options.keepLatest
    ) {
      return false;
    }
    if (
      cutoff !== undefined &&
      new Date(artifactTimestamp(artifact)).getTime() >= cutoff.getTime()
    ) {
      return false;
    }
    return true;
  });

  if (options.apply === true) {
    for (const artifact of candidates) {
      await unlink(join(options.almanacDir, artifact.artifactRelPath));
    }
  }

  return {
    almanacId: manifest.almanacId,
    version: manifest.version,
    artifactsDir,
    applied: options.apply === true,
    criteria: {
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.keepLatest === undefined
        ? {}
        : { keepLatest: options.keepLatest }),
      ...(options.olderThanMs === undefined
        ? {}
        : { olderThanMs: options.olderThanMs }),
      ...(cutoff === undefined
        ? {}
        : { cutoffInvokedBefore: cutoff.toISOString() }),
    },
    deletedCount: options.apply === true ? candidates.length : 0,
    runs: candidates.map(summarizeRunToolArtifact),
  };
}

export async function readRunToolArtifact(
  options: ReadRunToolArtifactOptions,
): Promise<ReadRunToolArtifactResult> {
  await readRunToolManifest(options.almanacDir);
  const runId = parseRunToolRunId(options.runId);
  const relPath = runArtifactRelPath(runId);
  const path = join(options.almanacDir, relPath);
  return {
    artifact: await readAndParseRunToolArtifact(path),
    path,
    relPath,
  };
}

export async function listRunTools(
  options: ListRunToolsOptions,
): Promise<RunToolList> {
  const manifest = await readRunToolManifest(options.almanacDir);
  const runtime = await createAlmanacRuntime({
    almanacDir: options.almanacDir,
    resolveSecret: options.resolveSecret,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });

  try {
    return {
      almanacId: manifest.almanacId,
      version: manifest.version,
      tools: await runtime.listTools(),
    };
  } finally {
    closeRuntime(runtime);
  }
}

export function exitCodeForRunTool(
  execution: RunToolExecution,
): RunToolExitCode {
  if (execution.status === "ok") return 0;
  if (
    execution.status === "bad-input" ||
    execution.status === "tool-not-found"
  ) {
    return 2;
  }
  return 1;
}

export function formatRunToolHuman(execution: RunToolExecution): string {
  const lines = [
    `tool: ${execution.toolName}`,
    `status: ${execution.status}`,
    `almanac: ${execution.almanacId} (${execution.version})`,
    `run: ${execution.runId}`,
  ];

  if (execution.result.ok) {
    lines.push(`citations: ${execution.citationsCount}`);
    lines.push(
      `freshness: ${execution.result.freshness.class}/${execution.result.freshness.staleness}`,
    );
    lines.push("data:");
    lines.push(JSON.stringify(execution.result.data, null, 2));
  } else {
    lines.push(
      `error: ${execution.result.error.code}: ${execution.result.error.message}`,
    );
    if (execution.availableTools !== undefined) {
      lines.push(
        `available tools: ${execution.availableTools.join(", ") || "(none)"}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

export function formatRunToolListHuman(list: RunToolList): string {
  const lines = [
    `tools: ${list.almanacId} (${list.version})`,
  ];
  if (list.tools.length === 0) {
    lines.push("  (none)");
    return lines.join("\n") + "\n";
  }

  for (const tool of list.tools) {
    lines.push(
      `  - ${tool.name}  ${tool.volatilityClass}  facts=${tool.knowledgeUsage.facts ? "yes" : "no"}`,
    );
    lines.push(`    ${tool.description}`);
  }
  return lines.join("\n") + "\n";
}

export function formatRunToolArtifactListHuman(
  list: RunToolArtifactList,
): string {
  const lines = [
    `runs: ${list.almanacId} (${list.version})`,
  ];
  if (list.runs.length === 0) {
    lines.push("  (none)");
    return lines.join("\n") + "\n";
  }

  for (const run of list.runs) {
    const label = run.label === undefined ? "" : `  label=${run.label}`;
    if (run.kind === "answer") {
      const question =
        run.question === undefined
          ? ""
          : ` question=${truncateOneLine(run.question, 72)}`;
      lines.push(
        `  - ${run.invokedAt}  ${run.runId}  ${run.status}  answer  exit=${run.exitCode} citations=${run.citationsCount ?? 0} duration=${run.durationMs}ms${label}${question}`,
      );
    } else if (run.kind === "refresh") {
      const benchmark =
        run.benchmarkStatus === undefined ? "" : ` benchmark=${run.benchmarkStatus}`;
      const askSuite =
        run.askSuiteStatus === undefined
          ? ""
          : ` askSuite=${run.askSuiteStatus}${run.askSuiteTotal === undefined ? "" : `/${run.askSuiteTotal}`}`;
      lines.push(
        `  - ${run.invokedAt}  ${run.runId}  ${run.status}  refresh  fromStage=${run.fromStage}  exit=${run.exitCode}${benchmark}${askSuite} duration=${run.durationMs}ms${label}`,
      );
    } else {
      lines.push(
        `  - ${run.invokedAt}  ${run.runId}  ${run.status}  ${run.toolName}  exit=${run.exitCode} citations=${run.citationsCount} duration=${run.durationMs}ms${label}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function formatPruneRunToolArtifactsHuman(
  result: PruneRunToolArtifactsResult,
): string {
  const lines = [
    `runs prune: ${result.almanacId} (${result.version})`,
    `mode: ${result.applied ? "apply" : "dry-run"}`,
    `candidates: ${result.runs.length}`,
  ];
  const criteria = formatPruneCriteria(result.criteria);
  if (criteria.length > 0) {
    lines.push(`criteria: ${criteria.join(", ")}`);
  }
  if (result.runs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const run of result.runs) {
      const label = run.label === undefined ? "" : `  label=${run.label}`;
      if (run.kind === "answer") {
        const question =
          run.question === undefined
            ? ""
            : ` question=${truncateOneLine(run.question, 72)}`;
        lines.push(
          `  - ${run.invokedAt}  ${run.runId}  ${run.status}  answer  exit=${run.exitCode} citations=${run.citationsCount ?? 0} duration=${run.durationMs}ms${label}${question}`,
        );
      } else if (run.kind === "refresh") {
        const benchmark =
          run.benchmarkStatus === undefined ? "" : ` benchmark=${run.benchmarkStatus}`;
        const askSuite =
          run.askSuiteStatus === undefined
            ? ""
            : ` askSuite=${run.askSuiteStatus}${run.askSuiteTotal === undefined ? "" : `/${run.askSuiteTotal}`}`;
        lines.push(
          `  - ${run.invokedAt}  ${run.runId}  ${run.status}  refresh  fromStage=${run.fromStage}  exit=${run.exitCode}${benchmark}${askSuite} duration=${run.durationMs}ms${label}`,
        );
      } else {
        lines.push(
          `  - ${run.invokedAt}  ${run.runId}  ${run.status}  ${run.toolName}  exit=${run.exitCode} citations=${run.citationsCount} duration=${run.durationMs}ms${label}`,
        );
      }
    }
  }
  lines.push(
    result.applied
      ? `deleted: ${result.deletedCount}`
      : "dry-run: no files deleted; rerun with --apply to delete",
  );
  return lines.join("\n") + "\n";
}

export function formatRunToolArtifactHuman(artifact: RunArtifactEnvelope): string {
  if (artifact.kind === "refresh") {
    return formatRefreshArtifactHuman(artifact);
  }
  if (artifact.kind === "answer") {
    return formatAnswerArtifactHuman(artifact);
  }
  const lines = [
    `run: ${artifact.runId}`,
    `tool: ${artifact.toolName}`,
    `status: ${artifact.status}`,
    `exit: ${artifact.exitCode}`,
    `almanac: ${artifact.almanacId} (${artifact.version})`,
    `invoked: ${artifact.invokedAt}`,
    `duration: ${artifact.durationMs}ms`,
    `citations: ${artifact.citationsCount}`,
    `artifact: ${artifact.artifactRelPath}`,
  ];
  if (artifact.label !== undefined) {
    lines.push(`label: ${artifact.label}`);
  }
  if (artifact.note !== undefined) {
    lines.push("note:");
    lines.push(artifact.note);
  }

  if (artifact.result.ok) {
    lines.push(
      `freshness: ${artifact.result.freshness.class}/${artifact.result.freshness.staleness}`,
    );
    lines.push("data:");
    lines.push(JSON.stringify(artifact.result.data, null, 2));
  } else {
    lines.push(
      `error: ${artifact.result.error.code}: ${artifact.result.error.message}`,
    );
    if (artifact.availableTools !== undefined) {
      lines.push(
        `available tools: ${artifact.availableTools.join(", ") || "(none)"}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

function formatAnswerArtifactHuman(artifact: AnswerArtifact): string {
  const lines = [
    `answer: ${artifact.answerId}`,
    `status: ${artifact.status}`,
    `exit: ${artifact.exitCode}`,
    `almanac: ${artifact.almanacId} (${artifact.version})`,
    `started: ${artifact.startedAt}`,
    `finished: ${artifact.finishedAt}`,
    `duration: ${artifact.durationMs}ms`,
    `question: ${artifact.question}`,
    `tools: ${artifact.toolCalls.map((call) => call.toolName).join(", ") || "(none)"}`,
    `citations: ${artifact.citations.length}`,
    `artifact: ${artifact.artifactRelPath}`,
  ];
  if (artifact.label !== undefined) {
    lines.push(`label: ${artifact.label}`);
  }
  if (artifact.note !== undefined) {
    lines.push("note:");
    lines.push(artifact.note);
  }
  if (artifact.model !== undefined) {
    lines.push(`model: ${artifact.model}`);
  }
  if (artifact.freshness !== undefined) {
    lines.push(
      `freshness: ${artifact.freshness.class}/${artifact.freshness.staleness}`,
    );
  }
  if (artifact.trace !== undefined) {
    lines.push(
      `trace: planner=${artifact.trace.planner.calls} stop=${artifact.trace.planner.stopReason} ` +
        `tools=${artifact.trace.tools.observations.length} ` +
        `citations=${artifact.trace.citations.usedCount}/${artifact.trace.citations.observed.length} ` +
        `stale=${artifact.trace.citations.staleCount}`,
    );
    if (artifact.trace.quality !== undefined) {
      const reasons =
        artifact.trace.quality.reasons.length === 0
          ? ""
          : ` reasons=${artifact.trace.quality.reasons.join("; ")}`;
      lines.push(
        `quality trace: ${artifact.trace.quality.status} citationRate=${formatRate(artifact.trace.quality.citationRate)} ` +
          `unsupported=${artifact.trace.quality.unsupportedClaimCount} stale=${artifact.trace.quality.staleCitationCount}${reasons}`,
      );
    }
    lines.push("planner trace:");
    for (const step of artifact.trace.planner.steps) {
      const tool = step.toolName === undefined ? "" : ` tool=${step.toolName}`;
      const stop =
        step.stopReason === undefined ? "" : ` stop=${step.stopReason}`;
      const error = step.error === undefined ? "" : ` error=${step.error.code}`;
      lines.push(
        `  - #${step.stepIndex} call=${step.plannerCall} ${step.action}${tool} outcome=${step.outcome}${stop}${error}`,
      );
    }
    lines.push("tool trace:");
    if (artifact.trace.tools.observations.length === 0) {
      lines.push("  (none)");
    } else {
      for (const observation of artifact.trace.tools.observations) {
        const freshness =
          observation.freshness === undefined
            ? ""
            : ` freshness=${observation.freshness.class}/${observation.freshness.staleness}`;
        const error =
          observation.errorCode === undefined
            ? ""
            : ` error=${observation.errorCode}`;
        lines.push(
          `  - #${observation.callIndex} ${observation.toolName} ${observation.status} citations=${observation.citationsCount} duration=${observation.durationMs}ms${freshness}${error}`,
        );
      }
    }
    lines.push("citation trace:");
    if (artifact.trace.citations.observed.length === 0) {
      lines.push("  (none)");
    } else {
      for (const citation of artifact.trace.citations.observed) {
        const used = citation.usedInAnswer ? "used" : "unused";
        const stale = citation.stale ? " stale" : "";
        const calls = citation.observedInCallIndexes.join(",");
        lines.push(
          `  - ${citation.sourceId} ${used}${stale} calls=${calls} ${truncateOneLine(citation.url, 96)}`,
        );
      }
    }
    if (artifact.trace.abstain !== undefined) {
      lines.push(
        `abstain trace: ${artifact.trace.abstain.stage}: ${artifact.trace.abstain.reason}`,
      );
    }
  }

  if (artifact.status === "ok") {
    lines.push("answer:");
    lines.push(artifact.answer ?? "");
  } else if (artifact.status === "abstained") {
    lines.push(`abstention: ${artifact.abstentionReason ?? "(none)"}`);
  } else if (artifact.error !== undefined) {
    lines.push(`error: ${artifact.error.code}: ${artifact.error.message}`);
  }
  return lines.join("\n") + "\n";
}

function formatRefreshArtifactHuman(artifact: RefreshArtifact): string {
  const lines = [
    `refresh: ${artifact.refreshId}`,
    `status: ${artifact.status}`,
    `exit: ${artifact.exitCode}`,
    `almanac: ${artifact.almanacId} (${artifact.version})`,
    `started: ${artifact.startedAt}`,
    `finished: ${artifact.finishedAt}`,
    `duration: ${artifact.durationMs}ms`,
    `from-stage: ${artifact.effectiveFromStage}`,
    `requested-from-stage: ${artifact.requestedFromStage}`,
    `artifact: ${artifact.artifactRelPath}`,
    `due: ${artifact.dueDecision.due}`,
    `recommended-from-stage: ${artifact.dueDecision.recommendedFromStage}`,
  ];
  if (artifact.label !== undefined) {
    lines.push(`label: ${artifact.label}`);
  }
  if (artifact.note !== undefined) {
    lines.push("note:");
    lines.push(artifact.note);
  }
  if (artifact.dueDecision.reasonCodes.length > 0) {
    lines.push(`reasons: ${artifact.dueDecision.reasonCodes.join(", ")}`);
  }
  if (artifact.benchmark !== undefined) {
    lines.push(`benchmark: ${artifact.benchmark.status}`);
  }
  if (artifact.askSuite !== undefined) {
    lines.push(
      `ask-suite: ${artifact.askSuite.status}` +
        (artifact.askSuite.total === undefined
          ? ""
          : `, ${artifact.askSuite.passed ?? 0}/${artifact.askSuite.total} passed`),
    );
    if (artifact.askSuite.error !== undefined) {
      lines.push(
        `ask-suite-error: ${artifact.askSuite.error.code}: ${artifact.askSuite.error.message}`,
      );
    }
  }
  if (artifact.error !== undefined) {
    lines.push(`error: ${artifact.error.code}: ${artifact.error.message}`);
  }
  return lines.join("\n") + "\n";
}

async function readRunToolManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new RunToolSetupError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new RunToolSetupError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}

async function loadRunToolArtifacts(
  almanacDir: string,
): Promise<{ artifactsDir: string; artifacts: RunArtifactEnvelope[] }> {
  const artifactsDir = runToolArtifactsDirPath(almanacDir);
  const files = await readRunToolArtifactFiles(artifactsDir);
  const artifacts = await Promise.all(
    files.map(async (fileName) => {
      const relPath = `.runs/${fileName}`;
      const path = join(almanacDir, relPath);
      return readAndParseRunToolArtifact(path);
    }),
  );
  return { artifactsDir, artifacts };
}

async function readRunToolArtifactFiles(artifactsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(artifactsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^(run|refresh|answer)-[A-Za-z0-9-]+\.json$/.test(name));
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      return [];
    }
    throw e;
  }
}

async function readAndParseRunToolArtifact(
  path: string,
): Promise<RunArtifactEnvelope> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      throw new RunToolSetupError(
        "run-artifact-not-found",
        `run artifact does not exist: ${path}`,
      );
    }
    throw e;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRefreshArtifactLike(parsed)) {
      return RefreshArtifactSchema.parse(parsed);
    }
    if (isAnswerArtifactLike(parsed)) {
      return AnswerArtifactSchema.parse(parsed);
    }
    return RunToolArtifactSchema.parse(parsed);
  } catch (e) {
    throw new RunToolSetupError(
      "run-artifact-invalid",
      `invalid run artifact ${path}: ${(e as Error).message}`,
    );
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRefreshArtifactLike(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "refresh"
  );
}

function isAnswerArtifactLike(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "answer"
  );
}

function parseRunToolRunId(runId: string): string {
  const parsed = RunArtifactIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new RunToolSetupError(
      "bad-run-id",
      `run id must look like run-YYYY-MM-DDTHH-MM-SS-SSSZ-xxxxxxxx, refresh-YYYY-MM-DDTHH-MM-SS-SSSZ-xxxxxxxx, or answer-YYYY-MM-DDTHH-MM-SS-SSSZ-xxxxxxxx: ${runId}`,
    );
  }
  return parsed.data;
}

function runArtifactRelPath(runId: string): string {
  return runId.startsWith("refresh-") || runId.startsWith("answer-")
    ? `.runs/${runId}.json`
    : runToolArtifactRelPath(runId);
}

function summarizeRunToolArtifact(
  artifact: RunArtifactEnvelope,
): RunToolArtifactSummary {
  if (artifact.kind === "refresh") {
    return {
      kind: "refresh",
      artifactRelPath: artifact.artifactRelPath,
      runId: artifact.refreshId,
      invokedAt: artifact.startedAt,
      ...(artifact.label === undefined ? {} : { label: artifact.label }),
      status: artifact.status,
      exitCode: artifact.exitCode,
      durationMs: artifact.durationMs,
      fromStage: artifact.effectiveFromStage,
      ...(artifact.benchmark === undefined
        ? {}
        : { benchmarkStatus: artifact.benchmark.status }),
      ...(artifact.askSuite === undefined
        ? {}
        : {
            askSuiteStatus: artifact.askSuite.status,
            ...(artifact.askSuite.total === undefined
              ? {}
              : { askSuiteTotal: artifact.askSuite.total }),
          }),
    };
  }
  if (artifact.kind === "answer") {
    return {
      kind: "answer",
      artifactRelPath: artifact.artifactRelPath,
      runId: artifact.answerId,
      invokedAt: artifact.startedAt,
      ...(artifact.label === undefined ? {} : { label: artifact.label }),
      status: artifact.status,
      exitCode: artifact.exitCode,
      durationMs: artifact.durationMs,
      citationsCount: artifact.citations.length,
      question: artifact.question,
      ...(artifact.answer === undefined ? {} : { answer: artifact.answer }),
      ...(artifact.abstentionReason === undefined
        ? {}
        : { abstentionReason: artifact.abstentionReason }),
    };
  }
  return {
    kind: "tool",
    artifactRelPath: artifact.artifactRelPath,
    runId: artifact.runId,
    invokedAt: artifact.invokedAt,
    toolName: artifact.toolName,
    ...(artifact.label === undefined ? {} : { label: artifact.label }),
    status: artifact.status,
    exitCode: artifact.exitCode,
    durationMs: artifact.durationMs,
    citationsCount: artifact.citationsCount,
  };
}

function filterRunToolArtifacts(
  artifacts: RunArtifactEnvelope[],
  options: ListRunToolArtifactsOptions,
): RunArtifactEnvelope[] {
  return artifacts.filter((artifact) => {
    if (
      options.kind !== undefined &&
      artifactKind(artifact) !== options.kind
    ) {
      return false;
    }
    if (options.status !== undefined && artifact.status !== options.status) {
      return false;
    }
    if (options.label !== undefined && artifact.label !== options.label) {
      return false;
    }
    return true;
  });
}

function artifactKind(artifact: RunArtifactEnvelope): RunArtifactKind {
  return artifact.kind;
}

function runToolArtifactMetadata(
  options: SaveRunToolArtifactOptions,
): Partial<Pick<RunToolArtifact, "label" | "note">> {
  return {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.note === undefined ? {} : { note: options.note }),
  };
}

function formatPruneCriteria(
  criteria: PruneRunToolArtifactsResult["criteria"],
): string[] {
  return [
    ...(criteria.kind === undefined ? [] : [`kind=${criteria.kind}`]),
    ...(criteria.status === undefined ? [] : [`status=${criteria.status}`]),
    ...(criteria.label === undefined ? [] : [`label=${criteria.label}`]),
    ...(criteria.keepLatest === undefined
      ? []
      : [`keep-latest=${criteria.keepLatest}`]),
    ...(criteria.olderThanMs === undefined
      ? []
      : [`older-than=${formatDurationMs(criteria.olderThanMs)}`]),
    ...(criteria.cutoffInvokedBefore === undefined
      ? []
      : [`cutoff=${criteria.cutoffInvokedBefore}`]),
  ];
}

function formatDurationMs(ms: number): string {
  const units = [
    ["w", 7 * 24 * 60 * 60 * 1000],
    ["d", 24 * 60 * 60 * 1000],
    ["h", 60 * 60 * 1000],
    ["m", 60 * 1000],
  ] as const;
  for (const [suffix, unitMs] of units) {
    if (ms > 0 && ms % unitMs === 0) {
      return `${ms / unitMs}${suffix}`;
    }
  }
  return `${ms}ms`;
}

function compareRunToolArtifactsNewestFirst(
  a: RunArtifactEnvelope,
  b: RunArtifactEnvelope,
): number {
  const byInvokedAt = artifactTimestamp(b).localeCompare(artifactTimestamp(a));
  if (byInvokedAt !== 0) return byInvokedAt;
  return artifactId(b).localeCompare(artifactId(a));
}

function artifactTimestamp(artifact: RunArtifactEnvelope): string {
  if (artifact.kind === "refresh" || artifact.kind === "answer") {
    return artifact.startedAt;
  }
  return artifact.invokedAt;
}

function artifactId(artifact: RunArtifactEnvelope): string {
  if (artifact.kind === "refresh") return artifact.refreshId;
  if (artifact.kind === "answer") return artifact.answerId;
  return artifact.runId;
}

function truncateOneLine(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function generateRunToolRunId(invokedAt: string): string {
  return (
    `run-${invokedAt.replace(/[:.]/g, "-")}-` +
    randomBytes(4).toString("hex")
  );
}

function normalizeToolInput(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function classifyToolResult(result: ToolResult): RunToolStatus {
  if (result.ok) return "ok";
  if (result.error.code === "bad-input") return "bad-input";
  return "tool-error";
}

function errorResult(code: string, message: string): ToolResult {
  return ToolResultSchema.parse({
    ok: false,
    error: { code, message, retryable: false },
  }) as ToolResult;
}

function closeRuntime(runtime: unknown): void {
  const candidate = runtime as { close?: unknown };
  if (typeof candidate.close === "function") {
    candidate.close();
  }
}
