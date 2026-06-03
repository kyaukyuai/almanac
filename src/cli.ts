#!/usr/bin/env bun
/**
 * `almanac` — top-level CLI.
 *
 * v0.1 commands:
 *   almanac new <domain> [opts]            bootstrap and compile an almanac
 *                                          (supports --resume to continue an
 *                                          interrupted run)
 *   almanac demo [id] [opts]               create a complete offline demo
 *                                          almanac with curated fixtures
 *   almanac update <id> [opts]             refresh an existing almanac
 *                                          (resets stages from --from-stage
 *                                          onwards and re-runs the pipeline)
 *   almanac list [opts]                    list compiled almanacs under the root
 *   almanac status <id> [opts]             show a compact lifecycle summary
 *   almanac maintain [id] [opts]           plan/apply due maintenance
 *   almanac inspect <id> [opts]            print manifest + per-stage state
 *   almanac profile <id> [opts]            summarize expertise, evidence, and limits
 *   almanac sources <id> [opts]            review approved/rejected sources
 *   almanac benchmark <id> [opts]          init/run human golden fixtures
 *   almanac doctor [id] [opts]             diagnose environment + artifacts
 *   almanac path <id> [opts]               print the absolute almanac dir path
 *   almanac run <id> --tool <name> [opts]  invoke one compiled tool locally
 *   almanac ask <id> <question> [opts]     synthesize a cited one-shot answer
 *   almanac ask-replay <id> [opts]         replay saved or fixture answer runs
 *   almanac ask-suite <id> [opts]          run ask replay fixture suite gate
 *   almanac ask-fixtures <subcommand>      author ask replay fixture JSONL
 *   almanac runs <id> [runId] [opts]       view saved local run artifacts
 *   almanac refresh due <id> [opts]        check read-only refresh due status
 *   almanac refresh run <id> [opts]        run a manual refresh over update
 *   almanac serve <id> [opts]              start the MCP server (stdio or HTTP)
 *   almanac register <id> [opts]           install SKILL.md + merge MCP entry
 *                                          into a downstream client config
 *                                          (--client=claude-code|claude-desktop|cursor|codex;
 *                                          --status for read-only inspection)
 *   almanac remove <id> [opts]             delete an almanac dir + unregister
 *                                          it from any client configs (dry-run
 *                                          by default; --apply to commit)
 *   almanac feed <id> <url> [opts]         incrementally add one source to a
 *                                          compiled almanac (fetch + extract +
 *                                          reindex; dry-run by default)
 *   almanac export <id> [opts]             package a compiled almanac as a
 *                                          portable .tar.gz archive
 *   almanac import <archive> [opts]        inspect/install an exported archive
 *   almanac wiki <id> [opts]               export a Markdown inspection bundle
 *
 * All twelve stages (0–12) are implemented and exercised by `src/e2e.test.ts`.
 * Stage 11 (benchmark generation) is LLM-driven and is skipped when no
 * `LlmProvider` is available; Stage 12 (benchmark run) is deterministic and
 * always registered. Together they emit `tests/{positive,negative}.jsonl`
 * and `.compile/benchmark-result.json`.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { Command, Option } from "commander";

import {
  parseMcpConfig,
  serializeMcpConfig,
  writeMcpConfigAtomic,
  type McpConfigFormat,
} from "./manage/mcp-config.ts";

import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";
import {
  createDomainAnalysisRunner,
  domainSpecPath,
} from "./compile/stages/s01-domain-analysis.ts";
import {
  createSourceDiscoveryPlannerRunner,
  sourceDiscoveryPlanPath,
} from "./compile/stages/s02a-source-discovery-planner.ts";
import {
  candidatesPath,
  createSourceDiscoveryExecutorRunner,
} from "./compile/stages/s02x-source-discovery-executor.ts";
import {
  createSourceDiscoveryEvaluatorRunner,
  sourcesDraftPath,
} from "./compile/stages/s02b-source-discovery-evaluator.ts";
import {
  approvedSourcesPath,
  createApproveRunner,
} from "./compile/stages/s03-approve-runner.ts";
import {
  createSourceFetchRunner,
  defaultFetchers,
  sourceFetchManifestPath,
} from "./compile/stages/s04-source-fetch-runner.ts";
import {
  createFactExtractionRunner,
  factsJsonlPath,
} from "./compile/stages/s05-fact-extraction.ts";
import {
  createToolDesignRunner,
  toolDesignPath,
} from "./compile/stages/s06-tool-design.ts";
import {
  createToolImplRunner,
  stage07OutputPath,
} from "./compile/stages/s07-tool-impl-runner.ts";
import { createLlmCodeWriter } from "./compile/stages/s07/code-writer.ts";
import { createBunxTscRunner } from "./compile/stages/s07/tsc-runner.ts";
import { createBunSmokeRunner } from "./compile/stages/s07/smoke-runner.ts";
import { LlmImplementer } from "./compile/stages/s07/llm-implementer.ts";
import { createKnowledgeIndexRunner } from "./compile/stages/s08-knowledge-index-runner.ts";
import {
  createContractFilesRunner,
  stage09OutputPath,
} from "./compile/stages/s09-contract-runner.ts";
import {
  createSkillAdapterRunner,
  stage10OutputPath,
} from "./compile/stages/s10-skill-adapter-runner.ts";
import {
  STAGE11_MIN_GENERATED_NEGATIVE_FIXTURES,
  STAGE11_MIN_GENERATED_POSITIVE_FIXTURES,
  STAGE11_MIN_GENERATED_TOTAL_FIXTURES,
  createBenchmarkGenRunner,
  negativeJsonlPath,
  positiveJsonlPath,
  stage11OutputPath,
} from "./compile/stages/s11-benchmark-gen.ts";
import {
  benchmarkResultPath,
  createBenchmarkRunRunner,
} from "./compile/stages/s12-benchmark-run-runner.ts";
import { createGithubSearcher } from "./compile/discovery/github-searcher.ts";
import { createHttpUrlProber } from "./compile/discovery/url-prober.ts";
import {
  createBraveWebSearcher,
  createNullWebSearcher,
} from "./compile/discovery/web-searcher.ts";
import { createDefaultCommunitySearchers } from "./compile/discovery/community-searcher.ts";
import {
  defaultAlmanacRoot,
  almanacDirPath,
  compileStatePath,
  ensureAlmanacLayout,
  knowledgeIndexManifestPath,
  readCompileState,
  readImplementedToolCount,
  readKnowledgeIndexManifest,
  readManifest,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
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
  type StageRunners,
} from "./compile/pipeline.ts";
import {
  BenchmarkReportSchema,
  BenchmarkSetSchema,
  DomainSpecSchema,
  FactRecordSchema,
  MaintenanceArtifactSchema,
  NegativeFixtureSchema,
  PositiveFixtureSchema,
  SourcesFileSchema,
  Stage11OutputSchema,
  STAGE_IDS,
  ToolDesignResultSchema,
  type AlmanacManifest,
  type BenchmarkReport,
  type BenchmarkSet,
  type CompileOptions,
  type CompileState,
  type DomainSpec,
  type FactRecord,
  type FreshnessProfileId,
  type KnowledgeIndexManifest,
  type KnowledgeVectorIndexManifest,
  type MaintenanceArtifact,
  type MaintenanceArtifactStatus,
  type MaintenanceStepResult,
  type SourcesFile,
  type StageId,
  type ToolDesignResult,
} from "./core/types.ts";
import { createAnthropicProvider } from "./llm/anthropic.ts";
import { createMockProvider, type MockProviderOptions } from "./llm/mock.ts";
import type { LlmProvider } from "./llm/provider.ts";
import {
  resolveEmbeddingProviderConfig,
} from "./embeddings/config.ts";
import {
  serveAlmanacOverHttp,
  serveAlmanacOverStdio,
} from "./serve/mcp-server.ts";
import { runFeed, FeedAlreadyExistsError } from "./manage/feed.ts";
import {
  ExportFailedError,
  defaultExportPath,
  runExport,
} from "./manage/export.ts";
import {
  ImportFailedError,
  ImportValidationError,
  runImport,
} from "./manage/import.ts";
import {
  defaultWikiExportDir,
  runWikiExport,
} from "./manage/wiki-export.ts";
import {
  RunToolSetupError,
  exitCodeForRunTool,
  formatPruneRunToolArtifactsHuman,
  formatRunToolArtifactHuman,
  formatRunToolArtifactListHuman,
  formatRunToolHuman,
  formatRunToolListHuman,
  listRunToolArtifacts,
  listRunTools,
  pruneRunToolArtifacts,
  readRunToolArtifact,
  runTool,
  saveRunToolArtifact,
  type RunArtifactKind,
  type RunArtifactStatus,
  type RunToolExitCode,
  type RunToolArtifactSummary,
} from "./manage/run-tool.ts";
import {
  AnswerArtifactSetupError,
  saveAnswerArtifact,
} from "./manage/answer-artifacts.ts";
import {
  AnswerSessionSetupError,
  runAnswerSession,
  type AnswerSession,
} from "./manage/answer-session.ts";
import {
  AskReplaySetupError,
  exitCodeForAskReplay,
  formatAskReplayHuman,
  runAskReplayFromFixtureFile,
  runAskReplayFromSavedRuns,
  type AskReplayEntailmentOptions,
} from "./manage/ask-replay.ts";
import {
  AskSuiteSetupError,
  exitCodeForAskSuite,
  formatAskSuiteHuman,
  runAskSuite,
} from "./manage/ask-suite.ts";
import {
  AskFixtureAuthoringError,
  addAskFixtureFromRun,
  formatAskFixtureAuthoringHuman,
  initAskFixtureFile,
} from "./manage/ask-fixtures.ts";
import {
  formatAnswerReadinessDoctor,
  getAnswerReadiness,
  type AnswerReadiness,
  type AnswerReadinessStatus,
} from "./manage/answer-readiness.ts";
import {
  embeddingReadinessLevel,
  formatEmbeddingReadiness,
  getRetrievalReadiness,
} from "./manage/retrieval-readiness.ts";
import {
  RefreshStatusError,
  formatRefreshDueHuman,
  getRefreshDueStatus,
} from "./manage/refresh-status.ts";
import {
  RefreshRunError,
  formatRefreshRunHuman,
  runRefresh,
} from "./manage/refresh-run.ts";
import type { IngestionMode, SourceKind } from "./core/types.ts";

function readForgerVersion(): string {
  const raw = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new Error("package.json must contain a non-empty version string");
  }
  return raw.version;
}

const FORGER_VERSION = readForgerVersion();

interface DisplayCounts {
  facts: number;
  tools: number;
  manifestFacts: number;
  manifestTools: number;
  toolsReadable: boolean;
}

interface RefreshRunVisibility {
  latest: RunToolArtifactSummary | null;
  readError: string | null;
  issue: string | null;
}

async function readRefreshRunVisibility(
  almanacDir: string,
): Promise<RefreshRunVisibility> {
  try {
    const list = await listRunToolArtifacts({
      almanacDir,
      kind: "refresh",
      limit: 1,
    });
    const latest = list.runs[0] ?? null;
    return {
      latest,
      readError: null,
      issue: refreshRunVisibilityIssue(latest),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      latest: null,
      readError: message,
      issue: `refresh artifacts unreadable: ${message}`,
    };
  }
}

function refreshRunVisibilityIssue(
  latest: RunToolArtifactSummary | null,
): string | null {
  if (latest === null) return null;
  if (latest.status === "failed") {
    return `latest refresh run failed: ${latest.runId}`;
  }
  if (latest.status === "locked") {
    return `latest refresh run was locked: ${latest.runId}`;
  }
  if (latest.exitCode !== 0) {
    return `latest refresh run exited ${latest.exitCode}: ${latest.runId}`;
  }
  return null;
}

function formatRefreshRunVisibility(
  latest: RunToolArtifactSummary | null,
): string {
  if (latest === null) return "none saved";
  const parts = [
    `last ${latest.status} @ ${latest.invokedAt}`,
    `from ${latest.fromStage ?? "(unknown)"}`,
    `exit=${latest.exitCode}`,
  ];
  if (latest.benchmarkStatus !== undefined) {
    parts.push(`benchmark=${latest.benchmarkStatus}`);
  }
  if (latest.askSuiteStatus !== undefined) {
    parts.push(
      `askSuite=${latest.askSuiteStatus}` +
        (latest.askSuiteTotal === undefined ? "" : `/${latest.askSuiteTotal}`),
    );
  }
  if (latest.label !== undefined) {
    parts.push(`label=${latest.label}`);
  }
  return parts.join(", ");
}

async function readDisplayCounts(
  almanacDir: string,
  manifest: AlmanacManifest,
  knowledge?: KnowledgeIndexManifest | null,
): Promise<DisplayCounts> {
  const knowledgeManifest =
    knowledge === undefined
      ? await readKnowledgeIndexManifest(almanacDir)
      : knowledge;
  let toolCount: number | null = null;
  try {
    toolCount = await readImplementedToolCount(almanacDir);
  } catch {
    // Keep list/inspect usable even if a legacy tool manifest is malformed.
  }

  return {
    facts: knowledgeManifest?.factCount ?? manifest.factCount,
    tools: toolCount ?? manifest.toolCount,
    manifestFacts: manifest.factCount,
    manifestTools: manifest.toolCount,
    toolsReadable: toolCount !== null,
  };
}

async function writeManifestWithActualCounts(
  almanacDir: string,
  manifest: AlmanacManifest,
): Promise<void> {
  const counts = await readDisplayCounts(almanacDir, manifest);
  await writeManifest(almanacDir, {
    ...manifest,
    factCount: counts.facts,
    toolCount: counts.tools,
  });
}

function countsMismatch(counts: DisplayCounts): boolean {
  return (
    counts.facts !== counts.manifestFacts ||
    counts.tools !== counts.manifestTools
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function titleCase(input: string): string {
  return input
    .split(/[\s\-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex");
  return `run-${ts}-${suffix}`;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

/**
 * Pick an `LlmProvider` for the run. Real Anthropic when `ANTHROPIC_API_KEY`
 * is set; `null` otherwise (callers skip LLM stages instead of crashing).
 *
 * `ALMANAC_LLM=mock` forces the in-process MockProvider — useful for smoke
 * tests that want the runner exercised without spending tokens. By default the
 * mock returns the empty string, so LLM JSON parsing fails visibly. Tests can
 * set `ALMANAC_MOCK_RESPONSES` to a JSON object keyed by callName; values are
 * response strings or arrays of response strings consumed in order.
 */
function resolveProvider(): LlmProvider | null {
  if (process.env["ALMANAC_LLM"] === "mock") {
    return createMockProvider(mockProviderOptionsFromEnv());
  }
  if (process.env["ANTHROPIC_API_KEY"]) {
    return createAnthropicProvider({
      timeoutMs: optionalPositiveIntegerEnv("ALMANAC_ANTHROPIC_TIMEOUT_MS"),
    });
  }
  return null;
}

function mockProviderOptionsFromEnv(): MockProviderOptions {
  const responsesRaw = process.env["ALMANAC_MOCK_RESPONSES"];
  const defaultResponse = process.env["ALMANAC_MOCK_DEFAULT_RESPONSE"] ?? "";
  if (responsesRaw === undefined || responsesRaw.trim() === "") {
    return { defaultResponse };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responsesRaw) as unknown;
  } catch (e) {
    fail(`ALMANAC_MOCK_RESPONSES must be valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("ALMANAC_MOCK_RESPONSES must be a JSON object keyed by callName");
  }

  const responses: NonNullable<MockProviderOptions["responses"]> = {};
  for (const [callName, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      responses[callName] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      let index = 0;
      const sequence = value;
      responses[callName] = () => {
        const response = sequence[Math.min(index, sequence.length - 1)] ?? "";
        index += 1;
        return response;
      };
      continue;
    }
    fail(
      `ALMANAC_MOCK_RESPONSES.${callName} must be a string or an array of strings`,
    );
  }
  return { responses, defaultResponse };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function markStageCompletedFromArtifact(
  state: CompileState,
  stageId: StageId,
  artifact: unknown,
): CompileState {
  return markStageCompleted(state, stageId, new Date(), {
    outputHash: sha256Hex(JSON.stringify(artifact)),
  });
}

async function runStandaloneStage(args: {
  almanacDir: string;
  state: CompileState;
  manifest: AlmanacManifest;
  stageId: StageId;
  runner: StageRunner;
  log?: (event: object) => void;
}): Promise<CompileState> {
  const now = () => new Date();
  let state = markStageRunning(
    args.state,
    args.stageId,
    now(),
    args.runner.promptVersion,
  );
  await writeCompileState(args.almanacDir, state);

  try {
    const outcome = await args.runner.run({
      almanacDir: args.almanacDir,
      state,
      manifest: args.manifest,
      stageId: args.stageId,
      log: args.log ?? (() => {}),
      now,
    });

    if (outcome.kind === "skipped") {
      state = markStageSkipped(state, args.stageId, now(), outcome.reason);
    } else {
      state = markStageCompleted(state, args.stageId, now(), {
        outputHash: outcome.outputHash,
        cost: outcome.cost,
        llmCalls: outcome.llmCalls,
      });
    }
    await writeCompileState(args.almanacDir, state);
    return state;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "stage-threw";
    const message =
      e instanceof Error ? e.message : `non-Error thrown: ${String(e)}`;
    state = markStageFailed(state, args.stageId, now(), { code, message });
    await writeCompileState(args.almanacDir, state);
    throw e;
  }
}

interface StageStatusSummary {
  completed: number;
  failed: number;
  pending: number;
  running: number;
  skipped: number;
}

function stageStatusCounts(state: CompileState): StageStatusSummary {
  const counts: StageStatusSummary = {
    completed: 0,
    failed: 0,
    pending: 0,
    running: 0,
    skipped: 0,
  };
  for (const id of STAGE_IDS as readonly StageId[]) {
    const status = state.stages[id].status;
    counts[status] += 1;
  }
  return counts;
}

async function readSourcesFileIfPresent(
  almanacDir: string,
): Promise<SourcesFile | null> {
  const path = approvedSourcesPath(almanacDir);
  if (!existsSync(path)) return null;
  return SourcesFileSchema.parse(await readJsonFile(path));
}

async function readBenchmarkReportIfPresent(
  almanacDir: string,
): Promise<BenchmarkReport | null> {
  const path = benchmarkResultPath(almanacDir);
  if (!existsSync(path)) return null;
  return BenchmarkReportSchema.parse(await readJsonFile(path));
}

async function readBenchmarkSetIfPresent(
  almanacDir: string,
  almanacId: string,
): Promise<BenchmarkSet | null> {
  const posPath = positiveJsonlPath(almanacDir);
  const negPath = negativeJsonlPath(almanacDir);
  if (existsSync(posPath) && existsSync(negPath)) {
    const positive = await readFixtureJsonl(posPath, PositiveFixtureSchema);
    const negative = await readFixtureJsonl(negPath, NegativeFixtureSchema);
    return BenchmarkSetSchema.parse({
      schemaVersion: "0.1.0" as const,
      almanacId,
      positive,
      negative,
    });
  }

  const stage11Path = stage11OutputPath(almanacDir);
  if (existsSync(stage11Path)) {
    const parsed = Stage11OutputSchema.parse(await readJsonFile(stage11Path));
    return parsed.set;
  }

  return null;
}

interface BenchmarkCoverageGate {
  applies: boolean;
  ok: boolean;
  positive: number;
  negative: number;
  total: number;
  minimum: {
    positive: number;
    negative: number;
    total: number;
  };
  issue: string | null;
}

function benchmarkCoverageGate(
  almanacDir: string,
  state: CompileState,
  set: BenchmarkSet | null,
): BenchmarkCoverageGate {
  const minimum = {
    positive: GENERATED_BENCHMARK_MIN_POSITIVE_FIXTURES,
    negative: GENERATED_BENCHMARK_MIN_NEGATIVE_FIXTURES,
    total: GENERATED_BENCHMARK_MIN_TOTAL_FIXTURES,
  };
  const positive = set?.positive.length ?? 0;
  const negative = set?.negative.length ?? 0;
  const total = positive + negative;
  const applies =
    set !== null &&
    state.stages["11-benchmark-gen"].status === "completed" &&
    existsSync(stage11OutputPath(almanacDir));
  const ok =
    !applies ||
    (positive >= minimum.positive &&
      negative >= minimum.negative &&
      total >= minimum.total);
  const issue = ok
    ? null
    : `benchmark coverage below minimum: ${positive} positive / ${negative} negative / ${total} total, require at least ${minimum.positive} positive / ${minimum.negative} negative / ${minimum.total} total`;

  return {
    applies,
    ok,
    positive,
    negative,
    total,
    minimum,
    issue,
  };
}

function formatBenchmarkFixturesWithCoverage(
  set: BenchmarkSet,
  coverage: BenchmarkCoverageGate,
): string {
  const base = `${set.positive.length} positive / ${set.negative.length} negative`;
  if (!coverage.applies) return base;
  return `${base} (generated min ${coverage.minimum.positive} positive / ${coverage.minimum.negative} negative / ${coverage.minimum.total} total)`;
}

async function readFixtureJsonl<T>(
  path: string,
  schema: typeof PositiveFixtureSchema | typeof NegativeFixtureSchema,
): Promise<T[]> {
  const body = await readFile(path, "utf8");
  const out: T[] = [];
  let lineNo = 0;
  for (const line of body.split("\n")) {
    lineNo += 1;
    if (line.trim().length === 0) continue;
    try {
      out.push(schema.parse(JSON.parse(line)) as T);
    } catch (e) {
      throw new Error(
        `${path}:${lineNo}: invalid benchmark fixture: ${(e as Error).message}`,
      );
    }
  }
  return out;
}

async function readFactsJsonlIfPresent(
  almanacDir: string,
): Promise<FactRecord[]> {
  const path = factsJsonlPath(almanacDir);
  if (!existsSync(path)) return [];
  const body = await readFile(path, "utf8");
  const out: FactRecord[] = [];
  let lineNo = 0;
  for (const line of body.split("\n")) {
    lineNo += 1;
    if (line.trim().length === 0) continue;
    try {
      out.push(FactRecordSchema.parse(JSON.parse(line)));
    } catch (e) {
      throw new Error(`${path}:${lineNo}: invalid fact: ${(e as Error).message}`);
    }
  }
  return out;
}

async function readDomainSpecIfPresent(
  almanacDir: string,
): Promise<DomainSpec | null> {
  const path = domainSpecPath(almanacDir);
  if (!existsSync(path)) return null;
  return DomainSpecSchema.parse(await readJsonFile(path));
}

function nonZeroCoverage(coverage: SourcesFile["coverage"]): string {
  return Object.entries(coverage)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ") || "none";
}

function nonZeroCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}=${count}`)
    .join(", ") || "none";
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatVectorIndexSummary(
  vectorIndex: KnowledgeVectorIndexManifest,
): string {
  if (vectorIndex.status === "built") {
    return (
      `built ${vectorIndex.vectorCount} vectors, ` +
      `${vectorIndex.provider}/${vectorIndex.model} ${vectorIndex.dimensions}d`
    );
  }
  return `skipped (${vectorIndex.reason.replace(/-/g, " ")})`;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rootArg(root: string): string {
  return root === defaultAlmanacRoot() ? "" : ` --root ${shellArg(root)}`;
}

interface StageFailureRecovery {
  stageId: StageId;
  code: string;
  message: string;
  resumeCommand: string;
  inspectCommand: string;
  compileStatePath: string;
  artifactPath: string;
  artifactExists: boolean;
  guidance: string;
}

function buildStageFailureRecovery(args: {
  almanacId: string;
  root: string;
  almanacDir: string;
  state: CompileState;
  failedStages?: StageId[];
}): StageFailureRecovery | null {
  const failedStages =
    args.failedStages ??
    (STAGE_IDS as readonly StageId[]).filter(
      (stageId) => args.state.stages[stageId].status === "failed",
    );
  const stageId = failedStages[0];
  if (stageId === undefined) return null;
  const entry = args.state.stages[stageId];
  const error = entry.error;
  const code = error?.code ?? "unknown";
  const message = error?.message ?? "no stage error message recorded";
  const artifactPath = stageRecoveryArtifactPath(args.almanacDir, stageId);
  const rootSuffix = rootArg(args.root);
  return {
    stageId,
    code,
    message,
    resumeCommand:
      `almanac update ${args.almanacId} --from-stage=${stageId}` +
      ` --no-bump${rootSuffix}`,
    inspectCommand: `almanac inspect ${args.almanacId}${rootSuffix}`,
    compileStatePath: compileStatePath(args.almanacDir),
    artifactPath,
    artifactExists: existsSync(artifactPath),
    guidance: stageFailureGuidance(code, message),
  };
}

function formatPipelineFailureRecovery(args: {
  recovery: StageFailureRecovery | null;
  failedStages: StageId[];
  heading?: string;
}): string {
  const heading = args.heading ?? "Pipeline halted.";
  if (args.recovery === null) {
    return (
      `\n${heading}\n` +
      `Failed stages: ${args.failedStages.join(", ") || "(unknown)"}\n`
    );
  }
  const artifactLabel = args.recovery.artifactExists
    ? "Stage artifact"
    : "Expected stage artifact";
  return (
    `\n${heading}\n` +
    `First failed stage: ${args.recovery.stageId}\n` +
    `Failure: ${args.recovery.code}: ${args.recovery.message}\n` +
    `Recovery: ${args.recovery.resumeCommand}\n` +
    `Inspect: ${args.recovery.inspectCommand}\n` +
    `State: ${args.recovery.compileStatePath}\n` +
    `${artifactLabel}: ${args.recovery.artifactPath}\n` +
    `Guidance: ${args.recovery.guidance}\n`
  );
}

function stageFailureNextActions(
  recovery: StageFailureRecovery | null,
): string[] {
  if (recovery === null) return [];
  const artifactLabel = recovery.artifactExists
    ? "inspect failed stage artifact"
    : "inspect expected failed stage artifact path";
  return [
    `rerun from the first failed stage: ${recovery.resumeCommand}`,
    `inspect compile state: ${recovery.compileStatePath}`,
    `${artifactLabel}: ${recovery.artifactPath}`,
    `failure guidance: ${recovery.guidance}`,
  ];
}

function stageFailureGuidance(code: string, message: string): string {
  const normalized = `${code} ${message}`.toLowerCase();
  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("rate limit") ||
    normalized.includes("overloaded")
  ) {
    return (
      "provider or network failure; retry the same stage with --no-bump after " +
      "checking provider status, timeout settings, and credentials"
    );
  }
  if (
    normalized.includes("schema") ||
    normalized.includes("validation") ||
    normalized.includes("preflight") ||
    normalized.includes("coverage") ||
    normalized.includes("malformed") ||
    normalized.includes("json") ||
    normalized.includes("parse")
  ) {
    return (
      "deterministic validation failure; inspect the stage artifact and fix " +
      "inputs, fixtures, or generator constraints before rerunning"
    );
  }
  return (
    "inspect the compile state and stage artifact, then rerun the same stage " +
    "with --no-bump"
  );
}

function stageRecoveryArtifactPath(almanacDir: string, stageId: StageId): string {
  switch (stageId) {
    case "00-bootstrap":
      return compileStatePath(almanacDir);
    case "01-domain-analysis":
      return domainSpecPath(almanacDir);
    case "02a-source-discovery-planner":
      return sourceDiscoveryPlanPath(almanacDir);
    case "02x-source-discovery-executor":
      return candidatesPath(almanacDir);
    case "02b-source-discovery-evaluator":
      return sourcesDraftPath(almanacDir);
    case "03-source-approve":
      return approvedSourcesPath(almanacDir);
    case "04-source-fetch":
      return sourceFetchManifestPath(almanacDir);
    case "05-fact-extraction":
      return factsJsonlPath(almanacDir);
    case "06-tool-design":
      return toolDesignPath(almanacDir);
    case "07-tool-impl":
      return stage07OutputPath(almanacDir);
    case "08-knowledge-index":
      return knowledgeIndexManifestPath(almanacDir);
    case "09-contract-files":
      return stage09OutputPath(almanacDir);
    case "10-adapter-generation":
      return stage10OutputPath(almanacDir);
    case "11-benchmark-gen":
      return stage11OutputPath(almanacDir);
    case "12-benchmark-run":
      return benchmarkResultPath(almanacDir);
  }
}

/**
 * Open `$EDITOR` (falls back to `vi`) on a temp file pre-filled with `content`.
 * Returns the user's saved contents. If the editor exits non-zero, throws.
 */
function editInExternalEditor(args: {
  content: string;
  filename: string;
}): string {
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  const tmpPath = join(tmpdir(), `${args.filename}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, args.content, "utf8");
  try {
    const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(
        `editor "${editor}" exited with status ${result.status}`,
      );
    }
    return readFileSync(tmpPath, "utf8");
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Interactive review loop for the Stage 1 `DomainSpec`. Prompts the user to
 * Accept / Edit / Quit. On Edit, opens `$EDITOR` on the spec, re-validates,
 * and re-prompts. Falls through to "accept" automatically when stdin is not
 * a TTY (CI / pipe-driven invocations).
 *
 * Returns `"accept"` or `"quit"`. Persists any user edits back to
 * `<almanacDir>/.compile/domain-spec.json`.
 */
async function reviewDomainSpec(almanacDir: string): Promise<"accept" | "quit"> {
  const specPath = domainSpecPath(almanacDir);

  if (!process.stdin.isTTY) {
    process.stdout.write(
      `\n--review: stdin is not a TTY; auto-accepting the DomainSpec at ${specPath}\n`,
    );
    return "accept";
  }

  // Loop so that after a successful edit we re-prompt for accept/edit/quit.
  for (;;) {
    const body = await readFile(specPath, "utf8");
    const spec = JSON.parse(body);
    process.stdout.write(
      "\n────────────────────────── DomainSpec (Stage 1 output) ──────────────────────────\n",
    );
    process.stdout.write(
      `  domain         ${spec.domain}\n` +
        `  displayName    ${spec.displayName}\n` +
        `  canonicalSlug  ${spec.canonicalSlug}\n` +
        `  summary        ${spec.summary}\n` +
        `  subareas       ${(spec.subareas as string[]).join(", ")}\n` +
        `  verbs          ${(spec.verbs as string[]).join(", ")}\n` +
        `  entityTypes    ${(spec.entityTypes as string[]).join(", ")}\n` +
        `  intents        ${(spec.intents as Array<{ kind: string; example: string }>)
          .map((i) => `${i.kind}: "${i.example}"`)
          .join("\n                 ")}\n` +
        `  profile        ${spec.freshnessProfile.profileId} (default=${spec.freshnessProfile.defaultClass})\n` +
        `  sources        ${spec.suggestedSources.length} suggested\n` +
        `  tools          ${spec.suggestedTools.length} suggested (in addition to 4 defaults)\n` +
        `  cautions       ${spec.cautions.length}\n` +
        `\n  full JSON at  ${specPath}\n`,
    );
    process.stdout.write(
      "────────────────────────────────────────────────────────────────────────────────\n",
    );

    const rl = createInterface({ input, output });
    const answer = (
      await rl.question(
        "\n[A]ccept and continue / [E]dit JSON in $EDITOR / [Q]uit (default: A): ",
      )
    )
      .trim()
      .toLowerCase();
    rl.close();

    if (answer === "" || answer === "a" || answer === "accept") {
      return "accept";
    }
    if (answer === "q" || answer === "quit") {
      return "quit";
    }
    if (answer === "e" || answer === "edit") {
      try {
        const edited = editInExternalEditor({
          content: body,
          filename: "domain-spec.json",
        });
        const parsed = DomainSpecSchema.parse(JSON.parse(edited));
        await writeFile(
          specPath,
          JSON.stringify(parsed, null, 2) + "\n",
          "utf8",
        );
        process.stdout.write(`  ✓ saved edited DomainSpec to ${specPath}\n`);
      } catch (e) {
        process.stdout.write(
          `\n  ✗ edit not saved: ${(e as Error).message}\n` +
            `    (your changes were discarded; original ${specPath} kept)\n`,
        );
      }
      continue;
    }
    process.stdout.write(`  unknown choice "${answer}"; try A/E/Q\n`);
  }
}

/**
 * Assemble the full set of stage runners. Deterministic runners (02x, 03, 04,
 * 07–10) are always registered. LLM-driven runners (01, 02a, 02b, 05, 06) are
 * only registered when an `LlmProvider` is available; otherwise they will be
 * recorded as `skipped` with reason `no-runner-registered`.
 *
 * Used by both `almanac new` and `almanac update` so the two commands agree
 * on what's runnable in the current environment.
 */
function buildRunners(): {
  runners: StageRunners;
  providerAvailable: boolean;
} {
  const provider = resolveProvider();
  const runners: StageRunners = {
    "02x-source-discovery-executor": createSourceDiscoveryExecutorRunner({
      prober: createHttpUrlProber(),
      webSearcher: process.env["BRAVE_SEARCH_API_KEY"]
        ? createBraveWebSearcher()
        : createNullWebSearcher(),
      communitySearchers: createDefaultCommunitySearchers(),
      githubSearcher: createGithubSearcher(),
    }),
    "03-source-approve": createApproveRunner(),
    "04-source-fetch": createSourceFetchRunner(),
    // Stage 7 is template-only by default; if a provider is available it
    // gets re-registered below with an LlmImplementer for custom tools.
    "07-tool-impl": createToolImplRunner(),
    "08-knowledge-index": createKnowledgeIndexRunner(),
    "09-contract-files": createContractFilesRunner(),
    "10-adapter-generation": createSkillAdapterRunner(),
    "12-benchmark-run": createBenchmarkRunRunner(),
  };
  if (provider !== null) {
    runners["01-domain-analysis"] = createDomainAnalysisRunner({ provider });
    runners["02a-source-discovery-planner"] =
      createSourceDiscoveryPlannerRunner({ provider });
    runners["02b-source-discovery-evaluator"] =
      createSourceDiscoveryEvaluatorRunner({ provider });
    runners["05-fact-extraction"] = createFactExtractionRunner({ provider });
    runners["06-tool-design"] = createToolDesignRunner({ provider });
    runners["11-benchmark-gen"] = createBenchmarkGenRunner({
      provider,
      preflightGeneratedSet: true,
    });
    // Stage 7 with LLM-driven custom-tool generation: re-register the runner
    // with a real LlmCodeWriter + TscRunner + SmokeTestRunner so custom
    // tools designed in Stage 6 actually get implemented.
    runners["07-tool-impl"] = createToolImplRunner({
      customToolImplementer: new LlmImplementer(),
      llm: createLlmCodeWriter({ provider }),
      tsc: createBunxTscRunner(),
      smoke: createBunSmokeRunner(),
    });
  }
  return { runners, providerAvailable: provider !== null };
}

// ──────────────────────────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────────────────────────

interface NewOptions {
  displayName?: string;
  slug?: string;
  profile: FreshnessProfileId;
  depth: CompileOptions["depth"];
  target: CompileOptions["target"];
  source: string[];
  /**
   * Optional one-paragraph scope narrowing forwarded into the Stage 1
   * domain-analysis prompt. Useful for abstract or broad domain terms.
   */
  scope?: string;
  /**
   * After Stage 1 completes, pause and let the user review the generated
   * DomainSpec before paying for Stages 2-10. The user can accept, edit
   * the JSON in $EDITOR, or quit. Falls through automatically when stdin
   * is not a TTY (CI / non-interactive runs).
   */
  review?: boolean;
  requireApproval?: boolean;
  root: string;
  bootstrapOnly?: boolean;
  /**
   * Resume a previously-interrupted compilation: skip the bootstrap step,
   * load the existing manifest + compile-state, and let `runPipeline`
   * re-execute any stage that is not already `completed`.
   *
   * Required when `<almanacDir>` already exists.
   */
  resume?: boolean;
}

async function cmdNew(domain: string, opts: NewOptions): Promise<void> {
  const slug = opts.slug ?? slugify(domain);
  if (slug.length === 0) {
    fail(`could not derive a canonicalSlug from "${domain}"; pass --slug=<id>`);
  }
  const displayName = opts.displayName ?? titleCase(domain);
  const almanacDir = almanacDirPath(opts.root, slug);
  const alreadyExists = existsSync(almanacDir);

  if (alreadyExists && !opts.resume) {
    fail(
      `almanac directory already exists: ${almanacDir}\n` +
        `       use \`almanac new ${slug} --resume\` to continue a previous run,\n` +
        `       or remove the directory first.`,
    );
  }
  if (!alreadyExists && opts.resume) {
    fail(
      `--resume requires an existing almanac at ${almanacDir}; ` +
        "drop --resume to bootstrap a new one.",
    );
  }

  let manifest: AlmanacManifest;
  let stage0CompletedState: CompileState;

  if (opts.resume) {
    process.stdout.write(`▶ resuming almanac "${slug}" (${displayName})\n`);
    manifest = await readManifest(almanacDir);
    stage0CompletedState = await readCompileState(almanacDir);
    if (stage0CompletedState.stages["00-bootstrap"].status !== "completed") {
      fail(
        `--resume: Stage 0 in ${almanacDir}/.compile/compile-state.json is not "completed"`,
      );
    }
  } else {
    const compileOptions: CompileOptions = {
      depth: opts.depth,
      sourcesHint: opts.source,
      ...(opts.scope !== undefined && opts.scope.length > 0
        ? { scopeHint: opts.scope }
        : {}),
      target: opts.target,
      autoApprove: opts.requireApproval !== true,
      language: "ts",
    };

    const runId = generateRunId();
    process.stdout.write(`▶ bootstrapping almanac "${slug}" (${displayName})\n`);

    const bootstrapped = bootstrapAlmanac({
      almanacId: slug,
      domain,
      displayName,
      freshnessProfileId: opts.profile,
      runId,
      forgerVersion: FORGER_VERSION,
      options: compileOptions,
    });
    manifest = bootstrapped.manifest;

    await ensureAlmanacLayout(almanacDir);
    await writeManifest(almanacDir, manifest);

    // Stage 0 is "complete" by virtue of having produced these two artifacts.
    // Hash them together so the outputHash is deterministic and verifiable.
    const stage0Hash = sha256Hex(
      JSON.stringify(manifest) + "\n" + JSON.stringify(bootstrapped.compileState),
    );
    stage0CompletedState = markStageCompleted(
      bootstrapped.compileState,
      "00-bootstrap",
      new Date(),
      { outputHash: stage0Hash },
    );
    await writeCompileState(almanacDir, stage0CompletedState);

    process.stdout.write(`  ✓ wrote ${almanacDir}\n`);
  }

  if (opts.bootstrapOnly) {
    process.stdout.write(
      `\nDone. \`almanac inspect ${slug}\` to see status.\n`,
    );
    return;
  }

  process.stdout.write("▶ running pipeline (stages 01–12)\n");
  const { runners, providerAvailable } = buildRunners();
  if (!providerAvailable) {
    process.stdout.write(
      "  ! ANTHROPIC_API_KEY not set; LLM-driven stages (01, 02a, 02b, 05, 06, 11) will be skipped " +
        "and Stage 7 will implement only the four default tools (custom tools disabled).\n",
    );
  }

  // --review: split the pipeline into two passes around Stage 1 so the user
  // can sanity-check the DomainSpec before any further LLM spend.
  let stateForFinalRun: CompileState = stage0CompletedState;
  if (opts.review === true) {
    process.stdout.write(
      "▶ --review: pausing after Stage 1 for human approval\n",
    );
    const stage1Result = await runPipeline({
      almanacDir,
      state: stage0CompletedState,
      manifest,
      runners,
      persistState: (s) => writeCompileState(almanacDir, s),
      persistManifest: (m) => writeManifestWithActualCounts(almanacDir, m),
      stopAfterStageId: "01-domain-analysis",
      log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
    });
    if (stage1Result.failed.length > 0) {
      const recovery = buildStageFailureRecovery({
        almanacId: slug,
        root: opts.root,
        almanacDir,
        state: stage1Result.state,
        failedStages: stage1Result.failed,
      });
      process.stderr.write(
        formatPipelineFailureRecovery({
          recovery,
          failedStages: stage1Result.failed,
          heading: "Stage 1 failed; cannot review.",
        }),
      );
      process.exit(1);
    }
    const decision = await reviewDomainSpec(almanacDir);
    if (decision === "quit") {
      process.stdout.write(
        `\nReview: quit. Re-run \`almanac new ${slug} --resume\` to continue.\n`,
      );
      return;
    }
    // After approval, reload state from disk in case user edited it.
    stateForFinalRun = await readCompileState(almanacDir);
  }

  const result = await runPipeline({
    almanacDir,
    state: stateForFinalRun,
    manifest,
    runners,
    persistState: (s) => writeCompileState(almanacDir, s),
    persistManifest: (m) => writeManifestWithActualCounts(almanacDir, m),
    log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
  });

  process.stdout.write(
    `\n  succeeded: ${result.succeeded.length}` +
      `   skipped: ${result.skipped.length}` +
      `   failed: ${result.failed.length}\n`,
  );

  if (result.failed.length > 0) {
    const recovery = buildStageFailureRecovery({
      almanacId: slug,
      root: opts.root,
      almanacDir,
      state: result.state,
      failedStages: result.failed,
    });
    process.stderr.write(
      formatPipelineFailureRecovery({
        recovery,
        failedStages: result.failed,
      }),
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nDone. \`almanac inspect ${slug}\` to see status.\n`,
  );
}

interface DemoOptions {
  root: string;
  force?: boolean;
}

async function cmdDemo(
  requestedId: string | undefined,
  opts: DemoOptions,
): Promise<void> {
  const almanacId = requestedId ? slugify(requestedId) : "sqlite-demo";
  if (almanacId.length === 0) {
    fail("demo id must contain at least one ASCII letter or number");
  }

  const almanacDir = almanacDirPath(opts.root, almanacId);
  if (existsSync(almanacDir)) {
    if (opts.force !== true) {
      fail(
        `demo target already exists: ${almanacDir} (re-run with --force to replace it)`,
      );
    }
    await rm(almanacDir, { recursive: true, force: true });
  }

  process.stdout.write(
    `▶ creating offline demo almanac "${almanacId}"\n` +
      `    root   ${opts.root}\n` +
      `    dir    ${almanacDir}\n`,
  );

  const options: CompileOptions = {
    depth: "quick",
    sourcesHint: [],
    target: "both",
    autoApprove: true,
    language: "ts",
  };
  const boot = bootstrapAlmanac({
    almanacId,
    domain: "sqlite operations demo",
    displayName: "SQLite Operations Demo",
    freshnessProfileId: "static-heavy",
    runId: generateRunId(),
    forgerVersion: FORGER_VERSION,
    options,
  });

  let manifest = boot.manifest;
  let state = markStageCompletedFromArtifact(
    boot.compileState,
    "00-bootstrap",
    boot.manifest,
  );

  await ensureAlmanacLayout(almanacDir);
  await writeManifest(almanacDir, manifest);
  await writeCompileState(almanacDir, state);

  const domainSpec = demoDomainSpec(almanacId);
  await writeJsonFile(domainSpecPath(almanacDir), domainSpec);
  state = markStageCompletedFromArtifact(
    state,
    "01-domain-analysis",
    domainSpec,
  );
  state = markStageSkipped(
    state,
    "02a-source-discovery-planner",
    new Date(),
    "demo-curated-sources",
  );
  state = markStageSkipped(
    state,
    "02x-source-discovery-executor",
    new Date(),
    "demo-curated-sources",
  );

  const draftSources = demoSourcesFile("draft");
  await writeJsonFile(sourcesDraftPath(almanacDir), draftSources);
  state = markStageCompletedFromArtifact(
    state,
    "02b-source-discovery-evaluator",
    draftSources,
  );
  await writeCompileState(almanacDir, state);

  state = await runStandaloneStage({
    almanacDir,
    state,
    manifest,
    stageId: "03-source-approve",
    runner: createApproveRunner(),
  });

  state = markStageSkipped(
    state,
    "04-source-fetch",
    new Date(),
    "demo-uses-curated-facts",
  );

  const facts = demoFacts();
  await writeFile(
    factsJsonlPath(almanacDir),
    facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
    "utf8",
  );
  state = markStageCompletedFromArtifact(state, "05-fact-extraction", facts);

  const toolDesign = demoToolDesign();
  await writeJsonFile(toolDesignPath(almanacDir), toolDesign);
  state = markStageCompletedFromArtifact(state, "06-tool-design", toolDesign);
  await writeCompileState(almanacDir, state);

  state = await runStandaloneStage({
    almanacDir,
    state,
    manifest,
    stageId: "07-tool-impl",
    runner: createToolImplRunner(),
  });

  state = await runStandaloneStage({
    almanacDir,
    state,
    manifest,
    stageId: "08-knowledge-index",
    runner: createKnowledgeIndexRunner(),
  });

  manifest = {
    ...manifest,
    factCount: facts.length,
    toolCount: await readImplementedToolCount(almanacDir),
    compiledAt: new Date().toISOString(),
  };
  await writeManifest(almanacDir, manifest);

  state = await runStandaloneStage({
    almanacDir,
    state,
    manifest,
    stageId: "09-contract-files",
    runner: createContractFilesRunner(),
  });
  state = await runStandaloneStage({
    almanacDir,
    state,
    manifest,
    stageId: "10-adapter-generation",
    runner: createSkillAdapterRunner(),
  });

  state = markStageSkipped(
    state,
    "11-benchmark-gen",
    new Date(),
    "demo-uses-human-golden-fixtures",
  );
  await writeBenchmarkFixtures(almanacDir, demoBenchmarkSet(almanacId), {
    force: true,
  });
  await writeCompileState(almanacDir, state);

  state = await runStandaloneStage({
    almanacDir,
    state,
    manifest,
    stageId: "12-benchmark-run",
    runner: createBenchmarkRunRunner(),
  });

  manifest = {
    ...manifest,
    compiledAt: new Date().toISOString(),
  };
  await writeManifest(almanacDir, manifest);
  await writeCompileState(almanacDir, state);

  const report = await readBenchmarkReportIfPresent(almanacDir);
  process.stdout.write(
    `\nDone.\n` +
      `    facts      ${manifest.factCount}\n` +
      `    tools      ${manifest.toolCount}\n` +
      `    benchmark  ${report ? `${report.summary.passed}/${report.summary.total} passed` : "not run"}\n\n` +
      `Try:\n` +
      `    almanac inspect ${almanacId} --root ${opts.root}\n` +
      `    almanac profile ${almanacId} --root ${opts.root}\n` +
      `    almanac run ${almanacId} --tool query_facts --input '{"q":"transactions atomic"}' --root ${opts.root}\n` +
      `    almanac sources ${almanacId} --root ${opts.root}\n` +
      `    almanac benchmark ${almanacId} --root ${opts.root}\n`,
  );
}

function demoDomainSpec(almanacId: string) {
  return DomainSpecSchema.parse({
    domain: "sqlite operations demo",
    canonicalSlug: almanacId,
    displayName: "SQLite Operations Demo",
    summary:
      "A small offline demonstration almanac for SQLite transaction, query-plan, and pragma lookup workflows.",
    subareas: [
      "transactions",
      "query planning",
      "database pragmas",
    ],
    intents: [
      { kind: "lookup", example: "What makes SQLite transactions atomic?" },
      { kind: "explain", example: "Explain what EXPLAIN QUERY PLAN reports." },
      { kind: "howto", example: "How do I inspect journal mode behavior?" },
    ],
    verbs: ["lookup", "explain", "inspect", "compare"],
    entityTypes: ["SQL command", "pragma", "runtime behavior"],
    freshnessProfile: {
      profileId: "static-heavy",
      defaultClass: "static",
      classes: {
        static: { examples: ["transaction semantics", "query plan output"] },
        slow: {
          examples: ["documentation wording", "recommended pragmas"],
          maxAgeDays: 180,
        },
        fast: { examples: [] },
        live: { examples: [] },
      },
    },
    suggestedSources: [
      { hint: "https://www.sqlite.org/lang_transaction.html", kind: "docs" },
      { hint: "https://www.sqlite.org/eqp.html", kind: "docs" },
      { hint: "https://www.sqlite.org/pragma.html", kind: "docs" },
    ],
    suggestedTools: [],
    cautions: [],
  });
}

function demoSourcesFile(status: "draft" | "approved"): SourcesFile {
  const generatedAt = new Date().toISOString();
  const base = {
    schemaVersion: "0.1.0" as const,
    status,
    generatedAt,
    generatedBy: {
      stage: "02-source-discovery" as const,
      evaluatorPromptVersion: "demo-curated-v1",
      candidateCount: 3,
      acceptedCount: 3,
    },
    coverage: {
      docs: 3,
      repo: 0,
      news: 0,
      community: 0,
      academic: 0,
      data: 0,
      file: 0,
      essay: 0,
      book: 0,
      talk: 0,
    },
    warnings: ["offline demo uses curated sources and facts; no network fetch was performed"],
    sources: [
      demoSource(
        "sqlite-transactions",
        "https://www.sqlite.org/lang_transaction.html",
        "SQLite transaction semantics are canonical for this demo.",
      ),
      demoSource(
        "sqlite-query-plan",
        "https://www.sqlite.org/eqp.html",
        "SQLite query-plan documentation backs lookup fixtures.",
      ),
      demoSource(
        "sqlite-pragmas",
        "https://www.sqlite.org/pragma.html",
        "SQLite pragma documentation backs operational fixtures.",
      ),
    ],
    rejected: [],
  };
  return SourcesFileSchema.parse(
    status === "approved"
      ? { ...base, approvedAt: generatedAt, approvedBy: "human" }
      : base,
  );
}

function demoSource(id: string, url: string, rationale: string) {
  return {
    id,
    url,
    kind: "docs" as const,
    trust: 0.98,
    volatility: "slow" as const,
    rationale,
    ingestion: {
      mode: "snapshot" as const,
      scope: [url],
      refreshIntervalHours: 24 * 180,
    },
    notes: "Curated offline demo source.",
  };
}

function demoFacts(): FactRecord[] {
  const extractedAt = new Date().toISOString();
  const rows: FactRecord[] = [
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      text:
        "SQLite transactions are atomic: either all changes inside COMMIT persist or none do after ROLLBACK.",
      type: "fact",
      entities: ["transaction", "COMMIT", "ROLLBACK"],
      source: {
        sourceId: "sqlite-transactions",
        contentHash: sha256Hex("sqlite-transactions"),
        url: "https://www.sqlite.org/lang_transaction.html",
        excerpt:
          "SQLite transactions are atomic, consistent, isolated, and durable within documented constraints.",
      },
      freshnessClass: "static",
      validUntil: null,
      confidence: 0.96,
      extractedAt,
      extractor: { model: "demo-curated", promptVersion: "v1" },
    },
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      text:
        "SQLite EXPLAIN QUERY PLAN reports whether a statement scans or searches each table or index.",
      type: "definition",
      entities: ["EXPLAIN QUERY PLAN", "index", "scan"],
      source: {
        sourceId: "sqlite-query-plan",
        contentHash: sha256Hex("sqlite-query-plan"),
        url: "https://www.sqlite.org/eqp.html",
        excerpt:
          "EXPLAIN QUERY PLAN shows how SQLite plans to scan or search tables and indexes.",
      },
      freshnessClass: "static",
      validUntil: null,
      confidence: 0.94,
      extractedAt,
      extractor: { model: "demo-curated", promptVersion: "v1" },
    },
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      text:
        "SQLite PRAGMA journal_mode controls rollback journal behavior, including WAL mode selection.",
      type: "reference",
      entities: ["PRAGMA journal_mode", "WAL", "rollback journal"],
      source: {
        sourceId: "sqlite-pragmas",
        contentHash: sha256Hex("sqlite-pragmas"),
        url: "https://www.sqlite.org/pragma.html#pragma_journal_mode",
        excerpt:
          "PRAGMA journal_mode queries or changes the journal mode for attached databases.",
      },
      freshnessClass: "static",
      validUntil: null,
      confidence: 0.93,
      extractedAt,
      extractor: { model: "demo-curated", promptVersion: "v1" },
    },
  ];
  return rows.map((row) => FactRecordSchema.parse(row));
}

function demoToolDesign(): ToolDesignResult {
  return ToolDesignResultSchema.parse({
    schemaVersion: "0.1.0",
    customTools: [],
    rationale:
      "The offline demo relies on the four default tools; no domain-specific custom tool is required.",
  });
}

function demoBenchmarkSet(almanacId: string) {
  return BenchmarkSetSchema.parse({
    schemaVersion: "0.1.0",
    almanacId,
    positive: [
      PositiveFixtureSchema.parse({
        id: "transaction-atomicity",
        intent: "lookup",
        query: "transaction atomicity",
        rationale:
          "The curated fact corpus includes an explicit transaction atomicity fact.",
        invocation: {
          tool: "query_facts",
          input: { q: "transactions atomic", limit: 3 },
        },
        expected: {
          minCitations: 1,
          contains: ["atomic"],
          acceptableStaleness: ["fresh", "warm"],
        },
      }),
    ],
    negative: [
      NegativeFixtureSchema.parse({
        id: "out-of-domain-violin",
        query: "quantum violin tuning",
        rationale:
          "This query is deliberately outside the SQLite operations domain.",
        refusalReason: "out-of-scope",
        invocation: {
          tool: "query_facts",
          input: { q: "quantum violin tuning", limit: 3 },
        },
        expected: {
          maxCitations: 0,
          expectedErrorCode: "no-results",
        },
      }),
    ],
  });
}

async function writeBenchmarkFixtures(
  almanacDir: string,
  set: ReturnType<typeof demoBenchmarkSet>,
  opts: { force?: boolean } = {},
): Promise<void> {
  const posPath = positiveJsonlPath(almanacDir);
  const negPath = negativeJsonlPath(almanacDir);
  if (opts.force !== true && (existsSync(posPath) || existsSync(negPath))) {
    fail(
      `benchmark fixtures already exist under ${join(almanacDir, "tests")} (use --force to replace them)`,
    );
  }
  await mkdir(dirname(posPath), { recursive: true });
  await writeFile(
    posPath,
    set.positive.map((fixture) => JSON.stringify(fixture)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    negPath,
    set.negative.map((fixture) => JSON.stringify(fixture)).join("\n") + "\n",
    "utf8",
  );
}

interface ListOptions {
  root: string;
  json?: boolean;
}

interface StatusOptions {
  root: string;
  json?: boolean;
}

interface MaintainOptions {
  root: string;
  json?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  all?: boolean;
  dueOnly?: boolean;
  label?: string;
  note?: string;
}

type McpServerEntry = {
  command: string;
  args: string[];
};

type RegistrationComponentStatus =
  | "current"
  | "missing"
  | "stale"
  | "mismatched"
  | "unreadable"
  | "unsupported";
type RegistrationOverallStatus =
  | "current"
  | "missing"
  | "stale"
  | "unreadable"
  | "unsupported";

interface RegistrationComponentState {
  status: RegistrationComponentStatus;
  path: string | null;
  issues: string[];
}

interface RegistrationClientState {
  client: RegisterClient;
  status: RegistrationOverallStatus;
  skill: RegistrationComponentState;
  mcp: RegistrationComponentState & {
    serverName: string;
    expected: McpServerEntry;
    actual: unknown;
  };
  nextActions: string[];
}

interface LifecycleRegistrationSummary {
  status: RegistrationOverallStatus;
  clients: RegistrationClientState[];
}

type LifecycleOverallStatus = "ok" | "attention" | "failed" | "broken";
type LifecycleCompileStatus = "ok" | "attention" | "failed" | "missing";
type LifecycleKnowledgeStatus = "present" | "missing" | "unreadable";
type LifecycleBenchmarkStatus =
  | "passed"
  | "failed"
  | "missing"
  | "not-run"
  | "needs-validation"
  | "unreadable";
type LifecycleRefreshStatus = "due" | "not-due" | "unknown";
type LifecycleUsabilityStatus = "usable" | "limited" | "not-usable";

interface LifecycleInventoryItem {
  almanacId: string;
  almanacDir: string;
  displayName: string;
  manifest: AlmanacManifest | null;
  lifecycle: {
    status: LifecycleOverallStatus;
    compile: {
      status: LifecycleCompileStatus;
      completed: number;
      failed: StageId[];
      pending: StageId[];
      running: StageId[];
      skipped: number;
      error?: string;
    };
    knowledge: {
      status: LifecycleKnowledgeStatus;
      facts: number | null;
      tools: number | null;
      manifestFacts: number | null;
      manifestTools: number | null;
      countsMatch: boolean | null;
      toolsReadable: boolean;
      retrieval: string | null;
      error?: string;
    };
    benchmark: {
      status: LifecycleBenchmarkStatus;
      positiveFixtures: number | null;
      negativeFixtures: number | null;
      total: number | null;
      passed: number | null;
      failed: number | null;
      errored: number | null;
      citationRate: number | null;
      issue?: string;
    };
    answer: {
      status: AnswerReadinessStatus | "unknown";
      fixtures: number | null;
      latestSuite: AnswerReadiness["latestSuite"]["status"] | null;
      qualityGate: AnswerReadiness["qualityGate"]["status"] | null;
      issue?: string;
    };
    refresh: {
      status: LifecycleRefreshStatus;
      recommendedFromStage: StageId | null;
      reasons: number | null;
      nextDueAt: string | null;
      issue?: string;
    };
    registration: LifecycleRegistrationSummary;
    issues: string[];
    nextActions: string[];
  };
}

interface LifecycleUsability {
  status: LifecycleUsabilityStatus;
  reason: string;
}

interface LifecycleLatestRuns {
  latest: RunToolArtifactSummary | null;
  byKind: {
    tool: RunToolArtifactSummary | null;
    answer: RunToolArtifactSummary | null;
    refresh: RunToolArtifactSummary | null;
    maintenance: RunToolArtifactSummary | null;
  };
  readError: string | null;
}

interface AlmanacStatusReport {
  almanacId: string;
  almanacDir: string;
  displayName: string;
  manifest: AlmanacManifest | null;
  status: LifecycleOverallStatus;
  usability: LifecycleUsability;
  lifecycle: LifecycleInventoryItem["lifecycle"];
  runs: LifecycleLatestRuns;
  nextActions: string[];
}

type MaintenanceStatus =
  | "ready"
  | "due"
  | "needs-validation"
  | "repairable"
  | "blocked"
  | "broken";

type MaintenancePlanStepStatus = "planned" | "skipped" | "blocked";

interface MaintenancePlanStep {
  id: "refresh" | "benchmark" | "ask-suite" | "cleanup";
  status: MaintenancePlanStepStatus;
  reason: string;
  command: string | null;
  providerRequired: boolean;
  expectedArtifact: string | null;
}

interface MaintenanceRepairCandidate {
  kind: "compile" | "knowledge" | "registration" | "runs" | "broken-directory";
  message: string;
  command: string | null;
  risk: "low" | "medium";
  applyRequired: boolean;
}

interface MaintenanceCleanupCandidate {
  kind: "saved-runs" | "export-archive";
  message: string;
  command: string | null;
  count: number;
  paths: string[];
}

interface MaintenanceReport {
  schemaVersion: "0.1.0";
  almanacId: string;
  version: string | null;
  root: string;
  almanacDir: string;
  checkedAt: string;
  dryRun: true;
  status: MaintenanceStatus;
  usability: LifecycleUsability;
  refresh: {
    status: LifecycleRefreshStatus;
    due: boolean;
    recommendedFromStage: StageId | null;
    reasons: number | null;
    nextDueAt: string | null;
    latestRun: RunToolArtifactSummary | null;
    issue?: string;
  };
  benchmark: LifecycleInventoryItem["lifecycle"]["benchmark"] & {
    planned: boolean;
  };
  answer: LifecycleInventoryItem["lifecycle"]["answer"] & {
    planned: boolean;
    latestRun: RunToolArtifactSummary | null;
  };
  registration: LifecycleRegistrationSummary;
  artifacts: {
    latestRun: RunToolArtifactSummary | null;
    latestByKind: LifecycleLatestRuns["byKind"];
    savedRunsReadError: string | null;
    cleanupCandidates: MaintenanceCleanupCandidate[];
  };
  repairs: MaintenanceRepairCandidate[];
  plan: MaintenancePlanStep[];
  issues: string[];
  nextActions: string[];
}

interface MaintenanceApplyResult {
  schemaVersion: "0.1.0";
  mode: "apply";
  almanacId: string;
  version: string | null;
  root: string;
  almanacDir: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dueOnly: boolean;
  status: MaintenanceArtifactStatus;
  exitCode: RunToolExitCode;
  reportBefore: MaintenanceReport;
  reportAfter: MaintenanceReport | null;
  steps: MaintenanceStepResult[];
  refresh: {
    status: string;
    refreshId: string;
    artifactRelPath?: string;
    exitCode: RunToolExitCode;
  } | null;
  benchmark: MaintenanceArtifact["benchmark"] | null;
  savedArtifact: {
    path: string;
    relPath: string;
  } | null;
  error?: {
    code: string;
    message: string;
  };
  nextActions: string[];
}

interface MaintenanceBatchEntry {
  almanacId: string;
  status: "applied" | "skipped" | "failed";
  reason: string;
  report?: MaintenanceReport;
  result?: MaintenanceApplyResult;
}

interface MaintenanceBatchResult {
  schemaVersion: "0.1.0";
  mode: "dry-run" | "apply";
  root: string;
  dueOnly: boolean;
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  results: MaintenanceBatchEntry[];
}

async function readLifecycleInventory(root: string): Promise<LifecycleInventoryItem[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readLifecycleInventoryItem(root, entry.name)),
  );
  items.sort((a, b) => a.almanacId.localeCompare(b.almanacId));
  return items;
}

async function readAlmanacStatusReport(
  id: string,
  opts: StatusOptions,
): Promise<AlmanacStatusReport> {
  const dir = almanacDirPath(opts.root, id);
  if (!existsSync(dir)) {
    fail(`almanac not found: ${dir}`);
  }
  const item = await readLifecycleInventoryItem(opts.root, id);
  const runs = await readLifecycleLatestRuns(dir);
  const runReadError =
    runs.readError === null ? [] : [`saved runs unreadable: ${runs.readError}`];
  const registrationRepairActions = item.lifecycle.registration.clients
    .filter((client) => client.status === "stale" || client.status === "unreadable")
    .flatMap((client) => client.nextActions);
  const nextActions = uniqueStrings([
    ...item.lifecycle.nextActions,
    ...registrationRepairActions,
    ...(runs.readError === null
      ? [`view saved runs: almanac runs ${id}${rootArg(opts.root)}`]
      : [`inspect runs directory: ${join(dir, ".runs")}`]),
  ]);

  return {
    almanacId: item.almanacId,
    almanacDir: item.almanacDir,
    displayName: item.displayName,
    manifest: item.manifest,
    status: item.lifecycle.status,
    usability: lifecycleUsability(item),
    lifecycle: {
      ...item.lifecycle,
      issues: uniqueStrings([...item.lifecycle.issues, ...runReadError]),
      nextActions,
    },
    runs,
    nextActions,
  };
}

async function readLifecycleLatestRuns(
  almanacDir: string,
): Promise<LifecycleLatestRuns> {
  try {
    const [latest, tool, answer, refresh, maintenance] = await Promise.all([
      listRunToolArtifacts({ almanacDir, limit: 1 }),
      listRunToolArtifacts({ almanacDir, kind: "tool", limit: 1 }),
      listRunToolArtifacts({ almanacDir, kind: "answer", limit: 1 }),
      listRunToolArtifacts({ almanacDir, kind: "refresh", limit: 1 }),
      listRunToolArtifacts({ almanacDir, kind: "maintenance", limit: 1 }),
    ]);
    return {
      latest: latest.runs[0] ?? null,
      byKind: {
        tool: tool.runs[0] ?? null,
        answer: answer.runs[0] ?? null,
        refresh: refresh.runs[0] ?? null,
        maintenance: maintenance.runs[0] ?? null,
      },
      readError: null,
    };
  } catch (e) {
    const message = unknownErrorMessage(e);
    return {
      latest: null,
      byKind: {
        tool: null,
        answer: null,
        refresh: null,
        maintenance: null,
      },
      readError: message,
    };
  }
}

async function readLifecycleInventoryItem(
  root: string,
  dirName: string,
): Promise<LifecycleInventoryItem> {
  const almanacDir = almanacDirPath(root, dirName);
  if (!existsSync(join(almanacDir, "manifest.json"))) {
    return brokenLifecycleItem({
      almanacId: dirName,
      almanacDir,
      issue: "manifest.json missing",
      nextAction: `inspect or remove directory: ${almanacDir}`,
    });
  }

  let manifest: AlmanacManifest;
  try {
    manifest = await readManifest(almanacDir);
  } catch (e) {
    return brokenLifecycleItem({
      almanacId: dirName,
      almanacDir,
      issue: `manifest unreadable: ${unknownErrorMessage(e)}`,
      nextAction: `repair or remove directory: ${almanacDir}`,
    });
  }

  const rootSuffix = rootArg(root);
  const issues: string[] = [];
  const nextActions: string[] = [];

  let state: CompileState | null = null;
  let compileStatus: LifecycleCompileStatus = "missing";
  let stageCounts: StageStatusSummary = {
    completed: 0,
    failed: 0,
    pending: 0,
    running: 0,
    skipped: 0,
  };
  let failedStages: StageId[] = [];
  let pendingStages: StageId[] = [];
  let runningStages: StageId[] = [];
  let compileError: string | undefined;
  try {
    state = await readCompileState(almanacDir);
    stageCounts = stageStatusCounts(state);
    failedStages = (STAGE_IDS as readonly StageId[]).filter(
      (stageId) => state?.stages[stageId].status === "failed",
    );
    pendingStages = (STAGE_IDS as readonly StageId[]).filter(
      (stageId) => state?.stages[stageId].status === "pending",
    );
    runningStages = (STAGE_IDS as readonly StageId[]).filter(
      (stageId) => state?.stages[stageId].status === "running",
    );
    compileStatus =
      failedStages.length > 0
        ? "failed"
        : pendingStages.length > 0 || runningStages.length > 0
          ? "attention"
          : "ok";
  } catch (e) {
    compileError = unknownErrorMessage(e);
    issues.push(`compile state unreadable: ${compileError}`);
    nextActions.push(`restore compile state: ${compileStatePath(almanacDir)}`);
  }
  if (failedStages.length > 0 && state !== null) {
    issues.push(`failed stages: ${failedStages.join(", ")}`);
    nextActions.push(
      ...stageFailureNextActions(
        buildStageFailureRecovery({
          almanacId: manifest.almanacId,
          root,
          almanacDir,
          state,
          failedStages,
        }),
      ),
    );
  } else if (pendingStages.length > 0) {
    issues.push(`pending stages: ${pendingStages.join(", ")}`);
    nextActions.push(
      `resume compile: almanac update ${manifest.almanacId} --from-stage ${pendingStages[0]} --no-bump${rootSuffix}`,
    );
  } else if (runningStages.length > 0) {
    issues.push(`running stages: ${runningStages.join(", ")}`);
    nextActions.push(`inspect compile state: ${compileStatePath(almanacDir)}`);
  }

  let knowledge: KnowledgeIndexManifest | null = null;
  let knowledgeStatus: LifecycleKnowledgeStatus = "missing";
  let knowledgeError: string | undefined;
  try {
    knowledge = await readKnowledgeIndexManifest(almanacDir);
    knowledgeStatus = knowledge === null ? "missing" : "present";
  } catch (e) {
    knowledgeError = unknownErrorMessage(e);
    knowledgeStatus = "unreadable";
    issues.push(`knowledge index unreadable: ${knowledgeError}`);
  }

  let counts: DisplayCounts = {
    facts: manifest.factCount,
    tools: manifest.toolCount,
    manifestFacts: manifest.factCount,
    manifestTools: manifest.toolCount,
    toolsReadable: false,
  };
  try {
    counts = await readDisplayCounts(almanacDir, manifest, knowledge);
  } catch (e) {
    issues.push(`counts unreadable: ${unknownErrorMessage(e)}`);
  }
  if (knowledgeStatus === "missing") {
    issues.push("knowledge index missing");
    nextActions.push(
      `rebuild knowledge index: almanac update ${manifest.almanacId} --from-stage 08-knowledge-index --no-bump${rootSuffix}`,
    );
  }
  if (countsMismatch(counts)) {
    issues.push("manifest counts differ from actual artifacts");
  }

  const embeddingConfig = resolveEmbeddingProviderConfig(process.env);
  const retrieval = getRetrievalReadiness({
    vectorIndex: knowledge?.vectorIndex ?? null,
    embeddingConfig,
  });
  if (retrieval.status === "needs-attention") {
    issues.push(`retrieval ${retrieval.summary}`);
  }

  const benchmark = await readLifecycleBenchmark({
    almanacDir,
    manifest,
    state,
    issues,
    nextActions,
    rootSuffix,
  });
  const answer = await readLifecycleAnswer({
    almanacDir,
    manifest,
    issues,
    nextActions,
    rootSuffix,
  });
  const refresh = await readLifecycleRefresh({
    almanacDir,
    manifest,
    issues,
    nextActions,
    rootSuffix,
  });
  const registration = await readLifecycleRegistration({
    almanacDir,
    manifest,
    root,
  });

  nextActions.push(`inspect details: almanac inspect ${manifest.almanacId}${rootSuffix}`);

  const overall = lifecycleOverallStatus({
    compileStatus,
    knowledgeStatus,
    benchmarkStatus: benchmark.status,
    answerStatus: answer.status,
    refreshStatus: refresh.status,
    issues,
  });

  return {
    almanacId: manifest.almanacId,
    almanacDir,
    displayName: manifest.displayName,
    manifest,
    lifecycle: {
      status: overall,
      compile: {
        status: compileStatus,
        completed: stageCounts.completed,
        failed: failedStages,
        pending: pendingStages,
        running: runningStages,
        skipped: stageCounts.skipped,
        ...(compileError === undefined ? {} : { error: compileError }),
      },
      knowledge: {
        status: knowledgeStatus,
        facts: counts.facts,
        tools: counts.tools,
        manifestFacts: counts.manifestFacts,
        manifestTools: counts.manifestTools,
        countsMatch: !countsMismatch(counts),
        toolsReadable: counts.toolsReadable,
        retrieval: retrieval.summary,
        ...(knowledgeError === undefined ? {} : { error: knowledgeError }),
      },
      benchmark,
      answer,
      refresh,
      registration,
      issues: uniqueStrings(issues),
      nextActions: uniqueStrings(nextActions),
    },
  };
}

function brokenLifecycleItem(args: {
  almanacId: string;
  almanacDir: string;
  issue: string;
  nextAction: string;
}): LifecycleInventoryItem {
  return {
    almanacId: args.almanacId,
    almanacDir: args.almanacDir,
    displayName: args.almanacId,
    manifest: null,
    lifecycle: {
      status: "broken",
      compile: {
        status: "missing",
        completed: 0,
        failed: [],
        pending: [],
        running: [],
        skipped: 0,
        error: args.issue,
      },
      knowledge: {
        status: "missing",
        facts: null,
        tools: null,
        manifestFacts: null,
        manifestTools: null,
        countsMatch: null,
        toolsReadable: false,
        retrieval: null,
      },
      benchmark: {
        status: "missing",
        positiveFixtures: null,
        negativeFixtures: null,
        total: null,
        passed: null,
        failed: null,
        errored: null,
        citationRate: null,
      },
      answer: {
        status: "unknown",
        fixtures: null,
        latestSuite: null,
        qualityGate: null,
      },
      refresh: {
        status: "unknown",
        recommendedFromStage: null,
        reasons: null,
        nextDueAt: null,
      },
      registration: {
        status: "unsupported",
        clients: [],
      },
      issues: [args.issue],
      nextActions: [args.nextAction],
    },
  };
}

async function readLifecycleBenchmark(args: {
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState | null;
  issues: string[];
  nextActions: string[];
  rootSuffix: string;
}): Promise<LifecycleInventoryItem["lifecycle"]["benchmark"]> {
  let set: BenchmarkSet | null = null;
  let report: BenchmarkReport | null = null;
  try {
    set = await readBenchmarkSetIfPresent(args.almanacDir, args.manifest.almanacId);
    report = await readBenchmarkReportIfPresent(args.almanacDir);
  } catch (e) {
    const issue = `benchmark artifacts unreadable: ${unknownErrorMessage(e)}`;
    args.issues.push(issue);
    return emptyLifecycleBenchmark("unreadable", issue);
  }

  if (set === null) {
    args.issues.push("benchmark fixtures missing");
    args.nextActions.push(
      `create benchmark fixtures: almanac benchmark ${args.manifest.almanacId} --init${args.rootSuffix}`,
    );
    return emptyLifecycleBenchmark("missing");
  }

  if (report === null) {
    args.issues.push("benchmark has not been run");
    args.nextActions.push(
      `run benchmark: almanac benchmark ${args.manifest.almanacId}${args.rootSuffix}`,
    );
    return {
      status: "not-run",
      positiveFixtures: set.positive.length,
      negativeFixtures: set.negative.length,
      total: null,
      passed: null,
      failed: null,
      errored: null,
      citationRate: null,
    };
  }

  const coverage =
    args.state === null
      ? null
      : benchmarkCoverageGate(args.almanacDir, args.state, set);
  const issue =
    report.summary.failed > 0 || report.summary.errored > 0
      ? `benchmark has ${report.summary.failed} failed and ${report.summary.errored} errored fixture(s)`
      : coverage?.issue ?? null;
  if (issue !== null) {
    args.issues.push(issue);
    args.nextActions.push(
      `rerun benchmark: almanac benchmark ${args.manifest.almanacId}${args.rootSuffix}`,
    );
  }

  return {
    status:
      report.summary.failed > 0 || report.summary.errored > 0
        ? "failed"
        : coverage?.issue !== null && coverage?.issue !== undefined
          ? "needs-validation"
          : "passed",
    positiveFixtures: set.positive.length,
    negativeFixtures: set.negative.length,
    total: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    errored: report.summary.errored,
    citationRate: report.summary.citationRate,
    ...(issue === null ? {} : { issue }),
  };
}

function emptyLifecycleBenchmark(
  status: "missing" | "unreadable",
  issue?: string,
): LifecycleInventoryItem["lifecycle"]["benchmark"] {
  return {
    status,
    positiveFixtures: null,
    negativeFixtures: null,
    total: null,
    passed: null,
    failed: null,
    errored: null,
    citationRate: null,
    ...(issue === undefined ? {} : { issue }),
  };
}

async function readLifecycleAnswer(args: {
  almanacDir: string;
  manifest: AlmanacManifest;
  issues: string[];
  nextActions: string[];
  rootSuffix: string;
}): Promise<LifecycleInventoryItem["lifecycle"]["answer"]> {
  try {
    const readiness = await getAnswerReadiness({ almanacDir: args.almanacDir });
    const answerIssues = [
      ...readiness.issues.blocking,
      ...readiness.issues.validation,
    ];
    if (readiness.status !== "ready") {
      args.issues.push(`answer mode ${readiness.status}`);
      args.nextActions.push(
        ...answerReadinessNextActions(
          args.manifest.almanacId,
          args.rootSuffix,
          readiness,
        ),
      );
    }
    return {
      status: readiness.status,
      fixtures: readiness.fixtures.count,
      latestSuite: readiness.latestSuite.status,
      qualityGate: readiness.qualityGate.status,
      ...(answerIssues.length === 0 ? {} : { issue: answerIssues.join("; ") }),
    };
  } catch (e) {
    const issue = `answer readiness unreadable: ${unknownErrorMessage(e)}`;
    args.issues.push(issue);
    return {
      status: "unknown",
      fixtures: null,
      latestSuite: null,
      qualityGate: null,
      issue,
    };
  }
}

async function readLifecycleRefresh(args: {
  almanacDir: string;
  manifest: AlmanacManifest;
  issues: string[];
  nextActions: string[];
  rootSuffix: string;
}): Promise<LifecycleInventoryItem["lifecycle"]["refresh"]> {
  try {
    const status = await getRefreshDueStatus({ almanacDir: args.almanacDir });
    if (status.due) {
      args.issues.push(`refresh due: ${status.reasons.length} reason(s)`);
      args.nextActions.push(
        `run refresh: almanac refresh run ${args.manifest.almanacId} --from-stage ${status.recommendedFromStage} --save${args.rootSuffix}`,
      );
    }
    return {
      status: status.due ? "due" : "not-due",
      recommendedFromStage: status.recommendedFromStage,
      reasons: status.reasons.length,
      nextDueAt: status.sources.nextDueAt,
    };
  } catch (e) {
    const issue = `refresh status unavailable: ${unknownErrorMessage(e)}`;
    args.issues.push(issue);
    return {
      status: "unknown",
      recommendedFromStage: null,
      reasons: null,
      nextDueAt: null,
      issue,
    };
  }
}

async function readLifecycleRegistration(args: {
  almanacDir: string;
  manifest: AlmanacManifest;
  root: string;
}): Promise<LifecycleRegistrationSummary> {
  const clients = await Promise.all(
    Object.values(CLIENT_PROFILES).map((profile) =>
      readRegistrationClientState({
        almanacDir: args.almanacDir,
        manifest: args.manifest,
        root: args.root,
        profile,
        target: "both",
      }),
    ),
  );
  return {
    status: aggregateRegistrationStatus(clients),
    clients,
  };
}

async function readRegistrationClientState(args: {
  almanacDir: string;
  manifest: AlmanacManifest;
  root: string;
  profile: ClientProfile;
  target: RegisterTarget;
  skillsDir?: string | null;
  mcpConfigPath?: string;
}): Promise<RegistrationClientState> {
  const skillsDir = args.skillsDir ?? args.profile.skillsDir;
  const mcpConfigPath = args.mcpConfigPath ?? args.profile.mcpConfigPath;
  const serverName = mcpServerName(args.manifest.almanacId);
  const expected = expectedMcpEntry(args.manifest.almanacId, args.root);
  const rootSuffix = rootArg(args.root);
  const skill =
    args.target === "mcp"
      ? unsupportedRegistrationComponent("target mcp skips skill")
      : await readSkillRegistrationState({
          almanacDir: args.almanacDir,
          almanacId: args.manifest.almanacId,
          skillsDir,
        });
  const mcp =
    args.target === "skill"
      ? {
          ...unsupportedRegistrationComponent("target skill skips mcp"),
          serverName,
          expected,
          actual: null,
        }
      : await readMcpRegistrationState({
          profile: args.profile,
          mcpConfigPath,
          serverName,
          expected,
        });
  const status = registrationClientOverall(args.target, skill.status, mcp.status);
  const nextActions = registrationRepairActions({
    almanacId: args.manifest.almanacId,
    client: args.profile.name,
    target: args.target,
    rootSuffix,
    skill,
    mcp,
    skillsDirOverride:
      args.skillsDir === undefined || args.skillsDir === args.profile.skillsDir
        ? undefined
        : args.skillsDir,
    mcpConfigOverride:
      args.mcpConfigPath === undefined ||
      args.mcpConfigPath === args.profile.mcpConfigPath
        ? undefined
        : args.mcpConfigPath,
  });
  return {
    client: args.profile.name,
    status,
    skill,
    mcp,
    nextActions,
  };
}

function unsupportedRegistrationComponent(
  reason: string,
): RegistrationComponentState {
  return {
    status: "unsupported",
    path: null,
    issues: [reason],
  };
}

async function readSkillRegistrationState(args: {
  almanacDir: string;
  almanacId: string;
  skillsDir: string | null;
}): Promise<RegistrationComponentState> {
  if (args.skillsDir === null) {
    return unsupportedRegistrationComponent("client has no skills concept");
  }
  const srcPath = join(args.almanacDir, "adapters", "skill", "SKILL.md");
  const destPath = join(args.skillsDir, `almanac-${args.almanacId}`, "SKILL.md");
  if (!existsSync(srcPath)) {
    return {
      status: "missing",
      path: destPath,
      issues: [`source SKILL.md missing at ${srcPath}`],
    };
  }
  if (!existsSync(destPath)) {
    return {
      status: "missing",
      path: destPath,
      issues: [`skill not installed at ${destPath}`],
    };
  }
  try {
    const [src, dest] = await Promise.all([
      readFile(srcPath, "utf8"),
      readFile(destPath, "utf8"),
    ]);
    if (src === dest) {
      return {
        status: "current",
        path: destPath,
        issues: [],
      };
    }
    return {
      status: "stale",
      path: destPath,
      issues: [`installed skill differs from ${srcPath}`],
    };
  } catch (e) {
    return {
      status: "unreadable",
      path: destPath,
      issues: [`skill unreadable: ${unknownErrorMessage(e)}`],
    };
  }
}

async function readMcpRegistrationState(args: {
  profile: ClientProfile;
  mcpConfigPath: string;
  serverName: string;
  expected: McpServerEntry;
}): Promise<RegistrationClientState["mcp"]> {
  if (!existsSync(args.mcpConfigPath)) {
    return {
      status: "missing",
      path: args.mcpConfigPath,
      issues: [`MCP config missing at ${args.mcpConfigPath}`],
      serverName: args.serverName,
      expected: args.expected,
      actual: null,
    };
  }
  let config: Record<string, unknown>;
  try {
    config = parseMcpConfig(
      await readFile(args.mcpConfigPath, "utf8"),
      args.profile.format,
    );
  } catch (e) {
    return {
      status: "unreadable",
      path: args.mcpConfigPath,
      issues: [
        `MCP config at ${args.mcpConfigPath} is not valid ${args.profile.format.toUpperCase()}: ${unknownErrorMessage(e)}`,
      ],
      serverName: args.serverName,
      expected: args.expected,
      actual: null,
    };
  }
  const servers = config[args.profile.mcpServersKey];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return {
      status: "missing",
      path: args.mcpConfigPath,
      issues: [`${args.profile.mcpServersKey} table missing or invalid`],
      serverName: args.serverName,
      expected: args.expected,
      actual: null,
    };
  }
  const actual = (servers as Record<string, unknown>)[args.serverName];
  if (actual === undefined) {
    return {
      status: "missing",
      path: args.mcpConfigPath,
      issues: [
        `MCP server entry missing at ${args.profile.mcpServersKey}["${args.serverName}"]`,
      ],
      serverName: args.serverName,
      expected: args.expected,
      actual: null,
    };
  }
  const issues = mcpEntryIssues(actual, args.expected);
  return {
    status: issues.length === 0 ? "current" : "mismatched",
    path: args.mcpConfigPath,
    issues,
    serverName: args.serverName,
    expected: args.expected,
    actual,
  };
}

function expectedMcpEntry(almanacId: string, root: string): McpServerEntry {
  return {
    command: "bun",
    args: ["run", selfCliPath(), "serve", almanacId, "--root", resolve(root)],
  };
}

function mcpEntryIssues(actual: unknown, expected: McpServerEntry): string[] {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return [`MCP entry is not an object`];
  }
  const entry = actual as Record<string, unknown>;
  const issues: string[] = [];
  if (entry.command !== expected.command) {
    issues.push(
      `command mismatch: expected ${expected.command}, got ${String(entry.command)}`,
    );
  }
  if (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")) {
    issues.push("args mismatch: expected a string array");
    return issues;
  }
  const actualArgs = entry.args;
  if (actualArgs[1] !== expected.args[1]) {
    issues.push(
      `CLI path mismatch: expected ${expected.args[1]}, got ${actualArgs[1] ?? "(missing)"}`,
    );
  }
  if (actualArgs[3] !== expected.args[3]) {
    issues.push(
      `almanac id mismatch: expected ${expected.args[3]}, got ${actualArgs[3] ?? "(missing)"}`,
    );
  }
  if (actualArgs[5] !== expected.args[5]) {
    issues.push(
      `root path mismatch: expected ${expected.args[5]}, got ${actualArgs[5] ?? "(missing)"}`,
    );
  }
  if (
    issues.length === 0 &&
    JSON.stringify(actualArgs) !== JSON.stringify(expected.args)
  ) {
    issues.push(
      `args mismatch: expected ${JSON.stringify(expected.args)}, got ${JSON.stringify(actualArgs)}`,
    );
  }
  return issues;
}

function registrationClientOverall(
  target: RegisterTarget,
  skill: RegistrationComponentStatus,
  mcp: RegistrationComponentStatus,
): RegistrationOverallStatus {
  const statuses = [
    ...(target === "mcp" ? [] : [skill]),
    ...(target === "skill" ? [] : [mcp]),
  ].filter((status) => status !== "unsupported");
  if (statuses.length === 0) return "unsupported";
  if (statuses.includes("unreadable")) return "unreadable";
  if (statuses.includes("stale") || statuses.includes("mismatched")) return "stale";
  if (statuses.includes("missing")) return "missing";
  return "current";
}

function aggregateRegistrationStatus(
  clients: RegistrationClientState[],
): RegistrationOverallStatus {
  const statuses = clients
    .map((client) => client.status)
    .filter((status) => status !== "unsupported");
  if (statuses.length === 0) return "unsupported";
  if (statuses.includes("unreadable")) return "unreadable";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("current")) return "current";
  return "missing";
}

function registrationRepairActions(args: {
  almanacId: string;
  client: RegisterClient;
  target: RegisterTarget;
  rootSuffix: string;
  skill: RegistrationComponentState;
  mcp: RegistrationComponentState;
  skillsDirOverride?: string | null;
  mcpConfigOverride?: string;
}): string[] {
  const actions: string[] = [];
  const skillsDir =
    args.skillsDirOverride === undefined || args.skillsDirOverride === null
      ? ""
      : ` --skills-dir ${shellArg(args.skillsDirOverride)}`;
  const mcpConfig =
    args.mcpConfigOverride === undefined
      ? ""
      : ` --mcp-config ${shellArg(args.mcpConfigOverride)}`;
  if (
    args.target !== "mcp" &&
    args.skill.status !== "current" &&
    args.skill.status !== "unsupported"
  ) {
    if (args.skill.issues.some((issue) => issue.startsWith("source SKILL.md missing"))) {
      actions.push(
        `almanac update ${args.almanacId} --from-stage=10-adapter-generation --no-bump${args.rootSuffix}`,
      );
    } else if (args.skill.status !== "unreadable") {
      actions.push(
        `almanac register ${args.almanacId} --client=${args.client} --target=skill --apply${skillsDir}${args.rootSuffix}`,
      );
    }
  }
  if (
    args.target !== "skill" &&
    args.mcp.status !== "current" &&
    args.mcp.status !== "unsupported"
  ) {
    if (args.mcp.status === "unreadable") {
      actions.push(`fix MCP config: ${args.mcp.path}`);
    } else {
      actions.push(
        `almanac register ${args.almanacId} --client=${args.client} --target=mcp --apply${mcpConfig}${args.rootSuffix}`,
      );
    }
  }
  return uniqueStrings(actions);
}

function lifecycleOverallStatus(args: {
  compileStatus: LifecycleCompileStatus;
  knowledgeStatus: LifecycleKnowledgeStatus;
  benchmarkStatus: LifecycleBenchmarkStatus;
  answerStatus: AnswerReadinessStatus | "unknown";
  refreshStatus: LifecycleRefreshStatus;
  issues: string[];
}): LifecycleOverallStatus {
  if (args.compileStatus === "missing" || args.knowledgeStatus === "unreadable") {
    return "broken";
  }
  if (args.compileStatus === "failed" || args.benchmarkStatus === "failed") {
    return "failed";
  }
  if (
    args.issues.length > 0 ||
    args.compileStatus === "attention" ||
    args.knowledgeStatus === "missing" ||
    args.benchmarkStatus !== "passed" ||
    args.answerStatus !== "ready" ||
    args.refreshStatus !== "not-due"
  ) {
    return "attention";
  }
  return "ok";
}

function lifecycleUsability(item: LifecycleInventoryItem): LifecycleUsability {
  const lifecycle = item.lifecycle;
  if (lifecycle.status === "broken") {
    return {
      status: "not-usable",
      reason: lifecycle.issues[0] ?? "almanac artifacts are broken",
    };
  }
  if (lifecycle.compile.status === "failed") {
    return {
      status: "not-usable",
      reason: `compile failed at ${lifecycle.compile.failed.join(", ")}`,
    };
  }
  if (lifecycle.compile.status !== "ok") {
    return {
      status: "not-usable",
      reason: `compile ${lifecycle.compile.status}`,
    };
  }
  if (lifecycle.knowledge.status !== "present") {
    return {
      status: "not-usable",
      reason: `knowledge index ${lifecycle.knowledge.status}`,
    };
  }
  if (
    lifecycle.knowledge.facts === 0 ||
    lifecycle.knowledge.tools === 0 ||
    lifecycle.knowledge.toolsReadable === false
  ) {
    return {
      status: "not-usable",
      reason: "facts or tools are unavailable",
    };
  }
  if (lifecycle.benchmark.status === "failed") {
    return {
      status: "not-usable",
      reason: lifecycle.benchmark.issue ?? "benchmark failed",
    };
  }
  if (
    lifecycle.benchmark.status !== "passed" ||
    lifecycle.answer.status !== "ready"
  ) {
    return {
      status: "limited",
      reason: `benchmark ${lifecycle.benchmark.status}, answer ${lifecycle.answer.status}`,
    };
  }
  return {
    status: "usable",
    reason:
      lifecycle.refresh.status === "due"
        ? "usable, but refresh is due"
        : "compile, knowledge, benchmark, and answer readiness are usable",
  };
}

function compactRunSummary(run: RunToolArtifactSummary | null): string {
  if (run === null) return "none";
  const subject =
    run.kind === "answer"
      ? run.answer ?? run.question ?? run.runId
      : run.toolName ?? run.fromStage ?? run.runId;
  const label = run.label === undefined ? "" : ` label=${run.label}`;
  return `${run.kind} ${run.runId}, ${run.status}, exit=${run.exitCode}, ${run.invokedAt}, ${subject}${label}`;
}

function formatLifecycleBenchmark(
  benchmark: LifecycleInventoryItem["lifecycle"]["benchmark"],
): string {
  if (benchmark.status === "missing" || benchmark.status === "unreadable") {
    return benchmark.issue === undefined
      ? benchmark.status
      : `${benchmark.status} (${benchmark.issue})`;
  }
  if (benchmark.status === "not-run") {
    return `not-run (${benchmark.positiveFixtures} positive / ${benchmark.negativeFixtures} negative fixtures)`;
  }
  const result =
    benchmark.total === null
      ? benchmark.status
      : `${benchmark.status}, ${benchmark.passed}/${benchmark.total} passed`;
  const citation =
    benchmark.citationRate === null
      ? ""
      : `, citationRate ${formatRate(benchmark.citationRate)}`;
  const fixtures =
    benchmark.positiveFixtures === null || benchmark.negativeFixtures === null
      ? ""
      : `, fixtures ${benchmark.positiveFixtures} positive / ${benchmark.negativeFixtures} negative`;
  const issue = benchmark.issue === undefined ? "" : ` (${benchmark.issue})`;
  return `${result}${citation}${fixtures}${issue}`;
}

function formatLifecycleAnswer(
  answer: LifecycleInventoryItem["lifecycle"]["answer"],
): string {
  const parts = [
    answer.status,
    answer.fixtures === null ? null : `${answer.fixtures} fixture(s)`,
    answer.latestSuite === null ? null : `suite=${answer.latestSuite}`,
    answer.qualityGate === null ? null : `quality=${answer.qualityGate}`,
  ].filter((part): part is string => part !== null);
  const issue = answer.issue === undefined ? "" : ` (${answer.issue})`;
  return `${parts.join(", ")}${issue}`;
}

function formatLifecycleRefresh(
  refresh: LifecycleInventoryItem["lifecycle"]["refresh"],
): string {
  const parts = [
    refresh.status,
    refresh.reasons === null ? null : `${refresh.reasons} reason(s)`,
    refresh.recommendedFromStage === null
      ? null
      : `from ${refresh.recommendedFromStage}`,
    refresh.nextDueAt === null ? null : `nextDueAt ${refresh.nextDueAt}`,
  ].filter((part): part is string => part !== null);
  const issue = refresh.issue === undefined ? "" : ` (${refresh.issue})`;
  return `${parts.join(", ")}${issue}`;
}

function formatLifecycleRegistration(
  registration: LifecycleRegistrationSummary,
): string {
  if (registration.clients.length === 0) return registration.status;
  const clients = registration.clients
    .map((client) => `${client.client}=${client.status}`)
    .join(", ");
  return `${registration.status} (${clients})`;
}

function lifecycleCountsDisplay(
  item: LifecycleInventoryItem,
  key: "facts" | "tools",
): string {
  const value = item.lifecycle.knowledge[key];
  if (value === null) return "-";
  const countsMatch = item.lifecycle.knowledge.countsMatch;
  return countsMatch === false ? `${value}*` : String(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cmdList(opts: ListOptions): Promise<void> {
  const items = await readLifecycleInventory(opts.root);
  if (opts.json) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return;
  }
  if (items.length === 0) {
    process.stdout.write(`no almanacs found in ${opts.root}\n`);
    return;
  }
  // Print a compact table.
  const rows = items.map((it) => ({
    id: it.almanacId,
    status: it.lifecycle.status,
    name: it.displayName,
    facts: lifecycleCountsDisplay(it, "facts"),
    tools: lifecycleCountsDisplay(it, "tools"),
    profile: it.manifest?.freshnessProfileId ?? "-",
    compiledAt: it.manifest?.compiledAt ?? "-",
    item: it,
  }));
  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    facts: Math.max(6, ...rows.map((r) => r.facts.length)),
    tools: Math.max(6, ...rows.map((r) => r.tools.length)),
    profile: Math.max(7, ...rows.map((r) => r.profile.length)),
    compiledAt: 24,
  };
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  const header =
    `${pad("ID", widths.id)}  ${pad("STATUS", widths.status)}  ${pad("NAME", widths.name)}  ${pad("FACTS", widths.facts)}  ${pad("TOOLS", widths.tools)}  ${pad("PROFILE", widths.profile)}  ${pad("COMPILED", widths.compiledAt)}`;
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.id, widths.id)}  ${pad(r.status, widths.status)}  ${pad(r.name, widths.name)}  ${pad(r.facts, widths.facts)}  ${pad(r.tools, widths.tools)}  ${pad(r.profile, widths.profile)}  ${pad(r.compiledAt, widths.compiledAt)}\n`,
    );
  }
  const mismatched = rows.filter(
    (r) => r.item.lifecycle.knowledge.countsMatch === false,
  );
  if (mismatched.length > 0) {
    process.stdout.write("\n* shown counts are actual filesystem/index counts; manifest differs:\n");
    for (const r of mismatched) {
      const knowledge = r.item.lifecycle.knowledge;
      process.stdout.write(
        `  ${r.id}: manifest facts/tools ${knowledge.manifestFacts} / ${knowledge.manifestTools}, actual ${knowledge.facts} / ${knowledge.tools}\n`,
      );
    }
  }
  const attention = rows.filter((r) => r.item.lifecycle.status !== "ok");
  if (attention.length > 0) {
    process.stdout.write("\nlifecycle attention:\n");
    for (const r of attention) {
      const issue = r.item.lifecycle.issues[0] ?? "needs review";
      process.stdout.write(
        `  ${r.id}: ${r.item.lifecycle.status} - ${issue}\n`,
      );
    }
  }
}

async function cmdStatus(id: string, opts: StatusOptions): Promise<void> {
  const report = await readAlmanacStatusReport(id, opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `almanac status: ${report.almanacId} (${report.displayName})\n`,
  );
  process.stdout.write(`  status        ${report.status}\n`);
  process.stdout.write(
    `  usability     ${report.usability.status} - ${report.usability.reason}\n`,
  );
  process.stdout.write(`  dir           ${report.almanacDir}\n`);
  if (report.manifest !== null) {
    process.stdout.write(`  domain        ${report.manifest.domain}\n`);
    process.stdout.write(`  version       ${report.manifest.version}\n`);
    process.stdout.write(`  profile       ${report.manifest.freshnessProfileId}\n`);
    process.stdout.write(`  compiled      ${report.manifest.compiledAt}\n`);
  }
  process.stdout.write(
    `  compile       ${report.lifecycle.compile.status}` +
      ` (${report.lifecycle.compile.completed} completed, ` +
      `${report.lifecycle.compile.failed.length} failed, ` +
      `${report.lifecycle.compile.pending.length} pending, ` +
      `${report.lifecycle.compile.running.length} running)\n`,
  );
  process.stdout.write(
    `  knowledge     ${report.lifecycle.knowledge.status}, ` +
      `${report.lifecycle.knowledge.facts ?? "-"} facts, ` +
      `${report.lifecycle.knowledge.tools ?? "-"} tools, ` +
      `retrieval ${report.lifecycle.knowledge.retrieval ?? "unknown"}\n`,
  );
  if (report.lifecycle.knowledge.countsMatch === false) {
    process.stdout.write(
      `  manifest      facts/tools ${report.lifecycle.knowledge.manifestFacts} / ${report.lifecycle.knowledge.manifestTools}\n`,
    );
  }
  process.stdout.write(
    `  benchmark     ${formatLifecycleBenchmark(report.lifecycle.benchmark)}\n`,
  );
  process.stdout.write(
    `  answer        ${formatLifecycleAnswer(report.lifecycle.answer)}\n`,
  );
  process.stdout.write(
    `  refresh       ${formatLifecycleRefresh(report.lifecycle.refresh)}\n`,
  );
  process.stdout.write(
    `  registration  ${formatLifecycleRegistration(report.lifecycle.registration)}\n`,
  );
  if (report.runs.readError === null) {
    process.stdout.write(`  latest run    ${compactRunSummary(report.runs.latest)}\n`);
    process.stdout.write(
      `  latest answer ${compactRunSummary(report.runs.byKind.answer)}\n`,
    );
    process.stdout.write(
      `  latest refresh ${compactRunSummary(report.runs.byKind.refresh)}\n`,
    );
    process.stdout.write(
      `  latest maintenance ${compactRunSummary(report.runs.byKind.maintenance)}\n`,
    );
  } else {
    process.stdout.write(`  saved runs    unreadable: ${report.runs.readError}\n`);
  }

  if (report.lifecycle.issues.length > 0) {
    process.stdout.write(`\nissues:\n`);
    for (const issue of report.lifecycle.issues) {
      process.stdout.write(`  - ${issue}\n`);
    }
  }
  if (report.nextActions.length > 0) {
    process.stdout.write(`\nnext actions:\n`);
    for (const action of report.nextActions) {
      process.stdout.write(`  - ${action}\n`);
    }
  }
}

async function readMaintenanceReport(
  id: string,
  opts: MaintainOptions,
  now = new Date(),
): Promise<MaintenanceReport> {
  const statusReport = await readAlmanacStatusReport(id, opts);
  const rootHygiene = await readRootHygieneReport(opts.root);
  const cleanupCandidates = maintenanceCleanupCandidates(statusReport, rootHygiene);
  const repairs = maintenanceRepairCandidates(statusReport);
  const plan = maintenancePlanSteps(statusReport, cleanupCandidates, opts.root);
  const nextActions = uniqueStrings([
    ...plan
      .filter((step) => step.status === "planned" && step.command !== null)
      .map((step) => step.command!),
    ...repairs
      .map((candidate) => candidate.command)
      .filter((command): command is string => command !== null),
    ...cleanupCandidates
      .map((candidate) => candidate.command)
      .filter((command): command is string => command !== null),
    ...statusReport.nextActions,
  ]);

  return {
    schemaVersion: "0.1.0",
    almanacId: statusReport.almanacId,
    version: statusReport.manifest?.version ?? null,
    root: opts.root,
    almanacDir: statusReport.almanacDir,
    checkedAt: now.toISOString(),
    dryRun: true,
    status: maintenanceOverallStatus(statusReport, repairs),
    usability: statusReport.usability,
    refresh: {
      ...statusReport.lifecycle.refresh,
      due: statusReport.lifecycle.refresh.status === "due",
      latestRun: statusReport.runs.byKind.refresh,
    },
    benchmark: {
      ...statusReport.lifecycle.benchmark,
      planned: maintenanceStepPlanned(plan, "benchmark"),
    },
    answer: {
      ...statusReport.lifecycle.answer,
      planned: maintenanceStepPlanned(plan, "ask-suite"),
      latestRun: statusReport.runs.byKind.answer,
    },
    registration: statusReport.lifecycle.registration,
    artifacts: {
      latestRun: statusReport.runs.latest,
      latestByKind: statusReport.runs.byKind,
      savedRunsReadError: statusReport.runs.readError,
      cleanupCandidates,
    },
    repairs,
    plan,
    issues: statusReport.lifecycle.issues,
    nextActions,
  };
}

function maintenanceCleanupCandidates(
  statusReport: AlmanacStatusReport,
  rootHygiene: RootHygieneReport,
): MaintenanceCleanupCandidate[] {
  const candidates: MaintenanceCleanupCandidate[] = [];
  const savedRuns = rootHygiene.cleanup.savedRunAlmanacs.find(
    (item) => item.almanacId === statusReport.almanacId,
  );
  if (savedRuns !== undefined) {
    candidates.push({
      kind: "saved-runs",
      message: `${savedRuns.runs} saved run artifact(s) can be reviewed for pruning`,
      command: savedRuns.nextAction,
      count: savedRuns.runs,
      paths: [],
    });
  }

  const exportArchives = rootHygiene.cleanup.exportArchives.filter((path) =>
    path.includes(`almanac-${statusReport.almanacId}-`) ||
    path.includes(statusReport.almanacId)
  );
  if (exportArchives.length > 0) {
    candidates.push({
      kind: "export-archive",
      message: `${exportArchives.length} exported archive(s) are present in the root`,
      command: `review exported archives in ${rootHygiene.root}`,
      count: exportArchives.length,
      paths: exportArchives,
    });
  }

  return candidates;
}

function maintenanceRepairCandidates(
  statusReport: AlmanacStatusReport,
): MaintenanceRepairCandidate[] {
  const lifecycle = statusReport.lifecycle;
  const candidates: MaintenanceRepairCandidate[] = [];
  if (statusReport.status === "broken") {
    candidates.push({
      kind: "broken-directory",
      message: lifecycle.issues[0] ?? "almanac directory is broken",
      command: lifecycle.nextActions[0] ?? null,
      risk: "medium",
      applyRequired: false,
    });
    return candidates;
  }

  if (lifecycle.compile.status === "failed") {
    candidates.push({
      kind: "compile",
      message: `compile failed at ${lifecycle.compile.failed.join(", ")}`,
      command: firstActionContaining(lifecycle.nextActions, "almanac update"),
      risk: "medium",
      applyRequired: false,
    });
  } else if (lifecycle.compile.status === "attention") {
    candidates.push({
      kind: "compile",
      message: `compile requires attention (${[
        ...lifecycle.compile.pending,
        ...lifecycle.compile.running,
      ].join(", ")})`,
      command: firstActionContaining(lifecycle.nextActions, "almanac update"),
      risk: "medium",
      applyRequired: false,
    });
  }

  if (
    lifecycle.knowledge.status === "missing" ||
    lifecycle.knowledge.status === "unreadable"
  ) {
    candidates.push({
      kind: "knowledge",
      message: `knowledge index ${lifecycle.knowledge.status}`,
      command: firstActionContaining(lifecycle.nextActions, "08-knowledge-index"),
      risk: "medium",
      applyRequired: false,
    });
  }

  for (const client of lifecycle.registration.clients) {
    if (client.status !== "stale" && client.status !== "unreadable") continue;
    const command = client.nextActions[0] ?? null;
    candidates.push({
      kind: "registration",
      message: `${client.client} registration is ${client.status}`,
      command,
      risk: "low",
      applyRequired: command?.includes("--apply") ?? false,
    });
  }

  if (statusReport.runs.readError !== null) {
    candidates.push({
      kind: "runs",
      message: `saved runs unreadable: ${statusReport.runs.readError}`,
      command: `inspect runs directory: ${join(statusReport.almanacDir, ".runs")}`,
      risk: "low",
      applyRequired: false,
    });
  }

  return candidates;
}

function maintenancePlanSteps(
  statusReport: AlmanacStatusReport,
  cleanupCandidates: MaintenanceCleanupCandidate[],
  root: string,
): MaintenancePlanStep[] {
  const rootSuffix = rootArg(root);
  return [
    maintenanceRefreshStep(statusReport, rootSuffix),
    maintenanceBenchmarkStep(statusReport, rootSuffix),
    maintenanceAskSuiteStep(statusReport, rootSuffix),
    maintenanceCleanupStep(cleanupCandidates),
  ];
}

function maintenanceRefreshStep(
  statusReport: AlmanacStatusReport,
  rootSuffix: string,
): MaintenancePlanStep {
  const refresh = statusReport.lifecycle.refresh;
  if (statusReport.status === "broken") {
    return blockedMaintenanceStep(
      "refresh",
      "almanac artifacts are broken",
    );
  }
  if (refresh.status === "unknown" || refresh.recommendedFromStage === null) {
    return blockedMaintenanceStep(
      "refresh",
      refresh.issue ?? "refresh status is unavailable",
    );
  }
  if (refresh.status !== "due") {
    return {
      id: "refresh",
      status: "skipped",
      reason: refresh.nextDueAt === null
        ? "refresh is not due"
        : `refresh is not due until ${refresh.nextDueAt}`,
      command: null,
      providerRequired: false,
      expectedArtifact: null,
    };
  }
  return {
    id: "refresh",
    status: "planned",
    reason: `${refresh.reasons ?? 0} refresh reason(s)`,
    command:
      `almanac refresh run ${statusReport.almanacId} --from-stage ${refresh.recommendedFromStage} --save${rootSuffix}`,
    providerRequired: refresh.recommendedFromStage !== "12-benchmark-run",
    expectedArtifact: ".runs/refresh-*.json",
  };
}

function maintenanceBenchmarkStep(
  statusReport: AlmanacStatusReport,
  rootSuffix: string,
): MaintenancePlanStep {
  const benchmark = statusReport.lifecycle.benchmark;
  if (statusReport.status === "broken") {
    return blockedMaintenanceStep(
      "benchmark",
      "almanac artifacts are broken",
    );
  }
  if (benchmark.status === "passed") {
    return {
      id: "benchmark",
      status: "skipped",
      reason: "benchmark is already passed",
      command: null,
      providerRequired: false,
      expectedArtifact: null,
    };
  }
  if (benchmark.status === "unreadable") {
    return blockedMaintenanceStep(
      "benchmark",
      benchmark.issue ?? "benchmark artifacts are unreadable",
    );
  }
  if (benchmark.status === "missing") {
    return {
      id: "benchmark",
      status: "planned",
      reason: "benchmark fixtures are missing",
      command: `almanac benchmark ${statusReport.almanacId} --init${rootSuffix}`,
      providerRequired: false,
      expectedArtifact: "tests/{positive,negative}.jsonl",
    };
  }
  return {
    id: "benchmark",
    status: "planned",
    reason: benchmark.issue ?? `benchmark is ${benchmark.status}`,
    command: `almanac benchmark ${statusReport.almanacId}${rootSuffix}`,
    providerRequired: false,
    expectedArtifact: ".compile/benchmark-result.json",
  };
}

function maintenanceAskSuiteStep(
  statusReport: AlmanacStatusReport,
  rootSuffix: string,
): MaintenancePlanStep {
  const answer = statusReport.lifecycle.answer;
  if (statusReport.status === "broken" || answer.status === "unknown") {
    return blockedMaintenanceStep(
      "ask-suite",
      answer.issue ?? "answer readiness is unavailable",
    );
  }
  if (answer.status === "ready") {
    return {
      id: "ask-suite",
      status: "skipped",
      reason: "answer readiness is already ready",
      command: null,
      providerRequired: false,
      expectedArtifact: null,
    };
  }
  if (answer.fixtures === 0) {
    return {
      id: "ask-suite",
      status: "planned",
      reason: "ask replay fixtures are missing",
      command: `almanac ask-fixtures init ${statusReport.almanacId}${rootSuffix}`,
      providerRequired: false,
      expectedArtifact: "tests/ask.jsonl",
    };
  }
  if (answer.latestSuite !== "passed") {
    return {
      id: "ask-suite",
      status: "planned",
      reason: answer.issue ?? `ask suite is ${answer.latestSuite}`,
      command: `almanac ask-suite ${statusReport.almanacId}${rootSuffix}`,
      providerRequired: false,
      expectedArtifact: null,
    };
  }
  if (answer.qualityGate !== "pass") {
    const latestAnswer = statusReport.runs.byKind.answer;
    return {
      id: "ask-suite",
      status: "planned",
      reason: answer.issue ?? `latest answer quality is ${answer.qualityGate}`,
      command:
        latestAnswer === null
          ? `almanac ask ${statusReport.almanacId} "<question>" --save${rootSuffix}`
          : `almanac runs ${statusReport.almanacId} ${latestAnswer.runId}${rootSuffix}`,
      providerRequired: latestAnswer === null,
      expectedArtifact: latestAnswer === null ? ".runs/answer-*.json" : null,
    };
  }
  return blockedMaintenanceStep(
    "ask-suite",
    answer.issue ?? `answer readiness is ${answer.status}`,
  );
}

function maintenanceCleanupStep(
  cleanupCandidates: MaintenanceCleanupCandidate[],
): MaintenancePlanStep {
  if (cleanupCandidates.length === 0) {
    return {
      id: "cleanup",
      status: "skipped",
      reason: "no cleanup candidates",
      command: null,
      providerRequired: false,
      expectedArtifact: null,
    };
  }
  return {
    id: "cleanup",
    status: "planned",
    reason: `${cleanupCandidates.length} cleanup candidate(s)`,
    command: cleanupCandidates[0]?.command ?? null,
    providerRequired: false,
    expectedArtifact: null,
  };
}

function blockedMaintenanceStep(
  id: MaintenancePlanStep["id"],
  reason: string,
): MaintenancePlanStep {
  return {
    id,
    status: "blocked",
    reason,
    command: null,
    providerRequired: false,
    expectedArtifact: null,
  };
}

function maintenanceOverallStatus(
  statusReport: AlmanacStatusReport,
  repairs: MaintenanceRepairCandidate[],
): MaintenanceStatus {
  if (statusReport.status === "broken") return "broken";
  if (
    statusReport.lifecycle.compile.status !== "ok" ||
    statusReport.lifecycle.knowledge.status === "unreadable"
  ) {
    return "blocked";
  }
  if (repairs.length > 0) return "repairable";
  if (statusReport.lifecycle.refresh.status === "due") return "due";
  if (
    statusReport.lifecycle.benchmark.status !== "passed" ||
    statusReport.lifecycle.answer.status !== "ready"
  ) {
    return "needs-validation";
  }
  return "ready";
}

function maintenanceStepPlanned(
  plan: MaintenancePlanStep[],
  id: MaintenancePlanStep["id"],
): boolean {
  return plan.some((step) => step.id === id && step.status === "planned");
}

function firstActionContaining(
  actions: string[],
  needle: string,
): string | null {
  return actions.find((action) => action.includes(needle)) ?? null;
}

function formatMaintenanceReportHuman(report: MaintenanceReport): string {
  const lines = [
    `maintenance: ${report.almanacId} (${report.version ?? "unknown"})`,
    `  status        ${report.status}`,
    `  dry-run       ${report.dryRun ? "yes" : "no"}`,
    `  usability     ${report.usability.status} - ${report.usability.reason}`,
    `  dir           ${report.almanacDir}`,
    `  refresh       ${formatLifecycleRefresh(report.refresh)}`,
    `  benchmark     ${formatLifecycleBenchmark(report.benchmark)}`,
    `  answer        ${formatLifecycleAnswer(report.answer)}`,
    `  registration  ${formatLifecycleRegistration(report.registration)}`,
    `  latest run    ${compactRunSummary(report.artifacts.latestRun)}`,
    "",
    "plan:",
  ];
  for (const step of report.plan) {
    const provider = step.providerRequired ? ", provider required" : "";
    const artifact =
      step.expectedArtifact === null ? "" : `, artifact ${step.expectedArtifact}`;
    lines.push(`  - ${step.status} ${step.id}: ${step.reason}${provider}${artifact}`);
    if (step.command !== null) {
      lines.push(`    ${step.command}`);
    }
  }

  lines.push("", "repairs:");
  if (report.repairs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const repair of report.repairs) {
      const apply = repair.applyRequired ? ", requires --apply" : "";
      lines.push(`  - ${repair.kind} (${repair.risk}${apply}): ${repair.message}`);
      if (repair.command !== null) {
        lines.push(`    ${repair.command}`);
      }
    }
  }

  lines.push("", "cleanup:");
  if (report.artifacts.cleanupCandidates.length === 0) {
    lines.push("  (none)");
  } else {
    for (const cleanup of report.artifacts.cleanupCandidates) {
      lines.push(`  - ${cleanup.kind}: ${cleanup.message}`);
      if (cleanup.command !== null) {
        lines.push(`    ${cleanup.command}`);
      }
      for (const path of cleanup.paths) {
        lines.push(`    ${path}`);
      }
    }
  }

  if (report.issues.length > 0) {
    lines.push("", "issues:");
    for (const issue of report.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  if (report.nextActions.length > 0) {
    lines.push("", "next actions:");
    for (const action of report.nextActions) {
      lines.push(`  - ${action}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function cmdMaintain(
  id: string | undefined,
  opts: MaintainOptions,
): Promise<void> {
  validateMaintainOptions(id, opts);
  if (opts.all === true) {
    const result = await runMaintainAll(opts);
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(result, null, 2) + "\n"
        : formatMaintenanceBatchHuman(result),
    );
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  const almanacId = id!;
  if (opts.apply === true) {
    const result = await applyMaintenanceForId(almanacId, opts);
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(result, null, 2) + "\n"
        : formatMaintenanceApplyHuman(result),
    );
    process.exitCode = result.exitCode;
    return;
  }

  const report = await readMaintenanceReport(almanacId, opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatMaintenanceReportHuman(report));
}

function validateMaintainOptions(
  id: string | undefined,
  opts: MaintainOptions,
): void {
  if (opts.all === true && id !== undefined) {
    maintainUsageError("<id> cannot be combined with --all");
  }
  if (opts.all !== true && id === undefined) {
    maintainUsageError("provide <id> or pass --all");
  }
  if (opts.apply === true && opts.dryRun === true) {
    maintainUsageError("--apply and --dry-run are mutually exclusive");
  }
  if (
    opts.all === true &&
    opts.apply === true &&
    opts.dueOnly !== true
  ) {
    maintainUsageError("--all --apply requires --due-only");
  }
  if (
    opts.apply !== true &&
    (opts.label !== undefined || opts.note !== undefined)
  ) {
    maintainUsageError("--label and --note require --apply");
  }
}

async function runMaintainAll(
  opts: MaintainOptions,
): Promise<MaintenanceBatchResult> {
  const items = await readLifecycleInventory(opts.root);
  const results: MaintenanceBatchEntry[] = [];
  for (const item of items) {
    const report = await readMaintenanceReport(item.almanacId, opts);
    if (opts.dueOnly === true && !maintenanceReportIsDue(report)) {
      results.push({
        almanacId: item.almanacId,
        status: "skipped",
        reason: "not due",
        report,
      });
      continue;
    }
    if (opts.apply === true) {
      const result = await applyMaintenanceForId(item.almanacId, opts, report);
      results.push({
        almanacId: item.almanacId,
        status: result.exitCode === 0 ? "applied" : "failed",
        reason: result.error?.message ?? result.status,
        result,
      });
    } else {
      results.push({
        almanacId: item.almanacId,
        status: "skipped",
        reason: "dry-run",
        report,
      });
    }
  }
  return {
    schemaVersion: "0.1.0",
    mode: opts.apply === true ? "apply" : "dry-run",
    root: opts.root,
    dueOnly: opts.dueOnly === true,
    total: results.length,
    applied: results.filter((entry) => entry.status === "applied").length,
    skipped: results.filter((entry) => entry.status === "skipped").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    results,
  };
}

async function applyMaintenanceForId(
  id: string,
  opts: MaintainOptions,
  precomputedReport?: MaintenanceReport,
): Promise<MaintenanceApplyResult> {
  const reportBefore = precomputedReport ?? await readMaintenanceReport(id, opts);
  const started = new Date();
  const startedAt = started.toISOString();
  const maintenanceId = generateMaintenanceRunId(startedAt);
  const steps: MaintenanceStepResult[] = [];
  let refreshResult: Awaited<ReturnType<typeof runRefresh>> | null = null;
  let reportAfter: MaintenanceReport | null = null;
  let error: MaintenanceApplyResult["error"];
  const refreshStep = reportBefore.plan.find((step) => step.id === "refresh");
  const { runners, providerAvailable } = buildRunners();

  if (opts.dueOnly === true && !maintenanceReportIsDue(reportBefore)) {
    steps.push(
      maintenanceStepResult(
        refreshStep ?? blockedMaintenanceStep("refresh", "refresh status unavailable"),
        "not-due",
        "due-only skipped because refresh is not due",
      ),
    );
    const finishedAt = new Date().toISOString();
    return {
      schemaVersion: "0.1.0",
      mode: "apply",
      almanacId: reportBefore.almanacId,
      version: reportBefore.version,
      root: opts.root,
      almanacDir: reportBefore.almanacDir,
      startedAt,
      finishedAt,
      durationMs: elapsedMs(startedAt, finishedAt),
      dueOnly: true,
      status: "skipped",
      exitCode: 0,
      reportBefore,
      reportAfter: reportBefore,
      steps,
      refresh: null,
      benchmark: null,
      savedArtifact: null,
      nextActions: reportBefore.nextActions,
    };
  }

  try {
    if (refreshStep?.status === "planned") {
      if (refreshStep.providerRequired && !providerAvailable) {
        error = {
          code: "provider-required",
          message:
            "selected maintenance refresh starts before provider-backed stages; set ANTHROPIC_API_KEY or rerun after narrowing the plan",
        };
        steps.push(maintenanceStepResult(refreshStep, "blocked", error.message, {
          error,
        }));
      } else {
        refreshResult = await runRefresh({
          almanacDir: reportBefore.almanacDir,
          ...(reportBefore.refresh.recommendedFromStage === null
            ? {}
            : { fromStage: reportBefore.refresh.recommendedFromStage }),
          runners,
          forgerVersion: FORGER_VERSION,
          persistManifest: (manifest) =>
            writeManifestWithActualCounts(reportBefore.almanacDir, manifest),
          save: true,
          label: normalizeMaintenanceLabel(opts.label ?? "maintenance"),
          ...(opts.note === undefined
            ? {}
            : { note: normalizeMaintenanceNote(opts.note) }),
        });
        steps.push(
          maintenanceStepResult(
            refreshStep,
            maintenanceStepStatusFromRefresh(refreshResult.status),
            `refresh ${refreshResult.status}`,
            {
              artifactRelPath: refreshResult.savedArtifact?.relPath,
              exitCode: refreshResult.exitCode,
              error: refreshResult.error,
            },
          ),
        );
      }
    } else if (refreshStep !== undefined) {
      steps.push(maintenanceStepResult(refreshStep, "skipped", refreshStep.reason));
    }

    const benchmarkStep = reportBefore.plan.find((step) => step.id === "benchmark");
    if (benchmarkStep !== undefined) {
      if (refreshResult !== null) {
        const benchmarkStatus = refreshResult.benchmark.status;
        steps.push(
          maintenanceStepResult(
            benchmarkStep,
            benchmarkStatus === "passed" ? "ok" : "failed",
            `benchmark ${benchmarkStatus}`,
            { exitCode: refreshResult.exitCode },
          ),
        );
      } else {
        steps.push(
          maintenanceStepResult(
            benchmarkStep,
            benchmarkStep.status === "planned" ? "blocked" : "skipped",
            error?.message ?? benchmarkStep.reason,
            error === undefined ? {} : { error },
          ),
        );
      }
    }

    for (const step of reportBefore.plan.filter(
      (step) => step.id !== "refresh" && step.id !== "benchmark",
    )) {
      steps.push(
        maintenanceStepResult(
          step,
          step.status === "planned" ? "skipped" : step.status,
          step.status === "planned"
            ? "not applied by the due-only maintenance runner"
            : step.reason,
        ),
      );
    }

    reportAfter =
      refreshResult !== null && refreshResult.exitCode === 0
        ? await readMaintenanceReport(id, opts)
        : null;
  } catch (cause) {
    error = {
      code: "maintenance-failed",
      message: unknownErrorMessage(cause),
    };
  }

  const finishedAt = new Date().toISOString();
  const status = maintenanceArtifactStatus({
    error,
    refreshResult,
    steps,
  });
  const exitCode = maintenanceExitCode(status);
  const nextActions = uniqueStrings([
    ...(reportAfter?.nextActions ?? reportBefore.nextActions),
    ...(error === undefined ? [] : reportBefore.nextActions),
  ]);
  const artifact = await saveMaintenanceArtifact({
    almanacDir: reportBefore.almanacDir,
    maintenanceId,
    startedAt,
    finishedAt,
    reportBefore,
    reportAfter,
    status,
    exitCode,
    dueOnly: opts.dueOnly === true,
    steps,
    refreshResult,
    label: normalizeMaintenanceLabel(opts.label ?? "maintenance"),
    ...(opts.note === undefined ? {} : { note: normalizeMaintenanceNote(opts.note) }),
    ...(error === undefined ? {} : { error }),
    nextActions,
  });

  return {
    schemaVersion: "0.1.0",
    mode: "apply",
    almanacId: reportBefore.almanacId,
    version: reportBefore.version,
    root: opts.root,
    almanacDir: reportBefore.almanacDir,
    startedAt,
    finishedAt,
    durationMs: elapsedMs(startedAt, finishedAt),
    dueOnly: opts.dueOnly === true,
    status,
    exitCode,
    reportBefore,
    reportAfter,
    steps,
    refresh:
      refreshResult === null
        ? null
        : {
            status: refreshResult.status,
            refreshId: refreshResult.refreshId,
            ...(refreshResult.savedArtifact === undefined
              ? {}
              : { artifactRelPath: refreshResult.savedArtifact.relPath }),
            exitCode: refreshResult.exitCode,
          },
    benchmark: refreshResult?.benchmark ?? null,
    savedArtifact: {
      path: artifact.path,
      relPath: artifact.relPath,
    },
    ...(error === undefined ? {} : { error }),
    nextActions,
  };
}

function maintenanceReportIsDue(report: MaintenanceReport): boolean {
  return report.refresh.due || report.benchmark.planned;
}

function maintenanceStepResult(
  step: MaintenancePlanStep,
  status: MaintenanceStepResult["status"],
  reason: string,
  extras: Partial<
    Pick<MaintenanceStepResult, "artifactRelPath" | "exitCode" | "error">
  > = {},
): MaintenanceStepResult {
  return {
    id: step.id,
    status,
    reason,
    command: step.command,
    providerRequired: step.providerRequired,
    expectedArtifact: step.expectedArtifact,
    ...extras,
  };
}

function maintenanceStepStatusFromRefresh(
  status: Awaited<ReturnType<typeof runRefresh>>["status"],
): MaintenanceStepResult["status"] {
  if (status === "ok") return "ok";
  if (status === "not-due") return "not-due";
  if (status === "locked") return "locked";
  return "failed";
}

function maintenanceArtifactStatus(args: {
  error?: MaintenanceApplyResult["error"];
  refreshResult: Awaited<ReturnType<typeof runRefresh>> | null;
  steps: MaintenanceStepResult[];
}): MaintenanceArtifactStatus {
  if (args.error !== undefined) return "failed";
  if (args.steps.some((step) => step.status === "locked")) return "locked";
  if (args.steps.some((step) => step.status === "failed" || step.status === "blocked")) {
    return "failed";
  }
  if (args.refreshResult?.status === "not-due") return "not-due";
  if (args.steps.every((step) => step.status === "skipped" || step.status === "not-due")) {
    return "skipped";
  }
  return "ok";
}

function maintenanceExitCode(status: MaintenanceArtifactStatus): RunToolExitCode {
  if (status === "ok" || status === "not-due" || status === "skipped") return 0;
  if (status === "locked") return 2;
  return 1;
}

async function saveMaintenanceArtifact(input: {
  almanacDir: string;
  maintenanceId: string;
  startedAt: string;
  finishedAt: string;
  reportBefore: MaintenanceReport;
  reportAfter: MaintenanceReport | null;
  status: MaintenanceArtifactStatus;
  exitCode: RunToolExitCode;
  dueOnly: boolean;
  steps: MaintenanceStepResult[];
  refreshResult: Awaited<ReturnType<typeof runRefresh>> | null;
  label?: string;
  note?: string;
  error?: MaintenanceApplyResult["error"];
  nextActions: string[];
}): Promise<{ artifact: MaintenanceArtifact; path: string; relPath: string }> {
  const relPath = `.runs/${input.maintenanceId}.json`;
  const path = join(input.almanacDir, relPath);
  const artifact = MaintenanceArtifactSchema.parse({
    schemaVersion: "0.1.0",
    kind: "maintenance",
    artifactRelPath: relPath,
    maintenanceId: input.maintenanceId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    almanacId: input.reportBefore.almanacId,
    version: input.reportBefore.version ?? "0.0.0",
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.note === undefined ? {} : { note: input.note }),
    status: input.status,
    exitCode: input.exitCode,
    dryRun: false,
    dueOnly: input.dueOnly,
    preStatus: input.reportBefore.status,
    ...(input.reportAfter === null ? {} : { postStatus: input.reportAfter.status }),
    ...(input.refreshResult === null
      ? {}
      : {
          refresh: {
            status: input.refreshResult.status,
            refreshId: input.refreshResult.refreshId,
            ...(input.refreshResult.savedArtifact === undefined
              ? {}
              : { artifactRelPath: input.refreshResult.savedArtifact.relPath }),
            exitCode: input.refreshResult.exitCode,
          },
          benchmark: input.refreshResult.benchmark,
        }),
    steps: input.steps,
    nextActions: input.nextActions,
    durationMs: elapsedMs(input.startedAt, input.finishedAt),
    ...(input.error === undefined ? {} : { error: input.error }),
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { artifact, path, relPath };
}

function generateMaintenanceRunId(invokedAt: string): string {
  return `maintain-${invokedAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function normalizeMaintenanceLabel(label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    maintainUsageError("--label must be between 1 and 80 characters");
  }
  return normalized;
}

function normalizeMaintenanceNote(note: string): string {
  const normalized = note.trim();
  if (normalized.length === 0 || normalized.length > 1000) {
    maintainUsageError("--note must be between 1 and 1000 characters");
  }
  return normalized;
}

function maintainUsageError(message: string): never {
  process.stderr.write(`error: maintain: ${message}\n`);
  process.exit(2);
}

function formatMaintenanceApplyHuman(result: MaintenanceApplyResult): string {
  const lines = [
    `maintenance apply: ${result.almanacId} (${result.version ?? "unknown"})`,
    `status: ${result.status}`,
    `exit: ${result.exitCode}`,
    `started: ${result.startedAt}`,
    `finished: ${result.finishedAt}`,
    `duration: ${result.durationMs}ms`,
    `due-only: ${result.dueOnly}`,
  ];
  if (result.refresh !== null) {
    lines.push(
      `refresh: ${result.refresh.status} ${result.refresh.refreshId} exit=${result.refresh.exitCode}`,
    );
    if (result.refresh.artifactRelPath !== undefined) {
      lines.push(`refresh-artifact: ${result.refresh.artifactRelPath}`);
    }
  }
  if (result.benchmark !== null) {
    lines.push(`benchmark: ${result.benchmark?.status ?? "unknown"}`);
  }
  if (result.savedArtifact !== null) {
    lines.push(`artifact: ${result.savedArtifact.path}`);
  }
  lines.push("steps:");
  for (const step of result.steps) {
    const exit = step.exitCode === undefined ? "" : ` exit=${step.exitCode}`;
    const artifact =
      step.artifactRelPath === undefined ? "" : ` artifact=${step.artifactRelPath}`;
    lines.push(`  - ${step.id} ${step.status}${exit}${artifact}: ${step.reason}`);
  }
  if (result.error !== undefined) {
    lines.push(`error: ${result.error.code}: ${result.error.message}`);
  }
  if (result.nextActions.length > 0) {
    lines.push("next actions:");
    for (const action of result.nextActions) {
      lines.push(`  - ${action}`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatMaintenanceBatchHuman(result: MaintenanceBatchResult): string {
  const lines = [
    `maintenance ${result.mode}: root ${result.root}`,
    `due-only: ${result.dueOnly}`,
    `total: ${result.total}`,
    `applied: ${result.applied}`,
    `skipped: ${result.skipped}`,
    `failed: ${result.failed}`,
    "results:",
  ];
  if (result.results.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of result.results) {
      lines.push(`  - ${entry.almanacId} ${entry.status}: ${entry.reason}`);
      if (entry.result?.savedArtifact !== undefined && entry.result.savedArtifact !== null) {
        lines.push(`    ${entry.result.savedArtifact.path}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

interface InspectOptions {
  root: string;
  json?: boolean;
}

async function cmdInspect(id: string, opts: InspectOptions): Promise<void> {
  const dir = almanacDirPath(opts.root, id);
  if (!existsSync(dir)) {
    fail(`almanac not found: ${dir}`);
  }
  const manifest = await readManifest(dir);
  const state = await readCompileState(dir);
  const knowledge = await readKnowledgeIndexManifest(dir);
  const counts = await readDisplayCounts(dir, manifest, knowledge);
  const sources = await readSourcesFileIfPresent(dir);
  const benchmarkSet = await readBenchmarkSetIfPresent(dir, manifest.almanacId);
  const benchmarkReport = await readBenchmarkReportIfPresent(dir);
  const benchmarkCoverage = benchmarkCoverageGate(dir, state, benchmarkSet);
  const refreshRunVisibility = await readRefreshRunVisibility(dir);
  const stageCounts = stageStatusCounts(state);
  const failedStages = (STAGE_IDS as readonly StageId[]).filter(
    (stageId) => state.stages[stageId].status === "failed",
  );
  const runningStages = (STAGE_IDS as readonly StageId[]).filter(
    (stageId) => state.stages[stageId].status === "running",
  );
  const pendingStages = (STAGE_IDS as readonly StageId[]).filter(
    (stageId) => state.stages[stageId].status === "pending",
  );
  const healthIssues: string[] = [];
  if (failedStages.length > 0) {
    healthIssues.push(`failed stages: ${failedStages.join(", ")}`);
  }
  if (runningStages.length > 0) {
    healthIssues.push(`running stages: ${runningStages.join(", ")}`);
  }
  if (sources === null) healthIssues.push("no approved sources file");
  if (knowledge === null) healthIssues.push("knowledge index missing");
  if (benchmarkSet === null) healthIssues.push("benchmark fixtures missing");
  if (benchmarkReport === null) healthIssues.push("benchmark report missing");
  if (benchmarkCoverage.issue !== null) {
    healthIssues.push(benchmarkCoverage.issue);
  }
  if (refreshRunVisibility.issue !== null) {
    healthIssues.push(refreshRunVisibility.issue);
  }
  if (
    benchmarkReport !== null &&
    (benchmarkReport.summary.failed > 0 || benchmarkReport.summary.errored > 0)
  ) {
    healthIssues.push(
      `benchmark has ${benchmarkReport.summary.failed} failed and ${benchmarkReport.summary.errored} errored fixture(s)`,
    );
  }
  if (countsMismatch(counts)) {
    healthIssues.push("manifest counts differ from actual artifacts");
  }
  const health =
    failedStages.length > 0
      ? "failed"
      : healthIssues.length > 0 || pendingStages.length > 0
        ? "attention"
        : "ok";
  const nextActions: string[] = [];
  const rootSuffix = rootArg(opts.root);
  const failureRecovery = buildStageFailureRecovery({
    almanacId: id,
    root: opts.root,
    almanacDir: dir,
    state,
    failedStages,
  });
  if (failedStages.length > 0) {
    nextActions.push(...stageFailureNextActions(failureRecovery));
  }
  if (sources === null) {
    nextActions.push("create or restore sources/sources.json");
  } else {
    nextActions.push(`review sources: almanac sources ${id}${rootSuffix}`);
    nextActions.push(`review expert profile: almanac profile ${id}${rootSuffix}`);
  }
  if (benchmarkSet === null) {
    nextActions.push(
      `create human fixtures: almanac benchmark ${id} --init${rootSuffix}`,
    );
  } else if (benchmarkReport === null) {
    nextActions.push(`run human fixtures: almanac benchmark ${id}${rootSuffix}`);
  } else if (
    benchmarkReport.summary.failed > 0 ||
    benchmarkReport.summary.errored > 0
  ) {
    nextActions.push(`inspect benchmark details: ${benchmarkResultPath(dir)}`);
  } else {
    nextActions.push(`rerun benchmark gate: almanac benchmark ${id}${rootSuffix}`);
  }
  if (health === "ok") {
    nextActions.push(`try MCP server: almanac serve ${id}${rootSuffix}`);
    nextActions.push(
      `register with Claude Code: almanac register ${id} --client=claude-code --apply${rootSuffix}`,
    );
  }
  if (
    refreshRunVisibility.latest !== null &&
    refreshRunVisibility.issue !== null
  ) {
    nextActions.push(
      `inspect latest refresh run: almanac runs ${id} ${refreshRunVisibility.latest.runId}${rootSuffix}`,
    );
    nextActions.push(
      `rerun manual refresh: almanac refresh run ${id} --from-stage ${refreshRunVisibility.latest.fromStage ?? "04-source-fetch"} --save${rootSuffix}`,
    );
  } else if (refreshRunVisibility.readError !== null) {
    nextActions.push(`inspect saved runs: almanac runs ${id}${rootSuffix}`);
  }
  nextActions.push(`diagnose artifacts: almanac doctor ${id}${rootSuffix}`);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          almanacDir: dir,
          manifest,
          state,
          knowledge,
          counts,
          sources,
          benchmarkSet,
          benchmarkReport,
          benchmarkCoverage,
          refresh: refreshRunVisibility,
          health: {
            status: health,
            stageCounts,
            issues: healthIssues,
            nextActions,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(`almanac: ${manifest.almanacId} (${manifest.displayName})\n`);
  process.stdout.write(`  dir            ${dir}\n`);
  process.stdout.write(`  domain         ${manifest.domain}\n`);
  process.stdout.write(`  version        ${manifest.version}\n`);
  process.stdout.write(`  profile        ${manifest.freshnessProfileId}\n`);
  process.stdout.write(`  facts/tools    ${counts.facts} / ${counts.tools}\n`);
  process.stdout.write(
    `  health         ${health}` +
      ` (${stageCounts.completed} completed, ${stageCounts.skipped} skipped, ${stageCounts.failed} failed, ${stageCounts.pending} pending)\n`,
  );
  if (countsMismatch(counts)) {
    process.stdout.write(
      `  manifest       facts/tools ${counts.manifestFacts} / ${counts.manifestTools}\n`,
    );
  }
  if (!counts.toolsReadable) {
    process.stdout.write("  tools          count unavailable; using manifest value\n");
  }
  process.stdout.write(`  bootstrapped   ${manifest.bootstrappedAt}\n`);
  process.stdout.write(`  compiled       ${manifest.compiledAt}\n`);
  process.stdout.write(`  forger         ${manifest.forgerVersion}\n`);
  if (knowledge !== null) {
    process.stdout.write(
      `  knowledge      ${knowledge.factCount} facts, sqlite ${knowledge.sqliteVersion}\n`,
    );
    if (knowledge.vectorIndex !== undefined) {
      process.stdout.write(
        `  vectors        ${formatVectorIndexSummary(knowledge.vectorIndex)}\n`,
      );
    }
  }
  if (sources !== null) {
    process.stdout.write(
      `  sources        ${sources.status}, ${sources.sources.length} accepted / ${sources.rejected.length} rejected (${nonZeroCoverage(sources.coverage)})\n`,
    );
  }
  if (benchmarkSet !== null) {
    process.stdout.write(
      `  fixtures       ${formatBenchmarkFixturesWithCoverage(benchmarkSet, benchmarkCoverage)}\n`,
    );
  }
  if (benchmarkReport !== null) {
    process.stdout.write(
      `  benchmark      ${benchmarkReport.summary.passed}/${benchmarkReport.summary.total} passed, citationRate ${formatRate(benchmarkReport.summary.citationRate)}\n`,
    );
  }
  if (
    refreshRunVisibility.latest !== null ||
    refreshRunVisibility.readError !== null
  ) {
    process.stdout.write(
      `  refresh        ${
        refreshRunVisibility.readError === null
          ? formatRefreshRunVisibility(refreshRunVisibility.latest)
          : `unreadable: ${refreshRunVisibility.readError}`
      }\n`,
    );
  }
  if (healthIssues.length > 0) {
    process.stdout.write(`\nhealth issues:\n`);
    for (const issue of healthIssues) {
      process.stdout.write(`  - ${issue}\n`);
    }
  }
  if (nextActions.length > 0) {
    process.stdout.write(`\nnext actions:\n`);
    for (const action of nextActions) {
      process.stdout.write(`  - ${action}\n`);
    }
  }

  process.stdout.write(`\nstages:\n`);
  for (const stageId of STAGE_IDS as readonly StageId[]) {
    const s = state.stages[stageId];
    const status = s.status.padEnd(9);
    const tail =
      s.status === "completed" && s.outputHash
        ? `  hash=${s.outputHash.slice(0, 12)}…`
        : s.status === "failed" && s.error
          ? `  ${s.error.code}: ${s.error.message}`
          : s.status === "skipped" && s.skipReason
            ? `  (${s.skipReason})`
            : "";
    process.stdout.write(`  ${stageId.padEnd(34)} ${status}${tail}\n`);
  }
}

type ExpertiseStatus = "usable" | "needs-validation" | "not-ready";
const HIGH_TRUST_ZERO_FACT_THRESHOLD = 0.9;
const GENERATED_BENCHMARK_MIN_POSITIVE_FIXTURES =
  STAGE11_MIN_GENERATED_POSITIVE_FIXTURES;
const GENERATED_BENCHMARK_MIN_NEGATIVE_FIXTURES =
  STAGE11_MIN_GENERATED_NEGATIVE_FIXTURES;
const GENERATED_BENCHMARK_MIN_TOTAL_FIXTURES =
  STAGE11_MIN_GENERATED_TOTAL_FIXTURES;

interface ProfileOptions {
  root: string;
  json?: boolean;
}

function countFactsByType(facts: FactRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    fact: 0,
    definition: 0,
    procedure: 0,
    opinion: 0,
    reference: 0,
    principle: 0,
    heuristic: 0,
    tradeoff: 0,
    framework: 0,
  };
  for (const fact of facts) {
    counts[fact.type] = (counts[fact.type] ?? 0) + 1;
  }
  return counts;
}

function countFactsByFreshness(facts: FactRecord[]): Record<string, number> {
  const counts: Record<string, number> = { static: 0, slow: 0 };
  for (const fact of facts) {
    counts[fact.freshnessClass] = (counts[fact.freshnessClass] ?? 0) + 1;
  }
  return counts;
}

function countFactsBySource(facts: FactRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    counts.set(fact.source.sourceId, (counts.get(fact.source.sourceId) ?? 0) + 1);
  }
  return counts;
}

function clipText(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim() ?? "";
}

function listWithRemainder(items: string[], max = 5): string {
  const shown = items.slice(0, max);
  const remainder = items.length - shown.length;
  return remainder > 0 ? `${shown.join(", ")} (+${remainder} more)` : shown.join(", ");
}

async function cmdProfile(id: string, opts: ProfileOptions): Promise<void> {
  const dir = almanacDirPath(opts.root, id);
  if (!existsSync(dir)) {
    fail(`almanac not found: ${dir}`);
  }

  const manifest = await readManifest(dir);
  const state = await readCompileState(dir);
  const knowledge = await readKnowledgeIndexManifest(dir);
  const counts = await readDisplayCounts(dir, manifest, knowledge);
  const domainSpec = await readDomainSpecIfPresent(dir);
  const sources = await readSourcesFileIfPresent(dir);
  const facts = await readFactsJsonlIfPresent(dir);
  const benchmarkSet = await readBenchmarkSetIfPresent(dir, manifest.almanacId);
  const benchmarkReport = await readBenchmarkReportIfPresent(dir);
  const benchmarkCoverage = benchmarkCoverageGate(dir, state, benchmarkSet);
  const refreshRunVisibility = await readRefreshRunVisibility(dir);
  const answerReadiness = await getAnswerReadiness({ almanacDir: dir });
  const embeddingConfig = resolveEmbeddingProviderConfig(process.env);
  const retrieval = getRetrievalReadiness({
    vectorIndex: knowledge?.vectorIndex ?? null,
    embeddingConfig,
  });
  const factsBySource = countFactsBySource(facts);
  const acceptedSources = sources?.sources ?? [];
  const highTrustZeroFactSources = acceptedSources
    .filter(
      (source) =>
        source.trust >= HIGH_TRUST_ZERO_FACT_THRESHOLD &&
        source.ingestion.mode !== "index-only" &&
        (factsBySource.get(source.id) ?? 0) === 0,
    )
    .map((source) => ({
      id: source.id,
      trust: source.trust,
      ingestionMode: source.ingestion.mode,
      kind: source.kind,
      url: source.url,
    }));

  const failedStages = (STAGE_IDS as readonly StageId[]).filter(
    (stageId) => state.stages[stageId].status === "failed",
  );
  const runningStages = (STAGE_IDS as readonly StageId[]).filter(
    (stageId) => state.stages[stageId].status === "running",
  );
  const pendingStages = (STAGE_IDS as readonly StageId[]).filter(
    (stageId) => state.stages[stageId].status === "pending",
  );

  const blockingIssues: string[] = [];
  const validationIssues: string[] = [];
  if (failedStages.length > 0) {
    blockingIssues.push(`failed stages: ${failedStages.join(", ")}`);
  }
  if (runningStages.length > 0) {
    blockingIssues.push(`running stages: ${runningStages.join(", ")}`);
  }
  if (sources === null || sources.sources.length === 0) {
    blockingIssues.push("no approved evidence sources");
  }
  if (knowledge === null) {
    blockingIssues.push("knowledge index missing");
  }
  if (facts.length === 0) {
    blockingIssues.push("no durable facts extracted");
  }
  if (domainSpec === null) {
    validationIssues.push("domain spec missing; capability scope is unavailable");
  }
  if (pendingStages.length > 0) {
    validationIssues.push(`pending stages: ${pendingStages.join(", ")}`);
  }
  if (countsMismatch(counts)) {
    validationIssues.push("manifest counts differ from actual artifacts");
  }
  if (highTrustZeroFactSources.length > 0) {
    validationIssues.push(
      `high-trust accepted sources contribute no facts: ${listWithRemainder(
        highTrustZeroFactSources.map(
          (source) => `${source.id} (${source.ingestionMode})`,
        ),
      )}`,
    );
  }
  if (benchmarkSet === null) {
    validationIssues.push("human benchmark fixtures missing");
  } else if (benchmarkReport === null) {
    validationIssues.push("human benchmark has not been run");
  } else if (
    benchmarkReport.summary.failed > 0 ||
    benchmarkReport.summary.errored > 0
  ) {
    blockingIssues.push(
      `benchmark has ${benchmarkReport.summary.failed} failed and ${benchmarkReport.summary.errored} errored fixture(s)`,
    );
  } else if (benchmarkCoverage.issue !== null) {
    validationIssues.push(benchmarkCoverage.issue);
  } else if (benchmarkReport.summary.citationRate < 1) {
    validationIssues.push("not every positive benchmark result carried citations");
  }
  if (refreshRunVisibility.issue !== null) {
    validationIssues.push(refreshRunVisibility.issue);
  }
  if (retrieval.status === "needs-attention") {
    validationIssues.push(`retrieval ${retrieval.summary}`);
  }

  const status: ExpertiseStatus =
    blockingIssues.length > 0
      ? "not-ready"
      : validationIssues.length > 0
        ? "needs-validation"
        : "usable";

  const uniqueFactSources = factsBySource.size;
  const evidenceSources = acceptedSources
    .map((source) => ({
      id: source.id,
      kind: source.kind,
      trust: source.trust,
      volatility: source.volatility,
      ingestionMode: source.ingestion.mode,
      refreshIntervalHours: source.ingestion.refreshIntervalHours,
      facts: factsBySource.get(source.id) ?? 0,
      url: source.url,
    }))
    .sort((a, b) => b.facts - a.facts || b.trust - a.trust || a.id.localeCompare(b.id));

  const rootSuffix = rootArg(opts.root);
  const nextActions: string[] = [];
  const failureRecovery = buildStageFailureRecovery({
    almanacId: id,
    root: opts.root,
    almanacDir: dir,
    state,
    failedStages,
  });
  if (failedStages.length > 0) {
    nextActions.push(...stageFailureNextActions(failureRecovery));
  }
  if (domainSpec === null) {
    nextActions.push(`restore domain scope artifact: ${domainSpecPath(dir)}`);
  }
  if (sources === null) {
    nextActions.push("create or restore sources/sources.json");
  } else {
    nextActions.push(`review evidence sources: almanac sources ${id}${rootSuffix}`);
  }
  if (facts.length === 0) {
    nextActions.push(`add source-backed evidence: almanac feed ${id} <url> --apply${rootSuffix}`);
  }
  if (benchmarkSet === null) {
    nextActions.push(
      `create human fixtures: almanac benchmark ${id} --init${rootSuffix}`,
    );
  } else if (benchmarkReport === null) {
    nextActions.push(`run human fixtures: almanac benchmark ${id}${rootSuffix}`);
  } else {
    nextActions.push(`rerun validation gate: almanac benchmark ${id}${rootSuffix}`);
  }
  if (
    refreshRunVisibility.latest !== null &&
    refreshRunVisibility.issue !== null
  ) {
    nextActions.push(
      `inspect latest refresh run: almanac runs ${id} ${refreshRunVisibility.latest.runId}${rootSuffix}`,
    );
    nextActions.push(
      `rerun manual refresh: almanac refresh run ${id} --from-stage ${refreshRunVisibility.latest.fromStage ?? "04-source-fetch"} --save${rootSuffix}`,
    );
  } else if (refreshRunVisibility.readError !== null) {
    nextActions.push(`inspect saved runs: almanac runs ${id}${rootSuffix}`);
  }
  if (answerReadiness.fixtures.count === 0) {
    nextActions.push(
      `create ask replay fixtures: almanac ask-fixtures init ${id}${rootSuffix}`,
    );
  } else if (answerReadiness.latestSuite.status !== "passed") {
    if (answerReadiness.latestSuite.refreshId !== undefined) {
      nextActions.push(
        `inspect latest ask suite refresh: almanac runs ${id} ${answerReadiness.latestSuite.refreshId}${rootSuffix}`,
      );
    }
    nextActions.push(
      `persist ask suite evidence: almanac refresh run ${id} --from-stage 12-benchmark-run --ask-suite --save${rootSuffix}`,
    );
  } else if (
    answerReadiness.issues.validation.some((issue) =>
      issue.startsWith("latest ask suite fixture coverage differs")
    )
  ) {
    nextActions.push(
      `rerun ask suite evidence: almanac refresh run ${id} --from-stage 12-benchmark-run --ask-suite --save${rootSuffix}`,
    );
  }
  if (answerReadiness.latestAnswer === null) {
    nextActions.push(
      `save answer artifact: almanac ask ${id} "<question>" --save${rootSuffix}`,
    );
  } else if (answerReadiness.qualityGate.status !== "pass") {
    nextActions.push(
      `inspect latest answer run: almanac runs ${id} ${answerReadiness.latestAnswer.answerId}${rootSuffix}`,
    );
  }
  nextActions.push(`diagnose artifacts: almanac doctor ${id}${rootSuffix}`);

  const profile = {
    almanacDir: dir,
    almanacId: manifest.almanacId,
    displayName: manifest.displayName,
    status,
    issues: {
      blocking: blockingIssues,
      validation: validationIssues,
    },
    identity: {
      domain: manifest.domain,
      summary: domainSpec?.summary ?? null,
      freshnessProfileId: manifest.freshnessProfileId,
      subareas: domainSpec?.subareas ?? [],
      intents: domainSpec?.intents ?? [],
      verbs: domainSpec?.verbs ?? [],
      entityTypes: domainSpec?.entityTypes ?? [],
      cautions: domainSpec?.cautions ?? [],
    },
    evidence: {
      facts: facts.length,
      manifestFacts: counts.manifestFacts,
      knowledgeFacts: knowledge?.factCount ?? null,
      retrieval,
      factSourceCount: uniqueFactSources,
      acceptedSources: acceptedSources.length,
      rejectedSources: sources?.rejected.length ?? null,
      sourceCoverage: sources?.coverage ?? null,
      factTypes: countFactsByType(facts),
      freshnessClasses: countFactsByFreshness(facts),
      vectorIndex: knowledge?.vectorIndex ?? null,
      zeroFactHighTrustSources: highTrustZeroFactSources,
      sources: evidenceSources,
    },
    benchmark: {
      fixtures:
        benchmarkSet === null
          ? null
          : {
              positive: benchmarkSet.positive.length,
              negative: benchmarkSet.negative.length,
            },
      coverageGate: benchmarkCoverage,
      report:
        benchmarkReport === null
          ? null
          : {
              total: benchmarkReport.summary.total,
              passed: benchmarkReport.summary.passed,
              failed: benchmarkReport.summary.failed,
              errored: benchmarkReport.summary.errored,
              citationRate: benchmarkReport.summary.citationRate,
            },
    },
    refresh: refreshRunVisibility,
    answer: answerReadiness,
    artifacts: {
      domainSpec: domainSpec === null ? null : domainSpecPath(dir),
      facts: factsJsonlPath(dir),
      benchmarkReport: benchmarkReport === null ? null : benchmarkResultPath(dir),
      vectorIndex:
        knowledge?.vectorIndex?.status === "built"
          ? join(dir, knowledge.vectorIndex.manifestRelPath)
          : null,
      vectors:
        knowledge?.vectorIndex?.status === "built"
          ? join(dir, knowledge.vectorIndex.vectorsRelPath)
          : null,
    },
    nextActions,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
    return;
  }

  process.stdout.write(`expert profile: ${manifest.almanacId} (${manifest.displayName})\n`);
  process.stdout.write(`  status         ${profile.status}\n`);
  process.stdout.write(`  domain         ${manifest.domain}\n`);
  if (domainSpec !== null) {
    process.stdout.write(`  summary        ${clipText(domainSpec.summary)}\n`);
  }
  process.stdout.write(
    `  evidence       ${facts.length} facts from ${uniqueFactSources} source${uniqueFactSources === 1 ? "" : "s"}\n`,
  );
  process.stdout.write(`  retrieval      ${retrieval.summary}\n`);
  if (knowledge?.vectorIndex !== undefined) {
    process.stdout.write(
      `  vectors        ${formatVectorIndexSummary(knowledge.vectorIndex)}\n`,
    );
  }
  if (sources !== null) {
    process.stdout.write(
      `  source review  ${sources.status}, ${acceptedSources.length} accepted / ${sources.rejected.length} rejected (${nonZeroCoverage(sources.coverage)})\n`,
    );
  }
  process.stdout.write(
    `  freshness      ${nonZeroCounts(profile.evidence.freshnessClasses)}\n`,
  );
  process.stdout.write(
    `  fact types     ${nonZeroCounts(profile.evidence.factTypes)}\n`,
  );
  if (benchmarkReport !== null) {
    process.stdout.write(
      `  benchmark      ${benchmarkReport.summary.passed}/${benchmarkReport.summary.total} passed, citationRate ${formatRate(benchmarkReport.summary.citationRate)}` +
        (benchmarkSet !== null
          ? `, fixtures ${formatBenchmarkFixturesWithCoverage(benchmarkSet, benchmarkCoverage)}`
          : "") +
        "\n",
    );
  } else if (benchmarkSet !== null) {
    process.stdout.write(
      `  benchmark      not run (${formatBenchmarkFixturesWithCoverage(benchmarkSet, benchmarkCoverage)} fixtures)\n`,
    );
  } else {
    process.stdout.write("  benchmark      fixtures missing\n");
  }
  if (
    refreshRunVisibility.latest !== null ||
    refreshRunVisibility.readError !== null
  ) {
    process.stdout.write(
      `  refresh        ${
        refreshRunVisibility.readError === null
          ? formatRefreshRunVisibility(refreshRunVisibility.latest)
          : `unreadable: ${refreshRunVisibility.readError}`
      }\n`,
    );
  }
  process.stdout.write(`  answer mode    ${answerReadiness.status}\n`);
  process.stdout.write(
    `  ask fixtures   ${formatAnswerReadinessFixtures(answerReadiness)}\n`,
  );
  process.stdout.write(
    `  ask suite      ${formatAnswerReadinessSuite(answerReadiness)}\n`,
  );
  process.stdout.write(
    `  latest answer  ${formatAnswerReadinessLatest(answerReadiness)}\n`,
  );
  process.stdout.write(
    `  quality gate   ${formatAnswerReadinessQuality(answerReadiness)}\n`,
  );

  if (domainSpec !== null) {
    process.stdout.write(`\ncapabilities:\n`);
    for (const subarea of domainSpec.subareas) {
      process.stdout.write(`  - ${subarea}\n`);
    }
    process.stdout.write(`\nquery shapes:\n`);
    for (const intent of domainSpec.intents) {
      process.stdout.write(`  - ${intent.kind}: ${intent.example}\n`);
    }
  }

  process.stdout.write(`\nevidence sources:\n`);
  if (evidenceSources.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const source of evidenceSources.slice(0, 5)) {
      process.stdout.write(
        `  - ${source.id}  ${source.kind}  trust=${source.trust.toFixed(2)}  facts=${source.facts}  ${source.ingestionMode}/${source.refreshIntervalHours}h\n`,
      );
    }
  }

  process.stdout.write(`\nlimits:\n`);
  if (domainSpec === null || domainSpec.cautions.length === 0) {
    process.stdout.write("  - no explicit caution areas declared\n");
  } else {
    for (const caution of domainSpec.cautions) {
      process.stdout.write(`  - ${caution.area}: ${caution.rationale}\n`);
    }
  }

  const issues = [...blockingIssues, ...validationIssues];
  if (issues.length > 0) {
    process.stdout.write(`\nreadiness gaps:\n`);
    for (const issue of issues) {
      process.stdout.write(`  - ${issue}\n`);
    }
  }
  const answerIssues = [
    ...answerReadiness.issues.blocking,
    ...answerReadiness.issues.validation,
  ];
  if (answerIssues.length > 0) {
    process.stdout.write(`\nanswer readiness gaps:\n`);
    for (const issue of answerIssues) {
      process.stdout.write(`  - ${issue}\n`);
    }
  }

  process.stdout.write(`\nnext actions:\n`);
  for (const action of nextActions) {
    process.stdout.write(`  - ${action}\n`);
  }
}

function formatAnswerReadinessFixtures(readiness: AnswerReadiness): string {
  const suffix =
    readiness.fixtures.paths.length === 0
      ? ""
      : ` (${readiness.fixtures.paths
          .map((file) => `${file.relPath}:${file.count}`)
          .join(", ")})`;
  return `${readiness.fixtures.count} found${suffix}`;
}

function formatAnswerReadinessSuite(readiness: AnswerReadiness): string {
  const suite = readiness.latestSuite;
  if (suite.status === "not-run") return "not-run";
  if (suite.status === "unreadable") {
    return `unreadable${suite.readError === undefined ? "" : ` (${suite.readError})`}`;
  }
  const counts =
    suite.total === undefined
      ? ""
      : `, ${suite.passed ?? 0}/${suite.total} passed`;
  const quality = [
    suite.citationRate === undefined
      ? null
      : `citationRate ${formatRate(suite.citationRate)}`,
    suite.unsupportedClaimCount === undefined
      ? null
      : `unsupported ${suite.unsupportedClaimCount}`,
    suite.staleCitationCount === undefined
      ? null
      : `stale ${suite.staleCitationCount}`,
    suite.abstentionMismatchCount === undefined
      ? null
      : `abstentionMismatch ${suite.abstentionMismatchCount}`,
  ].filter((part): part is string => part !== null);
  const qualitySuffix = quality.length === 0 ? "" : ` (${quality.join(", ")})`;
  const run =
    suite.refreshId === undefined
      ? ""
      : `, ${suite.refreshId}${suite.label === undefined ? "" : ` label=${suite.label}`}`;
  const error =
    suite.error === undefined
      ? ""
      : ` (${suite.error.code}: ${suite.error.message})`;
  return `${suite.status}${counts}${qualitySuffix}${run}${error}`;
}

function formatAnswerReadinessLatest(readiness: AnswerReadiness): string {
  if (readiness.latestAnswer === null) return "none";
  const latest = readiness.latestAnswer;
  const reason =
    latest.abstentionReason === undefined ? "" : ` (${latest.abstentionReason})`;
  const label = latest.label === undefined ? "" : ` label=${latest.label}`;
  return `${latest.status}${reason}, ${latest.startedAt}, ${latest.answerId}${label}`;
}

function formatAnswerReadinessQuality(readiness: AnswerReadiness): string {
  if (readiness.qualityGate.status === "missing") return "missing";
  const reasons =
    readiness.qualityGate.reasons.length === 0
      ? ""
      : ` (${readiness.qualityGate.reasons.join("; ")})`;
  return `${readiness.qualityGate.status}${reasons}`;
}

interface PathOptions {
  root: string;
}

function cmdPath(id: string, opts: PathOptions): void {
  process.stdout.write(almanacDirPath(opts.root, id) + "\n");
}

interface RunsOptions {
  root: string;
  apply?: boolean;
  dryRun?: boolean;
  keepLatest?: string;
  json?: boolean;
  label?: string;
  latest?: boolean;
  limit?: string;
  olderThan?: string;
  prune?: boolean;
  kind?: RunArtifactKind;
  status?: RunArtifactStatus;
}

async function cmdRuns(
  id: string,
  runId: string | undefined,
  opts: RunsOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);

  try {
    if (runId !== undefined) {
      if (
        opts.latest === true ||
        opts.limit !== undefined ||
        opts.status !== undefined ||
        opts.label !== undefined ||
        opts.kind !== undefined
      ) {
        runsUsageError(
          "[runId] cannot be combined with --latest, --limit, --status, --label, or --kind",
        );
      }
      if (hasRunsPruneOptions(opts)) {
        runsUsageError("[runId] cannot be combined with pruning options");
      }
      const read = await readRunToolArtifact({ almanacDir, runId });
      process.stdout.write(
        opts.json === true
          ? JSON.stringify(read.artifact, null, 2) + "\n"
          : formatRunToolArtifactHuman(read.artifact),
      );
      return;
    }

    if (opts.prune === true) {
      if (opts.latest === true || opts.limit !== undefined) {
        runsUsageError("--prune cannot be combined with --latest or --limit");
      }
      if (opts.apply === true && opts.dryRun === true) {
        runsUsageError("--apply and --dry-run are mutually exclusive");
      }
      if (opts.keepLatest === undefined && opts.olderThan === undefined) {
        runsUsageError(
          "--prune requires --keep-latest or --older-than retention criteria",
        );
      }
      const keepLatest =
        opts.keepLatest === undefined
          ? undefined
          : parseRunsKeepLatest(opts.keepLatest);
      const olderThan =
        opts.olderThan === undefined
          ? undefined
          : parseRunsOlderThan(opts.olderThan);
      const filters = runsFiltersFromOptions(opts);
      const pruned = await pruneRunToolArtifacts({
        almanacDir,
        ...filters,
        ...(keepLatest === undefined ? {} : { keepLatest }),
        ...(olderThan === undefined ? {} : { olderThanMs: olderThan.ms }),
        apply: opts.apply === true,
      });
      process.stdout.write(
        opts.json === true
          ? JSON.stringify(pruned, null, 2) + "\n"
          : formatPruneRunToolArtifactsHuman(pruned),
      );
      return;
    }

    if (hasRunsPruneOptions(opts)) {
      runsUsageError(
        "--keep-latest, --older-than, --dry-run, and --apply require --prune",
      );
    }
    if (opts.latest === true && opts.limit !== undefined) {
      runsUsageError("--latest and --limit are mutually exclusive");
    }
    const limit =
      opts.latest === true ? 1 : parseRunsLimit(opts.limit ?? undefined);
    const filters = runsFiltersFromOptions(opts);
    const list = await listRunToolArtifacts(
      limit === undefined
        ? { almanacDir, ...filters }
        : { almanacDir, limit, ...filters },
    );
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(list, null, 2) + "\n"
        : formatRunToolArtifactListHuman(list),
    );
  } catch (e) {
    if (e instanceof RunToolSetupError) {
      if (e.code === "bad-run-id") {
        runsUsageError(e.message);
      }
      fail(`runs: ${e.message}`);
    }
    throw e;
  }
}

function hasRunsPruneOptions(opts: RunsOptions): boolean {
  return (
    opts.prune === true ||
    opts.keepLatest !== undefined ||
    opts.olderThan !== undefined ||
    opts.dryRun === true ||
    opts.apply === true
  );
}

function runsFiltersFromOptions(
  opts: RunsOptions,
): { kind?: RunArtifactKind; status?: RunArtifactStatus; label?: string } {
  return {
    ...(opts.kind === undefined ? {} : { kind: opts.kind }),
    ...(opts.status === undefined ? {} : { status: opts.status }),
    ...(opts.label === undefined
      ? {}
      : { label: normalizeRunsLabel(opts.label) }),
  };
}

function normalizeRunsLabel(label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    runsUsageError("--label must be between 1 and 80 characters");
  }
  return normalized;
}

function parseRunsKeepLatest(raw: string): number {
  const keepLatest = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(keepLatest) ||
    keepLatest < 0 ||
    `${keepLatest}` !== raw.trim()
  ) {
    runsUsageError(`--keep-latest must be a non-negative integer (got "${raw}")`);
  }
  return keepLatest;
}

function parseRunsOlderThan(raw: string): { ms: number } {
  const match = /^([1-9]\d*)(m|h|d|w)$/.exec(raw.trim());
  if (match === null) {
    runsUsageError(
      `--older-than must be a duration like 30d, 12h, 90m, or 4w (got "${raw}")`,
    );
  }
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const unitMs =
    unit === "m"
      ? 60 * 1000
      : unit === "h"
        ? 60 * 60 * 1000
        : unit === "d"
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
  return { ms: amount * unitMs };
}

function parseRunsLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit <= 0 || `${limit}` !== raw.trim()) {
    runsUsageError(`--limit must be a positive integer (got "${raw}")`);
  }
  return limit;
}

function runsUsageError(message: string): never {
  process.stderr.write(`error: runs: ${message}\n`);
  process.exit(2);
}

interface RunOptions {
  root: string;
  tool?: string;
  input?: string;
  inputFile?: string;
  label?: string;
  json?: boolean;
  listTools?: boolean;
  note?: string;
  save?: boolean;
}

async function cmdRun(id: string, opts: RunOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);

  try {
    if (opts.listTools === true) {
      if (
        opts.tool !== undefined ||
        opts.input !== undefined ||
        opts.inputFile !== undefined ||
        opts.label !== undefined ||
        opts.note !== undefined ||
        opts.save === true
      ) {
        runUsageError(
          "--list-tools cannot be combined with --tool, --input, --input-file, --label, --note, or --save",
        );
        return;
      }
      const tools = await listRunTools({ almanacDir });
      process.stdout.write(
        opts.json === true
          ? JSON.stringify(tools, null, 2) + "\n"
          : formatRunToolListHuman(tools),
      );
      return;
    }

    if (opts.tool === undefined || opts.tool.trim().length === 0) {
      runUsageError("missing required --tool <name> (or use --list-tools)");
      return;
    }
    if (
      opts.save !== true &&
      (opts.label !== undefined || opts.note !== undefined)
    ) {
      runUsageError("--label and --note require --save");
    }

    const metadata =
      opts.save === true ? runArtifactMetadataFromOptions(opts) : {};
    const input = await readRunInput(opts);
    const execution = await runTool({
      almanacDir,
      toolName: opts.tool,
      input,
    });
    const saved =
      opts.save === true
        ? await saveRunToolArtifact({
            almanacDir,
            execution,
            ...metadata,
          })
        : null;
    if (opts.json === true) {
      process.stdout.write(
        JSON.stringify(saved ? saved.artifact : execution, null, 2) + "\n",
      );
    } else {
      process.stdout.write(formatRunToolHuman(execution));
      if (saved) {
        process.stdout.write(`artifact: ${saved.path}\n`);
      }
    }
    process.exitCode = exitCodeForRunTool(execution);
  } catch (e) {
    if (e instanceof RunToolSetupError) {
      fail(`run: ${e.message}`);
    }
    throw e;
  }
}

function runArtifactMetadataFromOptions(
  opts: { label?: string; note?: string },
): { label?: string; note?: string } {
  return {
    ...(opts.label === undefined
      ? {}
      : { label: normalizeRunArtifactLabel(opts.label) }),
    ...(opts.note === undefined
      ? {}
      : { note: normalizeRunArtifactNote(opts.note) }),
  };
}

function normalizeRunArtifactLabel(label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    runUsageError("--label must be between 1 and 80 characters");
  }
  return normalized;
}

function normalizeRunArtifactNote(note: string): string {
  const normalized = note.trim();
  if (normalized.length === 0 || normalized.length > 1000) {
    runUsageError("--note must be between 1 and 1000 characters");
  }
  return normalized;
}

async function readRunInput(opts: RunOptions): Promise<unknown> {
  if (opts.input !== undefined && opts.inputFile !== undefined) {
    runUsageError("--input and --input-file are mutually exclusive");
  }
  if (opts.inputFile !== undefined) {
    const path = resolve(opts.inputFile);
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch (e) {
      runUsageError(
        `could not read --input-file ${path}: ${(e as Error).message}`,
      );
    }
    return parseRunJson(body, `--input-file ${path}`);
  }
  return parseRunJson(opts.input ?? "{}", "--input");
}

function parseRunJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    runUsageError(`${label} must be valid JSON: ${(e as Error).message}`);
  }
}

function runUsageError(message: string): never {
  process.stderr.write(`error: run: ${message}\n`);
  process.exit(2);
}

interface AskOptions {
  root: string;
  json?: boolean;
  label?: string;
  model?: string;
  note?: string;
  save?: boolean;
}

async function cmdAsk(
  id: string,
  question: string,
  opts: AskOptions,
): Promise<void> {
  const normalizedQuestion = question.trim();
  if (normalizedQuestion.length === 0) {
    askUsageError("question must not be empty");
  }
  if (
    opts.save !== true &&
    (opts.label !== undefined || opts.note !== undefined)
  ) {
    askUsageError("--label and --note require --save");
  }

  const provider = resolveProvider();
  if (provider === null) {
    fail(
      "ask: ANTHROPIC_API_KEY is not set, but answer synthesis needs an LLM. " +
        "Export ANTHROPIC_API_KEY (or set ALMANAC_LLM=mock for local smoke tests).",
    );
  }

  const almanacDir = almanacDirPath(opts.root, id);
  const startedAt = new Date().toISOString();
  try {
    const session = await runAnswerSession({
      almanacDir,
      question: normalizedQuestion,
      provider,
      ...(opts.model === undefined ? {} : { model: opts.model }),
    });
    const finishedAt = new Date().toISOString();
    const exitCode = exitCodeForAnswerSession(session);
    const metadata =
      opts.save === true ? runArtifactMetadataFromOptions(opts) : {};
    const saved =
      opts.save === true
        ? await saveAnswerArtifact({
            almanacDir,
            question: session.question,
            status: session.status,
            exitCode,
            startedAt,
            finishedAt,
            model: session.model,
            promptVersions: session.promptVersions,
            ...(session.answer === undefined ? {} : { answer: session.answer }),
            ...(session.abstentionReason === undefined
              ? {}
              : { abstentionReason: session.abstentionReason }),
            toolCalls: answerToolCallSummaries(session),
            citations: session.citations,
            ...(session.freshness === undefined
              ? {}
              : { freshness: session.freshness }),
            usage: session.usage,
            trace: session.trace,
            ...(session.error === undefined ? {} : { error: session.error }),
            ...metadata,
          })
        : null;

    if (opts.json === true) {
      process.stdout.write(
        JSON.stringify(saved ? saved.artifact : session, null, 2) + "\n",
      );
    } else {
      process.stdout.write(formatAnswerSessionHuman(session));
      if (saved) {
        process.stdout.write(`artifact: ${saved.path}\n`);
      }
    }
    process.exitCode = exitCode;
  } catch (e) {
    if (e instanceof AnswerSessionSetupError) {
      fail(`ask: ${e.message}`);
    }
    if (e instanceof AnswerArtifactSetupError) {
      fail(`ask: ${e.message}`);
    }
    throw e;
  }
}

function exitCodeForAnswerSession(session: AnswerSession): RunToolExitCode {
  if (session.status === "ok") return 0;
  if (
    session.status === "bad-tool-input" ||
    session.status === "tool-not-found"
  ) {
    return 2;
  }
  return 1;
}

function answerToolCallSummaries(session: AnswerSession) {
  return session.toolCalls.map((call) => ({
    toolName: call.toolName,
    input: call.input,
    status: call.status,
    durationMs: call.durationMs,
    citationsCount: call.citationsCount,
    ...(call.error === undefined ? {} : { error: call.error }),
  }));
}

function formatAnswerSessionHuman(session: AnswerSession): string {
  const lines = [
    `answer: ${session.almanacId}`,
    `status: ${session.status}`,
    `almanac: ${session.almanacId} (${session.version})`,
    `question: ${session.question}`,
    `tools: ${session.toolCalls.map((call) => call.toolName).join(", ") || "(none)"}`,
    `citations: ${session.citations.length}`,
    `duration: ${session.durationMs}ms`,
  ];
  if (session.freshness !== undefined) {
    lines.push(
      `freshness: ${session.freshness.class}/${session.freshness.staleness}`,
    );
  }
  if (session.status === "ok") {
    lines.push("answer:");
    lines.push(session.answer ?? "");
  } else if (session.status === "abstained") {
    lines.push(`abstention: ${session.abstentionReason ?? "(none)"}`);
  } else if (session.error !== undefined) {
    lines.push(`error: ${session.error.code}: ${session.error.message}`);
  }
  if (session.citations.length > 0) {
    lines.push("sources:");
    for (const citation of session.citations) {
      lines.push(`  - ${citation.sourceId}: ${citation.url}`);
    }
  }
  return lines.join("\n") + "\n";
}

function askUsageError(message: string): never {
  process.stderr.write(`error: ask: ${message}\n`);
  process.exit(2);
}

interface AskReplayOptions {
  root: string;
  fixture?: string;
  fromRuns?: boolean;
  json?: boolean;
  label?: string;
  judge?: boolean;
  judgeModel?: string;
}

async function cmdAskReplay(
  id: string,
  opts: AskReplayOptions,
): Promise<void> {
  if ((opts.fixture === undefined) === (opts.fromRuns !== true)) {
    askReplayUsageError("specify exactly one of --fixture or --from-runs");
  }
  if (opts.label !== undefined && opts.fromRuns !== true) {
    askReplayUsageError("--label requires --from-runs");
  }

  const almanacDir = almanacDirPath(opts.root, id);
  try {
    const entailment =
      opts.judge === true
        ? resolveEntailmentOptions(opts.judgeModel, askReplayUsageError)
        : undefined;
    const report =
      opts.fixture !== undefined
        ? await runAskReplayFromFixtureFile({
            almanacDir,
            fixturePath: resolve(opts.fixture),
            ...(entailment === undefined ? {} : { entailment }),
          })
        : await runAskReplayFromSavedRuns({
            almanacDir,
            ...(opts.label === undefined
              ? {}
              : { label: normalizeRunArtifactLabel(opts.label) }),
            ...(entailment === undefined ? {} : { entailment }),
          });
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(report, null, 2) + "\n"
        : formatAskReplayHuman(report),
    );
    process.exitCode = exitCodeForAskReplay(report);
  } catch (e) {
    if (e instanceof AskReplaySetupError) {
      fail(`ask-replay: ${e.message}`);
    }
    if (e instanceof RunToolSetupError) {
      fail(`ask-replay: ${e.message}`);
    }
    throw e;
  }
}

function askReplayUsageError(message: string): never {
  process.stderr.write(`error: ask-replay: ${message}\n`);
  process.exit(2);
}

interface AskSuiteOptions {
  root: string;
  fixture?: string[];
  json?: boolean;
  judge?: boolean;
  judgeModel?: string;
}

async function cmdAskSuite(id: string, opts: AskSuiteOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  try {
    const fixturePaths =
      opts.fixture === undefined || opts.fixture.length === 0
        ? undefined
        : opts.fixture.map((path) => resolve(path));
    const report = await runAskSuite({
      almanacDir,
      ...(fixturePaths === undefined ? {} : { fixturePaths }),
      ...(opts.judge === true
        ? {
            entailment: resolveEntailmentOptions(
              opts.judgeModel,
              askSuiteUsageError,
            ),
          }
        : {}),
    });
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(report, null, 2) + "\n"
        : formatAskSuiteHuman(report),
    );
    process.exitCode = exitCodeForAskSuite(report);
  } catch (e) {
    if (e instanceof AskSuiteSetupError) {
      askSuiteUsageError(e.message);
    }
    if (e instanceof RunToolSetupError) {
      askSuiteUsageError(e.message);
    }
    throw e;
  }
}

function collectAskSuiteFixture(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function askSuiteUsageError(message: string): never {
  process.stderr.write(`error: ask-suite: ${message}\n`);
  process.exit(2);
}

function resolveEntailmentOptions(
  model: string | undefined,
  usageError: (message: string) => never,
): AskReplayEntailmentOptions {
  const provider = resolveProvider();
  if (provider === null) {
    usageError(
      "entailment judge requires an LLM provider. Export ANTHROPIC_API_KEY or set ALMANAC_LLM=mock.",
    );
  }
  return {
    provider,
    ...(model === undefined ? {} : { model }),
  };
}

interface AskFixturesInitOptions {
  root: string;
  fixture?: string;
  json?: boolean;
  overwrite?: boolean;
}

async function cmdAskFixturesInit(
  id: string,
  opts: AskFixturesInitOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  try {
    const result = await initAskFixtureFile({
      almanacDir,
      ...(opts.fixture === undefined
        ? {}
        : { fixturePath: resolve(opts.fixture) }),
      overwrite: opts.overwrite === true,
    });
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(result, null, 2) + "\n"
        : formatAskFixtureAuthoringHuman(result),
    );
  } catch (e) {
    if (e instanceof AskFixtureAuthoringError) {
      fail(`ask-fixtures: ${e.message}`);
    }
    throw e;
  }
}

interface AskFixturesAddFromRunOptions {
  root: string;
  fixture?: string;
  fixtureId?: string;
  json?: boolean;
}

async function cmdAskFixturesAddFromRun(
  id: string,
  answerId: string,
  opts: AskFixturesAddFromRunOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  try {
    const result = await addAskFixtureFromRun({
      almanacDir,
      answerId,
      ...(opts.fixture === undefined
        ? {}
        : { fixturePath: resolve(opts.fixture) }),
      ...(opts.fixtureId === undefined
        ? {}
        : { fixtureId: opts.fixtureId.trim() }),
    });
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(result, null, 2) + "\n"
        : formatAskFixtureAuthoringHuman(result),
    );
  } catch (e) {
    if (e instanceof AskFixtureAuthoringError) {
      fail(`ask-fixtures: ${e.message}`);
    }
    if (e instanceof RunToolSetupError) {
      fail(`ask-fixtures: ${e.message}`);
    }
    throw e;
  }
}

interface RefreshDueOptions {
  root: string;
  json?: boolean;
}

async function cmdRefreshDue(
  id: string,
  opts: RefreshDueOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  try {
    const status = await getRefreshDueStatus({ almanacDir });
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(status, null, 2) + "\n"
        : formatRefreshDueHuman(status),
    );
  } catch (e) {
    if (e instanceof RefreshStatusError) {
      fail(`refresh due: ${e.message}`);
    }
    throw e;
  }
}

interface RefreshRunCliOptions {
  root: string;
  fromStage?: string;
  askSuite?: boolean;
  json?: boolean;
  label?: string;
  note?: string;
  save?: boolean;
}

async function cmdRefreshRun(
  id: string,
  opts: RefreshRunCliOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  const fromStage = parseRefreshRunFromStage(opts.fromStage);
  if (
    opts.save !== true &&
    (opts.label !== undefined || opts.note !== undefined)
  ) {
    refreshRunUsageError("--label and --note require --save");
  }
  const metadata =
    opts.save === true ? refreshRunArtifactMetadataFromOptions(opts) : {};
  const { runners, providerAvailable } = buildRunners();
  if (opts.json !== true) {
    process.stdout.write(
      `▶ refresh run "${id}"\n` +
        `    fromStage     ${fromStage ?? "(auto)"}\n` +
        `    askSuite      ${opts.askSuite === true ? "yes" : "no"}\n` +
        `    save          ${opts.save === true ? "yes" : "no"}\n`,
    );
    if (!providerAvailable) {
      process.stdout.write(
        "  ! ANTHROPIC_API_KEY not set; LLM-driven stages (01, 02a, 02b, 05, 06, 11) will be skipped " +
          "and Stage 7 will implement only the four default tools (custom tools disabled).\n",
      );
    }
  }

  try {
    const result = await runRefresh({
      almanacDir,
      ...(fromStage === null ? {} : { fromStage }),
      runners,
      forgerVersion: FORGER_VERSION,
      persistManifest: (manifest) =>
        writeManifestWithActualCounts(almanacDir, manifest),
      log:
        opts.json === true
          ? undefined
          : (event) => process.stdout.write(`  · ${JSON.stringify(event)}\n`),
      save: opts.save === true,
      askSuite: opts.askSuite === true,
      ...metadata,
    });
    process.stdout.write(
      opts.json === true
        ? JSON.stringify(result, null, 2) + "\n"
        : formatRefreshRunHuman(result),
    );
    if (opts.json !== true && result.stageSummary.failed.length > 0) {
      const state = await readCompileState(almanacDir);
      const recovery = buildStageFailureRecovery({
        almanacId: id,
        root: opts.root,
        almanacDir,
        state,
        failedStages: result.stageSummary.failed,
      });
      process.stderr.write(
        formatPipelineFailureRecovery({
          recovery,
          failedStages: result.stageSummary.failed,
          heading: "Refresh pipeline halted.",
        }),
      );
    }
    process.exitCode = result.exitCode;
  } catch (e) {
    if (e instanceof RefreshRunError || e instanceof RefreshStatusError) {
      fail(`refresh run: ${e.message}`);
    }
    throw e;
  }
}

function parseRefreshRunFromStage(raw: string | undefined): StageId | null {
  if (raw === undefined) return null;
  if (!STAGE_IDS.includes(raw as StageId)) {
    refreshRunUsageError(
      `--from-stage: unknown stage id "${raw}". valid: ${STAGE_IDS.join(", ")}`,
    );
  }
  const stageId = raw as StageId;
  if (stageId === "00-bootstrap") {
    refreshRunUsageError(
      "--from-stage=00-bootstrap is not supported for refresh runs",
    );
  }
  return stageId;
}

function refreshRunArtifactMetadataFromOptions(
  opts: RefreshRunCliOptions,
): { label?: string; note?: string } {
  return {
    ...(opts.label === undefined
      ? {}
      : { label: normalizeRefreshRunArtifactLabel(opts.label) }),
    ...(opts.note === undefined
      ? {}
      : { note: normalizeRefreshRunArtifactNote(opts.note) }),
  };
}

function normalizeRefreshRunArtifactLabel(label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    refreshRunUsageError("--label must be between 1 and 80 characters");
  }
  return normalized;
}

function normalizeRefreshRunArtifactNote(note: string): string {
  const normalized = note.trim();
  if (normalized.length === 0 || normalized.length > 1000) {
    refreshRunUsageError("--note must be between 1 and 1000 characters");
  }
  return normalized;
}

function refreshRunUsageError(message: string): never {
  process.stderr.write(`error: refresh run: ${message}\n`);
  process.exit(2);
}

interface SourcesOptions {
  root: string;
  json?: boolean;
  rejected?: boolean;
  kind?: SourceKind;
}

async function cmdSources(id: string, opts: SourcesOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);
  const sources = await readSourcesFileIfPresent(almanacDir);
  if (sources === null) {
    fail(`sources file not found: ${approvedSourcesPath(almanacDir)}`);
  }

  const accepted = opts.kind
    ? sources.sources.filter((source) => source.kind === opts.kind)
    : sources.sources;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          almanacDir,
          almanacId: manifest.almanacId,
          status: sources.status,
          generatedAt: sources.generatedAt,
          approvedAt: sources.approvedAt ?? null,
          approvedBy: sources.approvedBy ?? null,
          coverage: sources.coverage,
          warnings: sources.warnings,
          stability: sources.stability ?? null,
          sources: accepted,
          rejected: opts.rejected === true ? sources.rejected : [],
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(
    `sources: ${manifest.almanacId} (${manifest.displayName})\n` +
      `  status        ${sources.status}` +
      `${sources.approvedBy ? ` (${sources.approvedBy})` : ""}\n` +
      `  accepted      ${accepted.length}${opts.kind ? ` of kind ${opts.kind}` : ""} / ${sources.sources.length} total\n` +
      `  rejected      ${sources.rejected.length}\n` +
      `  coverage      ${nonZeroCoverage(sources.coverage)}\n`,
  );
  if (sources.warnings.length > 0) {
    process.stdout.write(`  warnings      ${sources.warnings.join("; ")}\n`);
  }
  if (sources.stability !== undefined) {
    process.stdout.write(
      `  drift         previous=${sources.stability.previousAcceptedCount}, current=${sources.stability.currentAcceptedCount}, ` +
        `preserved=${sources.stability.preservedSourceIds.length}, restored=${sources.stability.restoredSourceIds.length}, ` +
        `replaced=${sources.stability.replacedSources.length}, dropped=${sources.stability.droppedSources.length}, added=${sources.stability.addedSourceIds.length}\n`,
    );
  }

  process.stdout.write(`\naccepted:\n`);
  if (accepted.length === 0) {
    process.stdout.write(`  (none)\n`);
  } else {
    for (const source of accepted) {
      process.stdout.write(
        `  - ${source.id}  ${source.kind}  trust=${source.trust.toFixed(2)}  ${source.ingestion.mode}/${source.ingestion.refreshIntervalHours}h\n` +
          `    ${source.url}\n` +
          `    ${source.rationale}\n`,
      );
    }
  }

  if (sources.rejected.length > 0) {
    process.stdout.write(`\nrejected:\n`);
    if (opts.rejected === true) {
      for (const source of sources.rejected) {
        process.stdout.write(`  - ${source.reason}  ${source.url}\n`);
      }
    } else {
      process.stdout.write(`  ${sources.rejected.length} hidden (use --rejected to show)\n`);
    }
  }
}

interface BenchmarkOptions {
  root: string;
  init?: boolean;
  force?: boolean;
  json?: boolean;
}

async function cmdBenchmark(
  id: string,
  opts: BenchmarkOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);

  if (opts.init === true) {
    const set = await starterBenchmarkSet(almanacDir, manifest);
    await writeBenchmarkFixtures(almanacDir, set, { force: opts.force });
    process.stdout.write(
      `benchmark fixtures written:\n` +
        `  ${positiveJsonlPath(almanacDir)}\n` +
        `  ${negativeJsonlPath(almanacDir)}\n\n` +
        `Edit the JSONL fields you want to make authoritative:\n` +
        `  - query: the human-facing test question\n` +
        `  - invocation.input.q: the exact runtime search query\n` +
        `  - expected.contains: substrings that must appear in positive results\n` +
        `  - expected.expectedErrorCode: required refusal code for strict negatives\n\n` +
        `Edit those JSONL files as human golden tests, then run:\n` +
        `  almanac benchmark ${manifest.almanacId} --root ${opts.root}\n`,
    );
    return;
  }

  let state = await readCompileState(almanacDir);
  const runner = createBenchmarkRunRunner();
  try {
    state = await runStandaloneStage({
      almanacDir,
      state,
      manifest,
      stageId: "12-benchmark-run",
      runner,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "MissingBenchmarkSetError") {
      fail(
        `benchmark fixtures are missing. Run \`almanac benchmark ${id} --init --root ${opts.root}\`, edit the JSONL files, then run this command again.`,
      );
    }
    throw e;
  }
  await writeCompileState(almanacDir, state);

  const report = await readBenchmarkReportIfPresent(almanacDir);
  if (report === null) {
    fail(`benchmark report was not written: ${benchmarkResultPath(almanacDir)}`);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      `benchmark: ${manifest.almanacId}\n` +
        `  report        ${benchmarkResultPath(almanacDir)}\n` +
        `  total         ${report.summary.total}\n` +
        `  passed        ${report.summary.passed}\n` +
        `  failed        ${report.summary.failed}\n` +
        `  errored       ${report.summary.errored}\n` +
        `  citationRate  ${formatRate(report.summary.citationRate)}\n`,
    );
  }

  if (report.summary.failed > 0 || report.summary.errored > 0) {
    process.exitCode = 1;
  }
}

async function starterBenchmarkSet(
  almanacDir: string,
  manifest: AlmanacManifest,
) {
  const facts = await readFactsJsonlIfPresent(almanacDir);
  const first = facts[0];
  const query = first ? queryFromFact(first) : manifest.displayName;
  const contains = first ? [first.text.split(/\s+/).find((w) => w.length >= 5) ?? query] : [];
  return BenchmarkSetSchema.parse({
    schemaVersion: "0.1.0",
    almanacId: manifest.almanacId,
    positive: [
      PositiveFixtureSchema.parse({
        id: "human-golden-positive-1",
        intent: "lookup",
        query,
        rationale:
          "Starter positive fixture generated from the current fact corpus; edit this into a real human golden query.",
        invocation: {
          tool: "query_facts",
          input: { q: query, limit: 5 },
        },
        expected: {
          minCitations: 1,
          contains,
          acceptableStaleness: ["fresh", "warm"],
        },
      }),
    ],
    negative: [
      NegativeFixtureSchema.parse({
        id: "human-golden-negative-1",
        query: "intentionally out of scope placeholder",
        rationale:
          "Starter negative fixture; replace with a query this almanac should refuse or leave uncited.",
        refusalReason: "out-of-scope",
        invocation: {
          tool: "query_facts",
          input: { q: "intentionally out of scope placeholder", limit: 5 },
        },
        expected: { maxCitations: 0 },
      }),
    ],
  });
}

function queryFromFact(fact: FactRecord): string {
  const words = fact.text
    .split(/[^A-Za-z0-9_]+/)
    .filter((word) => word.length >= 5)
    .slice(0, 2)
    .join(" ");
  if (words.length >= 5) return words;
  const entity = fact.entities.find((value) => value.trim().length >= 5);
  return entity ?? fact.text.slice(0, 80);
}

interface DoctorOptions {
  root: string;
  json?: boolean;
  strict?: boolean;
}

type DoctorLevel = "ok" | "warn" | "fail";

interface DoctorCheck {
  level: DoctorLevel;
  name: string;
  message: string;
}

type DoctorReadinessStatus =
  | "ready"
  | "setup"
  | "needs-validation"
  | "optional"
  | "blocked";

interface DoctorReadinessItem {
  status: DoctorReadinessStatus;
  name: string;
  message: string;
  nextActions: string[];
}

interface RootHygieneReport {
  status: Extract<DoctorReadinessStatus, "ready" | "setup" | "needs-validation">;
  root: string;
  almanacs: {
    total: number;
    ok: number;
    attention: number;
    failed: number;
    broken: number;
  };
  cleanup: {
    savedRuns: number;
    savedRunAlmanacs: Array<{
      almanacId: string;
      runs: number;
      nextAction: string;
    }>;
    exportArchives: string[];
    orphanedMcpRegistrations: Array<{
      client: RegisterClient;
      almanacId: string;
      serverName: string;
      path: string;
      nextAction: string;
    }>;
    staleRegistrations: Array<{
      almanacId: string;
      status: RegistrationOverallStatus;
      nextActions: string[];
    }>;
  };
  issues: string[];
  nextActions: string[];
}

function addDoctorReadiness(
  readiness: DoctorReadinessItem[],
  item: DoctorReadinessItem,
): void {
  readiness.push(item);
}

function formatDoctorReadinessStatus(status: DoctorReadinessStatus): string {
  return status.padEnd(16);
}

async function readRootHygieneReport(root: string): Promise<RootHygieneReport> {
  const rootSuffix = rootArg(root);
  if (!existsSync(root)) {
    return {
      status: "setup",
      root,
      almanacs: emptyRootHygieneAlmanacCounts(),
      cleanup: emptyRootHygieneCleanup(),
      issues: [],
      nextActions: [`almanac demo${rootSuffix}`],
    };
  }

  const items = await readLifecycleInventory(root);
  const almanacs = rootHygieneAlmanacCounts(items);
  const installedIds = new Set(items.map((item) => item.almanacId));
  const [savedRunAlmanacs, exportArchives, orphanedMcpRegistrations] =
    await Promise.all([
      readRootSavedRunCleanup(items, root),
      readRootExportArchives(root),
      readRootOrphanedMcpRegistrations(root, installedIds),
    ]);
  const staleRegistrations = items
    .filter(
      (item) =>
        item.manifest !== null &&
        (item.lifecycle.registration.status === "stale" ||
          item.lifecycle.registration.status === "unreadable"),
    )
    .map((item) => ({
      almanacId: item.almanacId,
      status: item.lifecycle.registration.status,
      nextActions: item.lifecycle.registration.clients.flatMap(
        (client) => client.nextActions,
      ),
    }));
  const issues = rootHygieneIssues({
    items,
    orphanedMcpRegistrations,
    staleRegistrations,
  });
  const cleanup = {
    savedRuns: savedRunAlmanacs.reduce((sum, item) => sum + item.runs, 0),
    savedRunAlmanacs,
    exportArchives,
    orphanedMcpRegistrations,
    staleRegistrations,
  };
  const nextActions = uniqueStrings([
    ...(items.length === 0 ? [`almanac demo${rootSuffix}`] : []),
    `almanac list${rootSuffix}`,
    ...items
      .filter((item) => item.lifecycle.status !== "ok")
      .flatMap((item) => item.lifecycle.nextActions.slice(0, 1)),
    ...staleRegistrations.flatMap((item) => item.nextActions),
    ...orphanedMcpRegistrations.map((item) => item.nextAction),
    ...savedRunAlmanacs.map((item) => item.nextAction),
    ...(exportArchives.length === 0
      ? []
      : [`review exported archives in ${root}`]),
  ]);

  return {
    status:
      issues.length > 0
        ? "needs-validation"
        : items.length === 0
          ? "setup"
          : "ready",
    root,
    almanacs,
    cleanup,
    issues,
    nextActions,
  };
}

function emptyRootHygieneAlmanacCounts(): RootHygieneReport["almanacs"] {
  return {
    total: 0,
    ok: 0,
    attention: 0,
    failed: 0,
    broken: 0,
  };
}

function emptyRootHygieneCleanup(): RootHygieneReport["cleanup"] {
  return {
    savedRuns: 0,
    savedRunAlmanacs: [],
    exportArchives: [],
    orphanedMcpRegistrations: [],
    staleRegistrations: [],
  };
}

function rootHygieneAlmanacCounts(
  items: LifecycleInventoryItem[],
): RootHygieneReport["almanacs"] {
  return {
    total: items.length,
    ok: items.filter((item) => item.lifecycle.status === "ok").length,
    attention: items.filter((item) => item.lifecycle.status === "attention")
      .length,
    failed: items.filter((item) => item.lifecycle.status === "failed").length,
    broken: items.filter((item) => item.lifecycle.status === "broken").length,
  };
}

async function readRootSavedRunCleanup(
  items: LifecycleInventoryItem[],
  root: string,
): Promise<RootHygieneReport["cleanup"]["savedRunAlmanacs"]> {
  const rootSuffix = rootArg(root);
  const out: RootHygieneReport["cleanup"]["savedRunAlmanacs"] = [];
  for (const item of items) {
    if (item.manifest === null) continue;
    try {
      const list = await listRunToolArtifacts({ almanacDir: item.almanacDir });
      if (list.runs.length === 0) continue;
      out.push({
        almanacId: item.almanacId,
        runs: list.runs.length,
        nextAction: `almanac runs ${item.almanacId} --prune --keep-latest 20 --dry-run${rootSuffix}`,
      });
    } catch {
      // Per-almanac status already reports unreadable .runs. Root hygiene keeps
      // cleanup guidance best-effort so one bad directory does not hide others.
    }
  }
  return out;
}

async function readRootExportArchives(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^almanac-.+\.tar\.gz$/.test(entry.name),
      )
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readRootOrphanedMcpRegistrations(
  root: string,
  installedIds: Set<string>,
): Promise<RootHygieneReport["cleanup"]["orphanedMcpRegistrations"]> {
  const rootPath = resolve(root);
  const out: RootHygieneReport["cleanup"]["orphanedMcpRegistrations"] = [];
  for (const profile of Object.values(CLIENT_PROFILES)) {
    if (!existsSync(profile.mcpConfigPath)) continue;
    let config: Record<string, unknown>;
    try {
      config = parseMcpConfig(
        await readFile(profile.mcpConfigPath, "utf8"),
        profile.format,
      );
    } catch {
      continue;
    }
    const servers = config[profile.mcpServersKey];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      continue;
    }
    for (const [serverName, entry] of Object.entries(
      servers as Record<string, unknown>,
    )) {
      if (!serverName.startsWith("almanac-")) continue;
      const almanacId = serverName.slice("almanac-".length);
      if (installedIds.has(almanacId)) continue;
      const entryRoot = mcpEntryRootPath(entry);
      if (entryRoot === null || resolve(entryRoot) !== rootPath) continue;
      out.push({
        client: profile.name,
        almanacId,
        serverName,
        path: profile.mcpConfigPath,
        nextAction: `remove ${profile.mcpServersKey}["${serverName}"] from ${profile.mcpConfigPath}`,
      });
    }
  }
  return out;
}

function mcpEntryRootPath(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const args = (entry as Record<string, unknown>)["args"];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return null;
  }
  const rootFlagIndex = args.indexOf("--root");
  if (rootFlagIndex < 0) return null;
  return args[rootFlagIndex + 1] ?? null;
}

function rootHygieneIssues(args: {
  items: LifecycleInventoryItem[];
  orphanedMcpRegistrations: RootHygieneReport["cleanup"]["orphanedMcpRegistrations"];
  staleRegistrations: RootHygieneReport["cleanup"]["staleRegistrations"];
}): string[] {
  return uniqueStrings([
    ...args.items
      .filter((item) => item.lifecycle.status === "broken")
      .map(
        (item) =>
          `${item.almanacId}: broken - ${
            item.lifecycle.issues[0] ?? "almanac artifacts are broken"
          }`,
      ),
    ...args.items
      .filter((item) => item.lifecycle.status === "failed")
      .map(
        (item) =>
          `${item.almanacId}: failed - ${
            item.lifecycle.issues[0] ?? "almanac failed validation"
          }`,
      ),
    ...args.items
      .filter((item) => item.lifecycle.status === "attention")
      .map(
        (item) =>
          `${item.almanacId}: attention - ${
            item.lifecycle.issues[0] ?? "needs review"
          }`,
      ),
    ...args.staleRegistrations.map(
      (item) => `${item.almanacId}: registration ${item.status}`,
    ),
    ...args.orphanedMcpRegistrations.map(
      (item) =>
        `${item.client}: orphaned MCP registration ${item.serverName} points at missing ${item.almanacId}`,
    ),
  ]);
}

function formatRootHygieneCheck(report: RootHygieneReport): string {
  const counts = report.almanacs;
  if (counts.total === 0) return "no almanacs found";
  return `${counts.total} almanac(s): ${counts.ok} ok, ${counts.attention} attention, ${counts.failed} failed, ${counts.broken} broken`;
}

function formatRootCleanupCheck(report: RootHygieneReport): string {
  const parts = [
    `${report.cleanup.savedRuns} saved run artifact(s)`,
    `${report.cleanup.exportArchives.length} export archive(s)`,
    `${report.cleanup.orphanedMcpRegistrations.length} orphaned MCP registration(s)`,
    `${report.cleanup.staleRegistrations.length} stale registration set(s)`,
  ];
  return parts.join(", ");
}

async function cmdDoctor(
  id: string | undefined,
  opts: DoctorOptions,
): Promise<void> {
  const checks: DoctorCheck[] = [];
  const readiness: DoctorReadinessItem[] = [];
  let rootHygiene: RootHygieneReport | null = null;
  const add = (level: DoctorLevel, name: string, message: string) => {
    checks.push({ level, name, message });
  };

  const bunVersion = (process.versions as { bun?: string }).bun;
  const rootSuffix = rootArg(opts.root);
  const hasAnthropic = Boolean(process.env["ANTHROPIC_API_KEY"]);
  const hasMockProvider = process.env["ALMANAC_LLM"] === "mock";
  add(
    bunVersion ? "ok" : "fail",
    "runtime",
    bunVersion ? `Bun ${bunVersion}` : "Bun runtime not detected",
  );
  add("ok", "cli", `almanac ${FORGER_VERSION}`);
  add(
    existsSync(opts.root) ? "ok" : "warn",
    "root",
    existsSync(opts.root)
      ? `root exists: ${opts.root}`
      : `root does not exist yet: ${opts.root}`,
  );
  for (const key of [
    "ANTHROPIC_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "GITHUB_TOKEN",
  ]) {
    add(
      process.env[key] ? "ok" : "warn",
      `env:${key}`,
      process.env[key] ? "set" : "unset",
    );
  }
  addDoctorReadiness(readiness, {
    status: bunVersion ? "ready" : "blocked",
    name: "demo",
    message: bunVersion
      ? "offline demo can run without provider keys"
      : "install Bun before running the offline demo",
    nextActions: bunVersion
      ? [`almanac demo${rootSuffix}`]
      : ["install Bun 1.1.0 or newer"],
  });
  addDoctorReadiness(readiness, {
    status: hasAnthropic ? "ready" : "setup",
    name: "real-compile",
    message: hasAnthropic
      ? "ANTHROPIC_API_KEY is set for provider-backed compile stages"
      : "set ANTHROPIC_API_KEY before running provider-backed compile stages; use demo first",
    nextActions: hasAnthropic
      ? [`almanac new <domain>${rootSuffix}`]
      : ["export ANTHROPIC_API_KEY=...", `almanac demo${rootSuffix}`],
  });
  addDoctorReadiness(readiness, {
    status: hasAnthropic || hasMockProvider ? "ready" : "optional",
    name: "judge",
    message:
      hasAnthropic || hasMockProvider
        ? "explicit --judge provider is available"
        : "optional entailment judging needs ANTHROPIC_API_KEY or ALMANAC_LLM=mock",
    nextActions:
      hasAnthropic || hasMockProvider
        ? ["almanac ask-suite <id> --judge"]
        : ["set ANTHROPIC_API_KEY or ALMANAC_LLM=mock when running --judge"],
  });
  const embeddingConfig = resolveEmbeddingProviderConfig(process.env);
  add(
    embeddingReadinessLevel(embeddingConfig),
    "embeddings",
    formatEmbeddingReadiness(embeddingConfig),
  );
  const pdftotext = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  add(
    pdftotext.error ? "warn" : "ok",
    "tool:pdftotext",
    pdftotext.error
      ? "missing; PDF snapshot sources will be skipped during fact extraction"
      : firstLine(`${pdftotext.stdout}${pdftotext.stderr}`) || "available",
  );

  if (id !== undefined) {
    const almanacDir = almanacDirPath(opts.root, id);
    const almanacExists = existsSync(almanacDir);
    add(
      almanacExists ? "ok" : "fail",
      "almanac",
      almanacExists ? `found: ${almanacDir}` : `not found: ${almanacDir}`,
    );
    if (!almanacExists) {
      addDoctorReadiness(readiness, {
        status: "setup",
        name: "answer",
        message: `create or restore ${id} before running answer mode`,
        nextActions: [
          `almanac demo${rootSuffix}`,
          `almanac doctor ${id}${rootSuffix}`,
        ],
      });
      addDoctorReadiness(readiness, {
        status: "setup",
        name: "refresh",
        message: `create or restore ${id} before checking refresh readiness`,
        nextActions: [
          `almanac demo${rootSuffix}`,
          `almanac doctor ${id}${rootSuffix}`,
        ],
      });
      addDoctorReadiness(readiness, {
        status: "setup",
        name: "registration",
        message: `create or restore ${id} before client registration`,
        nextActions: [
          `almanac demo${rootSuffix}`,
          `almanac doctor ${id}${rootSuffix}`,
        ],
      });
    }
    if (almanacExists) {
      try {
        const manifest = await readManifest(almanacDir);
        add("ok", "manifest", `${manifest.almanacId} v${manifest.version}`);
        const state = await readCompileState(almanacDir);
        const stageCounts = stageStatusCounts(state);
        add(
          stageCounts.failed > 0 ? "fail" : stageCounts.pending > 0 ? "warn" : "ok",
          "stages",
          `${stageCounts.completed} completed, ${stageCounts.skipped} skipped, ${stageCounts.failed} failed, ${stageCounts.pending} pending`,
        );
        const failedStages = (STAGE_IDS as readonly StageId[]).filter(
          (stageId) => state.stages[stageId].status === "failed",
        );
        const failureRecovery = buildStageFailureRecovery({
          almanacId: id,
          root: opts.root,
          almanacDir,
          state,
          failedStages,
        });
        if (failureRecovery !== null) {
          addDoctorReadiness(readiness, {
            status: "blocked",
            name: "recovery",
            message: `first failed stage ${failureRecovery.stageId}; ${failureRecovery.guidance}`,
            nextActions: [
              failureRecovery.resumeCommand,
              `inspect compile state: ${failureRecovery.compileStatePath}`,
            ],
          });
        }
        const knowledge = await readKnowledgeIndexManifest(almanacDir);
        add(
          knowledge === null ? "warn" : "ok",
          "knowledge",
          knowledge === null
            ? "knowledge/index-manifest.json missing"
            : `${knowledge.factCount} facts, sqlite ${knowledge.sqliteVersion}`,
        );
        if (knowledge?.vectorIndex !== undefined) {
          add("ok", "vectors", formatVectorIndexSummary(knowledge.vectorIndex));
        }
        if (knowledge !== null) {
          const retrieval = getRetrievalReadiness({
            vectorIndex: knowledge.vectorIndex ?? null,
            embeddingConfig,
          });
          add(
            retrieval.status === "ready" ? "ok" : "warn",
            "retrieval",
            retrieval.summary,
          );
        }
        const counts = await readDisplayCounts(almanacDir, manifest, knowledge);
        add(
          countsMismatch(counts) ? "warn" : "ok",
          "counts",
          countsMismatch(counts)
            ? `manifest ${counts.manifestFacts}/${counts.manifestTools}, actual ${counts.facts}/${counts.tools}`
            : `facts/tools ${counts.facts}/${counts.tools}`,
        );
        const sources = await readSourcesFileIfPresent(almanacDir);
        add(
          sources === null ? "warn" : "ok",
          "sources",
          sources === null
            ? "sources/sources.json missing"
            : `${sources.sources.length} accepted / ${sources.rejected.length} rejected`,
        );
        const set = await readBenchmarkSetIfPresent(
          almanacDir,
          manifest.almanacId,
        );
        const benchmarkCoverage = benchmarkCoverageGate(almanacDir, state, set);
        add(
          set === null ? "warn" : benchmarkCoverage.ok ? "ok" : "warn",
          "fixtures",
          set === null
            ? "benchmark fixtures missing"
            : formatBenchmarkFixturesWithCoverage(set, benchmarkCoverage),
        );
        const report = await readBenchmarkReportIfPresent(almanacDir);
        add(
          report === null
            ? "warn"
            : report.summary.failed > 0 || report.summary.errored > 0
              ? "fail"
              : "ok",
          "benchmark",
          report === null
            ? "benchmark report missing"
            : `${report.summary.passed}/${report.summary.total} passed, failed=${report.summary.failed}, errored=${report.summary.errored}`,
        );
        const refreshRunVisibility =
          await readRefreshRunVisibility(almanacDir);
        add(
          refreshRunVisibility.issue !== null ? "warn" : "ok",
          "refresh",
          refreshRunVisibility.readError !== null
            ? `refresh artifacts unreadable: ${refreshRunVisibility.readError}`
            : formatRefreshRunVisibility(refreshRunVisibility.latest),
        );
        const answerReadiness = await getAnswerReadiness({ almanacDir });
        add(
          answerReadiness.status === "ready" ? "ok" : "warn",
          "answer",
          formatAnswerReadinessDoctor(answerReadiness),
        );
        addDoctorReadiness(readiness, {
          status:
            answerReadiness.status === "ready" ? "ready" : "needs-validation",
          name: "answer",
          message:
            answerReadiness.status === "ready"
              ? "answer fixtures and quality evidence are ready"
              : formatAnswerReadinessDoctor(answerReadiness),
          nextActions: answerReadinessNextActions(
            id,
            rootSuffix,
            answerReadiness,
          ),
        });
        addDoctorReadiness(readiness, {
          status:
            refreshRunVisibility.issue === null ? "ready" : "needs-validation",
          name: "refresh",
          message:
            refreshRunVisibility.issue === null
              ? "refresh due checks can run without provider calls"
              : refreshRunVisibility.issue,
          nextActions: [
            `almanac refresh due ${id}${rootSuffix}`,
            `almanac refresh run ${id} --save${rootSuffix}`,
          ],
        });
        addDoctorReadiness(readiness, {
          status: "ready",
          name: "registration",
          message: "compiled almanac can be registered with supported clients",
          nextActions: [
            `almanac register ${id} --client=claude-code --apply${rootSuffix}`,
          ],
        });
      } catch (e) {
        add("fail", "almanac-read", (e as Error).message);
      }
    }
  } else {
    rootHygiene = await readRootHygieneReport(opts.root);
    add(
      rootHygiene.status === "needs-validation" ? "warn" : "ok",
      "root-hygiene",
      formatRootHygieneCheck(rootHygiene),
    );
    add(
      rootHygiene.cleanup.orphanedMcpRegistrations.length > 0 ||
        rootHygiene.cleanup.staleRegistrations.length > 0
        ? "warn"
        : "ok",
      "root-cleanup",
      formatRootCleanupCheck(rootHygiene),
    );
    addDoctorReadiness(readiness, {
      status: rootHygiene.status,
      name: "hygiene",
      message:
        rootHygiene.status === "ready"
          ? "root inventory has no blocking hygiene issues"
          : rootHygiene.status === "setup"
            ? "create or import an almanac before root hygiene can be validated"
            : rootHygiene.issues[0] ?? "root has lifecycle hygiene issues",
      nextActions: rootHygiene.nextActions,
    });
    addDoctorReadiness(readiness, {
      status: "setup",
      name: "answer",
      message: "create or select an almanac before running answer mode",
      nextActions: [
        `almanac demo${rootSuffix}`,
        `almanac doctor <id>${rootSuffix}`,
      ],
    });
    addDoctorReadiness(readiness, {
      status: "setup",
      name: "refresh",
      message: "create or select an almanac before checking refresh readiness",
      nextActions: [
        `almanac demo${rootSuffix}`,
        `almanac refresh due <id>${rootSuffix}`,
      ],
    });
    addDoctorReadiness(readiness, {
      status: "setup",
      name: "registration",
      message: "create or select an almanac before client registration",
      nextActions: [
        `almanac demo${rootSuffix}`,
        `almanac register <id> --client=claude-code${rootSuffix}`,
      ],
    });
  }

  const summary = {
    ok: checks.filter((check) => check.level === "ok").length,
    warn: checks.filter((check) => check.level === "warn").length,
    fail: checks.filter((check) => check.level === "fail").length,
  };

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          summary,
          checks,
          readiness,
          ...(rootHygiene === null ? {} : { rootHygiene }),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      `doctor${id ? `: ${id}` : ""}\n` +
        `  ok=${summary.ok} warn=${summary.warn} fail=${summary.fail}\n\n`,
    );
    for (const check of checks) {
      process.stdout.write(
        `  ${check.level.padEnd(4)} ${check.name.padEnd(24)} ${check.message}\n`,
      );
    }
    process.stdout.write("\nreadiness:\n");
    for (const item of readiness) {
      process.stdout.write(
        `  ${formatDoctorReadinessStatus(item.status)} ${item.name.padEnd(16)} ${
          item.message
        }\n`,
      );
      for (const action of item.nextActions.slice(0, 2)) {
        process.stdout.write(`    - ${action}\n`);
      }
    }
  }

  if (
    summary.fail > 0 ||
    (opts.strict === true && (summary.warn > 0 || summary.fail > 0))
  ) {
    process.exitCode = 1;
  }
}

function answerReadinessNextActions(
  id: string,
  rootSuffix: string,
  answerReadiness: AnswerReadiness,
): string[] {
  if (answerReadiness.fixtures.count === 0) {
    return [
      `almanac ask ${id} "<question>" --save${rootSuffix}`,
      `almanac ask-fixtures init ${id}${rootSuffix}`,
    ];
  }
  if (answerReadiness.latestSuite.status !== "passed") {
    return [`almanac ask-suite ${id}${rootSuffix}`];
  }
  if (answerReadiness.latestAnswer === null) {
    return [`almanac ask ${id} "<question>" --save${rootSuffix}`];
  }
  if (answerReadiness.qualityGate.status !== "pass") {
    return [
      `almanac runs ${id} ${answerReadiness.latestAnswer.answerId}${rootSuffix}`,
    ];
  }
  return [`almanac ask ${id} "<question>"${rootSuffix}`];
}

interface UpdateOptions {
  root: string;
  fromStage: StageId;
  bump: "major" | "minor" | "patch";
  /** Skip the version bump; useful when re-running because of an aborted update. */
  noBump?: boolean;
}

/**
 * Default stage to reset on `almanac update`. Stage 4 is the first stage that
 * touches external data (re-fetches sources), so refreshing from here picks up
 * any upstream changes while preserving the (LLM-derived) domain spec and
 * source-discovery decisions.
 */
const DEFAULT_UPDATE_FROM_STAGE: StageId = "04-source-fetch";

async function cmdUpdate(id: string, opts: UpdateOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }

  if (!STAGE_IDS.includes(opts.fromStage)) {
    fail(
      `--from-stage: unknown stage id "${opts.fromStage}". ` +
        `valid: ${STAGE_IDS.join(", ")}`,
    );
  }
  if (opts.fromStage === "00-bootstrap") {
    fail(
      "--from-stage=00-bootstrap is not supported; delete the almanac and use " +
        "`almanac new` to re-bootstrap from scratch.",
    );
  }

  const prevManifest = await readManifest(almanacDir);
  const prevState = await readCompileState(almanacDir);

  const nextVersion = opts.noBump
    ? prevManifest.version
    : bumpSemver(prevManifest.version, opts.bump);

  const nextManifest: AlmanacManifest = {
    ...prevManifest,
    version: nextVersion,
    forgerVersion: FORGER_VERSION,
  };

  const runId = generateRunId();
  const resetState = resetStagesForUpdate(prevState, opts.fromStage, {
    runId,
    now: new Date(),
  });

  await writeManifest(almanacDir, nextManifest);
  await writeCompileState(almanacDir, resetState);

  process.stdout.write(
    `▶ updating almanac "${id}" (${prevManifest.displayName})\n` +
      `    version       ${prevManifest.version} → ${nextVersion}\n` +
      `    fromStage     ${opts.fromStage}\n` +
      `    runId         ${runId}\n`,
  );

  const { runners, providerAvailable } = buildRunners();
  if (!providerAvailable) {
    process.stdout.write(
      "  ! ANTHROPIC_API_KEY not set; LLM-driven stages (01, 02a, 02b, 05, 06, 11) will be skipped " +
        "and Stage 7 will implement only the four default tools (custom tools disabled).\n",
    );
  }
  process.stdout.write("▶ running pipeline (stages 01–12)\n");

  const result = await runPipeline({
    almanacDir,
    state: resetState,
    manifest: nextManifest,
    runners,
    persistState: (s) => writeCompileState(almanacDir, s),
    persistManifest: (m) => writeManifestWithActualCounts(almanacDir, m),
    log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
  });

  process.stdout.write(
    `\n  succeeded: ${result.succeeded.length}` +
      `   skipped: ${result.skipped.length}` +
      `   failed: ${result.failed.length}\n`,
  );

  if (result.failed.length > 0) {
    const recovery = buildStageFailureRecovery({
      almanacId: id,
      root: opts.root,
      almanacDir,
      state: result.state,
      failedStages: result.failed,
    });
    process.stderr.write(
      formatPipelineFailureRecovery({
        recovery,
        failedStages: result.failed,
      }),
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nDone. \`almanac inspect ${id}\` to see status.\n`,
  );
}

interface ServeOptions {
  root: string;
  transport?: "stdio" | "http";
  host?: string;
  port?: string;
  path?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// export
// ──────────────────────────────────────────────────────────────────────────────

interface ExportOptions {
  root: string;
  output?: string;
  includeCompile?: boolean;
  includeRuns?: boolean;
}

interface ImportOptions {
  root: string;
  apply?: boolean;
  replace?: boolean;
  as?: string;
  json?: boolean;
}

interface WikiOptions {
  root: string;
  output?: string;
  json?: boolean;
}

async function cmdExport(id: string, opts: ExportOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);

  // Resolve output path. Relative paths are anchored at the cwd the user
  // ran the CLI from; absolute paths go through unchanged.
  const outputPath = opts.output
    ? resolve(opts.output)
    : defaultExportPath({
        almanacId: manifest.almanacId,
        version: manifest.version,
      });

  process.stdout.write(
    `▶ export almanac "${manifest.almanacId}" v${manifest.version}\n` +
      `    from   ${almanacDir}\n` +
      `    to     ${outputPath}\n` +
      `    extras ${formatExportExtras(opts)}\n\n`,
  );

  try {
    const result = await runExport({
      almanacDir,
      outputPath,
      ...(opts.includeCompile === true ? { includeCompile: true } : {}),
      ...(opts.includeRuns === true ? { includeRuns: true } : {}),
      log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
    });
    process.stdout.write(
      `\nDone.\n` +
        `    output  ${result.outputPath}\n` +
        `    size    ${formatBytes(result.byteLength)}\n` +
        `\nUnpack with:\n` +
        `    tar -xzf ${outputPath}\n` +
        `    almanac serve ${id} --root .\n`,
    );
  } catch (e) {
    if (e instanceof ExportFailedError) {
      fail(`export failed: ${e.message}`);
    }
    throw e;
  }
}

function formatExportExtras(opts: ExportOptions): string {
  return [
    opts.includeCompile === true ? "INCLUDE .compile/" : "exclude .compile/",
    opts.includeRuns === true ? "INCLUDE .runs/" : "exclude .runs/",
  ].join(", ");
}

async function cmdImport(archive: string, opts: ImportOptions): Promise<void> {
  const archivePath = resolve(archive);
  const root = resolve(opts.root);

  try {
    const result = await runImport({
      archivePath,
      root,
      ...(opts.apply === true ? { apply: true } : {}),
      ...(opts.replace === true ? { replace: true } : {}),
      ...(opts.as ? { targetId: opts.as } : {}),
    });

    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const mode =
      result.mode === "dry-run" ? "dry-run (no files written)" : "applied";
    const action =
      result.mode === "dry-run"
        ? result.collision
          ? "would replace existing target"
          : "would install"
        : result.replaced
          ? "replaced existing target"
          : "installed";

    process.stdout.write(
      `▶ import almanac archive\n` +
        `    archive  ${result.archivePath}\n` +
        `    root     ${result.root}\n` +
        `    top      ${result.topLevelDir}\n` +
        `    target   ${result.targetId}\n` +
        `    mode     ${mode}\n` +
        `    action   ${action}\n` +
        `    entries  ${result.entries}\n`,
    );

    if (result.mode === "dry-run") {
      process.stdout.write(
        `\nNo files were written. Re-run with --apply to install the archive.\n`,
      );
    } else {
      process.stdout.write(`\nDone.\n    dir     ${result.targetDir}\n`);
    }

    process.stdout.write(
      `\nNext actions:\n` +
        `    almanac status ${result.targetId} --root ${result.root}\n` +
        `    almanac benchmark ${result.targetId} --root ${result.root}\n`,
    );
  } catch (e) {
    if (e instanceof ImportValidationError || e instanceof ImportFailedError) {
      fail(`import failed: ${e.message}`);
    }
    throw e;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

async function cmdWiki(id: string, opts: WikiOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);
  const outputDir = opts.output
    ? resolve(opts.output)
    : defaultWikiExportDir({
        almanacId: manifest.almanacId,
        version: manifest.version,
      });

  const result = await runWikiExport({
    almanacDir,
    outputDir,
    log:
      opts.json === true
        ? () => {}
        : (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `wiki export: ${manifest.almanacId} (${manifest.displayName})\n` +
      `  output        ${result.outputDir}\n` +
      `  files         ${result.files.length}\n`,
  );
  for (const file of result.files) {
    process.stdout.write(`  - ${file.name} (${formatBytes(file.byteLength)})\n`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// feed
// ──────────────────────────────────────────────────────────────────────────────

interface FeedOptions {
  root: string;
  kind?: SourceKind;
  mode?: IngestionMode;
  trust?: string; // raw string from commander; we parse to number
  rationale?: string;
  sourceId?: string;
  scope?: string[];
  apply?: boolean;
  replace?: boolean;
}

async function cmdFeed(
  id: string,
  url: string,
  opts: FeedOptions,
): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  if (!/^https?:\/\//i.test(url)) {
    fail(
      `feed: <url> must be http:// or https:// (got "${url}"). ` +
        "file:// support lands in v0.3+.",
    );
  }

  const apply = opts.apply === true;
  const trust =
    opts.trust !== undefined ? Number.parseFloat(opts.trust) : undefined;
  if (trust !== undefined && (!Number.isFinite(trust) || trust < 0 || trust > 1)) {
    fail(`feed: --trust must be a number in [0, 1] (got "${opts.trust}")`);
  }
  const replace = opts.replace === true;
  if (replace && opts.sourceId === undefined) {
    fail("feed: --replace requires --source-id so the existing source is explicit");
  }

  const provider = apply
    ? resolveProvider()
    : createMockProvider({ defaultResponse: "" });
  if (provider === null) {
    fail(
      "feed: ANTHROPIC_API_KEY is not set, but Stage 5 fact extraction needs an LLM. " +
        "Export ANTHROPIC_API_KEY (or set ALMANAC_LLM=mock for an experimentation no-op).",
    );
  }

  process.stdout.write(
    `▶ feed almanac "${id}" ← ${url}\n` +
      `    mode          ${
        replace
          ? apply
            ? "REPLACE (writes will be made)"
            : "REPLACE DRY RUN (re-run with --apply to write)"
          : apply
            ? "APPLY (writes will be made)"
            : "DRY RUN (re-run with --apply to write)"
      }\n\n`,
  );

  try {
    const result = await runFeed({
      almanacDir,
      url,
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(trust !== undefined ? { trust } : {}),
      ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      apply,
      replaceExisting: replace,
      llm: provider,
      fetchers: defaultFetchers(),
      log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
    });

    process.stdout.write("\n");
    if (result.kind === "dry-run") {
      const nextCount =
        result.operation === "replace"
          ? result.existingSourcesCount
          : result.existingSourcesCount + 1;
      process.stdout.write(
        `Would ${result.operation} source:\n` +
          `    id            ${result.newSource.id}\n` +
          `    url           ${result.newSource.url}\n` +
          `    kind          ${result.newSource.kind}\n` +
          `    mode          ${result.newSource.ingestion.mode}\n` +
          `    trust         ${result.newSource.trust}\n` +
          (result.replacedSource !== null
            ? `    replaces      ${result.replacedSource.id} (${result.replacedSource.ingestion.mode})\n`
            : "") +
          `    sources       ${result.existingSourcesCount} → ${nextCount}\n\n` +
          `Re-run with --apply to fetch + extract + reindex.\n`,
      );
    } else if (result.kind === "skipped") {
      process.stdout.write(`Skipped: ${result.reason}\n`);
    } else {
      process.stdout.write(
        `Done.\n` +
          `    operation     ${result.operation}\n` +
          `    source        ${result.newSource.id}\n` +
          `    fetch status  ${result.fetchEntry.status}\n` +
          `    facts added   ${result.factsAdded}\n` +
          `    total facts   ${result.newFactCount}\n` +
          `    version       → ${result.newVersion}\n`,
      );
    }
  } catch (e) {
    if (e instanceof FeedAlreadyExistsError) {
      fail(e.message);
    }
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// remove
// ──────────────────────────────────────────────────────────────────────────────

interface RemoveOptions {
  root: string;
  /** If false (default), print what would happen but don't touch disk. */
  apply?: boolean;
  /** Skip the client-config cleanup pass; only delete the almanac dir. */
  keepRegistrations?: boolean;
}

async function cmdRemove(id: string, opts: RemoveOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);
  const apply = opts.apply === true;
  const serverName = mcpServerName(manifest.almanacId);

  process.stdout.write(
    `▶ remove almanac "${manifest.almanacId}" (${manifest.displayName})\n` +
      `    dir           ${almanacDir}\n` +
      `    mode          ${apply ? "APPLY (deletes will happen)" : "DRY RUN (re-run with --apply to delete)"}\n\n`,
  );

  // Pass 1 — client-config cleanup. Iterate every known ClientProfile and
  // try to remove any entry for this almanac. Missing configs are fine —
  // the user may have only registered with one client.
  if (opts.keepRegistrations !== true) {
    for (const profile of Object.values(CLIENT_PROFILES)) {
      await unregisterMcp({
        profileName: profile.name,
        serverName,
        mcpConfigPath: profile.mcpConfigPath,
        format: profile.format,
        mcpServersKey: profile.mcpServersKey,
        apply,
      });
      if (profile.skillsDir !== null) {
        await unregisterSkill({
          profileName: profile.name,
          almanacId: manifest.almanacId,
          skillsDir: profile.skillsDir,
          apply,
        });
      }
    }
    process.stdout.write("\n");
  }

  // Pass 2 — delete the almanac dir itself.
  process.stdout.write(`◆ almanac directory\n    ${almanacDir}\n`);
  if (!apply) {
    process.stdout.write("    (would rm -rf)\n");
  } else {
    const { rm } = await import("node:fs/promises");
    await rm(almanacDir, { recursive: true, force: true });
    process.stdout.write("    ✓ removed\n");
  }

  if (!apply) {
    process.stdout.write(
      "\nNothing was written. Re-run with --apply to perform the removal.\n",
    );
  }
}

/**
 * Remove `mcpServers[<serverName>]` from a client's MCP config, if present.
 * Missing configs and missing entries are no-ops (the user may have only
 * registered with a subset of clients).
 */
async function unregisterMcp(args: {
  profileName: RegisterClient;
  serverName: string;
  mcpConfigPath: string;
  format: McpConfigFormat;
  mcpServersKey: string;
  apply: boolean;
}): Promise<void> {
  process.stdout.write(`◆ ${args.profileName} mcp server "${args.serverName}"\n`);
  if (!existsSync(args.mcpConfigPath)) {
    process.stdout.write(`    skipped — config not found at ${args.mcpConfigPath}\n`);
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = parseMcpConfig(await readFile(args.mcpConfigPath, "utf8"), args.format);
  } catch (e) {
    process.stdout.write(
      `    ! config at ${args.mcpConfigPath} is not valid ${args.format.toUpperCase()}: ${(e as Error).message} — skipping\n`,
    );
    return;
  }
  const servers = config[args.mcpServersKey] as
    | Record<string, unknown>
    | undefined;
  if (!servers || !(args.serverName in servers)) {
    process.stdout.write(
      `    skipped — no entry at ${args.mcpServersKey}["${args.serverName}"]\n`,
    );
    return;
  }
  process.stdout.write(`    config ${args.mcpConfigPath} (${args.format})\n`);
  process.stdout.write(
    `    would remove ${args.mcpServersKey}["${args.serverName}"]\n`,
  );
  if (!args.apply) return;
  delete servers[args.serverName];
  await writeMcpConfigAtomic({
    path: args.mcpConfigPath,
    config,
    format: args.format,
  });
  process.stdout.write(`    ✓ removed\n`);
}

/**
 * Remove `<skillsDir>/almanac-<id>/` if present. Missing dir = no-op.
 */
async function unregisterSkill(args: {
  profileName: RegisterClient;
  almanacId: string;
  skillsDir: string;
  apply: boolean;
}): Promise<void> {
  process.stdout.write(`◆ ${args.profileName} skill\n`);
  const skillDir = join(args.skillsDir, `almanac-${args.almanacId}`);
  if (!existsSync(skillDir)) {
    process.stdout.write(`    skipped — no skill at ${skillDir}\n`);
    return;
  }
  process.stdout.write(`    would rm -rf ${skillDir}\n`);
  if (!args.apply) return;
  const { rm } = await import("node:fs/promises");
  await rm(skillDir, { recursive: true, force: true });
  process.stdout.write(`    ✓ removed\n`);
}

async function cmdServe(id: string, opts: ServeOptions): Promise<void> {
  const dir = almanacDirPath(opts.root, id);
  if (!existsSync(dir)) {
    fail(`almanac not found: ${dir}`);
  }
  const transport = opts.transport ?? "stdio";
  const serverInfo = { name: `almanac-${id}`, version: FORGER_VERSION };
  const log = (e: unknown) => process.stderr.write(JSON.stringify(e) + "\n");

  if (transport === "stdio") {
    // stdout is reserved for the JSON-RPC stream; structured logs go to stderr.
    await serveAlmanacOverStdio({
      almanacDir: dir,
      serverInfo,
      log,
    });
    return;
  }

  if (transport === "http") {
    const port = parseServePort(opts.port ?? "7331");
    const handle = await serveAlmanacOverHttp({
      almanacDir: dir,
      serverInfo,
      hostname: opts.host ?? "127.0.0.1",
      port,
      path: opts.path ?? "/mcp",
      log,
    });
    process.stderr.write(
      `▶ MCP Streamable HTTP server\n` +
        `    url       ${handle.url}\n` +
        `    health    ${new URL("/health", handle.url).toString()}\n`,
    );
    await waitForShutdown(async () => {
      await handle.close();
    });
    return;
  }

  fail(`serve: unsupported --transport "${transport}"`);
}

function parseServePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`serve: --port must be an integer in [0, 65535] (got "${raw}")`);
  }
  return port;
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void stop().finally(resolve);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// register
// ──────────────────────────────────────────────────────────────────────────────

type RegisterClient = "claude-code" | "claude-desktop" | "cursor" | "codex";
type RegisterTarget = "skill" | "mcp" | "both";

interface RegisterOptions {
  root: string;
  client: RegisterClient;
  target: RegisterTarget;
  /** Read client registration state without writing files. */
  status?: boolean;
  /** With --status, inspect every supported client. */
  all?: boolean;
  /** With --status, emit JSON instead of human-readable output. */
  json?: boolean;
  /** If false (default), print what would happen but don't touch disk. */
  apply?: boolean;
  /** Override the destination skills directory. */
  skillsDir?: string;
  /** Override the MCP config path. */
  mcpConfig?: string;
}

interface ClientProfile {
  /** Human-friendly client name. */
  readonly name: RegisterClient;
  /** Default MCP config path. */
  readonly mcpConfigPath: string;
  /**
   * Default skill destination directory. `null` for clients that don't have
   * a skills concept; `--target=skill` (or `both`) becomes a no-op for them.
   */
  readonly skillsDir: string | null;
  /** Wire format of the MCP config file. */
  readonly format: McpConfigFormat;
  /**
   * Top-level key under which MCP server entries live in the config file.
   * Claude / Cursor use `mcpServers` (camelCase, JSON convention); Codex
   * uses `mcp_servers` (snake_case, TOML convention).
   */
  readonly mcpServersKey: string;
}

const CLIENT_PROFILES: Readonly<Record<RegisterClient, ClientProfile>> = {
  "claude-code": {
    name: "claude-code",
    mcpConfigPath: join(homedir(), ".claude.json"),
    skillsDir: join(homedir(), ".claude", "skills"),
    format: "json",
    mcpServersKey: "mcpServers",
  },
  "claude-desktop": {
    name: "claude-desktop",
    // macOS-only default. Linux/Windows users can override with --mcp-config.
    // See https://modelcontextprotocol.io/quickstart/user
    mcpConfigPath: join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
    skillsDir: null, // Claude Desktop has no skills concept.
    format: "json",
    mcpServersKey: "mcpServers",
  },
  cursor: {
    name: "cursor",
    mcpConfigPath: join(homedir(), ".cursor", "mcp.json"),
    skillsDir: null, // Cursor has no skills concept.
    format: "json",
    mcpServersKey: "mcpServers",
  },
  codex: {
    name: "codex",
    // Codex CLI reads MCP servers from this TOML file. See
    // https://github.com/openai/codex/blob/main/codex-rs/config.md
    mcpConfigPath: join(homedir(), ".codex", "config.toml"),
    skillsDir: null, // Codex has no skills concept.
    format: "toml",
    mcpServersKey: "mcp_servers",
  },
};

/**
 * The MCP server name advertised by `almanac serve <id>` is `almanac-<id>` —
 * Stage 10's SKILL.md hard-codes `mcp__almanac-<id>__<tool>` references, so
 * the registered MCP config MUST use this exact key for tool routing to work.
 */
function mcpServerName(almanacId: string): string {
  return `almanac-${almanacId}`;
}

/**
 * Absolute path to this CLI entry. Used so the generated MCP command works
 * regardless of the user's current working directory.
 */
function selfCliPath(): string {
  return fileURLToPath(import.meta.url);
}

interface RegisterStatusReport {
  almanacId: string;
  almanacDir: string;
  client: RegisterClient | "all";
  target: RegisterTarget;
  clients: RegistrationClientState[];
  summary: RegistrationOverallStatus;
}

async function cmdRegisterStatus(
  id: string,
  opts: RegisterOptions,
  manifest: AlmanacManifest,
  almanacDir: string,
  profile: ClientProfile,
): Promise<void> {
  if (opts.apply === true) {
    fail("register: --status is read-only; omit --apply");
  }
  if (opts.all === true && (opts.skillsDir !== undefined || opts.mcpConfig !== undefined)) {
    fail("register: --all cannot be combined with --skills-dir or --mcp-config");
  }
  const profiles =
    opts.all === true ? Object.values(CLIENT_PROFILES) : [profile];
  const clients = await Promise.all(
    profiles.map((clientProfile) =>
      readRegistrationClientState({
        almanacDir,
        manifest,
        root: opts.root,
        profile: clientProfile,
        target: opts.target,
        ...(opts.all === true
          ? {}
          : {
              skillsDir: opts.skillsDir ?? clientProfile.skillsDir,
              mcpConfigPath: opts.mcpConfig ?? clientProfile.mcpConfigPath,
            }),
      }),
    ),
  );
  const report: RegisterStatusReport = {
    almanacId: manifest.almanacId,
    almanacDir,
    client: opts.all === true ? "all" : opts.client,
    target: opts.target,
    clients,
    summary: aggregateRegistrationStatus(clients),
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `registration status: ${manifest.almanacId} (${manifest.displayName})\n` +
      `  target        ${opts.target}\n` +
      `  client        ${report.client}\n` +
      `  summary       ${report.summary}\n` +
      `  mode          READ ONLY\n\n`,
  );
  for (const client of report.clients) {
    process.stdout.write(`◆ ${client.client}  ${client.status}\n`);
    process.stdout.write(formatRegistrationComponent("skill", client.skill));
    process.stdout.write(formatRegistrationComponent("mcp", client.mcp));
    if (client.nextActions.length > 0) {
      process.stdout.write(`  repair\n`);
      for (const action of client.nextActions) {
        process.stdout.write(`    - ${action}\n`);
      }
    }
    process.stdout.write("\n");
  }
}

function formatRegistrationComponent(
  label: "skill" | "mcp",
  component: RegistrationComponentState,
): string {
  const path = component.path === null ? "" : ` ${component.path}`;
  let out = `  ${label.padEnd(6)} ${component.status}${path}\n`;
  for (const issue of component.issues) {
    out += `    - ${issue}\n`;
  }
  return out;
}

async function cmdRegister(id: string, opts: RegisterOptions): Promise<void> {
  const profile = CLIENT_PROFILES[opts.client];
  if (profile === undefined) {
    fail(
      `unsupported --client "${opts.client}"; supported: ${Object.keys(CLIENT_PROFILES).join(", ")}`,
    );
  }
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);
  if (opts.json === true && opts.status !== true) {
    fail("register: --json is only supported with --status");
  }
  if (opts.all === true && opts.status !== true) {
    fail("register: --all requires --status");
  }
  if (opts.status === true) {
    await cmdRegisterStatus(id, opts, manifest, almanacDir, profile);
    return;
  }
  const apply = opts.apply === true;
  const skillsDir = opts.skillsDir ?? profile.skillsDir;
  const mcpConfigPath = opts.mcpConfig ?? profile.mcpConfigPath;
  const serverName = mcpServerName(manifest.almanacId);

  process.stdout.write(
    `▶ register almanac "${manifest.almanacId}" (${manifest.displayName}) → ${opts.client}\n` +
      `    target        ${opts.target}\n` +
      `    mode          ${apply ? "APPLY (writes will be made)" : "DRY RUN (re-run with --apply to write)"}\n\n`,
  );

  if (opts.target === "skill" || opts.target === "both") {
    if (skillsDir === null) {
      process.stdout.write(
        `◆ skill\n  ! ${opts.client} has no skills concept; skipping\n\n`,
      );
    } else {
      await registerSkill({
        almanacDir,
        almanacId: manifest.almanacId,
        skillsDir,
        apply,
      });
      process.stdout.write("\n");
    }
  }

  if (opts.target === "mcp" || opts.target === "both") {
    await registerMcp({
      almanacId: manifest.almanacId,
      serverName,
      mcpConfigPath,
      cliPath: selfCliPath(),
      almanacRoot: resolve(opts.root),
      format: profile.format,
      mcpServersKey: profile.mcpServersKey,
      apply,
    });
    process.stdout.write("\n");
  }

  if (!apply) {
    process.stdout.write(
      "Nothing was written. Re-run with --apply to perform the registration.\n",
    );
  }
}

async function registerSkill(args: {
  almanacDir: string;
  almanacId: string;
  skillsDir: string;
  apply: boolean;
}): Promise<void> {
  const srcPath = join(args.almanacDir, "adapters", "skill", "SKILL.md");
  const destDir = join(args.skillsDir, `almanac-${args.almanacId}`);
  const destPath = join(destDir, "SKILL.md");

  process.stdout.write(`◆ skill\n`);
  if (!existsSync(srcPath)) {
    process.stdout.write(
      `  ! source SKILL.md not found at ${srcPath}\n` +
        `    (run Stage 10 — \`almanac update ${args.almanacId} --from-stage=10-adapter-generation\` — first)\n`,
    );
    return;
  }
  process.stdout.write(`    from   ${srcPath}\n`);
  process.stdout.write(`    to     ${destPath}\n`);
  if (!args.apply) return;
  await mkdir(destDir, { recursive: true });
  await copyFile(srcPath, destPath);
  process.stdout.write(`    ✓ copied\n`);
}

async function registerMcp(args: {
  almanacId: string;
  serverName: string;
  mcpConfigPath: string;
  cliPath: string;
  almanacRoot: string;
  format: McpConfigFormat;
  mcpServersKey: string;
  apply: boolean;
}): Promise<void> {
  const entry = {
    command: "bun",
    args: ["run", args.cliPath, "serve", args.almanacId, "--root", args.almanacRoot],
  };
  process.stdout.write(`◆ mcp server "${args.serverName}"\n`);
  process.stdout.write(`    config ${args.mcpConfigPath} (${args.format})\n`);
  process.stdout.write(
    `    entry  ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n           ")}\n`,
  );

  if (!args.apply) return;

  // Read-modify-write the config. If it doesn't exist yet, create a minimal one.
  let config: Record<string, unknown> = {};
  if (existsSync(args.mcpConfigPath)) {
    const raw = await readFile(args.mcpConfigPath, "utf8");
    try {
      config = parseMcpConfig(raw, args.format);
    } catch (e) {
      fail(
        `MCP config at ${args.mcpConfigPath} is not valid ${args.format.toUpperCase()}: ${(e as Error).message}\n` +
          `       fix the file or pass --mcp-config=<path> to use a different one.`,
      );
    }
  }
  const servers: Record<string, unknown> =
    (config[args.mcpServersKey] as Record<string, unknown>) ?? {};
  const existed = args.serverName in servers;
  servers[args.serverName] = entry;
  config[args.mcpServersKey] = servers;

  await writeMcpConfigAtomic({
    path: args.mcpConfigPath,
    config,
    format: args.format,
  });
  process.stdout.write(
    `    ✓ ${existed ? "updated" : "added"} ${args.mcpServersKey}["${args.serverName}"]\n`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Wire up commander
// ──────────────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("almanac")
  .description("Compile a domain almanac. Always-fresh. As CLI, MCP, and Skill.")
  .version(FORGER_VERSION);

const rootOption = new Option(
  "--root <dir>",
  "Almanac root directory (env: ALMANAC_ROOT)",
).default(defaultAlmanacRoot(), "$ALMANAC_ROOT or ~/.almanac/almanacs");

program
  .command("new <domain>")
  .description("bootstrap a new almanac and run the compile pipeline")
  .option("--display-name <name>", "Title-case display name (default: derived from domain)")
  .option("--slug <id>", "canonicalSlug (default: slugify(domain))")
  .addOption(
    new Option("--profile <id>", "Freshness profile")
      .choices(["static-heavy", "mixed", "live-heavy"])
      .default("mixed"),
  )
  .addOption(
    new Option("--depth <level>", "Compile depth")
      .choices(["quick", "standard", "deep"])
      .default("standard"),
  )
  .addOption(
    new Option("--target <which>", "Adapter target")
      .choices(["mcp", "skill", "both"])
      .default("both"),
  )
  .option("--source <hint...>", "User-supplied source hint(s); repeatable", [])
  .option(
    "--scope <text>",
    "One-paragraph scope narrowing fed into Stage 1 (useful for abstract domains)",
  )
  .option("--require-approval", "Require human approval after Stage 2 (default: auto-approve)")
  .option(
    "--review",
    "Pause after Stage 1 to review (and optionally edit) the DomainSpec before continuing",
  )
  .option("--bootstrap-only", "Stop after Stage 0 (skip the rest of the pipeline)")
  .option(
    "--resume",
    "Continue a previously-interrupted run: skip bootstrap and re-execute any non-completed stages",
  )
  .addOption(rootOption)
  .action(cmdNew);

program
  .command("demo [id]")
  .description("create a complete offline demo almanac with curated fixtures")
  .option("--force", "Replace an existing demo almanac at the same id")
  .addOption(rootOption)
  .action(cmdDemo);

program
  .command("list")
  .description("list compiled almanacs under the root directory")
  .option("--json", "Emit JSON instead of a table")
  .addOption(rootOption)
  .action(cmdList);

program
  .command("status <id>")
  .description("show a compact lifecycle status for an almanac")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdStatus);

program
  .command("maintain [id]")
  .description("plan or apply provider-aware due maintenance")
  .option("--all", "Plan or apply maintenance for every almanac under the root")
  .option("--apply", "Run due maintenance and save a maintenance artifact")
  .option("--due-only", "Skip almanacs that are not due for refresh or benchmark")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--dry-run", "Show the maintenance plan without writing files")
  .option("--label <name>", "Short label for saved maintenance artifacts")
  .option("--note <text>", "Human note for saved maintenance artifacts")
  .addOption(rootOption)
  .action(cmdMaintain);

program
  .command("inspect <id>")
  .description("print manifest + per-stage state for an almanac")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdInspect);

program
  .command("profile <id>")
  .description("summarize expertise, evidence, validation, and limits")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdProfile);

program
  .command("path <id>")
  .description("print the absolute path to an almanac directory")
  .addOption(rootOption)
  .action(cmdPath);

program
  .command("run <id>")
  .description("invoke one compiled almanac tool locally")
  .option("--tool <name>", "Tool name to invoke, e.g. query_facts")
  .option("--input <json>", "JSON object input for the tool (default: {})")
  .option("--input-file <path>", "Read JSON object input from a file")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--label <name>", "Short label for --save audit artifacts")
  .option("--list-tools", "List enabled tools without invoking one")
  .option("--note <text>", "Human note for --save audit artifacts")
  .option("--save", "Save a run artifact under <almanac>/.runs/")
  .addOption(rootOption)
  .action(cmdRun);

program
  .command("ask <id> <question>")
  .description("synthesize a cited one-shot answer from a compiled almanac")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--label <name>", "Short label for --save answer artifacts")
  .option("--model <name>", "Override the answer planner/synthesis model")
  .option("--note <text>", "Human note for --save answer artifacts")
  .option("--save", "Save an answer artifact under <almanac>/.runs/")
  .addOption(rootOption)
  .action(cmdAsk);

program
  .command("ask-replay <id>")
  .description("replay saved or fixture answer runs; --judge opts into an LLM")
  .option("--fixture <path>", "Read replay cases from JSONL fixture file")
  .option("--from-runs", "Replay saved answer artifacts under <almanac>/.runs/")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--label <name>", "With --from-runs, replay only this answer label")
  .option("--judge", "Run an explicit LLM entailment judge over replayed answers")
  .option("--judge-model <model>", "Model to use for --judge")
  .addOption(rootOption)
  .action(cmdAskReplay);

program
  .command("ask-suite <id>")
  .description("run deterministic ask fixture suite gate; --judge opts into an LLM")
  .option(
    "--fixture <path>",
    "Read fixture JSONL path (repeatable; default: known paths)",
    collectAskSuiteFixture,
    [] as string[],
  )
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--judge", "Run an explicit LLM entailment judge over fixture answers")
  .option("--judge-model <model>", "Model to use for --judge")
  .addOption(rootOption)
  .action(cmdAskSuite);

const askFixturesCommand = program
  .command("ask-fixtures")
  .description("author ask replay fixture JSONL without an LLM provider");

askFixturesCommand
  .command("init <id>")
  .description("create an ask replay fixture JSONL file")
  .option(
    "--fixture <path>",
    "Fixture JSONL path (default: <almanac>/tests/ask.jsonl)",
  )
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--overwrite", "Replace an existing fixture file with an empty file")
  .addOption(rootOption)
  .action(cmdAskFixturesInit);

askFixturesCommand
  .command("add-from-run <id> <answerId>")
  .description("append a saved answer artifact to an ask replay fixture file")
  .option(
    "--fixture <path>",
    "Fixture JSONL path (default: <almanac>/tests/ask.jsonl)",
  )
  .option("--fixture-id <id>", "Override the fixture id (default: answer id)")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdAskFixturesAddFromRun);

program
  .command("runs <id> [runId]")
  .description("view saved local run artifacts")
  .option("--apply", "Apply --prune and delete selected artifacts")
  .option("--dry-run", "Preview --prune without deleting artifacts")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--keep-latest <n>", "With --prune, keep this many newest artifacts")
  .addOption(
    new Option("--kind <kind>", "Filter list by saved artifact kind").choices([
      "tool",
      "refresh",
      "answer",
      "maintenance",
    ]),
  )
  .option("--label <name>", "Filter list by saved artifact label")
  .option("--latest", "Show only the newest run artifact")
  .option("--limit <n>", "Maximum number of newest run artifacts to list")
  .option(
    "--older-than <duration>",
    "With --prune, delete artifacts older than 30d/12h/90m/4w",
  )
  .option("--prune", "Select saved run artifacts for retention cleanup")
  .addOption(
    new Option("--status <status>", "Filter list by saved artifact status")
      .choices([
        "ok",
        "tool-error",
        "bad-input",
        "tool-not-found",
        "failed",
        "not-due",
        "skipped",
        "locked",
        "abstained",
        "bad-tool-input",
        "budget-exhausted",
        "model-error",
      ]),
  )
  .addOption(rootOption)
  .action(cmdRuns);

const refreshCommand = program
  .command("refresh")
  .description("inspect and run refresh workflows");

refreshCommand
  .command("due <id>")
  .description("check whether an almanac is due for refresh without writing files")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdRefreshDue);

refreshCommand
  .command("run <id>")
  .description("run a manual refresh using the update pipeline")
  .addOption(
    new Option(
      "--from-stage <id>",
      "Earliest stage to reset; omitted uses refresh due recommendation",
    ),
  )
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--ask-suite", "Run deterministic ask fixture suite after refresh")
  .option("--label <name>", "Human label for --save refresh artifacts")
  .option("--note <text>", "Human note for --save refresh artifacts")
  .option("--save", "Save a refresh artifact under <almanac>/.runs/")
  .addOption(rootOption)
  .action(cmdRefreshRun);

program
  .command("sources <id>")
  .description("review approved and rejected sources for an almanac")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--rejected", "Show rejected source candidates")
  .addOption(
    new Option("--kind <name>", "Filter accepted sources by kind").choices([
      "docs",
      "community",
      "academic",
      "data",
      "news",
      "repo",
      "file",
      "essay",
      "book",
      "talk",
    ]),
  )
  .addOption(rootOption)
  .action(cmdSources);

program
  .command("benchmark <id>")
  .description("initialize or run human-authored golden benchmark fixtures")
  .option("--init", "Write starter tests/positive.jsonl and tests/negative.jsonl")
  .option("--force", "Replace existing fixtures when used with --init")
  .option("--json", "Emit the benchmark report as JSON")
  .addOption(rootOption)
  .action(cmdBenchmark);

program
  .command("doctor [id]")
  .description("diagnose CLI, environment, and optional almanac artifacts")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .option("--strict", "Exit non-zero on warnings as well as failures")
  .addOption(rootOption)
  .action(cmdDoctor);

program
  .command("update <id>")
  .description(
    "refresh an existing almanac: reset stages from --from-stage onwards and re-run the pipeline",
  )
  .addOption(
    new Option(
      "--from-stage <id>",
      "Earliest stage to reset back to pending (default: 04-source-fetch)",
    ).default(DEFAULT_UPDATE_FROM_STAGE),
  )
  .addOption(
    new Option("--bump <kind>", "Semver bump for manifest.version")
      .choices(["major", "minor", "patch"])
      .default("patch"),
  )
  .option(
    "--no-bump",
    "Do not bump manifest.version (keep the current version string)",
  )
  .addOption(rootOption)
  .action(cmdUpdate);

program
  .command("serve <id>")
  .description("start the MCP server for an almanac")
  .addOption(
    new Option("--transport <transport>", "MCP transport")
      .choices(["stdio", "http"])
      .default("stdio"),
  )
  .option("--host <host>", "HTTP bind host when --transport=http", "127.0.0.1")
  .option("--port <port>", "HTTP bind port when --transport=http", "7331")
  .option("--path <path>", "HTTP MCP endpoint path when --transport=http", "/mcp")
  .addOption(rootOption)
  .action(cmdServe);

program
  .command("remove <id>")
  .description(
    "delete a compiled almanac and clean up any client registrations (dry-run by default)",
  )
  .option("--apply", "Actually perform the deletions (default: dry-run)")
  .option(
    "--keep-registrations",
    "Skip the client-config cleanup pass; only remove the almanac directory",
  )
  .addOption(rootOption)
  .action(cmdRemove);

program
  .command("export <id>")
  .description(
    "package a compiled almanac as a portable .tar.gz archive",
  )
  .option(
    "--output <path>",
    "Output .tar.gz path (default: ./almanac-<id>-<version>.tar.gz)",
  )
  .option(
    "--include-compile",
    "Include the .compile/ directory (Stage 1–6 intermediates); default: exclude",
  )
  .option(
    "--include-runs",
    "Include saved .runs/ artifacts from almanac run --save; default: exclude",
  )
  .addOption(rootOption)
  .action(cmdExport);

program
  .command("import <archive>")
  .description(
    "inspect or install an exported almanac archive (dry-run by default)",
  )
  .option("--apply", "Actually extract the archive into the root")
  .option("--replace", "Allow replacing an existing target almanac directory")
  .option("--as <id>", "Import under a different almanac id")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdImport);

program
  .command("wiki <id>")
  .description("export a Markdown inspection bundle for a compiled almanac")
  .option(
    "--output <dir>",
    "Output directory (default: ./almanac-<id>-<version>-wiki)",
  )
  .option("--json", "Emit result metadata as JSON")
  .addOption(rootOption)
  .action(cmdWiki);

program
  .command("feed <id> <url>")
  .description(
    "incrementally add one source to a compiled almanac (fetch + extract + reindex; dry-run by default)",
  )
  .addOption(
    new Option("--kind <name>", "Source kind (default: docs)").choices([
      "docs",
      "community",
      "academic",
      "data",
      "news",
      "repo",
      "file",
      "essay",
      "book",
      "talk",
    ]),
  )
  .addOption(
    new Option("--mode <which>", "Ingestion mode (default: snapshot)").choices([
      "snapshot",
      "index-only",
    ]),
  )
  .option("--trust <n>", "Trust score in [0, 1] (default: 0.85)")
  .option("--rationale <text>", "One-line reason for adding this source")
  .option("--source-id <id>", "Override the derived source id (must be lowercase kebab-case)")
  .option(
    "--replace",
    "Replace the existing source matching --source-id instead of adding",
  )
  .option(
    "--scope <glob...>",
    "ingestion.scope globs (repeatable; default per-kind)",
  )
  .option("--apply", "Actually perform the changes (default: dry-run)")
  .addOption(rootOption)
  .action(cmdFeed);

program
  .command("register <id>")
  .description(
    "register an almanac with a downstream client (copies SKILL.md when supported, merges MCP server entry)",
  )
  .addOption(
    new Option("--client <name>", "Target client")
      .choices(Object.keys(CLIENT_PROFILES))
      .default("claude-code"),
  )
  .addOption(
    new Option("--target <what>", "What to register")
      .choices(["skill", "mcp", "both"])
      .default("both"),
  )
  .option("--status", "Inspect registration state without writing files")
  .option("--all", "With --status, inspect every supported client")
  .option("--json", "With --status, emit JSON")
  .option("--apply", "Actually perform the writes (default: dry-run)")
  .option(
    "--skills-dir <path>",
    "Override the destination skills directory (default: per-client; null for clients without skills)",
  )
  .option(
    "--mcp-config <path>",
    "Override the MCP config path (default: per-client — Claude Code, Claude Desktop, and Cursor have distinct defaults)",
  )
  .addOption(rootOption)
  .action(cmdRegister);

program.parseAsync(process.argv).catch((e) => {
  fail((e as Error).message);
});
