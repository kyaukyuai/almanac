/**
 * CLI regression tests that exercise the real command entrypoint in a
 * subprocess. These cover output behavior that unit tests on storage helpers
 * cannot pin by themselves.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { STAGE_IDS } from "./core/types.ts";
import {
  almanacDirPath,
  ensureAlmanacLayout,
  knowledgeIndexManifestPath,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";
import { markStageCompleted } from "./compile/pipeline.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "almanac-cli-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
) {
  const cliPath = join(import.meta.dirname, "cli.ts");
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  const result = spawnSync("bun", [cliPath, ...args], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function writeLegacyCountFixture(
  opts: { completed?: boolean } = {},
): Promise<void> {
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

  let state = compileState;
  if (opts.completed === true) {
    for (const stageId of STAGE_IDS) {
      state = markStageCompleted(state, stageId, new Date("2026-05-08T12:02:00.000Z"), {
        outputHash: "a".repeat(64),
      });
    }
  }

  await ensureAlmanacLayout(dir);
  await writeManifest(dir, manifest);
  await writeCompileState(dir, state);
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

  test("resume refreshes stale manifest counts from actual artifacts", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli([
      "new",
      "legacy domain",
      "--slug",
      "legacy",
      "--resume",
      "--root",
      root,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const manifest = JSON.parse(
      await readFile(join(almanacDirPath(root, "legacy"), "manifest.json"), "utf8"),
    ) as { factCount: number; toolCount: number };
    expect(manifest.factCount).toBe(7);
    expect(manifest.toolCount).toBe(2);
  });

  test("feed --replace requires an explicit --source-id", async () => {
    await writeLegacyCountFixture();

    const result = runCli([
      "feed",
      "legacy",
      "https://example.com/source.pdf",
      "--replace",
      "--root",
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("feed: --replace requires --source-id");
  });

  test("feed dry-run does not require LLM credentials", () => {
    const demo = runCli(["demo", "--root", root], {
      ALMANAC_LLM: undefined,
      ANTHROPIC_API_KEY: undefined,
    });
    expect(demo.status).toBe(0);

    const result = runCli(
      ["feed", "sqlite-demo", "https://example.com/new-source", "--root", root],
      {
        ALMANAC_LLM: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("Would add source");
  });
});

describe("almanac CLI product onboarding", () => {
  test("demo creates an inspectable almanac with sources, fixtures, and benchmark report", () => {
    const demo = runCli(["demo", "--root", root]);

    expect(demo.status).toBe(0);
    expect(demo.stderr).toBe("");
    expect(demo.stdout).toContain('creating offline demo almanac "sqlite-demo"');
    expect(demo.stdout).toContain("benchmark  2/2 passed");
    expect(demo.stdout).toContain(`almanac profile sqlite-demo --root ${root}`);

    const inspect = runCli(["inspect", "sqlite-demo", "--root", root]);
    expect(inspect.status).toBe(0);
    expect(inspect.stderr).toBe("");
    expect(inspect.stdout).toContain("health         ok");
    expect(inspect.stdout).toContain(`almanac profile sqlite-demo --root ${root}`);
    expect(inspect.stdout).toContain("sources        approved, 3 accepted / 0 rejected");
    expect(inspect.stdout).toContain("benchmark      2/2 passed");
    expect(inspect.stdout).toContain(`almanac benchmark sqlite-demo --root ${root}`);
    expect(inspect.stdout).toContain(`almanac serve sqlite-demo --root ${root}`);
    expect(inspect.stdout).toContain(
      `almanac register sqlite-demo --client=claude-code --apply --root ${root}`,
    );

    const profile = runCli(["profile", "sqlite-demo", "--root", root]);
    expect(profile.status).toBe(0);
    expect(profile.stderr).toBe("");
    expect(profile.stdout).toContain("expert profile: sqlite-demo (SQLite Operations Demo)");
    expect(profile.stdout).toContain("status         usable");
    expect(profile.stdout).toContain("evidence       3 facts from 3 sources");
    expect(profile.stdout).toContain("benchmark      2/2 passed, citationRate 100%");
    expect(profile.stdout).toContain("sqlite-transactions");

    const profileJson = runCli(["profile", "sqlite-demo", "--root", root, "--json"]);
    expect(profileJson.status).toBe(0);
    expect(profileJson.stderr).toBe("");
    const parsedProfile = JSON.parse(profileJson.stdout) as {
      status: string;
      evidence: {
        facts: number;
        factSourceCount: number;
        acceptedSources: number;
      };
      benchmark: {
        report: { passed: number; total: number; citationRate: number };
      };
    };
    expect(parsedProfile.status).toBe("usable");
    expect(parsedProfile.evidence.facts).toBe(3);
    expect(parsedProfile.evidence.factSourceCount).toBe(3);
    expect(parsedProfile.evidence.acceptedSources).toBe(3);
    expect(parsedProfile.benchmark.report.passed).toBe(2);
    expect(parsedProfile.benchmark.report.total).toBe(2);
    expect(parsedProfile.benchmark.report.citationRate).toBe(1);

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

    const init = runCli(["benchmark", "sqlite-demo", "--root", root, "--init", "--force"]);
    expect(init.status).toBe(0);
    expect(init.stderr).toBe("");
    expect(init.stdout).toContain("invocation.input.q");
    expect(init.stdout).toContain("expected.expectedErrorCode");

    const doctor = runCli(["doctor", "sqlite-demo", "--root", root]);
    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("doctor: sqlite-demo");
    expect(doctor.stdout).toContain("fail=0");
  });

  test("profile flags high-trust accepted sources with no extracted facts", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const sourcesPath = join(
      almanacDirPath(root, "sqlite-demo"),
      "sources",
      "sources.json",
    );
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as {
      generatedBy: { acceptedCount: number };
      coverage: { docs: number };
      sources: unknown[];
    };
    sources.sources.push({
      id: "sqlite-latest-docs",
      url: "https://www.sqlite.org/changes.html",
      kind: "docs",
      trust: 0.95,
      volatility: "slow",
      rationale: "High-trust SQLite documentation that is not in the fact corpus.",
      ingestion: {
        mode: "index-only",
        scope: [],
        refreshIntervalHours: 168,
      },
      notes: null,
    });
    sources.generatedBy.acceptedCount = sources.sources.length;
    sources.coverage.docs += 1;
    await writeFile(sourcesPath, JSON.stringify(sources, null, 2) + "\n", "utf8");

    const profile = runCli(["profile", "sqlite-demo", "--root", root]);

    expect(profile.status).toBe(0);
    expect(profile.stderr).toBe("");
    expect(profile.stdout).toContain("status         needs-validation");
    expect(profile.stdout).toContain(
      "high-trust accepted sources contribute no facts: sqlite-latest-docs (index-only)",
    );

    const profileJson = runCli(["profile", "sqlite-demo", "--root", root, "--json"]);
    const parsedProfile = JSON.parse(profileJson.stdout) as {
      evidence: {
        zeroFactHighTrustSources: Array<{ id: string; ingestionMode: string }>;
      };
    };
    expect(parsedProfile.evidence.zeroFactHighTrustSources).toEqual([
      expect.objectContaining({
        id: "sqlite-latest-docs",
        ingestionMode: "index-only",
      }),
    ]);
  });
});
