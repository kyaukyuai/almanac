/**
 * CLI regression tests that exercise the real command entrypoint in a
 * subprocess. These cover output behavior that unit tests on storage helpers
 * cannot pin by themselves.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RefreshArtifactSchema, STAGE_IDS } from "./core/types.ts";
import {
  almanacDirPath,
  compileStatePath,
  ensureAlmanacLayout,
  knowledgeIndexManifestPath,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";
import { markStageCompleted } from "./compile/pipeline.ts";
import {
  negativeJsonlPath,
  positiveJsonlPath,
  stage11OutputPath,
} from "./compile/stages/s11-benchmark-gen.ts";

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

function mockAskProviderEnv(): Record<string, string | undefined> {
  return {
    ALMANAC_LLM: "mock",
    ANTHROPIC_API_KEY: undefined,
    ALMANAC_MOCK_RESPONSES: JSON.stringify({
      "answer-planner@planner-v1": [
        JSON.stringify({
          action: "call_tool",
          toolName: "query_facts",
          input: { q: "transactions atomic", limit: 3 },
        }),
        JSON.stringify({ action: "stop", reason: "enough-evidence" }),
      ],
      "answer-synthesis@synthesis-v1": JSON.stringify({
        status: "ok",
        answer: "SQLite transactions are atomic.",
        citations: [
          {
            sourceId: "sqlite-transactions",
            url: "https://www.sqlite.org/lang_transaction.html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    }),
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

  test("new validates Anthropic timeout override before running LLM stages", () => {
    const result = runCli(
      [
        "new",
        "Timeout Env",
        "--slug",
        "timeout-env",
        "--profile",
        "mixed",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: "dummy",
        ALMANAC_ANTHROPIC_TIMEOUT_MS: "sixty-seconds",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ALMANAC_ANTHROPIC_TIMEOUT_MS must be a positive integer number of milliseconds",
    );
  });
});

describe("almanac CLI product onboarding", () => {
  test("demo creates an inspectable almanac with sources, fixtures, and benchmark report", async () => {
    const demo = runCli(["demo", "--root", root]);

    expect(demo.status).toBe(0);
    expect(demo.stderr).toBe("");
    expect(demo.stdout).toContain('creating offline demo almanac "sqlite-demo"');
    expect(demo.stdout).toContain("benchmark  2/2 passed");
    expect(demo.stdout).toContain(`almanac profile sqlite-demo --root ${root}`);
    expect(demo.stdout).toContain("almanac run sqlite-demo --tool query_facts");

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
    expect(profile.stdout).toContain("answer mode    needs-validation");
    expect(profile.stdout).toContain("ask fixtures   0 found");
    expect(profile.stdout).toContain("ask suite      not-run");
    expect(profile.stdout).toContain("quality gate   missing");
    expect(profile.stdout).toContain("no ask replay fixtures");
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
      answer: {
        status: string;
        fixtures: { count: number };
        latestSuite: { status: string };
        qualityGate: { status: string };
      };
    };
    expect(parsedProfile.status).toBe("usable");
    expect(parsedProfile.evidence.facts).toBe(3);
    expect(parsedProfile.evidence.factSourceCount).toBe(3);
    expect(parsedProfile.evidence.acceptedSources).toBe(3);
    expect(parsedProfile.benchmark.report.passed).toBe(2);
    expect(parsedProfile.benchmark.report.total).toBe(2);
    expect(parsedProfile.benchmark.report.citationRate).toBe(1);
    expect(parsedProfile.answer.status).toBe("needs-validation");
    expect(parsedProfile.answer.fixtures.count).toBe(0);
    expect(parsedProfile.answer.latestSuite.status).toBe("not-run");
    expect(parsedProfile.answer.qualityGate.status).toBe("missing");

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

    const refreshDue = runCli(
      ["refresh", "due", "sqlite-demo", "--root", root, "--json"],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );
    expect(refreshDue.status).toBe(0);
    expect(refreshDue.stderr).toBe("");
    const parsedRefreshDue = JSON.parse(refreshDue.stdout) as {
      due: boolean;
      recommendedFromStage: string;
      reasons: Array<{ code: string }>;
      benchmark: { status: string };
    };
    expect(parsedRefreshDue.due).toBe(true);
    expect(parsedRefreshDue.recommendedFromStage).toBe("04-source-fetch");
    expect(parsedRefreshDue.reasons).toContainEqual(
      expect.objectContaining({ code: "source-fetch-manifest-missing" }),
    );
    expect(parsedRefreshDue.benchmark.status).toBe("passed");

    const refreshRun = runCli(
      [
        "refresh",
        "run",
        "sqlite-demo",
        "--from-stage",
        "12-benchmark-run",
        "--json",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );
    expect(refreshRun.status).toBe(0);
    expect(refreshRun.stderr).toBe("");
    const parsedRefreshRun = JSON.parse(refreshRun.stdout) as {
      status: string;
      exitCode: number;
      requestedFromStage: string | null;
      effectiveFromStage: string;
      benchmark: { status: string };
      savedArtifact?: { relPath: string };
    };
    expect(parsedRefreshRun.status).toBe("ok");
    expect(parsedRefreshRun.exitCode).toBe(0);
    expect(parsedRefreshRun.requestedFromStage).toBe("12-benchmark-run");
    expect(parsedRefreshRun.effectiveFromStage).toBe("12-benchmark-run");
    expect(parsedRefreshRun.benchmark.status).toBe("passed");
    expect(parsedRefreshRun.savedArtifact).toBeUndefined();

    const savedRefreshRun = runCli(
      [
        "refresh",
        "run",
        "sqlite-demo",
        "--from-stage",
        "12-benchmark-run",
        "--save",
        "--label",
        "rc-smoke",
        "--json",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );
    expect(savedRefreshRun.status).toBe(0);
    expect(savedRefreshRun.stderr).toBe("");
    const parsedSavedRefreshRun = JSON.parse(savedRefreshRun.stdout) as {
      status: string;
      savedArtifact?: { relPath: string };
    };
    expect(parsedSavedRefreshRun.status).toBe("ok");
    expect(parsedSavedRefreshRun.savedArtifact?.relPath).toMatch(
      /^\.runs\/refresh-/,
    );

    const inspectWithRefresh = runCli(["inspect", "sqlite-demo", "--root", root]);
    expect(inspectWithRefresh.status).toBe(0);
    expect(inspectWithRefresh.stderr).toBe("");
    expect(inspectWithRefresh.stdout).toContain("health         ok");
    expect(inspectWithRefresh.stdout).toContain("refresh        last ok");
    expect(inspectWithRefresh.stdout).toContain("from 12-benchmark-run");
    expect(inspectWithRefresh.stdout).toContain("benchmark=passed");
    expect(inspectWithRefresh.stdout).toContain("label=rc-smoke");

    const profileWithRefresh = runCli(["profile", "sqlite-demo", "--root", root]);
    expect(profileWithRefresh.status).toBe(0);
    expect(profileWithRefresh.stderr).toBe("");
    expect(profileWithRefresh.stdout).toContain("status         usable");
    expect(profileWithRefresh.stdout).toContain("refresh        last ok");
    expect(profileWithRefresh.stdout).toContain("label=rc-smoke");

    const profileWithRefreshJson = runCli([
      "profile",
      "sqlite-demo",
      "--root",
      root,
      "--json",
    ]);
    expect(profileWithRefreshJson.status).toBe(0);
    expect(profileWithRefreshJson.stderr).toBe("");
    expect(
      (JSON.parse(profileWithRefreshJson.stdout) as {
        refresh: {
          latest: { status: string; label?: string; fromStage?: string };
          issue: string | null;
        };
      }).refresh,
    ).toEqual(
      expect.objectContaining({
        latest: expect.objectContaining({
          status: "ok",
          label: "rc-smoke",
          fromStage: "12-benchmark-run",
        }),
        issue: null,
      }),
    );

    const doctorWithRefresh = runCli(["doctor", "sqlite-demo", "--root", root]);
    expect(doctorWithRefresh.status).toBe(0);
    expect(doctorWithRefresh.stderr).toBe("");
    expect(doctorWithRefresh.stdout).toContain("ok   refresh");
    expect(doctorWithRefresh.stdout).toContain("last ok");
    expect(doctorWithRefresh.stdout).toContain("label=rc-smoke");

    const refreshRuns = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "refresh",
      "--json",
      "--root",
      root,
    ]);
    expect(refreshRuns.status).toBe(0);
    expect(refreshRuns.stderr).toBe("");
    expect(
      (JSON.parse(refreshRuns.stdout) as {
        runs: Array<{ kind: string; label?: string; fromStage?: string }>;
      }).runs,
    ).toContainEqual(
      expect.objectContaining({
        kind: "refresh",
        label: "rc-smoke",
        fromStage: "12-benchmark-run",
      }),
    );

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
    expect(doctor.stdout).toContain("embeddings");
    expect(doctor.stdout).toContain("warn answer");
    expect(doctor.stdout).toContain("no ask replay fixtures");

    const exported = runCli([
      "export",
      "sqlite-demo",
      "--include-runs",
      "--output",
      join(root, "sqlite-demo.tar.gz"),
      "--root",
      root,
    ]);
    expect(exported.status).toBe(0);
    expect(exported.stderr).toBe("");
    expect(exported.stdout).toContain("INCLUDE .runs/");

    const failedRefreshId = "refresh-2099-01-05T00-00-00-000Z-00000005";
    const failedRefreshArtifact = RefreshArtifactSchema.parse({
      schemaVersion: "0.1.0",
      kind: "refresh",
      artifactRelPath: `.runs/${failedRefreshId}.json`,
      refreshId: failedRefreshId,
      startedAt: "2099-01-05T00:00:00.000Z",
      finishedAt: "2099-01-05T00:00:05.000Z",
      almanacId: "sqlite-demo",
      version: "0.1.0",
      status: "failed",
      exitCode: 1,
      requestedFromStage: "04-source-fetch",
      effectiveFromStage: "04-source-fetch",
      dueDecision: {
        due: true,
        recommendedFromStage: "04-source-fetch",
        reasonCodes: ["source-fetch-failed"],
      },
      stageSummary: {
        succeeded: ["04-source-fetch"],
        skipped: [],
        failed: ["05-fact-extraction"],
      },
      benchmark: {
        status: "failed",
        total: 2,
        passed: 1,
        failed: 1,
        errored: 0,
        citationRate: 0.5,
      },
      durationMs: 5000,
      error: {
        code: "refresh-run-failed",
        message: "fixture failure",
      },
    });
    await writeFile(
      join(almanacDirPath(root, "sqlite-demo"), failedRefreshArtifact.artifactRelPath),
      JSON.stringify(failedRefreshArtifact, null, 2) + "\n",
      "utf8",
    );

    const failedInspect = runCli(["inspect", "sqlite-demo", "--root", root]);
    expect(failedInspect.status).toBe(0);
    expect(failedInspect.stdout).toContain("health         attention");
    expect(failedInspect.stdout).toContain(
      `latest refresh run failed: ${failedRefreshId}`,
    );
    expect(failedInspect.stdout).toContain(
      `almanac runs sqlite-demo ${failedRefreshId} --root ${root}`,
    );

    const failedProfile = runCli(["profile", "sqlite-demo", "--root", root]);
    expect(failedProfile.status).toBe(0);
    expect(failedProfile.stdout).toContain("status         needs-validation");
    expect(failedProfile.stdout).toContain(
      `latest refresh run failed: ${failedRefreshId}`,
    );

    const failedDoctor = runCli(["doctor", "sqlite-demo", "--root", root]);
    expect(failedDoctor.status).toBe(0);
    expect(failedDoctor.stdout).toContain("warn refresh");
    expect(failedDoctor.stdout).toContain("last failed");
  }, { timeout: 15_000 });

  test("run invokes compiled tools with stable output and exit codes", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const list = runCli(["run", "sqlite-demo", "--list-tools", "--root", root]);
    expect(list.status).toBe(0);
    expect(list.stderr).toBe("");
    expect(list.stdout).toContain("tools: sqlite-demo");
    expect(list.stdout).toContain("query_facts");

    const human = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '{"q":"transactions atomic","limit":3}',
      "--root",
      root,
    ]);
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("tool: query_facts");
    expect(human.stdout).toContain("status: ok");
    expect(human.stdout).toContain("citations: 1");
    expect(human.stdout).toContain("atomic");

    const inputFile = join(root, "run-input.json");
    await writeFile(
      inputFile,
      JSON.stringify({ q: "journal mode", limit: 3 }),
      "utf8",
    );
    const json = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input-file",
      inputFile,
      "--json",
      "--root",
      root,
    ]);
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout) as {
      status: string;
      result: {
        ok: boolean;
        data?: { hits?: Array<{ text: string }> };
      };
      citationsCount: number;
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.result.ok).toBe(true);
    expect(parsed.citationsCount).toBe(1);
    expect(parsed.result.data?.hits?.[0]?.text).toContain("journal_mode");

    const savedJson = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '{"q":"transactions atomic","limit":3}',
      "--label",
      "release-smoke",
      "--note",
      "Validate the saved run artifact viewer.",
      "--json",
      "--save",
      "--root",
      root,
    ]);
    expect(savedJson.status).toBe(0);
    expect(savedJson.stderr).toBe("");
    const savedArtifact = JSON.parse(savedJson.stdout) as {
      schemaVersion: string;
      kind: string;
      artifactRelPath: string;
      runId: string;
      status: string;
      exitCode: number;
      label?: string;
      note?: string;
      result: { ok: boolean };
    };
    expect(savedArtifact.schemaVersion).toBe("0.1.0");
    expect(savedArtifact.kind).toBe("tool");
    expect(savedArtifact.status).toBe("ok");
    expect(savedArtifact.exitCode).toBe(0);
    expect(savedArtifact.label).toBe("release-smoke");
    expect(savedArtifact.note).toBe("Validate the saved run artifact viewer.");
    expect(savedArtifact.result.ok).toBe(true);
    expect(savedArtifact.artifactRelPath).toBe(
      `.runs/${savedArtifact.runId}.json`,
    );
    const savedPath = join(
      almanacDirPath(root, "sqlite-demo"),
      savedArtifact.artifactRelPath,
    );
    expect(JSON.parse(await readFile(savedPath, "utf8"))).toEqual(savedArtifact);

    const missing = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "missing_tool",
      "--root",
      root,
    ]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe("");
    expect(missing.stdout).toContain("status: tool-not-found");
    expect(missing.stdout).toContain("available tools:");

    const badInput = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '"not an object"',
      "--root",
      root,
    ]);
    expect(badInput.status).toBe(2);
    expect(badInput.stderr).toBe("");
    expect(badInput.stdout).toContain("status: bad-input");

    const badInputSaved = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '"not an object"',
      "--save",
      "--json",
      "--root",
      root,
    ]);
    expect(badInputSaved.status).toBe(2);
    expect(badInputSaved.stderr).toBe("");
    const badInputArtifact = JSON.parse(badInputSaved.stdout) as {
      artifactRelPath: string;
      runId: string;
      status: string;
      exitCode: number;
      result: { ok: boolean; error?: { code: string } };
    };
    expect(badInputArtifact.status).toBe("bad-input");
    expect(badInputArtifact.exitCode).toBe(2);
    expect(badInputArtifact.result.ok).toBe(false);
    expect(badInputArtifact.result.error?.code).toBe("bad-input");
    expect(
      await readFile(
        join(
          almanacDirPath(root, "sqlite-demo"),
          badInputArtifact.artifactRelPath,
        ),
        "utf8",
      ),
    ).toContain('"status": "bad-input"');

    const runsList = runCli(["runs", "sqlite-demo", "--root", root]);
    expect(runsList.status).toBe(0);
    expect(runsList.stderr).toBe("");
    expect(runsList.stdout).toContain("runs: sqlite-demo");
    expect(runsList.stdout).toContain(savedArtifact.runId);
    expect(runsList.stdout).toContain("query_facts");
    expect(runsList.stdout).toContain("label=release-smoke");

    const runsJson = runCli([
      "runs",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(runsJson.status).toBe(0);
    expect(runsJson.stderr).toBe("");
    const parsedRuns = JSON.parse(runsJson.stdout) as {
      almanacId: string;
      runs: Array<{
        runId: string;
        label?: string;
        status: string;
        artifactRelPath: string;
      }>;
    };
    expect(parsedRuns.almanacId).toBe("sqlite-demo");
    expect(parsedRuns.runs.map((run) => run.runId).sort()).toEqual(
      [savedArtifact.runId, badInputArtifact.runId].sort(),
    );
    expect(
      parsedRuns.runs.find((run) => run.runId === savedArtifact.runId)?.label,
    ).toBe("release-smoke");

    const okRuns = runCli([
      "runs",
      "sqlite-demo",
      "--status",
      "ok",
      "--json",
      "--root",
      root,
    ]);
    expect(okRuns.status).toBe(0);
    expect(
      (JSON.parse(okRuns.stdout) as { runs: Array<{ runId: string }> }).runs
        .map((run) => run.runId),
    ).toEqual([savedArtifact.runId]);

    const labelRuns = runCli([
      "runs",
      "sqlite-demo",
      "--label",
      "release-smoke",
      "--json",
      "--root",
      root,
    ]);
    expect(labelRuns.status).toBe(0);
    expect(
      (JSON.parse(labelRuns.stdout) as { runs: Array<{ runId: string }> }).runs
        .map((run) => run.runId),
    ).toEqual([savedArtifact.runId]);

    const badInputRuns = runCli([
      "runs",
      "sqlite-demo",
      "--status",
      "bad-input",
      "--limit",
      "1",
      "--json",
      "--root",
      root,
    ]);
    expect(badInputRuns.status).toBe(0);
    expect(
      (JSON.parse(badInputRuns.stdout) as { runs: Array<{ runId: string }> })
        .runs.map((run) => run.runId),
    ).toEqual([badInputArtifact.runId]);

    const latestRun = runCli([
      "runs",
      "sqlite-demo",
      "--latest",
      "--json",
      "--root",
      root,
    ]);
    expect(latestRun.status).toBe(0);
    const latestParsed = JSON.parse(latestRun.stdout) as {
      runs: Array<{ runId: string }>;
    };
    expect(latestParsed.runs).toHaveLength(1);

    const limitedRuns = runCli([
      "runs",
      "sqlite-demo",
      "--limit",
      "1",
      "--json",
      "--root",
      root,
    ]);
    expect(limitedRuns.status).toBe(0);
    expect(
      (JSON.parse(limitedRuns.stdout) as { runs: unknown[] }).runs,
    ).toHaveLength(1);

    const runDetail = runCli([
      "runs",
      "sqlite-demo",
      savedArtifact.runId,
      "--root",
      root,
    ]);
    expect(runDetail.status).toBe(0);
    expect(runDetail.stderr).toBe("");
    expect(runDetail.stdout).toContain(`run: ${savedArtifact.runId}`);
    expect(runDetail.stdout).toContain("status: ok");
    expect(runDetail.stdout).toContain("label: release-smoke");
    expect(runDetail.stdout).toContain("note:");
    expect(runDetail.stdout).toContain(
      "Validate the saved run artifact viewer.",
    );
    expect(runDetail.stdout).toContain("data:");

    const runDetailJson = runCli([
      "runs",
      "sqlite-demo",
      savedArtifact.runId,
      "--json",
      "--root",
      root,
    ]);
    expect(runDetailJson.status).toBe(0);
    expect(JSON.parse(runDetailJson.stdout)).toEqual(savedArtifact);

    const refreshId = "refresh-2026-01-04T00-00-00-000Z-00000004";
    const refreshArtifact = RefreshArtifactSchema.parse({
      schemaVersion: "0.1.0",
      kind: "refresh",
      artifactRelPath: `.runs/${refreshId}.json`,
      refreshId,
      startedAt: "2026-01-04T00:00:00.000Z",
      finishedAt: "2026-01-04T00:00:04.000Z",
      almanacId: "sqlite-demo",
      version: "0.1.0",
      label: "nightly",
      status: "ok",
      exitCode: 0,
      requestedFromStage: "04-source-fetch",
      effectiveFromStage: "04-source-fetch",
      dueDecision: {
        due: true,
        recommendedFromStage: "04-source-fetch",
        reasonCodes: ["source-fetch-manifest-missing"],
      },
      benchmark: {
        status: "passed",
        total: 2,
        passed: 2,
        failed: 0,
        errored: 0,
        citationRate: 1,
      },
      durationMs: 4000,
    });
    await writeFile(
      join(almanacDirPath(root, "sqlite-demo"), refreshArtifact.artifactRelPath),
      JSON.stringify(refreshArtifact, null, 2) + "\n",
      "utf8",
    );

    const refreshRuns = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "refresh",
      "--json",
      "--root",
      root,
    ]);
    expect(refreshRuns.status).toBe(0);
    expect(
      (JSON.parse(refreshRuns.stdout) as {
        runs: Array<{
          kind: string;
          runId: string;
          fromStage?: string;
          benchmarkStatus?: string;
        }>;
      }).runs,
    ).toEqual([
      expect.objectContaining({
        kind: "refresh",
        runId: refreshId,
        fromStage: "04-source-fetch",
        benchmarkStatus: "passed",
      }),
    ]);

    const toolRuns = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "tool",
      "--json",
      "--root",
      root,
    ]);
    expect(toolRuns.status).toBe(0);
    expect(
      (JSON.parse(toolRuns.stdout) as {
        runs: Array<{ kind: string; runId: string }>;
      }).runs.map((run) => run.kind),
    ).toEqual(["tool", "tool"]);

    const refreshDetail = runCli([
      "runs",
      "sqlite-demo",
      refreshId,
      "--root",
      root,
    ]);
    expect(refreshDetail.status).toBe(0);
    expect(refreshDetail.stdout).toContain(`refresh: ${refreshId}`);
    expect(refreshDetail.stdout).toContain("benchmark: passed");

    const refreshPrune = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "refresh",
      "--prune",
      "--keep-latest",
      "0",
      "--apply",
      "--json",
      "--root",
      root,
    ]);
    expect(refreshPrune.status).toBe(0);
    const parsedRefreshPrune = JSON.parse(refreshPrune.stdout) as {
      applied: boolean;
      deletedCount: number;
      criteria: { kind?: string };
      runs: Array<{ kind: string; runId: string }>;
    };
    expect(parsedRefreshPrune.applied).toBe(true);
    expect(parsedRefreshPrune.deletedCount).toBe(1);
    expect(parsedRefreshPrune.criteria.kind).toBe("refresh");
    expect(parsedRefreshPrune.runs).toEqual([
      expect.objectContaining({ kind: "refresh", runId: refreshId }),
    ]);

    const refreshRunsAfterPrune = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "refresh",
      "--json",
      "--root",
      root,
    ]);
    expect(refreshRunsAfterPrune.status).toBe(0);
    expect(
      (JSON.parse(refreshRunsAfterPrune.stdout) as { runs: unknown[] }).runs,
    ).toEqual([]);

    const toolRunsAfterRefreshPrune = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "tool",
      "--json",
      "--root",
      root,
    ]);
    expect(toolRunsAfterRefreshPrune.status).toBe(0);
    expect(
      (JSON.parse(toolRunsAfterRefreshPrune.stdout) as {
        runs: Array<{ runId: string }>;
      }).runs.map((run) => run.runId).sort(),
    ).toEqual([savedArtifact.runId, badInputArtifact.runId].sort());

    const invalidRunsUsage = runCli([
      "runs",
      "sqlite-demo",
      "--latest",
      "--limit",
      "1",
      "--root",
      root,
    ]);
    expect(invalidRunsUsage.status).toBe(2);
    expect(invalidRunsUsage.stderr).toContain(
      "--latest and --limit are mutually exclusive",
    );

    const invalidDetailFilter = runCli([
      "runs",
      "sqlite-demo",
      savedArtifact.runId,
      "--status",
      "ok",
      "--root",
      root,
    ]);
    expect(invalidDetailFilter.status).toBe(2);
    expect(invalidDetailFilter.stderr).toContain(
      "[runId] cannot be combined with --latest, --limit, --status, --label, or --kind",
    );

    const pruneDryRun = runCli([
      "runs",
      "sqlite-demo",
      "--prune",
      "--status",
      "bad-input",
      "--keep-latest",
      "0",
      "--dry-run",
      "--json",
      "--root",
      root,
    ]);
    expect(pruneDryRun.status).toBe(0);
    const dryRunParsed = JSON.parse(pruneDryRun.stdout) as {
      applied: boolean;
      deletedCount: number;
      runs: Array<{ runId: string }>;
    };
    expect(dryRunParsed.applied).toBe(false);
    expect(dryRunParsed.deletedCount).toBe(0);
    expect(dryRunParsed.runs.map((run) => run.runId)).toEqual([
      badInputArtifact.runId,
    ]);

    const pruneApply = runCli([
      "runs",
      "sqlite-demo",
      "--prune",
      "--status",
      "bad-input",
      "--keep-latest",
      "0",
      "--apply",
      "--json",
      "--root",
      root,
    ]);
    expect(pruneApply.status).toBe(0);
    const applyParsed = JSON.parse(pruneApply.stdout) as {
      applied: boolean;
      deletedCount: number;
      runs: Array<{ runId: string }>;
    };
    expect(applyParsed.applied).toBe(true);
    expect(applyParsed.deletedCount).toBe(1);
    expect(applyParsed.runs.map((run) => run.runId)).toEqual([
      badInputArtifact.runId,
    ]);

    const prunedRuns = runCli([
      "runs",
      "sqlite-demo",
      "--status",
      "bad-input",
      "--json",
      "--root",
      root,
    ]);
    expect(prunedRuns.status).toBe(0);
    expect(
      (JSON.parse(prunedRuns.stdout) as { runs: unknown[] }).runs,
    ).toEqual([]);

    const invalidPruneMode = runCli([
      "runs",
      "sqlite-demo",
      "--prune",
      "--keep-latest",
      "1",
      "--dry-run",
      "--apply",
      "--root",
      root,
    ]);
    expect(invalidPruneMode.status).toBe(2);
    expect(invalidPruneMode.stderr).toContain(
      "--apply and --dry-run are mutually exclusive",
    );

    const pruneOptionWithoutPrune = runCli([
      "runs",
      "sqlite-demo",
      "--keep-latest",
      "1",
      "--root",
      root,
    ]);
    expect(pruneOptionWithoutPrune.status).toBe(2);
    expect(pruneOptionWithoutPrune.stderr).toContain("require --prune");

    const metadataWithoutSave = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '{"q":"transactions atomic","limit":3}',
      "--label",
      "unsaved",
      "--root",
      root,
    ]);
    expect(metadataWithoutSave.status).toBe(2);
    expect(metadataWithoutSave.stderr).toContain(
      "--label and --note require --save",
    );

    const missingToolOption = runCli(["run", "sqlite-demo", "--root", root]);
    expect(missingToolOption.status).toBe(2);
    expect(missingToolOption.stderr).toContain("missing required --tool");
  }, { timeout: 15_000 });

  test("ask synthesizes cited answers and can save answer artifacts", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const missingProvider = runCli(
      [
        "ask",
        "sqlite-demo",
        "Are SQLite transactions atomic?",
        "--save",
        "--root",
        root,
      ],
      {
        ALMANAC_LLM: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
    );
    expect(missingProvider.status).toBe(1);
    expect(missingProvider.stderr).toContain("ask: ANTHROPIC_API_KEY is not set");
    expect(await readdir(join(almanacDirPath(root, "sqlite-demo"), ".runs")))
      .toEqual([]);

    const mockEnv = mockAskProviderEnv();
    const human = runCli(
      [
        "ask",
        "sqlite-demo",
        "Are SQLite transactions atomic?",
        "--root",
        root,
      ],
      mockEnv,
    );
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("status: ok");
    expect(human.stdout).toContain("citations: 1");
    expect(human.stdout).toContain("SQLite transactions are atomic.");
    expect(human.stdout).toContain("sqlite-transactions");

    const savedJson = runCli(
      [
        "ask",
        "sqlite-demo",
        "Are SQLite transactions atomic?",
        "--save",
        "--label",
        "answer-smoke",
        "--note",
        "Validate saved ask artifacts.",
        "--json",
        "--root",
        root,
      ],
      mockAskProviderEnv(),
    );
    expect(savedJson.status).toBe(0);
    expect(savedJson.stderr).toBe("");
    const savedArtifact = JSON.parse(savedJson.stdout) as {
      schemaVersion: string;
      kind: string;
      artifactRelPath: string;
      answerId: string;
      status: string;
      exitCode: number;
      label?: string;
      note?: string;
      question: string;
      answer?: string;
      citations: unknown[];
      toolCalls: Array<{ toolName: string; status: string }>;
      trace?: {
        planner: { calls: number; stopReason: string };
        tools: { observations: Array<{ toolName: string; status: string }> };
        citations: { usedCount: number; observed: unknown[] };
        synthesis: { calls: number; status: string };
        quality?: {
          status: string;
          citationRate: number;
          unsupportedClaimCount: number;
          staleCitationCount: number;
        };
      };
    };
    expect(savedArtifact.schemaVersion).toBe("0.1.0");
    expect(savedArtifact.kind).toBe("answer");
    expect(savedArtifact.status).toBe("ok");
    expect(savedArtifact.exitCode).toBe(0);
    expect(savedArtifact.label).toBe("answer-smoke");
    expect(savedArtifact.note).toBe("Validate saved ask artifacts.");
    expect(savedArtifact.question).toBe("Are SQLite transactions atomic?");
    expect(savedArtifact.answer).toContain("atomic");
    expect(savedArtifact.citations).toHaveLength(1);
    expect(savedArtifact.toolCalls).toEqual([
      expect.objectContaining({ toolName: "query_facts", status: "ok" }),
    ]);
    expect(savedArtifact.trace?.planner).toEqual(
      expect.objectContaining({ calls: 2, stopReason: "planner-stop" }),
    );
    expect(savedArtifact.trace?.tools.observations).toEqual([
      expect.objectContaining({ toolName: "query_facts", status: "ok" }),
    ]);
    expect(savedArtifact.trace?.citations.usedCount).toBe(1);
    expect(savedArtifact.trace?.synthesis).toEqual(
      expect.objectContaining({ calls: 1, status: "ok" }),
    );
    expect(savedArtifact.trace?.quality).toEqual(
      expect.objectContaining({
        status: "pass",
        citationRate: 1,
        unsupportedClaimCount: 0,
        staleCitationCount: 0,
      }),
    );
    expect(savedArtifact.artifactRelPath).toBe(
      `.runs/${savedArtifact.answerId}.json`,
    );
    expect(
      JSON.parse(
        await readFile(
          join(
            almanacDirPath(root, "sqlite-demo"),
            savedArtifact.artifactRelPath,
          ),
          "utf8",
        ),
      ),
    ).toEqual(savedArtifact);

    const answerRuns = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "answer",
      "--json",
      "--root",
      root,
    ]);
    expect(answerRuns.status).toBe(0);
    expect(
      (JSON.parse(answerRuns.stdout) as {
        runs: Array<{ kind: string; runId: string; label?: string }>;
      }).runs,
    ).toEqual([
      expect.objectContaining({
        kind: "answer",
        runId: savedArtifact.answerId,
        label: "answer-smoke",
      }),
    ]);

    const answerDetail = runCli([
      "runs",
      "sqlite-demo",
      savedArtifact.answerId,
      "--root",
      root,
    ]);
    expect(answerDetail.status).toBe(0);
    expect(answerDetail.stdout).toContain(`answer: ${savedArtifact.answerId}`);
    expect(answerDetail.stdout).toContain("label: answer-smoke");
    expect(answerDetail.stdout).toContain("planner trace:");
    expect(answerDetail.stdout).toContain("tool trace:");
    expect(answerDetail.stdout).toContain("citation trace:");
    expect(answerDetail.stdout).toContain("quality trace: pass");
    expect(answerDetail.stdout).toContain("SQLite transactions are atomic.");

    const replayRuns = runCli([
      "ask-replay",
      "sqlite-demo",
      "--from-runs",
      "--label",
      "answer-smoke",
      "--json",
      "--root",
      root,
    ]);
    expect(replayRuns.status).toBe(0);
    const replayReport = JSON.parse(replayRuns.stdout) as {
      mode: string;
      total: number;
      passed: number;
      failed: number;
      errored: number;
      quality: { status: string; citationRate: number };
      results: Array<{
        fixtureId: string;
        quality: { status: string };
        observed: { status: string; citationsCount: number };
      }>;
    };
    expect(replayReport).toEqual(
      expect.objectContaining({
        mode: "saved-runs",
        total: 1,
        passed: 1,
        failed: 0,
        errored: 0,
      }),
    );
    expect(replayReport.results[0]).toEqual(
      expect.objectContaining({
        fixtureId: savedArtifact.answerId,
        quality: expect.objectContaining({
          status: "pass",
        }),
        observed: expect.objectContaining({
          status: "ok",
          citationsCount: 1,
        }),
      }),
    );

    const initAskFixtures = runCli([
      "ask-fixtures",
      "init",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(initAskFixtures.status).toBe(0);
    const initializedAskFixtures = JSON.parse(initAskFixtures.stdout) as {
      relPath: string;
      created: boolean;
      fixtureCount: number;
    };
    expect(initializedAskFixtures).toEqual(
      expect.objectContaining({
        relPath: "tests/ask.jsonl",
        created: true,
        fixtureCount: 0,
      }),
    );

    const addAskFixture = runCli([
      "ask-fixtures",
      "add-from-run",
      "sqlite-demo",
      savedArtifact.answerId,
      "--json",
      "--root",
      root,
    ]);
    expect(addAskFixture.status).toBe(0);
    const addedAskFixture = JSON.parse(addAskFixture.stdout) as {
      relPath: string;
      fixtureCount: number;
      fixture: { id: string; expectedStatus: string; minCitations: number };
    };
    expect(addedAskFixture).toEqual(
      expect.objectContaining({
        relPath: "tests/ask.jsonl",
        fixtureCount: 1,
        fixture: expect.objectContaining({
          id: savedArtifact.answerId,
          expectedStatus: "ok",
          minCitations: 1,
        }),
      }),
    );

    const authoredFixturePath = join(
      almanacDirPath(root, "sqlite-demo"),
      "tests",
      "ask.jsonl",
    );
    expect(await readFile(authoredFixturePath, "utf8")).toContain(
      savedArtifact.answerId,
    );
    const replayAuthoredFixture = runCli([
      "ask-replay",
      "sqlite-demo",
      "--fixture",
      authoredFixturePath,
      "--json",
      "--root",
      root,
    ]);
    expect(replayAuthoredFixture.status).toBe(0);
    expect(
      (JSON.parse(replayAuthoredFixture.stdout) as {
        mode: string;
        passed: number;
      }),
    ).toEqual(expect.objectContaining({ mode: "fixture", passed: 1 }));

    const askSuite = runCli([
      "ask-suite",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(askSuite.status).toBe(0);
    const askSuiteReport = JSON.parse(askSuite.stdout) as {
      status: string;
      total: number;
      passed: number;
      failed: number;
      errored: number;
      fixtureFiles: Array<{ relPath: string; count: number }>;
      quality: { status: string; citationRate: number };
      observedStatusCounts: { ok: number };
      results: Array<{ fixtureFile: { relPath: string; line: number } }>;
    };
    expect(askSuiteReport).toEqual(
      expect.objectContaining({
        status: "pass",
        total: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        quality: expect.objectContaining({ status: "pass", citationRate: 1 }),
      }),
    );
    expect(askSuiteReport.fixtureFiles).toEqual([
      expect.objectContaining({ relPath: "tests/ask.jsonl", count: 1 }),
    ]);
    expect(askSuiteReport.observedStatusCounts.ok).toBe(1);
    expect(askSuiteReport.results[0]?.fixtureFile).toEqual(
      expect.objectContaining({ relPath: "tests/ask.jsonl", line: 1 }),
    );

    const fixturePath = join(root, "ask-fixtures.jsonl");
    await writeFile(
      fixturePath,
      JSON.stringify({
        id: "sqlite-transactions-replay",
        question: "Are SQLite transactions atomic?",
        toolCalls: [
          {
            tool: "query_facts",
            input: { q: "transactions atomic", limit: 3 },
            expectedStatus: "ok",
          },
        ],
        expectedStatus: "ok",
        minCitations: 1,
        maxStaleCitations: 0,
      }) + "\n",
      "utf8",
    );
    const replayFixture = runCli([
      "ask-replay",
      "sqlite-demo",
      "--fixture",
      fixturePath,
      "--json",
      "--root",
      root,
    ]);
    expect(replayFixture.status).toBe(0);
    expect(
      (JSON.parse(replayFixture.stdout) as {
        mode: string;
        passed: number;
        quality: { status: string };
      }),
    ).toEqual(
      expect.objectContaining({
        mode: "fixture",
        passed: 1,
        quality: expect.objectContaining({ status: "pass" }),
      }),
    );

    const answerStatusRuns = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "answer",
      "--status",
      "ok",
      "--json",
      "--root",
      root,
    ]);
    expect(answerStatusRuns.status).toBe(0);
    expect(
      (JSON.parse(answerStatusRuns.stdout) as {
        runs: Array<{ runId: string }>;
      }).runs.map((run) => run.runId),
    ).toEqual([savedArtifact.answerId]);

    const savedToolJson = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '{"q":"journal mode","limit":3}',
      "--save",
      "--json",
      "--root",
      root,
    ]);
    expect(savedToolJson.status).toBe(0);
    const savedTool = JSON.parse(savedToolJson.stdout) as {
      runId: string;
      artifactRelPath: string;
    };

    const refreshId = "refresh-2026-01-06T00-00-00-000Z-00000006";
    const refreshArtifact = RefreshArtifactSchema.parse({
      schemaVersion: "0.1.0",
      kind: "refresh",
      artifactRelPath: `.runs/${refreshId}.json`,
      refreshId,
      startedAt: "2026-01-06T00:00:00.000Z",
      finishedAt: "2026-01-06T00:00:04.000Z",
      almanacId: "sqlite-demo",
      version: "0.1.0",
      status: "ok",
      exitCode: 0,
      requestedFromStage: "12-benchmark-run",
      effectiveFromStage: "12-benchmark-run",
      dueDecision: {
        due: true,
        recommendedFromStage: "12-benchmark-run",
        reasonCodes: ["manual-smoke"],
      },
      benchmark: {
        status: "passed",
        total: 2,
        passed: 2,
        failed: 0,
        errored: 0,
        citationRate: 1,
      },
      durationMs: 4000,
    });
    await writeFile(
      join(almanacDirPath(root, "sqlite-demo"), refreshArtifact.artifactRelPath),
      JSON.stringify(refreshArtifact, null, 2) + "\n",
      "utf8",
    );

    const answerPrune = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "answer",
      "--prune",
      "--keep-latest",
      "0",
      "--apply",
      "--json",
      "--root",
      root,
    ]);
    expect(answerPrune.status).toBe(0);
    const parsedAnswerPrune = JSON.parse(answerPrune.stdout) as {
      applied: boolean;
      deletedCount: number;
      criteria: { kind?: string };
      runs: Array<{ kind: string; runId: string }>;
    };
    expect(parsedAnswerPrune.applied).toBe(true);
    expect(parsedAnswerPrune.deletedCount).toBe(1);
    expect(parsedAnswerPrune.criteria.kind).toBe("answer");
    expect(parsedAnswerPrune.runs).toEqual([
      expect.objectContaining({
        kind: "answer",
        runId: savedArtifact.answerId,
      }),
    ]);

    const remainingRuns = runCli([
      "runs",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(remainingRuns.status).toBe(0);
    expect(
      (JSON.parse(remainingRuns.stdout) as {
        runs: Array<{ kind: string; runId: string }>;
      }).runs.map((run) => ({ kind: run.kind, runId: run.runId })).sort((a, b) =>
        a.runId.localeCompare(b.runId)
      ),
    ).toEqual(
      [
        { kind: "tool", runId: savedTool.runId },
        { kind: "refresh", runId: refreshId },
      ].sort((a, b) => a.runId.localeCompare(b.runId)),
    );
    expect(
      (await readdir(join(almanacDirPath(root, "sqlite-demo"), ".runs")))
        .sort(),
    ).toEqual(
      [savedTool.artifactRelPath.split("/").pop()!, `${refreshId}.json`]
        .sort(),
    );

    const answerRunsAfterPrune = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "answer",
      "--json",
      "--root",
      root,
    ]);
    expect(answerRunsAfterPrune.status).toBe(0);
    expect(
      (JSON.parse(answerRunsAfterPrune.stdout) as { runs: unknown[] }).runs,
    ).toEqual([]);

    const refreshWithAskSuite = runCli([
      "refresh",
      "run",
      "sqlite-demo",
      "--from-stage",
      "12-benchmark-run",
      "--ask-suite",
      "--save",
      "--json",
      "--root",
      root,
    ]);
    expect(refreshWithAskSuite.status).toBe(0);
    const parsedRefreshWithAskSuite = JSON.parse(
      refreshWithAskSuite.stdout,
    ) as {
      status: string;
      exitCode: number;
      askSuite?: { status: string; total: number; passed: number };
      savedArtifact?: { relPath: string };
    };
    expect(parsedRefreshWithAskSuite).toEqual(
      expect.objectContaining({
        status: "ok",
        exitCode: 0,
        askSuite: expect.objectContaining({
          status: "passed",
          total: 1,
          passed: 1,
        }),
      }),
    );
    expect(parsedRefreshWithAskSuite.savedArtifact?.relPath).toContain(
      ".runs/refresh-",
    );

    const latestRefreshWithAskSuite = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "refresh",
      "--latest",
      "--json",
      "--root",
      root,
    ]);
    expect(latestRefreshWithAskSuite.status).toBe(0);
    expect(
      (JSON.parse(latestRefreshWithAskSuite.stdout) as {
        runs: Array<{ askSuiteStatus?: string; askSuiteTotal?: number }>;
      }).runs[0],
    ).toEqual(
      expect.objectContaining({
        askSuiteStatus: "passed",
        askSuiteTotal: 1,
      }),
    );

    const answerProfileAfterSuite = runCli([
      "profile",
      "sqlite-demo",
      "--root",
      root,
    ]);
    expect(answerProfileAfterSuite.status).toBe(0);
    expect(answerProfileAfterSuite.stdout).toContain(
      "answer mode    needs-validation",
    );
    expect(answerProfileAfterSuite.stdout).toContain(
      "ask fixtures   1 found (tests/ask.jsonl:1)",
    );
    expect(answerProfileAfterSuite.stdout).toContain(
      "ask suite      passed, 1/1 passed",
    );
    expect(answerProfileAfterSuite.stdout).toContain("latest answer  none");
    expect(answerProfileAfterSuite.stdout).toContain("no saved answer artifacts");

    const answerProfileJsonAfterSuite = runCli([
      "profile",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(answerProfileJsonAfterSuite.status).toBe(0);
    expect(
      (JSON.parse(answerProfileJsonAfterSuite.stdout) as {
        answer: {
          status: string;
          fixtures: { paths: Array<{ relPath: string; count: number }> };
          latestSuite: { status: string; total?: number };
        };
      }).answer,
    ).toEqual(
      expect.objectContaining({
        status: "needs-validation",
        fixtures: expect.objectContaining({
          paths: [expect.objectContaining({ relPath: "tests/ask.jsonl", count: 1 })],
        }),
        latestSuite: expect.objectContaining({ status: "passed", total: 1 }),
      }),
    );

    const doctorAfterSuite = runCli([
      "doctor",
      "sqlite-demo",
      "--root",
      root,
    ]);
    expect(doctorAfterSuite.status).toBe(0);
    expect(doctorAfterSuite.stdout).toContain("warn answer");
    expect(doctorAfterSuite.stdout).toContain("suite passed");
    expect(doctorAfterSuite.stdout).toContain("no saved answer artifacts");

    const metadataWithoutSave = runCli([
      "ask",
      "sqlite-demo",
      "Are SQLite transactions atomic?",
      "--label",
      "unsaved",
      "--root",
      root,
    ]);
    expect(metadataWithoutSave.status).toBe(2);
    expect(metadataWithoutSave.stderr).toContain(
      "--label and --note require --save",
    );
  }, { timeout: 15_000 });

  test("profile flags high-trust snapshot sources with no extracted facts", async () => {
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
        mode: "snapshot",
        scope: ["**"],
        refreshIntervalHours: 168,
      },
      notes: null,
    });
    sources.sources.push({
      id: "sqlite-index-docs",
      url: "https://www.sqlite.org/index.html",
      kind: "docs",
      trust: 0.95,
      volatility: "slow",
      rationale: "High-trust SQLite documentation intentionally kept index-only.",
      ingestion: {
        mode: "index-only",
        scope: [],
        refreshIntervalHours: 168,
      },
      notes: null,
    });
    sources.generatedBy.acceptedCount = sources.sources.length;
    sources.coverage.docs += 2;
    await writeFile(sourcesPath, JSON.stringify(sources, null, 2) + "\n", "utf8");

    const profile = runCli(["profile", "sqlite-demo", "--root", root]);

    expect(profile.status).toBe(0);
    expect(profile.stderr).toBe("");
    expect(profile.stdout).toContain("status         needs-validation");
    expect(profile.stdout).toContain(
      "high-trust accepted sources contribute no facts: sqlite-latest-docs (snapshot)",
    );
    expect(profile.stdout).not.toContain("sqlite-index-docs (index-only)");

    const profileJson = runCli(["profile", "sqlite-demo", "--root", root, "--json"]);
    const parsedProfile = JSON.parse(profileJson.stdout) as {
      evidence: {
        zeroFactHighTrustSources: Array<{ id: string; ingestionMode: string }>;
      };
    };
    expect(parsedProfile.evidence.zeroFactHighTrustSources).toEqual([
      expect.objectContaining({
        id: "sqlite-latest-docs",
        ingestionMode: "snapshot",
      }),
    ]);
  });

  test("profile and inspect flag generated benchmark coverage below minimum", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const dir = almanacDirPath(root, "sqlite-demo");
    const positive = (await readFile(positiveJsonlPath(dir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const negative = (await readFile(negativeJsonlPath(dir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await writeFile(
      stage11OutputPath(dir),
      JSON.stringify(
        {
          schemaVersion: "0.1.0",
          set: {
            schemaVersion: "0.1.0",
            almanacId: "sqlite-demo",
            positive,
            negative,
          },
          rationale:
            "Synthetic Stage 11 output used to exercise generated benchmark coverage gating.",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const state = JSON.parse(await readFile(compileStatePath(dir), "utf8"));
    await writeCompileState(
      dir,
      markStageCompleted(
        state,
        "11-benchmark-gen",
        new Date(),
        { outputHash: "b".repeat(64), llmCalls: 1 },
      ),
    );

    const inspect = runCli(["inspect", "sqlite-demo", "--root", root]);
    expect(inspect.status).toBe(0);
    expect(inspect.stderr).toBe("");
    expect(inspect.stdout).toContain("health         attention");
    expect(inspect.stdout).toContain(
      "benchmark coverage below minimum: 1 positive / 1 negative / 2 total",
    );
    expect(inspect.stdout).toContain(
      "fixtures       1 positive / 1 negative (generated min 8 positive / 5 negative / 13 total)",
    );

    const profile = runCli(["profile", "sqlite-demo", "--root", root]);
    expect(profile.status).toBe(0);
    expect(profile.stderr).toBe("");
    expect(profile.stdout).toContain("status         needs-validation");
    expect(profile.stdout).toContain(
      "benchmark coverage below minimum: 1 positive / 1 negative / 2 total",
    );

    const profileJson = runCli(["profile", "sqlite-demo", "--root", root, "--json"]);
    const parsedProfile = JSON.parse(profileJson.stdout) as {
      status: string;
      benchmark: {
        coverageGate: {
          applies: boolean;
          ok: boolean;
          minimum: { positive: number; negative: number; total: number };
        };
      };
    };
    expect(parsedProfile.status).toBe("needs-validation");
    expect(parsedProfile.benchmark.coverageGate).toEqual(
      expect.objectContaining({
        applies: true,
        ok: false,
        minimum: { positive: 8, negative: 5, total: 13 },
      }),
    );
  });
});
