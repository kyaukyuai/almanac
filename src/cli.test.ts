/**
 * CLI regression tests that exercise the real command entrypoint in a
 * subprocess. These cover output behavior that unit tests on storage helpers
 * cannot pin by themselves.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  almanacDirPath,
  ensureAlmanacLayout,
  knowledgeIndexManifestPath,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "almanac-cli-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runCli(args: string[]) {
  const cliPath = join(import.meta.dirname, "cli.ts");
  const result = spawnSync("bun", [cliPath, ...args], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function writeLegacyCountFixture(): Promise<void> {
  const dir = almanacDirPath(root, "legacy");
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "legacy",
    domain: "legacy domain",
    displayName: "Legacy Domain",
    freshnessProfileId: "mixed",
    runId: "run-legacy",
    forgerVersion: "0.0.0",
    options: {
      depth: "quick",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-05-08T12:00:00.000Z"),
  });

  await ensureAlmanacLayout(dir);
  await writeManifest(dir, manifest);
  await writeCompileState(dir, compileState);
  await writeFile(
    knowledgeIndexManifestPath(dir),
    JSON.stringify(
      {
        schemaVersion: "0.1.0",
        almanacId: "legacy",
        dbRelPath: "knowledge/almanac.sqlite",
        factCount: 7,
        counts: {
          byClass: { static: 7, slow: 0 },
          byType: {
            fact: 4,
            definition: 3,
            procedure: 0,
            opinion: 0,
            reference: 0,
          },
        },
        builtAt: "2026-05-08T12:01:00.000Z",
        sqliteVersion: "3.51.0",
        factCorpusHash: "b".repeat(64),
      },
      null,
      2,
    ),
    "utf8",
  );

  const toolsDir = join(dir, "tools");
  for (const name of ["query_facts", "fetch_official_docs"]) {
    await writeFile(
      join(toolsDir, `${name}.json`),
      JSON.stringify({ name, disabled: false }),
      "utf8",
    );
    await writeFile(join(toolsDir, `${name}.ts`), "export default async function() {}", "utf8");
  }
}

describe("almanac CLI legacy artifact counts", () => {
  test("list shows actual fact/tool counts and annotates stale manifest counts", async () => {
    await writeLegacyCountFixture();

    const result = runCli(["list", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("legacy");
    expect(result.stdout).toContain("7*");
    expect(result.stdout).toContain("2*");
    expect(result.stdout).toContain(
      "legacy: manifest facts/tools 0 / 0, actual 7 / 2",
    );
  });

  test("inspect shows actual counts first and the stale manifest counts below", async () => {
    await writeLegacyCountFixture();

    const result = runCli(["inspect", "legacy", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("almanac: legacy (Legacy Domain)");
    expect(result.stdout).toContain("facts/tools    7 / 2");
    expect(result.stdout).toContain("manifest       facts/tools 0 / 0");
    expect(result.stdout).toContain("knowledge      7 facts, sqlite 3.51.0");
  });
});

describe("almanac CLI product onboarding", () => {
  test("demo creates an inspectable almanac with sources, fixtures, and benchmark report", () => {
    const demo = runCli(["demo", "--root", root]);

    expect(demo.status).toBe(0);
    expect(demo.stderr).toBe("");
    expect(demo.stdout).toContain('creating offline demo almanac "sqlite-demo"');
    expect(demo.stdout).toContain("benchmark  2/2 passed");

    const inspect = runCli(["inspect", "sqlite-demo", "--root", root]);
    expect(inspect.status).toBe(0);
    expect(inspect.stderr).toBe("");
    expect(inspect.stdout).toContain("health         ok");
    expect(inspect.stdout).toContain("sources        approved, 3 accepted / 0 rejected");
    expect(inspect.stdout).toContain("benchmark      2/2 passed");

    const sources = runCli(["sources", "sqlite-demo", "--root", root]);
    expect(sources.status).toBe(0);
    expect(sources.stderr).toBe("");
    expect(sources.stdout).toContain("accepted      3 / 3 total");
    expect(sources.stdout).toContain("sqlite-transactions");

    const benchmark = runCli(["benchmark", "sqlite-demo", "--root", root]);
    expect(benchmark.status).toBe(0);
    expect(benchmark.stderr).toBe("");
    expect(benchmark.stdout).toContain("total         2");
    expect(benchmark.stdout).toContain("passed        2");

    const doctor = runCli(["doctor", "sqlite-demo", "--root", root]);
    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("doctor: sqlite-demo");
    expect(doctor.stdout).toContain("fail=0");
  });
});
