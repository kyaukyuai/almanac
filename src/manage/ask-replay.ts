/**
 * Deterministic replay for saved or fixture-authored answer sessions.
 *
 * This intentionally does not call an LLM provider. It re-executes recorded
 * tool calls and compares the observed evidence shape to expected answer-mode
 * outcomes.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { readManifest } from "../compile/storage.ts";
import {
  AnswerArtifactStatusSchema,
  AnswerToolCallStatusSchema,
  ToolNameSchema,
  type AnswerArtifact,
  type AnswerArtifactStatus,
  type AnswerToolCallStatus,
  type ToolError,
  type ToolResultFreshness,
} from "../core/types.ts";
import {
  listRunToolArtifacts,
  readRunToolArtifact,
  runTool,
} from "./run-tool.ts";
import {
  evaluateAnswerQualityGate,
  type AnswerQualityGateResult,
} from "./answer-quality.ts";

const AskReplayFixtureToolCallSchema = z.object({
  tool: ToolNameSchema,
  input: z.record(z.unknown()).optional(),
  expectedStatus: AnswerToolCallStatusSchema.optional(),
});

export const AskReplayFixtureSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/, "must be a stable fixture id"),
    question: z.string().trim().min(1).max(4000),
    toolCalls: z.array(AskReplayFixtureToolCallSchema).min(1).max(20),
    expectedStatus: AnswerArtifactStatusSchema,
    minCitations: z.number().int().nonnegative().optional(),
    maxStaleCitations: z.number().int().nonnegative().optional(),
    unsupportedClaims: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .optional(),
    maxUnsupportedClaims: z.number().int().nonnegative().optional(),
    expectedAbstentionReason: z.string().trim().min(1).max(2000).optional(),
  })
  .superRefine((fixture, ctx) => {
    if (
      fixture.expectedStatus === "abstained" &&
      fixture.expectedAbstentionReason === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedAbstentionReason"],
        message:
          "expectedAbstentionReason is required when expectedStatus is abstained",
      });
    }
  });
export type AskReplayFixture = z.infer<typeof AskReplayFixtureSchema>;

export interface RunAskReplayFromFixturesOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  fixtures: AskReplayFixture[];
}

export interface RunAskReplayFromFixtureFileOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Absolute or cwd-relative JSONL fixture file path. */
  fixturePath: string;
}

export interface RunAskReplayFromSavedRunsOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Optional saved answer label filter. */
  label?: string;
}

export interface AskReplayToolObservation {
  callIndex: number;
  toolName: string;
  input: Record<string, unknown> | null;
  status: AnswerToolCallStatus;
  durationMs: number;
  citationsCount: number;
  freshness?: ToolResultFreshness;
  error?: ToolError;
}

export interface AskReplayResultEntry {
  fixtureId: string;
  question: string;
  source:
    | { kind: "fixture"; line?: number }
    | {
        kind: "answer-artifact";
        answerId: string;
        artifactRelPath: string;
        label?: string;
      };
  expected: {
    status: AnswerArtifactStatus;
    minCitations?: number;
    maxStaleCitations?: number;
    maxUnsupportedClaims?: number;
    unsupportedClaimCount: number;
    abstentionReason?: string;
    toolStatuses: Array<{
      callIndex: number;
      toolName: string;
      status?: AnswerToolCallStatus;
    }>;
  };
  observed: {
    status: AnswerArtifactStatus;
    citationsCount: number;
    staleCitationCount: number;
    abstentionReason?: string;
    toolCalls: AskReplayToolObservation[];
  };
  quality: AnswerQualityGateResult;
  status: "pass" | "fail" | "error";
  reasons: string[];
}

export interface AskReplayReport {
  schemaVersion: "0.1.0";
  almanacId: string;
  version: string;
  mode: "fixture" | "saved-runs";
  total: number;
  passed: number;
  failed: number;
  errored: number;
  quality: {
    status: "pass" | "fail";
    passed: number;
    failed: number;
    citationRate: number;
    unsupportedClaimCount: number;
    staleCitationCount: number;
  };
  results: AskReplayResultEntry[];
}

export class AskReplaySetupError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "fixture-invalid"
      | "no-cases",
    message: string,
  ) {
    super(message);
    this.name = "AskReplaySetupError";
  }
}

interface ReplayCase {
  fixtureId: string;
  question: string;
  source: AskReplayResultEntry["source"];
  toolCalls: Array<{
    toolName: string;
    input: Record<string, unknown> | null;
    expectedStatus?: AnswerToolCallStatus;
  }>;
  expectedStatus: AnswerArtifactStatus;
  minCitations?: number;
  maxStaleCitations?: number;
  unsupportedClaims?: string[];
  maxUnsupportedClaims?: number;
  expectedAbstentionReason?: string;
}

export function parseAskReplayFixtureJsonl(raw: string): AskReplayFixture[] {
  const fixtures: AskReplayFixture[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw new AskReplaySetupError(
        "fixture-invalid",
        `invalid fixture JSONL line ${index + 1}: ${(cause as Error).message}`,
      );
    }
    const fixture = AskReplayFixtureSchema.safeParse(parsed);
    if (!fixture.success) {
      throw new AskReplaySetupError(
        "fixture-invalid",
        `invalid fixture JSONL line ${index + 1}: ${fixture.error.message}`,
      );
    }
    fixtures.push(fixture.data);
  }
  return fixtures;
}

export async function runAskReplayFromFixtureFile(
  options: RunAskReplayFromFixtureFileOptions,
): Promise<AskReplayReport> {
  let raw: string;
  try {
    raw = await readFile(options.fixturePath, "utf8");
  } catch (cause) {
    throw new AskReplaySetupError(
      "fixture-invalid",
      `could not read fixture file ${options.fixturePath}: ${(cause as Error).message}`,
    );
  }
  return runAskReplayFromFixtures({
    almanacDir: options.almanacDir,
    fixtures: parseAskReplayFixtureJsonl(raw),
  });
}

export async function runAskReplayFromFixtures(
  options: RunAskReplayFromFixturesOptions,
): Promise<AskReplayReport> {
  const cases = options.fixtures.map(replayCaseFromFixture);
  return runAskReplayCases({
    almanacDir: options.almanacDir,
    mode: "fixture",
    cases,
  });
}

export async function runAskReplayFromSavedRuns(
  options: RunAskReplayFromSavedRunsOptions,
): Promise<AskReplayReport> {
  const list = await listRunToolArtifacts({
    almanacDir: options.almanacDir,
    kind: "answer",
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  const cases: ReplayCase[] = [];
  for (const summary of list.runs) {
    const read = await readRunToolArtifact({
      almanacDir: options.almanacDir,
      runId: summary.runId,
    });
    if (read.artifact.kind !== "answer") continue;
    cases.push(replayCaseFromAnswerArtifact(read.artifact));
  }
  return runAskReplayCases({
    almanacDir: options.almanacDir,
    mode: "saved-runs",
    cases,
  });
}

export function formatAskReplayHuman(report: AskReplayReport): string {
  const lines = [
    `ask replay: ${report.almanacId} (${report.version})`,
    `mode: ${report.mode}`,
    `total: ${report.total}`,
    `passed: ${report.passed}`,
    `failed: ${report.failed}`,
    `errored: ${report.errored}`,
    `quality: ${report.quality.status} citationRate=${formatRate(report.quality.citationRate)} ` +
      `unsupported=${report.quality.unsupportedClaimCount} stale=${report.quality.staleCitationCount}`,
  ];
  for (const result of report.results) {
    const reasons =
      result.reasons.length === 0 ? "" : ` reasons=${result.reasons.join("; ")}`;
    lines.push(
      `  - ${result.fixtureId}  ${result.status}  expected=${result.expected.status} ` +
        `observed=${result.observed.status} citations=${result.observed.citationsCount} ` +
        `stale=${result.observed.staleCitationCount} quality=${result.quality.status}${reasons}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function exitCodeForAskReplay(report: AskReplayReport): 0 | 1 {
  return report.failed === 0 && report.errored === 0 ? 0 : 1;
}

async function runAskReplayCases(input: {
  almanacDir: string;
  mode: AskReplayReport["mode"];
  cases: ReplayCase[];
}): Promise<AskReplayReport> {
  const manifest = await readAskReplayManifest(input.almanacDir);
  if (input.cases.length === 0) {
    throw new AskReplaySetupError(
      "no-cases",
      "no ask replay cases matched the requested input",
    );
  }
  const results: AskReplayResultEntry[] = [];
  for (const replayCase of input.cases) {
    results.push(await runAskReplayCase(input.almanacDir, replayCase));
  }
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const errored = results.filter((result) => result.status === "error").length;
  const quality = summarizeQuality(results);
  return {
    schemaVersion: "0.1.0",
    almanacId: manifest.almanacId,
    version: manifest.version,
    mode: input.mode,
    total: results.length,
    passed,
    failed,
    errored,
    quality,
    results,
  };
}

async function runAskReplayCase(
  almanacDir: string,
  replayCase: ReplayCase,
): Promise<AskReplayResultEntry> {
  const observations: AskReplayToolObservation[] = [];
  const reasons: string[] = [];
  try {
    for (let callIndex = 0; callIndex < replayCase.toolCalls.length; callIndex += 1) {
      observations.push(
        await executeReplayToolCall({
          almanacDir,
          callIndex,
          call: replayCase.toolCalls[callIndex]!,
        }),
      );
    }
  } catch (cause) {
    return buildReplayResult({
      replayCase,
      observations,
      status: "error",
      reasons: [`replay error: ${(cause as Error).message}`],
    });
  }

  for (let index = 0; index < replayCase.toolCalls.length; index += 1) {
    const expected = replayCase.toolCalls[index]!;
    const observed = observations[index];
    if (
      expected.expectedStatus !== undefined &&
      observed?.status !== expected.expectedStatus
    ) {
      reasons.push(
        `tool #${index} ${expected.toolName} expected ${expected.expectedStatus}, observed ${observed?.status ?? "(missing)"}`,
      );
    }
  }

  return buildReplayResult({
    replayCase,
    observations,
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
  });
}

async function executeReplayToolCall(input: {
  almanacDir: string;
  callIndex: number;
  call: ReplayCase["toolCalls"][number];
}): Promise<AskReplayToolObservation> {
  const execution = await runTool({
    almanacDir: input.almanacDir,
    toolName: input.call.toolName,
    input: input.call.input,
  });
  return {
    callIndex: input.callIndex,
    toolName: execution.toolName,
    input: execution.input,
    status: answerToolStatusFromRunToolStatus(execution.status),
    durationMs: execution.durationMs,
    citationsCount: execution.citationsCount,
    ...(execution.result.ok ? { freshness: execution.result.freshness } : {}),
    ...(execution.result.ok ? {} : { error: execution.result.error }),
  };
}

function buildReplayResult(input: {
  replayCase: ReplayCase;
  observations: AskReplayToolObservation[];
  status: AskReplayResultEntry["status"];
  reasons: string[];
}): AskReplayResultEntry {
  const observedStatus = inferObservedAnswerStatus(input.observations);
  const citationStats = citationStatsFromObservations(input.observations);
  const observedAbstentionReason =
    observedStatus === "abstained"
      ? inferObservedAbstentionReason(input.observations)
      : undefined;
  const quality = evaluateAnswerQualityGate({
    expectedStatus: input.replayCase.expectedStatus,
    observedStatus,
    citationsCount: citationStats.citationsCount,
    staleCitationCount: citationStats.staleCitationCount,
    ...(input.replayCase.minCitations === undefined
      ? {}
      : { minCitations: input.replayCase.minCitations }),
    ...(input.replayCase.maxStaleCitations === undefined
      ? {}
      : { maxStaleCitations: input.replayCase.maxStaleCitations }),
    ...(input.replayCase.unsupportedClaims === undefined
      ? {}
      : { unsupportedClaims: input.replayCase.unsupportedClaims }),
    ...(input.replayCase.maxUnsupportedClaims === undefined
      ? {}
      : { maxUnsupportedClaims: input.replayCase.maxUnsupportedClaims }),
    ...(input.replayCase.expectedAbstentionReason === undefined
      ? {}
      : {
          expectedAbstentionReason: input.replayCase.expectedAbstentionReason,
        }),
    ...(observedAbstentionReason === undefined
      ? {}
      : { observedAbstentionReason }),
  });
  const reasons = [...quality.reasons, ...input.reasons];
  const status =
    input.status === "error" ? "error" : reasons.length === 0 ? "pass" : "fail";
  return {
    fixtureId: input.replayCase.fixtureId,
    question: input.replayCase.question,
    source: input.replayCase.source,
    expected: {
      status: input.replayCase.expectedStatus,
      ...(input.replayCase.minCitations === undefined
        ? {}
        : { minCitations: input.replayCase.minCitations }),
      ...(input.replayCase.maxStaleCitations === undefined
        ? {}
        : { maxStaleCitations: input.replayCase.maxStaleCitations }),
      ...(input.replayCase.maxUnsupportedClaims === undefined
        ? {}
        : { maxUnsupportedClaims: input.replayCase.maxUnsupportedClaims }),
      unsupportedClaimCount: input.replayCase.unsupportedClaims?.length ?? 0,
      ...(input.replayCase.expectedAbstentionReason === undefined
        ? {}
        : { abstentionReason: input.replayCase.expectedAbstentionReason }),
      toolStatuses: input.replayCase.toolCalls.map((call, callIndex) => ({
        callIndex,
        toolName: call.toolName,
        ...(call.expectedStatus === undefined
          ? {}
          : { status: call.expectedStatus }),
      })),
    },
    observed: {
      status: observedStatus,
      citationsCount: citationStats.citationsCount,
      staleCitationCount: citationStats.staleCitationCount,
      ...(observedStatus === "abstained"
        ? { abstentionReason: observedAbstentionReason }
        : {}),
      toolCalls: input.observations,
    },
    quality,
    status,
    reasons,
  };
}

function replayCaseFromFixture(
  fixture: AskReplayFixture,
  index: number,
): ReplayCase {
  return {
    fixtureId: fixture.id,
    question: fixture.question,
    source: { kind: "fixture", line: index + 1 },
    toolCalls: fixture.toolCalls.map((call) => ({
      toolName: call.tool,
      input: call.input ?? {},
      ...(call.expectedStatus === undefined
        ? {}
        : { expectedStatus: call.expectedStatus }),
    })),
    expectedStatus: fixture.expectedStatus,
    ...(fixture.minCitations === undefined
      ? {}
      : { minCitations: fixture.minCitations }),
    ...(fixture.maxStaleCitations === undefined
      ? {}
      : { maxStaleCitations: fixture.maxStaleCitations }),
    ...(fixture.unsupportedClaims === undefined
      ? {}
      : { unsupportedClaims: fixture.unsupportedClaims }),
    ...(fixture.maxUnsupportedClaims === undefined
      ? {}
      : { maxUnsupportedClaims: fixture.maxUnsupportedClaims }),
    ...(fixture.expectedAbstentionReason === undefined
      ? {}
      : { expectedAbstentionReason: fixture.expectedAbstentionReason }),
  };
}

function summarizeQuality(
  results: AskReplayResultEntry[],
): AskReplayReport["quality"] {
  const passed = results.filter(
    (result) => result.quality.status === "pass",
  ).length;
  const failed = results.length - passed;
  const citationRate =
    results.length === 0
      ? 1
      : results.reduce((sum, result) => sum + result.quality.citationRate, 0) /
        results.length;
  const unsupportedClaimCount = results.reduce(
    (sum, result) => sum + result.quality.unsupportedClaimCount,
    0,
  );
  const staleCitationCount = results.reduce(
    (sum, result) => sum + result.quality.staleCitationCount,
    0,
  );
  return {
    status: failed === 0 ? "pass" : "fail",
    passed,
    failed,
    citationRate,
    unsupportedClaimCount,
    staleCitationCount,
  };
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function replayCaseFromAnswerArtifact(artifact: AnswerArtifact): ReplayCase {
  return {
    fixtureId: artifact.answerId,
    question: artifact.question,
    source: {
      kind: "answer-artifact",
      answerId: artifact.answerId,
      artifactRelPath: artifact.artifactRelPath,
      ...(artifact.label === undefined ? {} : { label: artifact.label }),
    },
    toolCalls: artifact.toolCalls.map((call) => ({
      toolName: call.toolName,
      input: call.input,
      expectedStatus: call.status,
    })),
    expectedStatus: artifact.status,
    ...(artifact.status === "ok"
      ? { minCitations: Math.max(1, artifact.citations.length) }
      : {}),
    ...(artifact.abstentionReason === undefined
      ? {}
      : { expectedAbstentionReason: artifact.abstentionReason }),
  };
}

function inferObservedAnswerStatus(
  observations: AskReplayToolObservation[],
): AnswerArtifactStatus {
  const citationStats = citationStatsFromObservations(observations);
  if (citationStats.citationsCount > 0) return "ok";
  return "abstained";
}

function inferObservedAbstentionReason(
  observations: AskReplayToolObservation[],
): string {
  if (observations.length > 0 && observations.every((o) => o.status !== "ok")) {
    return "tool-errors-only";
  }
  return "no-citations";
}

function citationStatsFromObservations(
  observations: AskReplayToolObservation[],
): { citationsCount: number; staleCitationCount: number } {
  let citationsCount = 0;
  let staleCitationCount = 0;
  for (const observation of observations) {
    citationsCount += observation.citationsCount;
    if (observation.freshness?.staleness === "stale") {
      staleCitationCount += observation.citationsCount;
    }
  }
  return { citationsCount, staleCitationCount };
}

function answerToolStatusFromRunToolStatus(status: string): AnswerToolCallStatus {
  if (status === "ok") return "ok";
  if (status === "tool-not-found") return "tool-not-found";
  if (status === "bad-input") return "bad-tool-input";
  return "tool-error";
}

async function readAskReplayManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new AskReplaySetupError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new AskReplaySetupError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}
