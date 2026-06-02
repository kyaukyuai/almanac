/**
 * Authoring helpers for deterministic ask-replay fixtures.
 *
 * These commands deliberately operate on saved answer artifacts and JSONL
 * files only. They do not run an LLM provider and they do not replay tools.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readManifest } from "../compile/storage.ts";
import type { AnswerArtifact } from "../core/types.ts";
import { readRunToolArtifact } from "./run-tool.ts";
import {
  AskReplayFixtureSchema,
  parseAskReplayFixtureJsonl,
  type AskReplayFixture,
} from "./ask-replay.ts";

export const DEFAULT_ASK_FIXTURE_REL_PATH = "tests/ask.jsonl";

export const ASK_FIXTURE_REL_PATHS = [
  DEFAULT_ASK_FIXTURE_REL_PATH,
  "tests/ask-replay.jsonl",
  "fixtures/ask.jsonl",
  "fixtures/ask-replay.jsonl",
];

export interface InitAskFixtureFileOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Absolute or cwd-relative fixture file path. */
  fixturePath?: string;
  overwrite?: boolean;
}

export interface AddAskFixtureFromRunOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  answerId: string;
  /** Absolute or cwd-relative fixture file path. */
  fixturePath?: string;
  /** Optional explicit fixture id. Defaults to the answer artifact id. */
  fixtureId?: string;
}

export interface AskFixtureAuthoringResult {
  almanacId: string;
  version: string;
  path: string;
  relPath: string;
  created: boolean;
  fixtureCount: number;
}

export interface AddAskFixtureFromRunResult
  extends AskFixtureAuthoringResult {
  fixture: AskReplayFixture;
  sourceAnswerId: string;
}

export class AskFixtureAuthoringError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "fixture-exists"
      | "fixture-invalid"
      | "duplicate-fixture-id"
      | "not-answer-artifact"
      | "answer-not-replayable",
    message: string,
  ) {
    super(message);
    this.name = "AskFixtureAuthoringError";
  }
}

export async function initAskFixtureFile(
  options: InitAskFixtureFileOptions,
): Promise<AskFixtureAuthoringResult> {
  const manifest = await readAskFixtureManifest(options.almanacDir);
  const fixturePath = resolveAskFixturePath(
    options.almanacDir,
    options.fixturePath,
  );
  const existed = existsSync(fixturePath);
  if (existed && options.overwrite !== true) {
    throw new AskFixtureAuthoringError(
      "fixture-exists",
      `ask fixture file already exists: ${fixturePath}`,
    );
  }

  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, "", "utf8");
  return {
    almanacId: manifest.almanacId,
    version: manifest.version,
    path: fixturePath,
    relPath: relPathForFixture(options.almanacDir, fixturePath),
    created: !existed,
    fixtureCount: 0,
  };
}

export async function addAskFixtureFromRun(
  options: AddAskFixtureFromRunOptions,
): Promise<AddAskFixtureFromRunResult> {
  const manifest = await readAskFixtureManifest(options.almanacDir);
  const read = await readRunToolArtifact({
    almanacDir: options.almanacDir,
    runId: options.answerId,
  });
  if (read.artifact.kind !== "answer") {
    throw new AskFixtureAuthoringError(
      "not-answer-artifact",
      `run artifact is not an answer artifact: ${options.answerId}`,
    );
  }

  const fixture = askReplayFixtureFromAnswerArtifact(read.artifact, {
    fixtureId: options.fixtureId,
  });
  const fixturePath = resolveAskFixturePath(
    options.almanacDir,
    options.fixturePath,
  );
  const existing = await readExistingFixtures(fixturePath);
  if (existing.fixtures.some((item) => item.id === fixture.id)) {
    throw new AskFixtureAuthoringError(
      "duplicate-fixture-id",
      `ask fixture id already exists in ${fixturePath}: ${fixture.id}`,
    );
  }

  await mkdir(dirname(fixturePath), { recursive: true });
  const fixtureRow = JSON.stringify(fixture);
  const existingRaw = existing.raw.trimEnd();
  const nextRaw =
    existingRaw.length === 0
      ? `${fixtureRow}\n`
      : `${existingRaw}\n${fixtureRow}\n`;
  await writeFile(fixturePath, nextRaw, "utf8");

  return {
    almanacId: manifest.almanacId,
    version: manifest.version,
    path: fixturePath,
    relPath: relPathForFixture(options.almanacDir, fixturePath),
    created: !existing.exists,
    fixtureCount: existing.fixtures.length + 1,
    fixture,
    sourceAnswerId: read.artifact.answerId,
  };
}

export function askReplayFixtureFromAnswerArtifact(
  artifact: AnswerArtifact,
  options: { fixtureId?: string } = {},
): AskReplayFixture {
  if (artifact.toolCalls.length === 0) {
    throw new AskFixtureAuthoringError(
      "answer-not-replayable",
      `answer artifact has no recorded tool calls: ${artifact.answerId}`,
    );
  }

  return AskReplayFixtureSchema.parse({
    id: options.fixtureId ?? artifact.answerId,
    question: artifact.question,
    toolCalls: artifact.toolCalls.map((call) => ({
      tool: call.toolName,
      input: call.input,
      expectedStatus: call.status,
    })),
    expectedStatus: artifact.status,
    ...(artifact.status === "ok"
      ? {
          minCitations: Math.max(1, artifact.citations.length),
          maxStaleCitations: artifact.trace?.citations.staleCount ?? 0,
        }
      : {}),
    ...(artifact.status === "abstained" &&
    artifact.abstentionReason !== undefined
      ? { expectedAbstentionReason: artifact.abstentionReason }
      : {}),
  });
}

export function formatAskFixtureAuthoringHuman(
  result: AskFixtureAuthoringResult | AddAskFixtureFromRunResult,
): string {
  const lines = [
    `ask fixtures: ${result.almanacId} (${result.version})`,
    `file: ${result.path}`,
    `created: ${result.created ? "yes" : "no"}`,
    `fixtures: ${result.fixtureCount}`,
  ];
  if (isAddResult(result)) {
    lines.push(`added: ${result.fixture.id}`);
    lines.push(`source answer: ${result.sourceAnswerId}`);
  }
  return lines.join("\n") + "\n";
}

async function readExistingFixtures(
  fixturePath: string,
): Promise<{ exists: boolean; fixtures: AskReplayFixture[]; raw: string }> {
  if (!existsSync(fixturePath)) {
    return { exists: false, fixtures: [], raw: "" };
  }
  let raw: string;
  try {
    raw = await readFile(fixturePath, "utf8");
  } catch (cause) {
    throw new AskFixtureAuthoringError(
      "fixture-invalid",
      `could not read ask fixture file ${fixturePath}: ${(cause as Error).message}`,
    );
  }
  try {
    return {
      exists: true,
      fixtures: parseAskReplayFixtureJsonl(raw),
      raw,
    };
  } catch (cause) {
    throw new AskFixtureAuthoringError(
      "fixture-invalid",
      `invalid ask fixture file ${fixturePath}: ${(cause as Error).message}`,
    );
  }
}

async function readAskFixtureManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new AskFixtureAuthoringError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new AskFixtureAuthoringError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}

function resolveAskFixturePath(almanacDir: string, fixturePath?: string): string {
  if (fixturePath === undefined) {
    return join(almanacDir, DEFAULT_ASK_FIXTURE_REL_PATH);
  }
  return resolve(fixturePath);
}

function relPathForFixture(almanacDir: string, fixturePath: string): string {
  const relPath = relative(almanacDir, fixturePath);
  return relPath.startsWith("..") ? fixturePath : relPath;
}

function isAddResult(
  result: AskFixtureAuthoringResult | AddAskFixtureFromRunResult,
): result is AddAskFixtureFromRunResult {
  return "fixture" in result;
}
