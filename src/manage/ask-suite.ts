/**
 * Suite-level gate for deterministic ask replay fixtures.
 *
 * The suite discovers reviewable JSONL fixtures and delegates execution to the
 * ask-replay engine. It does not call an LLM provider.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { readManifest } from "../compile/storage.ts";
import {
  AnswerArtifactStatusSchema,
  type AnswerArtifactStatus,
} from "../core/types.ts";
import { ASK_FIXTURE_REL_PATHS } from "./ask-fixtures.ts";
import {
  AskReplayFixtureSchema,
  AskReplaySetupError,
  runAskReplayFromFixtures,
  type AskReplayFixture,
  type AskReplayReport,
  type AskReplayResultEntry,
} from "./ask-replay.ts";

export interface RunAskSuiteOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Optional absolute or cwd-relative fixture paths. Defaults to known paths. */
  fixturePaths?: string[];
}

export interface AskSuiteFixtureFileSummary {
  path: string;
  relPath: string;
  count: number;
}

export interface AskSuiteResultEntry extends AskReplayResultEntry {
  fixtureFile: {
    path: string;
    relPath: string;
    line: number;
  };
}

export interface AskSuiteReport {
  schemaVersion: "0.1.0";
  almanacId: string;
  version: string;
  status: "pass" | "fail";
  fixtureFiles: AskSuiteFixtureFileSummary[];
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
    abstentionMismatchCount: number;
  };
  observedStatusCounts: Record<AnswerArtifactStatus, number>;
  results: AskSuiteResultEntry[];
}

export class AskSuiteSetupError extends Error {
  constructor(
    public readonly code:
      | "bad-almanac-dir"
      | "almanac-not-found"
      | "fixture-invalid"
      | "duplicate-fixture-id"
      | "no-fixtures",
    message: string,
  ) {
    super(message);
    this.name = "AskSuiteSetupError";
  }
}

interface FixtureSource {
  path: string;
  relPath: string;
  line: number;
}

interface DiscoveredFixtureFile extends AskSuiteFixtureFileSummary {
  fixtures: AskReplayFixture[];
  sources: Map<string, FixtureSource>;
}

export async function runAskSuite(
  options: RunAskSuiteOptions,
): Promise<AskSuiteReport> {
  const manifest = await readAskSuiteManifest(options.almanacDir);
  const fixtureFiles = await discoverFixtureFiles(options);
  const fixtures: AskReplayFixture[] = [];
  const sourceByFixtureId = new Map<string, FixtureSource>();

  for (const file of fixtureFiles) {
    for (const fixture of file.fixtures) {
      if (sourceByFixtureId.has(fixture.id)) {
        const first = sourceByFixtureId.get(fixture.id)!;
        const duplicate = file.sources.get(fixture.id)!;
        throw new AskSuiteSetupError(
          "duplicate-fixture-id",
          `duplicate ask fixture id ${fixture.id}: ${first.relPath}:${first.line} and ${duplicate.relPath}:${duplicate.line}`,
        );
      }
      fixtures.push(fixture);
      sourceByFixtureId.set(fixture.id, file.sources.get(fixture.id)!);
    }
  }

  if (fixtures.length === 0) {
    throw new AskSuiteSetupError(
      "no-fixtures",
      "no ask fixtures found; run `almanac ask-fixtures init` and add fixtures first",
    );
  }

  let replay: AskReplayReport;
  try {
    replay = await runAskReplayFromFixtures({
      almanacDir: options.almanacDir,
      fixtures,
    });
  } catch (cause) {
    if (cause instanceof AskReplaySetupError) {
      throw new AskSuiteSetupError(
        cause.code === "almanac-not-found"
          ? "almanac-not-found"
          : cause.code === "bad-almanac-dir"
            ? "bad-almanac-dir"
            : "fixture-invalid",
        cause.message,
      );
    }
    throw cause;
  }

  const results: AskSuiteResultEntry[] = replay.results.map((result) => {
    const source = sourceByFixtureId.get(result.fixtureId);
    if (source === undefined) {
      throw new AskSuiteSetupError(
        "fixture-invalid",
        `replay result referenced unknown fixture id: ${result.fixtureId}`,
      );
    }
    return {
      ...result,
      fixtureFile: source,
    };
  });
  const quality = {
    ...replay.quality,
    abstentionMismatchCount: results.filter(
      (result) => !result.quality.abstention.matches,
    ).length,
  };
  const status =
    replay.failed === 0 && replay.errored === 0 && quality.status === "pass"
      ? "pass"
      : "fail";

  return {
    schemaVersion: "0.1.0",
    almanacId: manifest.almanacId,
    version: manifest.version,
    status,
    fixtureFiles: fixtureFiles.map(({ path, relPath, count }) => ({
      path,
      relPath,
      count,
    })),
    total: replay.total,
    passed: replay.passed,
    failed: replay.failed,
    errored: replay.errored,
    quality,
    observedStatusCounts: summarizeObservedStatuses(results),
    results,
  };
}

export function formatAskSuiteHuman(report: AskSuiteReport): string {
  const lines = [
    `ask suite: ${report.almanacId} (${report.version})`,
    `status: ${report.status}`,
    `fixtures: ${report.total} from ${report.fixtureFiles.length} file(s)`,
  ];
  for (const file of report.fixtureFiles) {
    lines.push(`  - ${file.relPath}: ${file.count}`);
  }
  lines.push(
    `passed: ${report.passed}`,
    `failed: ${report.failed}`,
    `errored: ${report.errored}`,
    `quality: ${report.quality.status} citationRate=${formatRate(report.quality.citationRate)} ` +
      `unsupported=${report.quality.unsupportedClaimCount} stale=${report.quality.staleCitationCount} ` +
      `abstentionMismatches=${report.quality.abstentionMismatchCount}`,
    `observed: ${formatObservedStatusCounts(report.observedStatusCounts)}`,
  );
  for (const result of report.results) {
    const reasons =
      result.reasons.length === 0 ? "" : ` reasons=${result.reasons.join("; ")}`;
    lines.push(
      `  - ${result.fixtureId}  ${result.status}  ${result.fixtureFile.relPath}:${result.fixtureFile.line} ` +
        `expected=${result.expected.status} observed=${result.observed.status} ` +
        `citations=${result.observed.citationsCount} stale=${result.observed.staleCitationCount} ` +
        `quality=${result.quality.status}${reasons}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function exitCodeForAskSuite(report: AskSuiteReport): 0 | 1 {
  return report.status === "pass" ? 0 : 1;
}

async function discoverFixtureFiles(
  options: RunAskSuiteOptions,
): Promise<DiscoveredFixtureFile[]> {
  const explicit =
    options.fixturePaths !== undefined && options.fixturePaths.length > 0;
  const paths = explicit
    ? options.fixturePaths!.map((path) => resolve(path))
    : ASK_FIXTURE_REL_PATHS.map((relPath) => join(options.almanacDir, relPath));

  const files: DiscoveredFixtureFile[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      if (explicit) {
        throw new AskSuiteSetupError(
          "fixture-invalid",
          `ask fixture file does not exist: ${path}`,
        );
      }
      continue;
    }
    files.push(await readFixtureFile(options.almanacDir, path));
  }
  return files;
}

async function readFixtureFile(
  almanacDir: string,
  path: string,
): Promise<DiscoveredFixtureFile> {
  const relPath = relPathForFixture(almanacDir, path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new AskSuiteSetupError(
      "fixture-invalid",
      `could not read ask fixture file ${path}: ${(cause as Error).message}`,
    );
  }

  const fixtures: AskReplayFixture[] = [];
  const sources = new Map<string, FixtureSource>();
  const seenIds = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw new AskSuiteSetupError(
        "fixture-invalid",
        `invalid ask fixture JSONL line ${relPath}:${index + 1}: ${(cause as Error).message}`,
      );
    }
    const fixture = AskReplayFixtureSchema.safeParse(parsed);
    if (!fixture.success) {
      throw new AskSuiteSetupError(
        "fixture-invalid",
        `invalid ask fixture JSONL line ${relPath}:${index + 1}: ${fixture.error.message}`,
      );
    }
    if (seenIds.has(fixture.data.id)) {
      throw new AskSuiteSetupError(
        "duplicate-fixture-id",
        `duplicate ask fixture id ${fixture.data.id} in ${relPath}:${index + 1}`,
      );
    }
    seenIds.add(fixture.data.id);
    fixtures.push(fixture.data);
    sources.set(fixture.data.id, {
      path,
      relPath,
      line: index + 1,
    });
  }

  return {
    path,
    relPath,
    count: fixtures.length,
    fixtures,
    sources,
  };
}

async function readAskSuiteManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new AskSuiteSetupError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new AskSuiteSetupError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}

function summarizeObservedStatuses(
  results: AskSuiteResultEntry[],
): Record<AnswerArtifactStatus, number> {
  const counts = Object.fromEntries(
    AnswerArtifactStatusSchema.options.map((status) => [status, 0]),
  ) as Record<AnswerArtifactStatus, number>;
  for (const result of results) {
    counts[result.observed.status] += 1;
  }
  return counts;
}

function formatObservedStatusCounts(
  counts: Record<AnswerArtifactStatus, number>,
): string {
  const formatted = AnswerArtifactStatusSchema.options
    .filter((status) => counts[status] > 0)
    .map((status) => `${status}=${counts[status]}`)
    .join(", ");
  return formatted || "(none)";
}

function relPathForFixture(almanacDir: string, fixturePath: string): string {
  const relPath = relative(almanacDir, fixturePath);
  return relPath.startsWith("..") ? fixturePath : relPath;
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}
