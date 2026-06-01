/**
 * Management helpers for saved answer-session artifacts.
 *
 * The answer runner lands in later v0.7 PRs. This module only defines the
 * durable artifact write boundary so schema/read/list behavior can settle first.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { readManifest } from "../compile/storage.ts";
import {
  AnswerArtifactSchema,
  AnswerRunIdSchema,
  type AnswerArtifact,
  type AnswerArtifactStatus,
  type AnswerToolCallSummary,
  type Citation,
  type RunToolExitCode,
  type ToolError,
  type ToolResultFreshness,
} from "../core/types.ts";

export interface SaveAnswerArtifactOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  question: string;
  status: AnswerArtifactStatus;
  exitCode: RunToolExitCode;
  startedAt: string;
  finishedAt: string;
  /** Optional deterministic id override, mainly for tests. */
  answerId?: string;
  /** Optional short human label for later audit lookup. */
  label?: string;
  /** Optional human note describing why this answer was saved. */
  note?: string;
  model?: string;
  promptVersions?: AnswerArtifact["promptVersions"];
  answer?: string;
  abstentionReason?: string;
  toolCalls?: AnswerToolCallSummary[];
  citations?: Citation[];
  freshness?: ToolResultFreshness;
  usage?: AnswerArtifact["usage"];
  error?: ToolError;
}

export interface SaveAnswerArtifactResult {
  artifact: AnswerArtifact;
  path: string;
  relPath: string;
}

export class AnswerArtifactSetupError extends Error {
  constructor(
    public readonly code: "bad-almanac-dir" | "almanac-not-found",
    message: string,
  ) {
    super(message);
    this.name = "AnswerArtifactSetupError";
  }
}

export async function saveAnswerArtifact(
  options: SaveAnswerArtifactOptions,
): Promise<SaveAnswerArtifactResult> {
  const manifest = await readAnswerArtifactManifest(options.almanacDir);
  const answerId =
    options.answerId ?? generateAnswerRunId(options.startedAt);
  const relPath = answerArtifactRelPath(answerId);
  const path = join(options.almanacDir, relPath);
  const artifact = AnswerArtifactSchema.parse({
    schemaVersion: "0.1.0",
    kind: "answer",
    artifactRelPath: relPath,
    answerId,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    almanacId: manifest.almanacId,
    version: manifest.version,
    forgerVersion: manifest.forgerVersion,
    question: options.question,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.note === undefined ? {} : { note: options.note }),
    status: options.status,
    exitCode: options.exitCode,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.promptVersions === undefined
      ? {}
      : { promptVersions: options.promptVersions }),
    ...(options.answer === undefined ? {} : { answer: options.answer }),
    ...(options.abstentionReason === undefined
      ? {}
      : { abstentionReason: options.abstentionReason }),
    toolCalls: options.toolCalls ?? [],
    citations: options.citations ?? [],
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    durationMs: Date.parse(options.finishedAt) - Date.parse(options.startedAt),
    ...(options.error === undefined ? {} : { error: options.error }),
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { artifact, path, relPath };
}

export function answerArtifactRelPath(answerId: string): string {
  const validatedAnswerId = AnswerRunIdSchema.parse(answerId);
  return `.runs/${validatedAnswerId}.json`;
}

export function generateAnswerRunId(startedAt: string): string {
  return AnswerRunIdSchema.parse(
    `answer-${startedAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`,
  );
}

async function readAnswerArtifactManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new AnswerArtifactSetupError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new AnswerArtifactSetupError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}
