/**
 * CLI regression tests that exercise the real command entrypoint in a
 * subprocess. These cover output behavior that unit tests on storage helpers
 * cannot pin by themselves.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  RefreshArtifactSchema,
  STAGE_IDS,
  buildSourceFetchManifest,
} from "./core/types.ts";
import {
  almanacDirPath,
  compileStatePath,
  ensureAlmanacLayout,
  knowledgeIndexManifestPath,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";
import { markStageCompleted, markStageFailed } from "./compile/pipeline.ts";
import {
  negativeJsonlPath,
  positiveJsonlPath,
  stage11OutputPath,
} from "./compile/stages/s11-benchmark-gen.ts";
import { benchmarkResultPath } from "./compile/stages/s12-benchmark-run-runner.ts";

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

function runCliExecutable(
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
  const result = spawnSync(cliPath, args, {
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

function mockAbstainAskProviderEnv(): Record<string, string | undefined> {
  return {
    ALMANAC_LLM: "mock",
    ANTHROPIC_API_KEY: undefined,
    ALMANAC_MOCK_RESPONSES: JSON.stringify({
      "answer-planner@planner-v1": [
        JSON.stringify({
          action: "call_tool",
          toolName: "query_facts",
          input: { q: "definitely no matching sqlite fact", limit: 3 },
        }),
        JSON.stringify({ action: "stop", reason: "no-evidence" }),
      ],
    }),
  };
}

function coverageMap(fileCount = 0): Record<string, number> {
  return {
    docs: 0,
    repo: 0,
    news: 0,
    community: 0,
    academic: 0,
    data: 0,
    file: fileCount,
    essay: 0,
    book: 0,
    talk: 0,
  };
}

function guidedCreateMockEnv(
  sourceUrl: string,
): Record<string, string | undefined> {
  const almanacId = "tiny-guided-domain";
  const positive = Array.from({ length: 8 }, (_, index) => ({
    id: `tiny-pos-${String(index + 1).padStart(3, "0")}`,
    query: `what does guided activation support ${index + 1}?`,
    intent: "lookup",
    rationale:
      "Facts-backed query_facts fixture for the guided create apply smoke.",
    invocation: { tool: "query_facts", input: { q: "guided activation" } },
    expected: {
      minCitations: 1,
      contains: [],
      acceptableStaleness: ["fresh", "warm"],
    },
  }));
  const negative = Array.from({ length: 5 }, (_, index) => ({
    id: `tiny-neg-${String(index + 1).padStart(3, "0")}`,
    query: `out of scope weather lookup ${index + 1}`,
    rationale:
      "Out-of-scope query should not produce citations from the tiny almanac.",
    invocation: { tool: "query_facts", input: { q: `weather forecast ${index + 1}` } },
    refusalReason: "out-of-scope",
    expected: { maxCitations: 0 },
  }));

  return {
    ALMANAC_LLM: "mock",
    ANTHROPIC_API_KEY: undefined,
    BRAVE_SEARCH_API_KEY: undefined,
    ALMANAC_MOCK_RESPONSES: JSON.stringify({
      "01-domain-analysis@v2": JSON.stringify({
        domain: "Tiny Guided Domain",
        canonicalSlug: almanacId,
        displayName: "Tiny Guided Domain",
        summary:
          "Small deterministic domain for exercising guided almanac creation.",
        subareas: ["guided activation", "readiness checks"],
        intents: [
          { kind: "lookup", example: "what does guided activation support?" },
          { kind: "explain", example: "why does readiness matter?" },
        ],
        verbs: ["lookup", "explain"],
        entityTypes: ["activation", "readiness"],
        freshnessProfile: {
          profileId: "mixed",
          defaultClass: "slow",
          classes: {
            static: { examples: ["activation definition"] },
            slow: { examples: ["readiness workflow"], maxAgeDays: 365 },
            fast: { examples: [] },
            live: { examples: [] },
          },
        },
        suggestedSources: [
          { hint: sourceUrl, kind: "file" },
          { hint: "https://example.com/docs", kind: "docs" },
          { hint: "https://github.com/example/project", kind: "repo" },
        ],
        suggestedTools: [],
        cautions: [],
      }),
      "02-source-discovery@planner-v1": JSON.stringify({
        schemaVersion: "0.1.0",
        domain: {
          canonicalSlug: almanacId,
          displayName: "Tiny Guided Domain",
        },
        budgets: {
          maxWebSearchQueries: 0,
          maxGithubQueries: 0,
          maxUrlProbes: 0,
          maxCandidatesPerKind: 1,
          targetAcceptedSources: 1,
        },
        directProbes: [],
        webSearchQueries: [],
        githubQueries: [],
        coverageGoals: {
          docs: { min: 0, max: 0 },
          repo: { min: 0, max: 0 },
          news: { min: 0, max: 0 },
          community: { min: 0, max: 0 },
          academic: { min: 0, max: 0 },
          data: { min: 0, max: 0 },
          file: { min: 1, max: 1 },
          essay: { min: 0, max: 0 },
          book: { min: 0, max: 0 },
          talk: { min: 0, max: 0 },
        },
      }),
      "02-source-discovery@evaluator-v1": JSON.stringify({
        schemaVersion: "0.1.0",
        status: "draft",
        generatedAt: "2026-06-04T00:00:00.000Z",
        generatedBy: {
          stage: "02-source-discovery",
          evaluatorPromptVersion: "02-source-discovery/evaluator-v1",
          candidateCount: 0,
          acceptedCount: 1,
        },
        coverage: coverageMap(1),
        warnings: [],
        sources: [
          {
            id: "tiny-guided-source",
            url: sourceUrl,
            kind: "file",
            trust: 0.9,
            volatility: "slow",
            rationale: "Local deterministic source for guided create apply tests.",
            ingestion: {
              mode: "snapshot",
              scope: ["**"],
              refreshIntervalHours: 168,
            },
            notes: null,
          },
        ],
        rejected: [],
      }),
      "05-fact-extraction@v1": JSON.stringify({
        schemaVersion: "0.1.0",
        status: "extracted",
        skipReason: null,
        coverage: {
          extractable: "Guided activation workflow basics.",
          nonExtractable: "No live data in the local source.",
        },
        facts: [
          {
            text: "Tiny Guided Domain supports guided activation workflows.",
            type: "definition",
            entities: ["guided activation"],
            excerpt: "Tiny Guided Domain supports guided activation workflows.",
            freshnessClass: "static",
            validUntilRelative: null,
            confidence: 0.95,
          },
        ],
      }),
      "06-tool-design@v3": JSON.stringify({
        schemaVersion: "0.1.0",
        customTools: [],
        rationale:
          "The default facts-backed tools are sufficient for the guided create apply smoke.",
      }),
      "11-benchmark-gen@v3": JSON.stringify({
        schemaVersion: "0.1.0",
        set: {
          schemaVersion: "0.1.0",
          almanacId,
          positive,
          negative,
        },
        rationale:
          "Deterministic ask-independent benchmark fixtures for guided create apply.",
      }),
    }),
  };
}

describe("almanac CLI install/bin sanity", () => {
  test("package bin points at an executable Bun CLI entrypoint", async () => {
    const repoRoot = join(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as {
      bin?: Record<string, unknown>;
      engines?: Record<string, unknown>;
      version?: unknown;
    };

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageJson.engines?.bun).toBe(">=1.1.0");
    expect(packageJson.bin?.almanac).toBe("src/cli.ts");

    const cliPath = join(repoRoot, "src/cli.ts");
    const cliText = await readFile(cliPath, "utf8");
    expect(cliText.split("\n")[0]).toBe("#!/usr/bin/env bun");

    const cliMode = (await stat(cliPath)).mode;
    expect(cliMode & 0o111).not.toBe(0);
  });

  test("version is stable through both source and executable entrypoints", async () => {
    const repoRoot = join(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };

    const sourceResult = runCli(["--version"]);
    expect(sourceResult.status).toBe(0);
    expect(sourceResult.stderr).toBe("");
    expect(sourceResult.stdout.trim()).toBe(packageJson.version);

    const executableResult = runCliExecutable(["--version"]);
    expect(executableResult.status).toBe(0);
    expect(executableResult.stderr).toBe("");
    expect(executableResult.stdout.trim()).toBe(packageJson.version);
  });
});

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

async function writeFreshSqliteDemoSourceFetchManifest(): Promise<void> {
  const almanacDir = almanacDirPath(root, "sqlite-demo");
  const fetchedAt = new Date();
  const contentHash = "c".repeat(64);
  const manifest = buildSourceFetchManifest({
    almanacId: "sqlite-demo",
    startedAt: new Date(fetchedAt.getTime() - 1000),
    finishedAt: fetchedAt,
    entries: [
      {
        sourceId: "sqlite-transactions",
        status: "fetched",
        fetchedAt: fetchedAt.toISOString(),
        finalUrl: "https://www.sqlite.org/lang_transaction.html",
        fetcher: "fixture",
        documents: [
          {
            contentHash,
            relPath: `sources/raw/${contentHash}.html`,
            url: "https://www.sqlite.org/lang_transaction.html",
            mediaType: "text/html",
            byteLength: 120,
            fetchedAt: fetchedAt.toISOString(),
            sourceTimestamp: fetchedAt.toISOString(),
            title: "SQLite Transactions",
          },
        ],
      },
      {
        sourceId: "sqlite-query-plan",
        status: "fetched",
        fetchedAt: fetchedAt.toISOString(),
        finalUrl: "https://www.sqlite.org/eqp.html",
        fetcher: "fixture",
        documents: [
          {
            contentHash: "d".repeat(64),
            relPath: `sources/raw/${"d".repeat(64)}.html`,
            url: "https://www.sqlite.org/eqp.html",
            mediaType: "text/html",
            byteLength: 100,
            fetchedAt: fetchedAt.toISOString(),
            sourceTimestamp: fetchedAt.toISOString(),
            title: "SQLite Query Plan",
          },
        ],
      },
      {
        sourceId: "sqlite-pragmas",
        status: "fetched",
        fetchedAt: fetchedAt.toISOString(),
        finalUrl: "https://www.sqlite.org/pragma.html",
        fetcher: "fixture",
        documents: [
          {
            contentHash: "e".repeat(64),
            relPath: `sources/raw/${"e".repeat(64)}.html`,
            url: "https://www.sqlite.org/pragma.html",
            mediaType: "text/html",
            byteLength: 80,
            fetchedAt: fetchedAt.toISOString(),
            sourceTimestamp: fetchedAt.toISOString(),
            title: "SQLite Pragmas",
          },
        ],
      },
    ],
  });
  await writeFile(
    join(almanacDir, "sources", "manifest.summary.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
}

async function writeSqliteDemoAskFixture(
  opts: { unsupported?: boolean } = {},
): Promise<void> {
  const almanacDir = almanacDirPath(root, "sqlite-demo");
  await mkdir(join(almanacDir, "tests"), { recursive: true });
  const fixture = {
    id: opts.unsupported === true
      ? "sqlite-transactions-unsupported"
      : "sqlite-transactions-ok",
    question: "Are SQLite transactions atomic?",
    answer: "SQLite transactions are atomic.",
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
    ...(opts.unsupported === true
      ? { unsupportedClaims: ["SQLite encrypts every page by default."] }
      : {}),
  };
  await writeFile(
    join(almanacDir, "tests", "ask.jsonl"),
    JSON.stringify(fixture) + "\n",
    "utf8",
  );
}

async function writeFailedStageFixture(args: {
  almanacId: string;
  stageId: (typeof STAGE_IDS)[number];
  code: string;
  message: string;
}): Promise<void> {
  const dir = almanacDirPath(root, args.almanacId);
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: args.almanacId,
    domain: `${args.almanacId} domain`,
    displayName: "Failure Recovery Domain",
    freshnessProfileId: "mixed",
    runId: "run-failure-recovery",
    forgerVersion: "0.0.0",
    options: {
      depth: "quick",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-05-09T12:00:00.000Z"),
  });
  let state = markStageCompleted(
    compileState,
    "00-bootstrap",
    new Date("2026-05-09T12:01:00.000Z"),
    { outputHash: "a".repeat(64) },
  );
  state = markStageFailed(
    state,
    args.stageId,
    new Date("2026-05-09T12:02:00.000Z"),
    { code: args.code, message: args.message },
  );

  await ensureAlmanacLayout(dir);
  await writeManifest(dir, manifest);
  await writeCompileState(dir, state);
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

  test("list --json includes lifecycle inventory fields", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(["list", "--json", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const items = JSON.parse(result.stdout) as Array<{
      almanacId: string;
      manifest: unknown;
      lifecycle: {
        status: string;
        compile: { status: string; completed: number; failed: string[] };
        knowledge: {
          status: string;
          facts: number;
          tools: number;
          manifestFacts: number;
          manifestTools: number;
          countsMatch: boolean;
        };
        benchmark: { status: string };
        answer: { status: string };
        refresh: { status: string; reasons: number };
        issues: string[];
        nextActions: string[];
      };
    }>;

    const legacy = items.find((item) => item.almanacId === "legacy");
    expect(legacy).toBeDefined();
    expect(legacy?.manifest).not.toBeNull();
    expect(legacy?.lifecycle.status).toBe("attention");
    expect(legacy?.lifecycle.compile).toMatchObject({
      status: "ok",
      completed: STAGE_IDS.length,
      failed: [],
    });
    expect(legacy?.lifecycle.knowledge).toMatchObject({
      status: "present",
      facts: 7,
      tools: 2,
      manifestFacts: 0,
      manifestTools: 0,
      countsMatch: false,
    });
    expect(legacy?.lifecycle.benchmark.status).toBe("missing");
    expect(legacy?.lifecycle.answer.status).toBe("not-ready");
    expect(legacy?.lifecycle.refresh.status).toBe("due");
    expect(legacy?.lifecycle.refresh.reasons).toBeGreaterThan(0);
    expect(legacy?.lifecycle.issues).toContain(
      "manifest counts differ from actual artifacts",
    );
    expect(legacy?.lifecycle.nextActions.some((action) =>
      action.includes("almanac benchmark legacy --init"),
    )).toBe(true);
  });

  test("list reports partial and malformed almanac directories as broken", async () => {
    await mkdir(join(root, "partial"), { recursive: true });
    await mkdir(join(root, "malformed"), { recursive: true });
    await writeFile(join(root, "malformed", "manifest.json"), "{", "utf8");

    const result = runCli(["list", "--json", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const items = JSON.parse(result.stdout) as Array<{
      almanacId: string;
      manifest: unknown;
      lifecycle: { status: string; issues: string[] };
    }>;

    const partial = items.find((item) => item.almanacId === "partial");
    const malformed = items.find((item) => item.almanacId === "malformed");
    expect(partial?.manifest).toBeNull();
    expect(partial?.lifecycle.status).toBe("broken");
    expect(partial?.lifecycle.issues).toContain("manifest.json missing");
    expect(malformed?.manifest).toBeNull();
    expect(malformed?.lifecycle.status).toBe("broken");
    expect(malformed?.lifecycle.issues[0]?.startsWith("manifest unreadable:")).toBe(
      true,
    );
  });

  test("start guides an empty root to the provider-free demo", () => {
    const result = runCli(["start", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("almanac start");
    expect(result.stdout).toContain("status        empty");
    expect(result.stdout).toContain("Create the offline demo");
    expect(result.stdout).toContain(`command: almanac demo --root ${root}`);
    expect(result.stdout).toContain("references = citable source material");
    expect(result.stdout).toContain("Anthropic missing");
  });

  test("start --json emits a stable empty-root guide", () => {
    const result = runCli(["start", "--json", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: string;
      status: string;
      almanacs: unknown[];
      provider: { anthropic: string; braveSearch: string };
      firstUse: {
        status: string;
        stage: string;
        nextStage: string | null;
        nextAction: { command: string; providerRequired: boolean } | null;
        gaps: string[];
      };
      nextBestAction: {
        label: string;
        command: string;
        providerRequired: boolean;
        mutates: boolean;
      };
      nextActions: Array<{ command: string }>;
    };

    expect(parsed.schemaVersion).toBe("0.1.0");
    expect(parsed.status).toBe("empty");
    expect(parsed.almanacs).toEqual([]);
    expect(parsed.provider).toMatchObject({
      anthropic: "missing",
      braveSearch: "missing",
    });
    expect(parsed.firstUse).toEqual(
      expect.objectContaining({
        status: "not-started",
        stage: "empty-root",
        nextStage: "planning",
        nextAction: expect.objectContaining({
          command: `almanac demo --root ${root}`,
          providerRequired: false,
        }),
        gaps: ["no local almanac is visible in this root"],
      }),
    );
    expect(parsed.nextBestAction).toMatchObject({
      label: "Create the offline demo",
      command: `almanac demo --root ${root}`,
      providerRequired: false,
      mutates: true,
    });
    expect(parsed.nextActions.map((action) => action.command)).toContain(
      `almanac doctor --root ${root}`,
    );
  });

  test("start with a natural-language goal drafts a provider-backed setup plan", () => {
    const result = runCli(
      [
        "start",
        "Build an almanac for production AI governance checks",
        "--json",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      summary: string;
      firstUse: {
        status: string;
        stage: string;
        nextStage: string | null;
        nextAction: { command: string; providerRequired: boolean } | null;
      };
      goalDraft: {
        goal: string;
        domain: string;
        displayName: string;
        slug: string;
        scope: string;
        reviewedReferences: string[];
        sourceChecklist: {
          status: string;
          summary: string;
          items: Array<{
            id: string;
            status: string;
            acceptedCount: number;
            rejectedCount: number;
          }>;
        };
        referenceChecklist: Array<{ kind: string; label: string }>;
        firstUseChecklist: Array<{
          id: string;
          status: string;
          command: string | null;
          providerRequired: boolean;
          mutates: boolean;
        }>;
        firstQuestions: string[];
        applyCommand: string;
        suggestedCommand: string;
        studioHandoff: {
          command: string;
          providerRequired: boolean;
          mutates: boolean;
        };
        confirmationRequired: boolean;
        providerRequiredForCompile: boolean;
        notes: string[];
      };
      nextBestAction: {
        command: string;
        providerRequired: boolean;
        mutates: boolean;
      };
      nextActions: Array<{ command: string; providerRequired: boolean }>;
    };

    expect(parsed.status).toBe("planning");
    expect(parsed.summary).toContain("Drafted a setup plan");
    expect(parsed.firstUse).toEqual(
      expect.objectContaining({
        status: "in-progress",
        stage: "planning",
        nextStage: "source-checklist",
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac start 'Build an almanac for production AI governance checks'"),
          providerRequired: true,
        }),
      }),
    );
    expect(parsed.goalDraft).toMatchObject({
      goal: "Build an almanac for production AI governance checks",
      domain: "production AI governance checks",
      displayName: "Production AI Governance Checks",
      slug: "production-ai-governance-checks",
      confirmationRequired: true,
      providerRequiredForCompile: true,
    });
    expect(parsed.goalDraft.reviewedReferences).toEqual([]);
    expect(parsed.goalDraft.sourceChecklist).toMatchObject({
      status: "missing",
      summary: "no reviewed references yet",
    });
    expect(parsed.goalDraft.sourceChecklist.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "official-docs",
          status: "missing",
          acceptedCount: 0,
          rejectedCount: 0,
        }),
        expect.objectContaining({
          id: "repository",
          status: "missing",
          acceptedCount: 0,
          rejectedCount: 0,
        }),
        expect.objectContaining({
          id: "secondary-article",
          status: "optional",
        }),
        expect.objectContaining({
          id: "community",
          status: "optional",
        }),
      ]),
    );
    expect(parsed.goalDraft.scope).toContain("Production AI Governance Checks");
    expect(parsed.goalDraft.referenceChecklist.map((item) => item.kind)).toEqual([
      "docs",
      "standard",
      "repo",
      "internal-doc",
    ]);
    expect(parsed.goalDraft.firstUseChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "choose-reference",
          status: "todo",
          command: "export REFERENCE_URL=<reviewed-url-or-file>",
          providerRequired: false,
          mutates: false,
        }),
        expect.objectContaining({
          id: "confirm-provider",
          status: "todo",
          command: "export ANTHROPIC_API_KEY=<your-key>",
          providerRequired: true,
        }),
        expect.objectContaining({
          id: "create-almanac",
          status: "blocked",
          command: expect.stringContaining("--apply"),
          providerRequired: true,
          mutates: true,
        }),
        expect.objectContaining({
          id: "open-studio",
          status: "later",
          command: `almanac studio --root ${root}`,
          providerRequired: false,
          mutates: false,
        }),
      ]),
    );
    expect(parsed.goalDraft.firstQuestions[0]).toContain(
      "Production AI Governance Checks",
    );
    expect(parsed.goalDraft.applyCommand).toContain(
      "almanac start 'Build an almanac for production AI governance checks'",
    );
    expect(parsed.goalDraft.applyCommand).toContain("--apply");
    expect(parsed.goalDraft.suggestedCommand).toContain(
      "almanac new 'production AI governance checks'",
    );
    expect(parsed.goalDraft.suggestedCommand).toContain('--source "$REFERENCE_URL"');
    expect(parsed.goalDraft.notes).toContain(
      "Add at least one reviewed reference with --source before using --apply.",
    );
    expect(parsed.goalDraft.notes).toContain(
      "Creation needs ANTHROPIC_API_KEY because Almanac will read references and compile grounded tools.",
    );
    expect(parsed.goalDraft.studioHandoff).toMatchObject({
      command: `almanac studio --root ${root}`,
      providerRequired: false,
      mutates: false,
    });
    expect(parsed.nextActions.some((action) =>
      action.command === `almanac studio --root ${root}` &&
      action.providerRequired === false,
    )).toBe(true);
    expect(parsed.nextActions.some((action) =>
      action.command.includes("--apply") && action.providerRequired === true,
    )).toBe(true);
  });

  test("start with reviewed references returns an apply-ready first-use handoff", () => {
    const result = runCli(
      [
        "start",
        "Build an almanac for production AI governance checks",
        "--source",
        "https://docs.example.com/reference",
        "--json",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: "dummy",
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      firstUse: {
        summary: string;
        nextStage: string | null;
      };
      goalDraft: {
        reviewedReferences: string[];
        sourceChecklist: {
          status: string;
          acceptedCount: number;
          items: Array<{ id: string; status: string; acceptedCount: number }>;
        };
        firstUseChecklist: Array<{
          id: string;
          status: string;
          command: string | null;
        }>;
        applyCommand: string;
        suggestedCommand: string;
      };
      nextBestAction: { command: string; providerRequired: boolean; mutates: boolean };
    };
    expect(parsed.firstUse).toEqual(
      expect.objectContaining({
        summary: "setup planned; next compile handoff",
        nextStage: "compile-handoff",
      }),
    );
    expect(parsed.goalDraft.reviewedReferences).toEqual([
      "https://docs.example.com/reference",
    ]);
    expect(parsed.goalDraft.sourceChecklist).toMatchObject({
      status: "ready",
      acceptedCount: 1,
    });
    expect(parsed.goalDraft.sourceChecklist.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "official-docs",
          status: "ready",
          acceptedCount: 1,
        }),
      ]),
    );
    expect(parsed.goalDraft.firstUseChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "choose-reference", status: "ready" }),
        expect.objectContaining({ id: "confirm-provider", status: "ready" }),
        expect.objectContaining({
          id: "create-almanac",
          status: "ready",
          command: expect.stringContaining(
            "--source https://docs.example.com/reference --apply",
          ),
        }),
      ]),
    );
    expect(parsed.goalDraft.applyCommand).toContain(
      "--source https://docs.example.com/reference --apply",
    );
    expect(parsed.goalDraft.suggestedCommand).toContain(
      "--source https://docs.example.com/reference",
    );
    expect(parsed.nextBestAction).toMatchObject({
      command: expect.stringContaining("--apply"),
      providerRequired: true,
      mutates: true,
    });
  });

  test("start with a natural-language goal is readable in human output", () => {
    const result = runCli(
      [
        "start",
        "Build an almanac for production AI governance checks",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("status        planning");
    expect(result.stdout).toContain("first use     setup planned; next references needed");
    expect(result.stdout).toContain("setup draft:");
    expect(result.stdout).toContain("domain        production AI governance checks");
    expect(result.stdout).toContain("trusted reference checklist:");
    expect(result.stdout).toContain("[missing] Official docs");
    expect(result.stdout).toContain("[missing] Implementation repositories");
    expect(result.stdout).toContain("first-use checklist:");
    expect(result.stdout).toContain("[todo] Choose at least one trusted reference");
    expect(result.stdout).toContain("command: export REFERENCE_URL=<reviewed-url-or-file>");
    expect(result.stdout).toContain("[todo] Confirm provider credentials");
    expect(result.stdout).toContain("references to gather:");
    expect(result.stdout).toContain("first questions:");
    expect(result.stdout).toContain("credential boundary:");
    expect(result.stdout).toContain("Creation needs ANTHROPIC_API_KEY");
    expect(result.stdout).toContain("studio handoff:");
    expect(result.stdout).toContain(`almanac studio --root ${root}`);
    expect(result.stdout).toContain('--source "$REFERENCE_URL"');
  });

  test("start --apply blocks before provider work when source is missing", async () => {
    const result = runCli(
      [
        "start",
        "Build an almanac for Tiny Guided Domain",
        "--apply",
        "--json",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: "dummy",
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      blockers: string[];
      plannedCommand: string;
      delegatedCommand: string;
      goalDraft: {
        referenceChecklist: Array<{ label: string }>;
        firstUseChecklist: Array<{ id: string; status: string; command: string | null }>;
        applyCommand: string;
        studioHandoff: { command: string };
      };
      result: unknown;
    };
    expect(parsed.status).toBe("blocked");
    expect(parsed.blockers).toContain(
      "start --apply requires at least one explicit --source <url> reference.",
    );
    expect(parsed.plannedCommand).toContain("--apply");
    expect(parsed.delegatedCommand).toContain('--source "$REFERENCE_URL"');
    expect(parsed.goalDraft.referenceChecklist.map((item) => item.label)).toContain(
      "Official documentation",
    );
    expect(parsed.goalDraft.firstUseChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "choose-reference", status: "todo" }),
        expect.objectContaining({ id: "confirm-provider", status: "ready" }),
        expect.objectContaining({
          id: "create-almanac",
          status: "blocked",
          command: expect.stringContaining("--source \"$REFERENCE_URL\" --apply"),
        }),
      ]),
    );
    expect(parsed.goalDraft.applyCommand).toContain("--source \"$REFERENCE_URL\" --apply");
    expect(parsed.goalDraft.studioHandoff.command).toBe(
      `almanac studio --root ${root}`,
    );
    expect(parsed.result).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test("start --apply blocks before provider work when provider is missing", async () => {
    const result = runCli(
      [
        "start",
        "Build an almanac for Tiny Guided Domain",
        "--source",
        "https://example.com/reference",
        "--apply",
        "--json",
        "--root",
        root,
      ],
      {
        ALMANAC_LLM: undefined,
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      providerRequirement: { available: boolean; satisfiedBy: string | null };
      blockers: string[];
      goalDraft: {
        reviewedReferences: string[];
        firstUseChecklist: Array<{ id: string; status: string }>;
      };
      nextActions: Array<{ command: string }>;
      result: unknown;
    };
    expect(parsed.status).toBe("blocked");
    expect(parsed.providerRequirement).toMatchObject({
      available: false,
      satisfiedBy: null,
    });
    expect(parsed.blockers).toContain(
      "start --apply requires ANTHROPIC_API_KEY before provider-backed compile starts.",
    );
    expect(parsed.goalDraft.reviewedReferences).toEqual([
      "https://example.com/reference",
    ]);
    expect(parsed.goalDraft.firstUseChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "choose-reference", status: "ready" }),
        expect.objectContaining({ id: "confirm-provider", status: "todo" }),
        expect.objectContaining({ id: "create-almanac", status: "blocked" }),
      ]),
    );
    expect(parsed.nextActions.map((action) => action.command)).toContain(
      "export ANTHROPIC_API_KEY=<your-key>",
    );
    expect(parsed.result).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test("start --apply delegates to new with explicit source and mock provider", async () => {
    const sourcePath = join(root, "tiny-guided.md");
    await writeFile(
      sourcePath,
      "# Tiny Guided Domain\n\nTiny Guided Domain supports guided activation workflows.\n",
      "utf8",
    );
    const sourceUrl = pathToFileURL(sourcePath).href;

    const result = runCli(
      [
        "start",
        "Build an almanac for Tiny Guided Domain",
        "--source",
        sourceUrl,
        "--apply",
        "--json",
        "--root",
        root,
      ],
      guidedCreateMockEnv(sourceUrl),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      providerRequirement: { available: boolean; satisfiedBy: string | null };
      delegatedCommand: string;
      sources: string[];
      goalDraft: {
        reviewedReferences: string[];
        firstUseChecklist: Array<{ id: string; status: string; command: string | null }>;
        applyCommand: string;
        studioHandoff: { command: string };
      };
      result: {
        almanacId: string;
        almanacDir: string;
        stdoutLineCount: number;
        stdoutTail: string[];
      };
      nextActions: Array<{ command: string }>;
    };

    expect(parsed.status).toBe("created");
    expect(parsed.providerRequirement).toMatchObject({
      available: true,
      satisfiedBy: "mock",
    });
    expect(parsed.sources).toEqual([sourceUrl]);
    expect(parsed.goalDraft.reviewedReferences).toEqual([sourceUrl]);
    expect(parsed.goalDraft.firstUseChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "choose-reference", status: "ready" }),
        expect.objectContaining({ id: "confirm-provider", status: "ready" }),
        expect.objectContaining({
          id: "create-almanac",
          status: "ready",
          command: expect.stringContaining(`--source ${sourceUrl} --apply`),
        }),
      ]),
    );
    expect(parsed.goalDraft.applyCommand).toContain(`--source ${sourceUrl} --apply`);
    expect(parsed.goalDraft.studioHandoff.command).toBe(
      `almanac studio --root ${root}`,
    );
    expect(parsed.delegatedCommand).toContain("almanac new 'Tiny Guided Domain'");
    expect(parsed.result.almanacId).toBe("tiny-guided-domain");
    expect(parsed.result.stdoutLineCount).toBeGreaterThan(0);
    expect(parsed.result.stdoutTail.join("\n")).toContain(
      "Done. `almanac inspect tiny-guided-domain`",
    );
    expect(existsSync(join(root, "tiny-guided-domain", "manifest.json"))).toBe(
      true,
    );
    expect(parsed.nextActions.map((action) => action.command)).toContain(
      `almanac inspect tiny-guided-domain --root ${root}`,
    );

    const benchmark = runCli(["benchmark", "tiny-guided-domain", "--root", root]);
    expect(benchmark.status).toBe(0);
    expect(benchmark.stdout).toContain("total         13");
    expect(benchmark.stdout).toContain("passed        13");
  }, { timeout: 30_000 });

  test("start summarizes existing almanacs and recommends validation", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(["start", "--json", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      summary: string;
      almanacs: Array<{
        id: string;
        name: string;
        health: string;
        usability: { status: string };
        references: { extractedKnowledge: number; tools: number };
        checks: { validation: string; answer: string; refresh: string };
        nextAction: { label: string; command: string; providerRequired: boolean };
      }>;
      nextBestAction: { label: string; command: string; providerRequired: boolean };
    };

    expect(parsed.status).toBe("attention");
    expect(parsed.summary).toContain("1 almanac(s) found");
    expect(parsed.almanacs).toHaveLength(1);
    expect(parsed.almanacs[0]).toMatchObject({
      id: "legacy",
      name: "Legacy Domain",
      health: "attention",
      references: { extractedKnowledge: 7, tools: 2 },
      checks: {
        validation: "missing",
        answer: "not-ready",
        refresh: "due",
      },
    });
    expect(parsed.nextBestAction).toMatchObject({
      label: "Create validation checks",
      command: `almanac benchmark legacy --init --root ${root}`,
      providerRequired: false,
    });
  });

  test("doctor --json reports root hygiene without selecting one almanac", async () => {
    await writeLegacyCountFixture({ completed: true });
    await mkdir(join(root, "partial"), { recursive: true });
    await mkdir(join(root, "malformed"), { recursive: true });
    await writeFile(join(root, "malformed", "manifest.json"), "{", "utf8");
    await writeFile(join(root, "almanac-legacy-0.1.0.tar.gz"), "fake", "utf8");

    const home = `${root}-home`;
    const result = runCli(["doctor", "--json", "--root", root], {
      HOME: home,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      checks: Array<{ level: string; name: string; message: string }>;
      readiness: Array<{ name: string; status: string; nextActions: string[] }>;
      rootHygiene: {
        status: string;
        almanacs: {
          total: number;
          attention: number;
          broken: number;
        };
        cleanup: {
          exportArchives: string[];
          orphanedMcpRegistrations: unknown[];
        };
        issues: string[];
        nextActions: string[];
      };
    };

    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        level: "warn",
        name: "root-hygiene",
      }),
    );
    expect(parsed.rootHygiene.status).toBe("needs-validation");
    expect(parsed.rootHygiene.almanacs.total).toBe(3);
    expect(parsed.rootHygiene.almanacs.attention).toBe(1);
    expect(parsed.rootHygiene.almanacs.broken).toBe(2);
    expect(parsed.rootHygiene.cleanup.exportArchives).toEqual([
      join(root, "almanac-legacy-0.1.0.tar.gz"),
    ]);
    expect(parsed.rootHygiene.cleanup.orphanedMcpRegistrations).toEqual([]);
    expect(parsed.rootHygiene.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("partial: broken"),
        expect.stringContaining("malformed: broken"),
        expect.stringContaining("legacy: attention"),
      ]),
    );
    expect(parsed.rootHygiene.nextActions).toContain(`almanac list --root ${root}`);
    expect(parsed.readiness).toContainEqual(
      expect.objectContaining({
        name: "hygiene",
        status: "needs-validation",
      }),
    );
  });

  test("doctor reports provider readiness without leaking key values", async () => {
    const secret = "sk-ant-doctor-secret-0123456789";
    const lockedEnv = {
      ANTHROPIC_API_KEY: undefined,
      ALMANAC_LLM: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
      VOYAGE_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ALMANAC_EMBEDDINGS: undefined,
    };

    const locked = runCli(["doctor", "--json", "--root", root], lockedEnv);
    expect(locked.status).toBe(0);
    const lockedReadiness = (
      JSON.parse(locked.stdout) as {
        providerReadiness: {
          llm: { presence: string; detectedEnv: string[] };
          capabilities: Array<{
            id: string;
            status: string;
            unlockEnv: string[];
          }>;
        };
      }
    ).providerReadiness;
    expect(lockedReadiness.llm).toEqual({ presence: "absent", detectedEnv: [] });
    expect(lockedReadiness.capabilities).toContainEqual(
      expect.objectContaining({
        id: "compile",
        status: "locked",
        unlockEnv: ["ANTHROPIC_API_KEY"],
      }),
    );
    expect(lockedReadiness.capabilities).toContainEqual(
      expect.objectContaining({ id: "answer", status: "locked" }),
    );

    const unlocked = runCli(["doctor", "--root", root], {
      ...lockedEnv,
      ANTHROPIC_API_KEY: secret,
    });
    expect(unlocked.status).toBe(0);
    expect(unlocked.stdout).toContain("providers:");
    expect(unlocked.stdout).toContain("llm              anthropic (ANTHROPIC_API_KEY)");
    expect(unlocked.stdout).toContain("unlocked   compile");
    expect(unlocked.stdout).toContain("unlocked   answer");
    expect(unlocked.stdout).not.toContain(secret);
  });

  test("doctor detects MCP registrations orphaned from the selected root", async () => {
    const almanacRoot = join(root, "almanacs");
    const home = join(root, "home");
    await mkdir(almanacRoot, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "almanac-missing": {
            command: "bun",
            args: [
              "run",
              "/tmp/almanac-cli.ts",
              "serve",
              "missing",
              "--root",
              almanacRoot,
            ],
          },
          "almanac-other-root": {
            command: "bun",
            args: [
              "run",
              "/tmp/almanac-cli.ts",
              "serve",
              "other-root",
              "--root",
              join(root, "different-root"),
            ],
          },
        },
      }),
      "utf8",
    );

    const result = runCli(["doctor", "--json", "--root", almanacRoot], {
      HOME: home,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      checks: Array<{ level: string; name: string; message: string }>;
      rootHygiene: {
        status: string;
        cleanup: {
          orphanedMcpRegistrations: Array<{
            client: string;
            almanacId: string;
            serverName: string;
            path: string;
            nextAction: string;
          }>;
        };
        issues: string[];
      };
    };

    expect(parsed.rootHygiene.status).toBe("needs-validation");
    expect(parsed.rootHygiene.cleanup.orphanedMcpRegistrations).toEqual([
      expect.objectContaining({
        client: "claude-code",
        almanacId: "missing",
        serverName: "almanac-missing",
        path: join(home, ".claude.json"),
      }),
    ]);
    expect(
      parsed.rootHygiene.cleanup.orphanedMcpRegistrations[0]?.nextAction,
    ).toContain('remove mcpServers["almanac-missing"]');
    expect(parsed.rootHygiene.issues).toContainEqual(
      expect.stringContaining("orphaned MCP registration almanac-missing"),
    );
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        level: "warn",
        name: "root-cleanup",
      }),
    );
  });

  test("status --json includes lifecycle usability and latest run summary", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(["status", "legacy", "--json", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const status = JSON.parse(result.stdout) as {
      almanacId: string;
      status: string;
      usability: { status: string; reason: string };
      activation: {
        status: string;
        milestone: string;
        nextMilestone: string | null;
        nextAction: { command: string; providerRequired: boolean } | null;
        gaps: string[];
      };
      firstUse: {
        status: string;
        stage: string;
        nextStage: string | null;
        nextAction: { command: string; providerRequired: boolean } | null;
        gaps: string[];
        sourceChecklist: { status: string; acceptedCount: number; rejectedCount: number };
      };
      sourceChecklist: { status: string; acceptedCount: number; rejectedCount: number };
      operations: Array<{
        id: string;
        label: string;
        category: string;
        mutation: string;
        providerRequired: boolean;
        studioRunnable: boolean;
        command: string;
      }>;
      recommendedOperation: {
        label: string;
        category: string;
        mutation: string;
        providerRequired: boolean;
        studioRunnable: boolean;
        command: string;
      } | null;
      lifecycle: {
        compile: { status: string; completed: number };
        knowledge: {
          status: string;
          facts: number;
          tools: number;
          countsMatch: boolean;
        };
        benchmark: { status: string };
        answer: { status: string };
        refresh: { status: string };
        issues: string[];
        nextActions: string[];
      };
      runs: {
        latest: unknown;
        byKind: {
          tool: unknown;
          answer: unknown;
          refresh: unknown;
          maintenance: unknown;
        };
        readError: string | null;
      };
    };

    expect(status.almanacId).toBe("legacy");
    expect(status.status).toBe("attention");
    expect(status.usability.status).toBe("limited");
    expect(status.usability.reason).toContain("benchmark missing");
    expect(status.activation).toEqual(
      expect.objectContaining({
        status: "in-progress",
        milestone: "compiled",
        nextMilestone: "validated",
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac benchmark legacy --init"),
          providerRequired: false,
        }),
      }),
    );
    expect(status.activation.gaps).toContain("checks are missing");
    expect(status.firstUse).toEqual(
      expect.objectContaining({
        status: "in-progress",
        stage: "compiled",
        nextStage: "validated",
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac benchmark legacy --init"),
          providerRequired: false,
        }),
      }),
    );
    expect(status.firstUse.gaps).toContain("checks are missing");
    expect(status.sourceChecklist).toMatchObject({
      status: "missing",
      acceptedCount: 0,
      rejectedCount: 0,
    });
    expect(status.firstUse.sourceChecklist).toMatchObject({
      status: "missing",
      acceptedCount: 0,
      rejectedCount: 0,
    });
    expect(status.recommendedOperation).toEqual(
      expect.objectContaining({
        label: "Run validation",
        category: "validate",
        mutation: "almanac-write",
        providerRequired: false,
        studioRunnable: false,
        command: expect.stringContaining("almanac benchmark legacy --init"),
      }),
    );
    expect(status.operations).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^op-validate-[a-f0-9]{10}$/),
        label: "Run validation",
        category: "validate",
        command: expect.stringContaining("almanac benchmark legacy --init"),
      }),
    );
    expect(status.lifecycle.compile).toMatchObject({
      status: "ok",
      completed: STAGE_IDS.length,
    });
    expect(status.lifecycle.knowledge).toMatchObject({
      status: "present",
      facts: 7,
      tools: 2,
      countsMatch: false,
    });
    expect(status.lifecycle.benchmark.status).toBe("missing");
    expect(status.lifecycle.answer.status).toBe("not-ready");
    expect(status.lifecycle.refresh.status).toBe("due");
    expect(
      (status.lifecycle as { registration?: { clients: unknown[] } }).registration
        ?.clients.length,
    ).toBeGreaterThan(0);
    expect(status.lifecycle.nextActions.some((action) =>
      action.includes("almanac inspect legacy"),
    )).toBe(true);
    expect(status.runs.latest).toBeNull();
    expect(status.runs.byKind.answer).toBeNull();
    expect(status.runs.readError).toBeNull();
  });

  test("status reports provider readiness without leaking key values", async () => {
    await writeLegacyCountFixture({ completed: true });
    const secret = "sk-ant-status-secret-0123456789";
    const lockedEnv = {
      ANTHROPIC_API_KEY: undefined,
      ALMANAC_LLM: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
      VOYAGE_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ALMANAC_EMBEDDINGS: undefined,
    };

    const locked = runCli(
      ["status", "legacy", "--json", "--root", root],
      lockedEnv,
    );
    expect(locked.status).toBe(0);
    const lockedReadiness = (
      JSON.parse(locked.stdout) as {
        providerReadiness: {
          llm: { presence: string; detectedEnv: string[] };
          capabilities: Array<{ id: string; status: string }>;
        };
      }
    ).providerReadiness;
    expect(lockedReadiness.llm).toEqual({ presence: "absent", detectedEnv: [] });
    expect(lockedReadiness.capabilities).toContainEqual(
      expect.objectContaining({ id: "compile", status: "locked" }),
    );

    const unlocked = runCli(["status", "legacy", "--root", root], {
      ...lockedEnv,
      ANTHROPIC_API_KEY: secret,
    });
    expect(unlocked.status).toBe(0);
    expect(unlocked.stdout).toContain(
      "providers     llm anthropic, web search unset,",
    );
    expect(unlocked.stdout).toContain("compile and answer unlocked");
    expect(unlocked.stdout).not.toContain(secret);
  });

  test("status human output uses guided terminology", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(["status", "legacy", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("health        attention");
    expect(result.stdout).toContain("activation    compiled -> validated, in-progress");
    expect(result.stdout).toContain("activation next create validation checks: almanac benchmark legacy --init");
    expect(result.stdout).toContain("first use     compiled; next validated");
    expect(result.stdout).toContain("first-use next create validation checks: almanac benchmark legacy --init");
    expect(result.stdout).toContain("operation     Run validation (validate, almanac-write, no provider, CLI handoff)");
    expect(result.stdout).toContain("references = citable source material");
    expect(result.stdout).toContain("extracted knowledge present, 7 item(s), 2 tools");
    expect(result.stdout).toContain("checks        missing");
    expect(result.stdout).toContain("answer checks not-ready");
    expect(result.stdout).toContain("latest history none");
    expect(result.stdout).not.toContain("benchmark     ");
  });

  test("studio rejects non-local bind hosts before startup", async () => {
    const result = runCli([
      "studio",
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--root",
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("studio only binds to localhost");
  });

  test("maintain --json emits a provider-free dry-run maintenance report", async () => {
    await writeLegacyCountFixture({ completed: true });
    await writeFile(join(root, "almanac-legacy-0.1.0.tar.gz"), "fake", "utf8");

    const result = runCli(
      ["maintain", "legacy", "--json", "--dry-run", "--root", root],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
        VOYAGE_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      schemaVersion: string;
      almanacId: string;
      dryRun: boolean;
      status: string;
      refresh: { due: boolean; status: string; recommendedFromStage: string };
      benchmark: { status: string; planned: boolean };
      answer: { status: string; planned: boolean };
      registration: { clients: unknown[] };
      artifacts: {
        cleanupCandidates: Array<{ kind: string; count: number; paths: string[] }>;
      };
      plan: Array<{
        id: string;
        status: string;
        command: string | null;
        providerRequired: boolean;
        expectedArtifact: string | null;
      }>;
      repairs: unknown[];
      nextActions: string[];
    };

    expect(report.schemaVersion).toBe("0.1.0");
    expect(report.almanacId).toBe("legacy");
    expect(report.dryRun).toBe(true);
    expect(report.status).toBe("due");
    expect(report.refresh).toMatchObject({ due: true, status: "due" });
    expect(report.benchmark).toMatchObject({
      status: "missing",
      planned: true,
    });
    expect(report.answer).toMatchObject({
      status: "not-ready",
      planned: true,
    });
    expect(report.registration.clients.length).toBeGreaterThan(0);
    expect(report.repairs).toEqual([]);

    const refreshStep = report.plan.find((step) => step.id === "refresh");
    const benchmarkStep = report.plan.find((step) => step.id === "benchmark");
    const askSuiteStep = report.plan.find((step) => step.id === "ask-suite");
    const cleanupStep = report.plan.find((step) => step.id === "cleanup");
    expect(refreshStep).toMatchObject({
      status: "planned",
      providerRequired: true,
      expectedArtifact: ".runs/refresh-*.json",
    });
    expect(refreshStep?.command).toContain("almanac refresh run legacy");
    expect(benchmarkStep?.command).toContain("almanac benchmark legacy --init");
    expect(askSuiteStep?.command).toContain("almanac ask-fixtures init legacy");
    expect(cleanupStep?.status).toBe("planned");
    expect(report.artifacts.cleanupCandidates).toEqual([
      expect.objectContaining({
        kind: "export-archive",
        count: 1,
        paths: [join(root, "almanac-legacy-0.1.0.tar.gz")],
      }),
    ]);
    expect(report.nextActions).toContainEqual(
      expect.stringContaining("almanac refresh run legacy"),
    );
  });

  test("maintain human output uses guided terminology", async () => {
    await writeLegacyCountFixture({ completed: true });
    await writeFile(join(root, "almanac-legacy-0.1.0.tar.gz"), "fake", "utf8");

    const result = runCli(["maintain", "legacy", "--dry-run", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
      VOYAGE_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("health        due");
    expect(result.stdout).toContain("references = citable source material");
    expect(result.stdout).toContain("checks        missing");
    expect(result.stdout).toContain("answer checks not-ready");
    expect(result.stdout).toContain("latest history none");
    expect(result.stdout).toContain("planned checks:");
    expect(result.stdout).toContain("planned answer checks:");
    expect(result.stdout).toContain("history cleanup:");
  });

  test("maintain --json surfaces stale registration repair candidates", async () => {
    await writeLegacyCountFixture({ completed: true });
    const almanacDir = almanacDirPath(root, "legacy");
    const home = join(root, "home");
    const skillSource = join(almanacDir, "adapters", "skill", "SKILL.md");
    const skillDest = join(home, ".claude", "skills", "almanac-legacy", "SKILL.md");
    await mkdir(join(almanacDir, "adapters", "skill"), { recursive: true });
    await mkdir(join(home, ".claude", "skills", "almanac-legacy"), {
      recursive: true,
    });
    await writeFile(skillSource, "# Legacy Skill\n", "utf8");
    await writeFile(skillDest, "# Legacy Skill\n", "utf8");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "almanac-legacy": {
            command: "bun",
            args: ["run", "/tmp/old-cli.ts", "serve", "legacy", "--root", "/tmp/old-root"],
          },
        },
      }),
      "utf8",
    );

    const result = runCli(["maintain", "legacy", "--json", "--root", root], {
      HOME: home,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      status: string;
      registration: { status: string };
      repairs: Array<{
        kind: string;
        message: string;
        command: string | null;
        applyRequired: boolean;
      }>;
      nextActions: string[];
    };

    expect(report.status).toBe("repairable");
    expect(report.registration.status).toBe("stale");
    expect(report.repairs).toContainEqual(
      expect.objectContaining({
        kind: "registration",
        message: "claude-code registration is stale",
        applyRequired: true,
      }),
    );
    expect(report.repairs[0]?.command).toContain(
      "almanac register legacy --client=claude-code --target=mcp --apply",
    );
    expect(report.nextActions).toContainEqual(
      expect.stringContaining("almanac register legacy --client=claude-code"),
    );
  });

  test("schedule print emits a dry-run cron handoff by default", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(["schedule", "print", "legacy", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("schedule handoff: legacy (0.1.0)");
    expect(result.stdout).toContain("target        cron");
    expect(result.stdout).toContain("mode          dry-run");
    expect(result.stdout).toContain(`root          ${root}`);
    expect(result.stdout).toContain(
      'command       almanac maintain legacy --dry-run --json --root "$ALMANAC_ROOT"',
    );
    expect(result.stdout).toContain(`export ALMANAC_ROOT=${root}`);
    expect(result.stdout).toContain("17 3 * * *");
    expect(result.stdout).toContain("No scheduler is installed");
    expect(result.stdout).not.toContain("--apply --due-only");
  });

  test("schedule print --apply emits launchd due-only handoff", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(
      [
        "schedule",
        "print",
        "legacy",
        "--target",
        "launchd",
        "--apply",
        "--label",
        "launchd-test",
        "--root",
        root,
      ],
      { ANTHROPIC_API_KEY: undefined },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("target        launchd");
    expect(result.stdout).toContain("mode          due-only-apply");
    expect(result.stdout).toContain(
      'almanac maintain legacy --apply --due-only --json --label launchd-test --root "$ALMANAC_ROOT"',
    );
    expect(result.stdout).toContain("<key>StartCalendarInterval</key>");
    expect(result.stdout).toContain("com.almanac.maintain.legacy.plist");
    expect(result.stdout).toContain("launchctl load");
  });

  test("schedule print --target github-actions --json emits workflow handoff", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(
      [
        "schedule",
        "print",
        "legacy",
        "--target",
        "github-actions",
        "--json",
        "--root",
        root,
      ],
      { ANTHROPIC_API_KEY: undefined },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      almanacId: string;
      target: string;
      mode: string;
      root: string;
      workflowPath: string | null;
      command: string;
      environment: Array<{ name: string; value: string | null; required: boolean }>;
      snippet: string;
    };

    expect(report.almanacId).toBe("legacy");
    expect(report.target).toBe("github-actions");
    expect(report.mode).toBe("dry-run");
    expect(report.root).toBe(root);
    expect(report.workflowPath).toBe(
      ".github/workflows/almanac-maintain-legacy.yml",
    );
    expect(report.command).toBe(
      'almanac maintain legacy --dry-run --json --root "$ALMANAC_ROOT"',
    );
    expect(report.environment).toContainEqual(
      expect.objectContaining({
        name: "ALMANAC_ROOT",
        value: root,
        required: true,
      }),
    );
    expect(report.snippet).toContain("workflow_dispatch:");
    expect(report.snippet).toContain("actions/upload-artifact@v4");
    expect(report.snippet).toContain(
      'almanac maintain legacy --dry-run --json --root "$ALMANAC_ROOT"',
    );
  });

  test("schedule print rejects labels without apply", async () => {
    await writeLegacyCountFixture({ completed: true });

    const result = runCli(
      ["schedule", "print", "legacy", "--label", "nightly", "--root", root],
      { ANTHROPIC_API_KEY: undefined },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: schedule: --label requires --apply");
  });

  test("maintain reports partial almanac directories as broken plans", async () => {
    await mkdir(join(root, "partial"), { recursive: true });

    const result = runCli(["maintain", "partial", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("maintenance: partial");
    expect(result.stdout).toContain("health        broken");
    expect(result.stdout).toContain("blocked refresh: almanac files are broken");
    expect(result.stdout).toContain("broken-directory");
    expect(result.stdout).toContain("manifest.json missing");
  });

  test("repair --json dry-run and apply fixes stale manifest counts", async () => {
    await writeLegacyCountFixture({ completed: true });

    const dryRun = runCli(["repair", "legacy", "--json", "--dry-run", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
    });

    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe("");
    const dryRunReport = JSON.parse(dryRun.stdout) as {
      status: string;
      mode: string;
      candidates: Array<{
        kind: string;
        status: string;
        applySupported: boolean;
        paths: string[];
        command: string | null;
      }>;
    };
    expect(dryRunReport.status).toBe("repairable");
    expect(dryRunReport.mode).toBe("dry-run");
    expect(dryRunReport.candidates).toContainEqual(
      expect.objectContaining({
        kind: "manifest-counts",
        status: "planned",
        applySupported: true,
        paths: expect.arrayContaining([
          join(root, "legacy", "manifest.json"),
          join(root, "legacy", "knowledge", "index-manifest.json"),
        ]),
      }),
    );
    expect(dryRunReport.candidates[0]?.command).toContain(
      "almanac repair legacy --apply",
    );

    const applied = runCli(["repair", "legacy", "--json", "--apply", "--root", root], {
      ANTHROPIC_API_KEY: undefined,
    });

    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe("");
    const appliedReport = JSON.parse(applied.stdout) as {
      status: string;
      applied: number;
      failed: number;
      candidates: Array<{ kind: string; status: string }>;
    };
    expect(appliedReport.status).toBe("clean");
    expect(appliedReport.applied).toBe(1);
    expect(appliedReport.failed).toBe(0);
    expect(appliedReport.candidates).toContainEqual(
      expect.objectContaining({
        kind: "manifest-counts",
        status: "applied",
      }),
    );

    const manifest = JSON.parse(
      await readFile(join(root, "legacy", "manifest.json"), "utf8"),
    ) as { factCount: number; toolCount: number };
    expect(manifest.factCount).toBe(7);
    expect(manifest.toolCount).toBe(2);
  });

  test("repair --apply refreshes stale registration artifacts with JSON output", async () => {
    await writeLegacyCountFixture({ completed: true });
    const almanacDir = almanacDirPath(root, "legacy");
    const home = join(root, "home");
    const skillSource = join(almanacDir, "adapters", "skill", "SKILL.md");
    const skillDest = join(home, ".claude", "skills", "almanac-legacy", "SKILL.md");
    await mkdir(join(almanacDir, "adapters", "skill"), { recursive: true });
    await mkdir(join(home, ".claude", "skills", "almanac-legacy"), {
      recursive: true,
    });
    await writeFile(skillSource, "# Current Legacy Skill\n", "utf8");
    await writeFile(skillDest, "# Stale Legacy Skill\n", "utf8");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "almanac-legacy": {
            command: "bun",
            args: ["run", "/tmp/old-cli.ts", "serve", "legacy", "--root", "/tmp/old-root"],
          },
        },
      }),
      "utf8",
    );

    const result = runCli(["repair", "legacy", "--json", "--apply", "--root", root], {
      HOME: home,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      status: string;
      applied: number;
      failed: number;
      candidates: Array<{
        id: string;
        kind: string;
        status: string;
        paths: string[];
      }>;
    };
    expect(report.status).toBe("clean");
    expect(report.applied).toBeGreaterThanOrEqual(3);
    expect(report.failed).toBe(0);
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        id: "registration:claude-code:skill",
        kind: "registration",
        status: "applied",
        paths: expect.arrayContaining([skillSource, skillDest]),
      }),
    );
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        id: "registration:claude-code:mcp",
        kind: "registration",
        status: "applied",
        paths: [join(home, ".claude.json")],
      }),
    );
    expect(await readFile(skillDest, "utf8")).toBe("# Current Legacy Skill\n");
    const mcpConfig = JSON.parse(
      await readFile(join(home, ".claude.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcpConfig.mcpServers["almanac-legacy"]?.command).toBe("bun");
    expect(mcpConfig.mcpServers["almanac-legacy"]?.args).toEqual(
      expect.arrayContaining(["serve", "legacy", "--root", root]),
    );
  });

  test("cleanup --json dry-run lists saved runs, exports, and orphaned MCP registrations", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    const savedRun = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '{"q":"transactions atomic"}',
      "--save",
      "--label",
      "cleanup-test",
      "--json",
      "--root",
      root,
    ]);
    expect(savedRun.status).toBe(0);
    const saved = JSON.parse(savedRun.stdout) as { artifactRelPath: string };
    const savedPath = join(root, "sqlite-demo", saved.artifactRelPath);
    const archivePath = join(root, "almanac-sqlite-demo-0.1.0.tar.gz");
    await writeFile(archivePath, "fake", "utf8");
    const home = `${root}-home`;
    await mkdir(home, { recursive: true });
    const mcpPath = join(home, ".claude.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "almanac-missing": {
            command: "bun",
            args: ["run", "/tmp/almanac-cli.ts", "serve", "missing", "--root", root],
          },
        },
      }),
      "utf8",
    );

    const result = runCli(
      ["cleanup", "--json", "--dry-run", "--keep-latest", "0", "--root", root],
      {
        HOME: home,
        ANTHROPIC_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      status: string;
      keepLatest: number;
      candidates: Array<{
        kind: string;
        status: string;
        applySupported: boolean;
        paths: string[];
        command: string | null;
      }>;
    };
    expect(report.status).toBe("attention");
    expect(report.keepLatest).toBe(0);
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        kind: "saved-runs",
        status: "planned",
        applySupported: true,
        paths: [savedPath],
      }),
    );
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        kind: "export-archive",
        applySupported: false,
        paths: [archivePath],
      }),
    );
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        kind: "orphaned-mcp-registration",
        applySupported: true,
        paths: [mcpPath],
      }),
    );
    expect(
      report.candidates.find((candidate) => candidate.kind === "saved-runs")
        ?.command,
    ).toContain("almanac runs sqlite-demo --prune --keep-latest 0 --dry-run");
  });

  test("cleanup --apply prunes runs and orphaned MCP entries without deleting archives", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    const savedRun = runCli([
      "run",
      "sqlite-demo",
      "--tool",
      "query_facts",
      "--input",
      '{"q":"transactions atomic"}',
      "--save",
      "--json",
      "--root",
      root,
    ]);
    expect(savedRun.status).toBe(0);
    const saved = JSON.parse(savedRun.stdout) as { artifactRelPath: string };
    const savedPath = join(root, "sqlite-demo", saved.artifactRelPath);
    const archivePath = join(root, "almanac-sqlite-demo-0.1.0.tar.gz");
    await writeFile(archivePath, "fake", "utf8");
    const home = `${root}-home`;
    await mkdir(home, { recursive: true });
    const mcpPath = join(home, ".claude.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "almanac-missing": {
            command: "bun",
            args: ["run", "/tmp/almanac-cli.ts", "serve", "missing", "--root", root],
          },
        },
      }),
      "utf8",
    );

    const result = runCli(
      ["cleanup", "--json", "--apply", "--keep-latest", "0", "--root", root],
      {
        HOME: home,
        ANTHROPIC_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      status: string;
      applied: number;
      skipped: number;
      failed: number;
      candidates: Array<{ kind: string; status: string }>;
    };
    expect(report.status).toBe("partial");
    expect(report.applied).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.candidates).toContainEqual(
      expect.objectContaining({ kind: "saved-runs", status: "applied" }),
    );
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        kind: "orphaned-mcp-registration",
        status: "applied",
      }),
    );
    expect(report.candidates).toContainEqual(
      expect.objectContaining({ kind: "export-archive", status: "skipped" }),
    );
    expect(existsSync(savedPath)).toBe(false);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(join(root, "sqlite-demo"))).toBe(true);
    const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpConfig.mcpServers["almanac-missing"]).toBeUndefined();
  });

  test("maintain --apply runs due provider-free refresh and saves a maintenance artifact", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    await writeFreshSqliteDemoSourceFetchManifest();
    const almanacDir = almanacDirPath(root, "sqlite-demo");
    await rm(benchmarkResultPath(almanacDir), { force: true });

    const dryRun = runCli(
      ["maintain", "sqlite-demo", "--json", "--dry-run", "--root", root],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );
    expect(dryRun.status).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout) as {
      status: string;
      plan: unknown[];
      refresh: { due: boolean; recommendedFromStage: string };
      benchmark: { planned: boolean; status: string };
    };
    expect(dryReport.status).toBe("due");
    expect(dryReport.refresh).toMatchObject({
      due: true,
      recommendedFromStage: "12-benchmark-run",
    });
    expect(dryReport.benchmark).toMatchObject({
      planned: true,
      status: "not-run",
    });

    const applied = runCli(
      [
        "maintain",
        "sqlite-demo",
        "--apply",
        "--json",
        "--label",
        "pr3-smoke",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe("");
    const result = JSON.parse(applied.stdout) as {
      status: string;
      exitCode: number;
      dueOnly: boolean;
      reportBefore: { plan: unknown[] };
      reportAfter: { status: string } | null;
      refresh: {
        status: string;
        artifactRelPath?: string;
        exitCode: number;
      } | null;
      benchmark: { status: string; total?: number; passed?: number } | null;
      savedArtifact: { relPath: string; path: string } | null;
      steps: Array<{ id: string; status: string; artifactRelPath?: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.dueOnly).toBe(false);
    expect(result.reportBefore.plan).toEqual(dryReport.plan);
    expect(result.reportAfter?.status).toBe("needs-validation");
    expect(result.refresh).toMatchObject({
      status: "ok",
      exitCode: 0,
    });
    expect(result.refresh?.artifactRelPath).toMatch(/^\.runs\/refresh-/);
    expect(result.benchmark).toMatchObject({
      status: "passed",
      total: 2,
      passed: 2,
    });
    expect(result.savedArtifact?.relPath).toMatch(/^\.runs\/maintain-/);
    expect(existsSync(result.savedArtifact!.path)).toBe(true);
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        id: "refresh",
        status: "ok",
        artifactRelPath: result.refresh?.artifactRelPath,
      }),
    );

    const runs = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "maintenance",
      "--json",
      "--root",
      root,
    ]);
    expect(runs.status).toBe(0);
    const listed = JSON.parse(runs.stdout) as {
      runs: Array<{
        kind: string;
        runId: string;
        status: string;
        label?: string;
        maintenanceSteps?: number;
        benchmarkStatus?: string;
      }>;
    };
    expect(listed.runs).toEqual([
      expect.objectContaining({
        kind: "maintenance",
        status: "ok",
        label: "pr3-smoke",
        benchmarkStatus: "passed",
      }),
    ]);
    expect(listed.runs[0]?.maintenanceSteps).toBeGreaterThanOrEqual(2);

    const status = runCli(["status", "sqlite-demo", "--root", root]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("activation    maintainable, complete");
    expect(status.stdout).toContain(
      "first use     maintainable; first useful almanac path is complete",
    );
    expect(status.stdout).toContain("latest maintenance history maintenance");
    expect(status.stdout).toContain("label=pr3-smoke");

    const statusJson = runCli(["status", "sqlite-demo", "--json", "--root", root]);
    expect(statusJson.status).toBe(0);
    expect(
      (JSON.parse(statusJson.stdout) as {
        activation: {
          status: string;
          milestone: string;
          nextMilestone: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
        firstUse: {
          status: string;
          stage: string;
          nextStage: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).activation,
    ).toEqual(
      expect.objectContaining({
        status: "complete",
        milestone: "maintainable",
        nextMilestone: null,
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac maintain sqlite-demo --dry-run"),
          providerRequired: false,
        }),
      }),
    );
    expect(
      (JSON.parse(statusJson.stdout) as {
        firstUse: {
          status: string;
          stage: string;
          nextStage: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).firstUse,
    ).toEqual(
      expect.objectContaining({
        status: "complete",
        stage: "maintainable",
        nextStage: null,
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac maintain sqlite-demo --dry-run"),
          providerRequired: false,
        }),
      }),
    );
  });

  test("maintain --apply runs ask-suite with provider-free refresh when fixtures exist", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    await writeFreshSqliteDemoSourceFetchManifest();
    await writeSqliteDemoAskFixture();
    const almanacDir = almanacDirPath(root, "sqlite-demo");
    await rm(benchmarkResultPath(almanacDir), { force: true });

    const dryRun = runCli(
      ["maintain", "sqlite-demo", "--json", "--dry-run", "--root", root],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );
    expect(dryRun.status).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout) as {
      plan: Array<{ id: string; status: string; command: string | null }>;
      answer: {
        planned: boolean;
        suite: {
          status: string;
          unsupportedClaimCount?: number;
          staleCitationCount?: number;
          abstentionMismatchCount?: number;
        } | null;
      };
    };
    expect(
      dryReport.plan.find((step) => step.id === "refresh")?.command,
    ).toContain("--ask-suite");
    expect(
      dryReport.plan.find((step) => step.id === "ask-suite"),
    ).toMatchObject({
      status: "planned",
      command: expect.stringContaining("--ask-suite"),
    });
    expect(dryReport.answer.planned).toBe(true);

    const applied = runCli(
      [
        "maintain",
        "sqlite-demo",
        "--apply",
        "--json",
        "--label",
        "pr4-ask-suite",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe("");
    const result = JSON.parse(applied.stdout) as {
      status: string;
      exitCode: number;
      reportAfter: {
        answer: {
          suite: {
            status: string;
            total: number;
            passed: number;
            unsupportedClaimCount: number;
            staleCitationCount: number;
            abstentionMismatchCount: number;
          };
        };
      } | null;
      refresh: { artifactRelPath?: string } | null;
      benchmark: { status: string; total?: number; passed?: number } | null;
      askSuite: {
        status: string;
        total: number;
        passed: number;
        unsupportedClaimCount: number;
        staleCitationCount: number;
        abstentionMismatchCount: number;
      } | null;
      savedArtifact: { path: string; relPath: string } | null;
      steps: Array<{ id: string; status: string; artifactRelPath?: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.benchmark).toMatchObject({
      status: "passed",
      total: 2,
      passed: 2,
    });
    expect(result.askSuite).toEqual(
      expect.objectContaining({
        status: "passed",
        total: 1,
        passed: 1,
        unsupportedClaimCount: 0,
        staleCitationCount: 0,
        abstentionMismatchCount: 0,
      }),
    );
    expect(result.reportAfter?.answer.suite).toEqual(
      expect.objectContaining({
        status: "passed",
        total: 1,
        passed: 1,
        unsupportedClaimCount: 0,
      }),
    );
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        id: "ask-suite",
        status: "ok",
        artifactRelPath: result.refresh?.artifactRelPath,
      }),
    );
    const savedArtifact = JSON.parse(
      await readFile(result.savedArtifact!.path, "utf8"),
    ) as { askSuite?: { status: string; total: number } };
    expect(savedArtifact.askSuite).toEqual(
      expect.objectContaining({ status: "passed", total: 1 }),
    );

    const runs = runCli([
      "runs",
      "sqlite-demo",
      "--kind",
      "maintenance",
      "--json",
      "--root",
      root,
    ]);
    expect(runs.status).toBe(0);
    expect(
      (JSON.parse(runs.stdout) as {
        runs: Array<{ askSuiteStatus?: string; askSuiteTotal?: number }>;
      }).runs[0],
    ).toEqual(
      expect.objectContaining({
        askSuiteStatus: "passed",
        askSuiteTotal: 1,
      }),
    );
  });

  test("maintain --apply records ask-suite quality failure without losing benchmark result", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    await writeFreshSqliteDemoSourceFetchManifest();
    await writeSqliteDemoAskFixture({ unsupported: true });
    const almanacDir = almanacDirPath(root, "sqlite-demo");
    await rm(benchmarkResultPath(almanacDir), { force: true });

    const applied = runCli(
      [
        "maintain",
        "sqlite-demo",
        "--apply",
        "--json",
        "--label",
        "pr4-ask-suite-fail",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(applied.status).toBe(1);
    expect(applied.stderr).toBe("");
    const result = JSON.parse(applied.stdout) as {
      status: string;
      exitCode: number;
      reportAfter: {
        status: string;
        answer: {
          suite: {
            status: string;
            unsupportedClaimCount: number;
          };
        };
      } | null;
      refresh: { status: string; artifactRelPath?: string } | null;
      benchmark: { status: string; total?: number; passed?: number } | null;
      askSuite: {
        status: string;
        total: number;
        failed: number;
        unsupportedClaimCount: number;
        error?: { code: string };
      } | null;
      steps: Array<{ id: string; status: string; reason: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.refresh?.status).toBe("failed");
    expect(result.benchmark).toMatchObject({
      status: "passed",
      total: 2,
      passed: 2,
    });
    expect(result.askSuite).toEqual(
      expect.objectContaining({
        status: "failed",
        total: 1,
        failed: 1,
        unsupportedClaimCount: 1,
        error: expect.objectContaining({ code: "ask-suite-failed" }),
      }),
    );
    expect(result.reportAfter).toEqual(
      expect.objectContaining({
        status: "needs-validation",
        answer: expect.objectContaining({
          suite: expect.objectContaining({
            status: "failed",
            unsupportedClaimCount: 1,
          }),
        }),
      }),
    );
    expect(result.steps).toContainEqual(
      expect.objectContaining({ id: "refresh", status: "ok" }),
    );
    expect(result.steps).toContainEqual(
      expect.objectContaining({ id: "benchmark", status: "ok" }),
    );
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        id: "ask-suite",
        status: "failed",
        reason: expect.stringContaining("unsupported=1"),
      }),
    );
  });

  test("maintain --no-ask-suite keeps refresh and benchmark apply provider-free", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    await writeFreshSqliteDemoSourceFetchManifest();
    await writeSqliteDemoAskFixture({ unsupported: true });
    const almanacDir = almanacDirPath(root, "sqlite-demo");
    await rm(benchmarkResultPath(almanacDir), { force: true });

    const applied = runCli(
      [
        "maintain",
        "sqlite-demo",
        "--apply",
        "--json",
        "--no-ask-suite",
        "--root",
        root,
      ],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe("");
    const result = JSON.parse(applied.stdout) as {
      status: string;
      refresh: { artifactRelPath?: string } | null;
      benchmark: { status: string; total?: number; passed?: number } | null;
      askSuite: unknown;
      steps: Array<{ id: string; status: string; reason: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.benchmark).toMatchObject({
      status: "passed",
      total: 2,
      passed: 2,
    });
    expect(result.askSuite).toBeNull();
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        id: "ask-suite",
        status: "skipped",
        reason: "ask-suite validation disabled",
      }),
    );
    const refreshArtifact = JSON.parse(
      await readFile(join(almanacDir, result.refresh!.artifactRelPath!), "utf8"),
    ) as { askSuite?: unknown };
    expect(refreshArtifact.askSuite).toBeUndefined();
  });

  test("maintain --all --due-only --apply skips almanacs that are not due", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    await writeFreshSqliteDemoSourceFetchManifest();

    const result = runCli(
      ["maintain", "--all", "--due-only", "--apply", "--json", "--root", root],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      mode: string;
      dueOnly: boolean;
      total: number;
      applied: number;
      skipped: number;
      failed: number;
      results: Array<{ almanacId: string; status: string; reason: string }>;
    };
    expect(parsed.mode).toBe("apply");
    expect(parsed.dueOnly).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.applied).toBe(0);
    expect(parsed.skipped).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.results).toEqual([
      expect.objectContaining({
        almanacId: "sqlite-demo",
        status: "skipped",
        reason: "not due",
      }),
    ]);
  });

  test("maintain --apply records locked refresh attempts without hiding progress", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);
    await writeFreshSqliteDemoSourceFetchManifest();
    const almanacDir = almanacDirPath(root, "sqlite-demo");
    await rm(benchmarkResultPath(almanacDir), { force: true });
    await writeFile(
      join(almanacDir, ".compile", "refresh.lock"),
      JSON.stringify({
        pid: 12345,
        command: "almanac refresh run sqlite-demo",
        acquiredAt: "2026-06-03T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );

    const result = runCli(
      ["maintain", "sqlite-demo", "--apply", "--json", "--root", root],
      {
        ANTHROPIC_API_KEY: undefined,
        BRAVE_SEARCH_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      exitCode: number;
      refresh: { status: string; artifactRelPath?: string } | null;
      savedArtifact: { path: string; relPath: string } | null;
      steps: Array<{
        id: string;
        status: string;
        artifactRelPath?: string;
        exitCode?: number;
      }>;
    };
    expect(parsed.status).toBe("locked");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.refresh?.status).toBe("locked");
    expect(parsed.refresh?.artifactRelPath).toMatch(/^\.runs\/refresh-/);
    expect(parsed.savedArtifact?.relPath).toMatch(/^\.runs\/maintain-/);
    expect(existsSync(parsed.savedArtifact!.path)).toBe(true);
    expect(parsed.steps).toContainEqual(
      expect.objectContaining({
        id: "refresh",
        status: "locked",
        artifactRelPath: parsed.refresh?.artifactRelPath,
        exitCode: 2,
      }),
    );
  });

  test("status shows failed compile recovery as operator next action", async () => {
    await writeFailedStageFixture({
      almanacId: "failed-status",
      stageId: "05-fact-extraction",
      code: "schema-validation",
      message: "bad fact payload",
    });

    const result = runCli(["status", "failed-status", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("almanac status: failed-status");
    expect(result.stdout).toContain("health        failed");
    expect(result.stdout).toContain("usability     not-usable");
    expect(result.stdout).toContain("failed stages: 05-fact-extraction");
    expect(result.stdout).toContain(
      "almanac update failed-status --from-stage=05-fact-extraction --no-bump",
    );
  });

  test("status reports partial almanac directories without crashing", async () => {
    await mkdir(join(root, "partial"), { recursive: true });

    const result = runCli(["status", "partial", "--root", root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("almanac status: partial (partial)");
    expect(result.stdout).toContain("health        broken");
    expect(result.stdout).toContain("manifest.json missing");
  });

  test("register --status distinguishes current skill from mismatched MCP entry", async () => {
    await writeLegacyCountFixture({ completed: true });
    const almanacDir = almanacDirPath(root, "legacy");
    const skillSource = join(almanacDir, "adapters", "skill", "SKILL.md");
    const skillsDir = join(root, "skills");
    const skillDest = join(skillsDir, "almanac-legacy", "SKILL.md");
    const mcpConfig = join(root, "claude.json");
    await mkdir(join(almanacDir, "adapters", "skill"), { recursive: true });
    await mkdir(join(skillsDir, "almanac-legacy"), { recursive: true });
    await writeFile(skillSource, "# Legacy Skill\n", "utf8");
    await writeFile(skillDest, "# Legacy Skill\n", "utf8");
    await writeFile(
      mcpConfig,
      JSON.stringify(
        {
          mcpServers: {
            "almanac-legacy": {
              command: "bun",
              args: [
                "run",
                "/tmp/old-cli.ts",
                "serve",
                "legacy",
                "--root",
                "/tmp/old-root",
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = runCli([
      "register",
      "legacy",
      "--status",
      "--client",
      "claude-code",
      "--skills-dir",
      skillsDir,
      "--mcp-config",
      mcpConfig,
      "--json",
      "--root",
      root,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      summary: string;
      clients: Array<{
        status: string;
        skill: { status: string };
        mcp: { status: string; issues: string[] };
        nextActions: string[];
      }>;
    };
    expect(report.summary).toBe("stale");
    expect(report.clients[0]?.status).toBe("stale");
    expect(report.clients[0]?.skill.status).toBe("current");
    expect(report.clients[0]?.mcp.status).toBe("mismatched");
    expect(report.clients[0]?.mcp.issues.some((issue) =>
      issue.startsWith("CLI path mismatch:"),
    )).toBe(true);
    expect(report.clients[0]?.mcp.issues.some((issue) =>
      issue.startsWith("root path mismatch:"),
    )).toBe(true);
    expect(report.clients[0]?.nextActions.some((action) =>
      action.includes("almanac register legacy --client=claude-code --target=mcp --apply"),
    )).toBe(true);
  });

  test("register --status validates current MCP entries for every supported client", async () => {
    await writeLegacyCountFixture({ completed: true });
    const cliPath = join(import.meta.dirname, "cli.ts");
    const expectedArgs = ["run", cliPath, "serve", "legacy", "--root", root];
    const clients = [
      { name: "claude-code", format: "json", key: "mcpServers" },
      { name: "claude-desktop", format: "json", key: "mcpServers" },
      { name: "cursor", format: "json", key: "mcpServers" },
      { name: "codex", format: "toml", key: "mcp_servers" },
    ] as const;

    for (const client of clients) {
      const mcpConfig = join(root, `${client.name}.${client.format}`);
      if (client.format === "json") {
        await writeFile(
          mcpConfig,
          JSON.stringify(
            {
              [client.key]: {
                "almanac-legacy": {
                  command: "bun",
                  args: expectedArgs,
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );
      } else {
        await writeFile(
          mcpConfig,
          `[mcp_servers.almanac-legacy]\ncommand = "bun"\nargs = ${JSON.stringify(expectedArgs)}\n`,
          "utf8",
        );
      }

      const result = runCli([
        "register",
        "legacy",
        "--status",
        "--target",
        "mcp",
        "--client",
        client.name,
        "--mcp-config",
        mcpConfig,
        "--json",
        "--root",
        root,
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as {
        summary: string;
        clients: Array<{ client: string; status: string; mcp: { status: string } }>;
      };
      expect(report.summary).toBe("current");
      expect(report.clients).toHaveLength(1);
      expect(report.clients[0]).toMatchObject({
        client: client.name,
        status: "current",
        mcp: { status: "current" },
      });
    }
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

  test("new pipeline failures print deterministic recovery guidance", () => {
    const result = runCli(
      [
        "new",
        "Failure UX",
        "--slug",
        "failure-ux",
        "--profile",
        "mixed",
        "--root",
        root,
      ],
      {
        ALMANAC_LLM: "mock",
        ALMANAC_MOCK_DEFAULT_RESPONSE: "not json",
        ANTHROPIC_API_KEY: undefined,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Pipeline halted.");
    expect(result.stderr).toContain("First failed stage: 01-domain-analysis");
    expect(result.stderr).toContain(
      `Recovery: almanac update failure-ux --from-stage=01-domain-analysis --no-bump --root ${root}`,
    );
    expect(result.stderr).toContain(
      `State: ${join(root, "failure-ux", ".compile", "compile-state.json")}`,
    );
    expect(result.stderr).toContain("Expected stage artifact:");
    expect(result.stderr).toContain("Guidance: deterministic validation failure");

    const inspect = runCli(["inspect", "failure-ux", "--root", root]);
    expect(inspect.status).toBe(0);
    expect(inspect.stdout).toContain("health         failed");
    expect(inspect.stdout).toContain(
      `rerun from the first failed stage: almanac update failure-ux --from-stage=01-domain-analysis --no-bump --root ${root}`,
    );
    expect(inspect.stdout).toContain("inspect compile state:");
    expect(inspect.stdout).toContain(
      "failure guidance: deterministic validation failure",
    );
  });

  test("inspect profile and doctor distinguish provider timeout recovery", async () => {
    await writeFailedStageFixture({
      almanacId: "timeout-fixture",
      stageId: "02b-source-discovery-evaluator",
      code: "unknown",
      message: "Request timed out.",
    });

    const inspect = runCli(["inspect", "timeout-fixture", "--root", root]);
    expect(inspect.status).toBe(0);
    expect(inspect.stdout).toContain("health         failed");
    expect(inspect.stdout).toContain(
      `almanac update timeout-fixture --from-stage=02b-source-discovery-evaluator --no-bump --root ${root}`,
    );
    expect(inspect.stdout).toContain(
      "failure guidance: provider or network failure",
    );

    const profile = runCli(["profile", "timeout-fixture", "--root", root]);
    expect(profile.status).toBe(0);
    expect(profile.stdout).toContain("health         not-ready");
    expect(profile.stdout).toContain(
      "failure guidance: provider or network failure",
    );

    const doctor = runCli(["doctor", "timeout-fixture", "--root", root]);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain("fail=1");
    expect(doctor.stdout).toContain("recovery");
    expect(doctor.stdout).toContain(
      "first failed stage 02b-source-discovery-evaluator",
    );
    expect(doctor.stdout).toContain("provider or network failure");
  });

  test("refresh run pipeline failures print recovery footer", () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const refresh = runCli(
      [
        "refresh",
        "run",
        "sqlite-demo",
        "--from-stage",
        "01-domain-analysis",
        "--root",
        root,
      ],
      {
        ALMANAC_LLM: "mock",
        ALMANAC_MOCK_DEFAULT_RESPONSE: "not json",
        ANTHROPIC_API_KEY: undefined,
      },
    );

    expect(refresh.status).toBe(1);
    expect(refresh.stdout).toContain("refresh run: sqlite-demo");
    expect(refresh.stdout).toContain("status: failed");
    expect(refresh.stderr).toContain("Refresh pipeline halted.");
    expect(refresh.stderr).toContain("First failed stage: 01-domain-analysis");
    expect(refresh.stderr).toContain(
      `Recovery: almanac update sqlite-demo --from-stage=01-domain-analysis --no-bump --root ${root}`,
    );
    expect(refresh.stderr).toContain(
      "Guidance: deterministic validation failure",
    );
  });
});

describe("almanac CLI product onboarding", () => {
  test("doctor explains first-run task readiness without credentials", () => {
    const doctor = runCli(["doctor", "--json", "--root", root], {
      ALMANAC_LLM: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe("");
    const parsed = JSON.parse(doctor.stdout) as {
      summary: { fail: number };
      readiness: Array<{
        name: string;
        status: string;
        message: string;
        nextActions: string[];
      }>;
    };
    expect(parsed.summary.fail).toBe(0);
    expect(parsed.readiness).toContainEqual(
      expect.objectContaining({
        name: "demo",
        status: "ready",
        nextActions: [`almanac demo --root ${root}`],
      }),
    );
    expect(parsed.readiness).toContainEqual(
      expect.objectContaining({
        name: "real-compile",
        status: "setup",
      }),
    );
    expect(parsed.readiness).toContainEqual(
      expect.objectContaining({
        name: "answer",
        status: "setup",
        nextActions: [
          `almanac demo --root ${root}`,
          `almanac doctor <id> --root ${root}`,
        ],
      }),
    );
    expect(parsed.readiness).toContainEqual(
      expect.objectContaining({
        name: "registration",
        status: "setup",
      }),
    );
  });

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
    expect(profile.stdout).toContain("health         usable");
    expect(profile.stdout).toContain("references = citable source material");
    expect(profile.stdout).toContain("extracted knowledge 3 item(s) from 3 references");
    expect(profile.stdout).toContain("references     approved, 3 accepted / 0 rejected");
    expect(profile.stdout).toContain("retrieval      fts-only");
    expect(profile.stdout).toContain("checks         2/2 passed, citationRate 100%");
    expect(profile.stdout).toContain("knowledge types");
    expect(profile.stdout).toContain("answer readiness needs-validation");
    expect(profile.stdout).toContain("answer checks  0 found");
    expect(profile.stdout).toContain("answer check suite not-run");
    expect(profile.stdout).toContain("quality gate   missing");
    expect(profile.stdout).toContain("no answer checks");
    expect(profile.stdout).toContain("sqlite-transactions");

    const profileJson = runCli(["profile", "sqlite-demo", "--root", root, "--json"]);
    expect(profileJson.status).toBe(0);
    expect(profileJson.stderr).toBe("");
    const parsedProfile = JSON.parse(profileJson.stdout) as {
      status: string;
      evidence: {
        facts: number;
        retrieval: { mode: string; status: string };
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
    expect(parsedProfile.evidence.retrieval.mode).toBe("fts-only");
    expect(parsedProfile.evidence.retrieval.status).toBe("ready");
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
    expect(profileWithRefresh.stdout).toContain("health         usable");
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

    const rootDoctorJson = runCli(["doctor", "--json", "--root", root], {
      HOME: join(root, "doctor-home"),
    });
    expect(rootDoctorJson.status).toBe(0);
    expect(rootDoctorJson.stderr).toBe("");
    expect(
      (JSON.parse(rootDoctorJson.stdout) as {
        rootHygiene: {
          cleanup: {
            savedRuns: number;
            savedRunAlmanacs: Array<{
              almanacId: string;
              nextAction: string;
            }>;
          };
        };
      }).rootHygiene.cleanup,
    ).toEqual(
      expect.objectContaining({
        savedRuns: expect.any(Number),
        savedRunAlmanacs: expect.arrayContaining([
          expect.objectContaining({
            almanacId: "sqlite-demo",
            nextAction: `almanac runs sqlite-demo --prune --keep-latest 20 --dry-run --root ${root}`,
          }),
        ]),
      }),
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
    expect(doctor.stdout).toContain("retrieval");
    expect(doctor.stdout).toContain("fts-only");
    expect(doctor.stdout).toContain("warn answer");
    expect(doctor.stdout).toContain("no ask replay fixtures");
    expect(doctor.stdout).toContain("readiness:");
    expect(doctor.stdout).toContain("ready            demo");
    expect(doctor.stdout).toContain("needs-validation answer");
    expect(doctor.stdout).toContain("ready            registration");

    const doctorJson = runCli(["doctor", "sqlite-demo", "--root", root, "--json"]);
    expect(doctorJson.status).toBe(0);
    expect(doctorJson.stderr).toBe("");
    expect(
      (JSON.parse(doctorJson.stdout) as {
        readiness: Array<{ name: string; status: string; nextActions: string[] }>;
      }).readiness,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "demo", status: "ready" }),
        expect.objectContaining({
          name: "answer",
          status: "needs-validation",
        }),
        expect.objectContaining({
          name: "refresh",
          status: "ready",
        }),
        expect.objectContaining({
          name: "registration",
          status: "ready",
          nextActions: [
            `almanac register sqlite-demo --client=claude-code --apply --root ${root}`,
          ],
        }),
      ]),
    );

    const defaultExportPath = join(root, "sqlite-demo-default.tar.gz");
    const defaultExport = runCli([
      "export",
      "sqlite-demo",
      "--output",
      defaultExportPath,
      "--root",
      root,
    ]);
    expect(defaultExport.status).toBe(0);
    expect(defaultExport.stderr).toBe("");
    expect(defaultExport.stdout).toContain("exclude .runs/");
    expect(defaultExport.stdout).toContain("exclude .compile/");
    expect((await stat(defaultExportPath)).size).toBeGreaterThan(0);

    const importRoot = join(root, "import-root");
    const importDryRun = runCli([
      "import",
      defaultExportPath,
      "--root",
      importRoot,
    ]);
    expect(importDryRun.status).toBe(0);
    expect(importDryRun.stderr).toBe("");
    expect(importDryRun.stdout).toContain("dry-run (no files written)");
    expect(importDryRun.stdout).toContain(`almanac status sqlite-demo --root ${importRoot}`);
    expect(existsSync(almanacDirPath(importRoot, "sqlite-demo"))).toBe(false);

    const importApply = runCli([
      "import",
      defaultExportPath,
      "--root",
      importRoot,
      "--apply",
    ]);
    expect(importApply.status).toBe(0);
    expect(importApply.stderr).toBe("");
    expect(importApply.stdout).toContain("installed");
    expect(existsSync(almanacDirPath(importRoot, "sqlite-demo"))).toBe(true);
    const importedStatus = runCli(["status", "sqlite-demo", "--root", importRoot]);
    expect(importedStatus.status).toBe(0);
    expect(importedStatus.stderr).toBe("");
    expect(importedStatus.stdout).toContain("almanac status: sqlite-demo");
    expect(importedStatus.stdout).not.toContain("compile state unreadable");
    expect(importedStatus.stdout).not.toContain("status        broken");

    const importedInspect = runCli([
      "inspect",
      "sqlite-demo",
      "--root",
      importRoot,
    ]);
    expect(importedInspect.status).toBe(0);
    expect(importedInspect.stderr).toBe("");
    expect(importedInspect.stdout).toContain("almanac: sqlite-demo");

    const importedProfile = runCli([
      "profile",
      "sqlite-demo",
      "--root",
      importRoot,
    ]);
    expect(importedProfile.status).toBe(0);
    expect(importedProfile.stderr).toBe("");
    expect(importedProfile.stdout).toContain("expert profile: sqlite-demo");

    const importedBenchmark = runCli([
      "benchmark",
      "sqlite-demo",
      "--root",
      importRoot,
    ]);
    expect(importedBenchmark.status).toBe(0);
    expect(importedBenchmark.stderr).toBe("");
    expect(importedBenchmark.stdout).toContain("benchmark: sqlite-demo");

    const importCollision = runCli([
      "import",
      defaultExportPath,
      "--root",
      importRoot,
      "--apply",
    ]);
    expect(importCollision.status).toBe(1);
    expect(importCollision.stderr).toContain("target almanac already exists");

    const importAsRoot = join(root, "import-as-root");
    const importAs = runCli([
      "import",
      defaultExportPath,
      "--root",
      importAsRoot,
      "--as",
      "sqlite-copy",
      "--apply",
      "--json",
    ]);
    expect(importAs.status).toBe(0);
    expect(importAs.stderr).toBe("");
    const importAsJson = JSON.parse(importAs.stdout) as {
      targetId: string;
      mode: string;
      targetDir: string;
      manifest: { almanacId: string };
    };
    expect(importAsJson.targetId).toBe("sqlite-copy");
    expect(importAsJson.mode).toBe("applied");
    expect(importAsJson.manifest.almanacId).toBe("sqlite-copy");
    expect(existsSync(importAsJson.targetDir)).toBe(true);

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

    const wikiDir = join(root, "sqlite-demo-wiki");
    const wiki = runCli([
      "wiki",
      "sqlite-demo",
      "--output",
      wikiDir,
      "--json",
      "--root",
      root,
    ]);
    expect(wiki.status).toBe(0);
    expect(wiki.stderr).toBe("");
    const wikiJson = JSON.parse(wiki.stdout) as {
      outputDir: string;
      files: Array<{ name: string; path: string; byteLength: number }>;
    };
    expect(wikiJson.outputDir).toBe(wikiDir);
    expect(wikiJson.files.map((file) => file.name)).toEqual([
      "README.md",
      "sources.md",
      "facts.md",
      "tools.md",
      "benchmark.md",
      "artifacts.json",
    ]);
    expect(await readFile(join(wikiDir, "README.md"), "utf8")).toContain(
      "# SQLite Operations Demo",
    );
    const wikiArtifacts = JSON.parse(
      await readFile(join(wikiDir, "artifacts.json"), "utf8"),
    ) as {
      almanacId: string;
      files: Array<{ name: string; byteLength: number }>;
    };
    expect(wikiArtifacts.almanacId).toBe("sqlite-demo");
    expect(wikiArtifacts.files.map((file) => file.name)).toContain(
      "artifacts.json",
    );

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
    expect(failedProfile.stdout).toContain("health         needs-validation");
    expect(failedProfile.stdout).toContain(
      `latest refresh run failed: ${failedRefreshId}`,
    );

    const failedDoctor = runCli(["doctor", "sqlite-demo", "--root", root]);
    expect(failedDoctor.status).toBe(0);
    expect(failedDoctor.stdout).toContain("warn refresh");
    expect(failedDoctor.stdout).toContain("last failed");
  }, { timeout: 15_000 });

  test("demo can bootstrap answer readiness without provider credentials", async () => {
    const noProviderEnv = {
      ANTHROPIC_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
    };
    const demo = runCli(["demo", "--root", root], noProviderEnv);
    expect(demo.status).toBe(0);

    const initialStatus = runCli(
      ["status", "sqlite-demo", "--json", "--root", root],
      noProviderEnv,
    );
    expect(initialStatus.status).toBe(0);
    expect(
      (JSON.parse(initialStatus.stdout) as {
        activation: {
          milestone: string;
          nextMilestone: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).activation,
    ).toEqual(
      expect.objectContaining({
        milestone: "validated",
        nextMilestone: "answer-ready",
        nextAction: expect.objectContaining({
          command: expect.stringContaining(
            "ask-fixtures init sqlite-demo --seed-demo",
          ),
          providerRequired: false,
        }),
      }),
    );

    const dryRun = runCli(
      ["maintain", "sqlite-demo", "--dry-run", "--json", "--root", root],
      noProviderEnv,
    );
    expect(dryRun.status).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout) as {
      plan: Array<{ id: string; reason: string; command: string | null }>;
      nextActions: string[];
    };
    const askSuiteStep = dryReport.plan.find((step) => step.id === "ask-suite");
    expect(askSuiteStep).toEqual(
      expect.objectContaining({
        reason: "seeded answer checks are missing",
        command: expect.stringContaining(
          "ask-fixtures init sqlite-demo --seed-demo",
        ),
      }),
    );
    expect(dryReport.nextActions).toContainEqual(
      expect.stringContaining("ask-fixtures init sqlite-demo --seed-demo"),
    );
    expect(dryReport.nextActions).toContainEqual(
      expect.stringContaining("almanac ask sqlite-demo"),
    );

    const seed = runCli(
      [
        "ask-fixtures",
        "init",
        "sqlite-demo",
        "--seed-demo",
        "--json",
        "--root",
        root,
      ],
      noProviderEnv,
    );
    expect(seed.status).toBe(0);
    const seeded = JSON.parse(seed.stdout) as {
      relPath: string;
      fixtureCount: number;
      seed: string | null;
    };
    expect(seeded).toEqual(
      expect.objectContaining({
        relPath: "tests/ask.jsonl",
        fixtureCount: 1,
        seed: "sqlite-demo",
      }),
    );

    const askSuite = runCli(
      ["ask-suite", "sqlite-demo", "--json", "--root", root],
      noProviderEnv,
    );
    expect(askSuite.status).toBe(0);
    expect(JSON.parse(askSuite.stdout)).toEqual(
      expect.objectContaining({
        status: "pass",
        total: 1,
        passed: 1,
      }),
    );

    const refresh = runCli(
      [
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
      ],
      noProviderEnv,
    );
    expect(refresh.status).toBe(0);
    expect(JSON.parse(refresh.stdout)).toEqual(
      expect.objectContaining({
        status: "ok",
        askSuite: expect.objectContaining({
          status: "passed",
          total: 1,
          passed: 1,
        }),
      }),
    );

    const profile = runCli(
      ["profile", "sqlite-demo", "--root", root],
      noProviderEnv,
    );
    expect(profile.status).toBe(0);
    expect(profile.stdout).toContain("answer readiness ready");
    expect(profile.stdout).toContain("answer checks  1 found");
    expect(profile.stdout).toContain("quality gate   pass");
    expect(profile.stdout).toContain("save real answer history");

    const readyStatus = runCli(
      ["status", "sqlite-demo", "--json", "--root", root],
      noProviderEnv,
    );
    expect(readyStatus.status).toBe(0);
    expect(
      (JSON.parse(readyStatus.stdout) as {
        activation: {
          milestone: string;
          nextMilestone: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).activation,
    ).toEqual(
      expect.objectContaining({
        milestone: "answer-ready",
        nextMilestone: "first-answer",
        nextAction: expect.objectContaining({
          command: expect.stringContaining('almanac ask sqlite-demo "<question>" --save'),
          providerRequired: true,
        }),
      }),
    );
  }, { timeout: 12_000 });

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

  test("operations lists and runs bounded provider-free operations", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const initialList = runCli([
      "operations",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(initialList.status).toBe(0);
    const initialReport = JSON.parse(initialList.stdout) as {
      recommendedOperation: {
        id: string;
        label: string;
        command: string;
        studioRunnable: boolean;
      };
      operations: Array<{
        id: string;
        command: string;
        providerRequired: boolean;
        studioRunnable: boolean;
      }>;
    };
    expect(initialReport.recommendedOperation).toEqual(
      expect.objectContaining({
        label: "Manage answer checks",
        studioRunnable: false,
        command: expect.stringContaining("almanac ask-fixtures init sqlite-demo"),
      }),
    );

    const initialListFromEnv = runCli(
      ["operations", "sqlite-demo", "--json"],
      { ALMANAC_ROOT: root },
    );
    expect(initialListFromEnv.status).toBe(0);
    expect(
      (JSON.parse(initialListFromEnv.stdout) as {
        recommendedOperation: { id: string };
      }).recommendedOperation.id,
    ).toBe(initialReport.recommendedOperation.id);

    const blockedRun = runCli([
      "operations",
      "run",
      "sqlite-demo",
      initialReport.recommendedOperation.id,
      "--json",
      "--root",
      root,
    ]);
    expect(blockedRun.status).toBe(2);
    const blocked = JSON.parse(blockedRun.stdout) as {
      status: string;
      summary: string;
      operation: { command: string };
    };
    expect(blocked.status).toBe("blocked");
    expect(blocked.summary).toContain("almanac-writing operation");
    expect(blocked.operation.command).toContain("ask-fixtures init");

    const initAskFixtures = runCli([
      "ask-fixtures",
      "init",
      "sqlite-demo",
      "--seed-demo",
      "--root",
      root,
    ]);
    expect(initAskFixtures.status).toBe(0);

    const readyList = runCli([
      "operations",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(readyList.status).toBe(0);
    const readyReport = JSON.parse(readyList.stdout) as {
      operations: Array<{
        id: string;
        command: string;
        providerRequired: boolean;
        studioRunnable: boolean;
      }>;
    };
    const askSuiteOperation = readyReport.operations.find((operation) =>
      operation.command.startsWith("almanac ask-suite sqlite-demo")
    );
    expect(askSuiteOperation).toEqual(
      expect.objectContaining({
        providerRequired: false,
        studioRunnable: true,
      }),
    );
    const refreshEvidenceOperation = readyReport.operations.find((operation) =>
      operation.command.startsWith("almanac refresh run sqlite-demo") &&
      operation.command.includes("--from-stage 12-benchmark-run")
    );
    expect(refreshEvidenceOperation).toEqual(
      expect.objectContaining({
        providerRequired: false,
        studioRunnable: true,
      }),
    );
    const inspectOperation = readyReport.operations.find((operation) =>
      operation.command.startsWith("almanac inspect sqlite-demo")
    );
    expect(inspectOperation).toEqual(
      expect.objectContaining({
        providerRequired: false,
        studioRunnable: false,
      }),
    );

    const askSuiteRun = runCli([
      "operations",
      "run",
      "sqlite-demo",
      askSuiteOperation!.id,
      "--json",
      "--root",
      root,
    ]);
    expect(askSuiteRun.status).toBe(0);
    const askSuiteResult = JSON.parse(askSuiteRun.stdout) as {
      status: string;
      provider: { expected: boolean; actual: boolean };
      artifactsWritten: string[];
      result: { total: number; passed: number };
    };
    expect(askSuiteResult).toEqual(
      expect.objectContaining({
        status: "ok",
        provider: { expected: false, actual: false },
        artifactsWritten: [],
      }),
    );
    expect(askSuiteResult.result).toEqual(
      expect.objectContaining({ total: 1, passed: 1 }),
    );

    const refreshRun = runCli([
      "operations",
      "run",
      "sqlite-demo",
      refreshEvidenceOperation!.id,
      "--json",
      "--root",
      root,
    ]);
    expect(refreshRun.status).toBe(0);
    const refreshResult = JSON.parse(refreshRun.stdout) as {
      status: string;
      provider: { expected: boolean; actual: boolean };
      artifactsWritten: string[];
      result: { askSuite?: { status: string }; savedArtifact?: { relPath: string } };
    };
    expect(["ok", "attention"]).toContain(refreshResult.status);
    expect(refreshResult.provider).toEqual({ expected: false, actual: false });
    expect(refreshResult.artifactsWritten[0]).toMatch(/^\.runs\/refresh-/);
    expect(refreshResult.result.askSuite?.status).toBe("passed");
    expect(refreshResult.result.savedArtifact?.relPath).toBe(
      refreshResult.artifactsWritten[0],
    );
  }, { timeout: 20_000 });

  test("status and profile expose first-answer suggested questions", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const statusJson = runCli([
      "status",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(statusJson.status).toBe(0);
    const statusReport = JSON.parse(statusJson.stdout) as {
      firstAnswer: {
        status: string;
        suggestedQuestions: Array<{
          intent: string;
          question: string;
          saveCommand: string;
        }>;
        nextActions: Array<{ command: string; providerRequired: boolean }>;
      };
      firstUse: {
        status: string;
        stage: string;
        nextStage: string | null;
        nextAction: { command: string; providerRequired: boolean } | null;
        sourceChecklist: { status: string; acceptedCount: number; rejectedCount: number };
      };
      recommendedOperation: {
        label: string;
        category: string;
        studioRunnable: boolean;
        command: string;
      } | null;
    };
    expect(statusReport.firstAnswer.status).toBe("not-started");
    expect(statusReport.firstAnswer.suggestedQuestions[0]).toEqual(
      expect.objectContaining({
        intent: "lookup",
        question: "What makes SQLite transactions atomic?",
        saveCommand: expect.stringContaining(
          "almanac ask sqlite-demo 'What makes SQLite transactions atomic?' --save",
        ),
      }),
    );
    expect(statusReport.firstAnswer.nextActions).toEqual([]);
    expect(statusReport.firstUse).toEqual(
      expect.objectContaining({
        status: "in-progress",
        stage: "validated",
        nextStage: "answer-ready",
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac ask-fixtures init sqlite-demo"),
          providerRequired: false,
        }),
      }),
    );
    expect(statusReport.firstUse.sourceChecklist).toMatchObject({
      status: "ready",
      acceptedCount: 3,
      rejectedCount: 0,
    });
    expect(statusReport.recommendedOperation).toEqual(
      expect.objectContaining({
        label: "Manage answer checks",
        category: "validate",
        studioRunnable: false,
        command: expect.stringContaining("almanac ask-fixtures init sqlite-demo"),
      }),
    );

    const statusHuman = runCli(["status", "sqlite-demo", "--root", root]);
    expect(statusHuman.status).toBe(0);
    expect(statusHuman.stdout).toContain("first answer");
    expect(statusHuman.stdout).toContain("first use     validated; next answer ready");
    expect(statusHuman.stdout).toContain("operation     Manage answer checks");
    expect(statusHuman.stdout).toContain("suggested questions");
    expect(statusHuman.stdout).toContain("What makes SQLite transactions atomic?");

    const profileJson = runCli([
      "profile",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(profileJson.status).toBe(0);
    const profileReport = JSON.parse(profileJson.stdout) as {
      firstAnswer: { suggestedQuestions: Array<{ question: string }> };
      firstUse: { stage: string; nextStage: string | null };
      recommendedOperation: { command: string; studioRunnable: boolean } | null;
    };
    expect(profileReport.firstAnswer.suggestedQuestions[0]?.question).toBe(
      "What makes SQLite transactions atomic?",
    );
    expect(profileReport.firstUse).toEqual(
      expect.objectContaining({
        stage: "validated",
        nextStage: "answer-ready",
      }),
    );
    expect(
      profileReport.recommendedOperation,
    ).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("almanac ask-fixtures init sqlite-demo"),
        studioRunnable: false,
      }),
    );

    const profileHuman = runCli(["profile", "sqlite-demo", "--root", root]);
    expect(profileHuman.status).toBe(0);
    expect(profileHuman.stdout).toContain("operation");
    expect(profileHuman.stdout).toContain("first use      validated; next answer ready");
    expect(profileHuman.stdout).toContain("first answer suggestions");
    expect(profileHuman.stdout).toContain(
      "almanac ask sqlite-demo 'What makes SQLite transactions atomic?' --save",
    );

    const initAskFixtures = runCli([
      "ask-fixtures",
      "init",
      "sqlite-demo",
      "--seed-demo",
      "--root",
      root,
    ]);
    expect(initAskFixtures.status).toBe(0);
    const askSuite = runCli(["ask-suite", "sqlite-demo", "--root", root]);
    expect(askSuite.status).toBe(0);
    const refreshAskSuite = runCli([
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
    expect(refreshAskSuite.status).toBe(0);

    const readyStatusJson = runCli([
      "status",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(readyStatusJson.status).toBe(0);
    expect(
      (JSON.parse(readyStatusJson.stdout) as {
        firstAnswer: {
          nextActions: Array<{ command: string; providerRequired: boolean }>;
        };
        firstUse: { status: string; stage: string; nextStage: string | null };
      }).firstAnswer.nextActions[0],
    ).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("--save"),
        providerRequired: true,
      }),
    );
    expect(
      (JSON.parse(readyStatusJson.stdout) as {
        firstUse: { status: string; stage: string; nextStage: string | null };
      }).firstUse,
    ).toEqual(
      expect.objectContaining({
        status: "useful",
        stage: "answer-ready",
        nextStage: "first-answer",
      }),
    );
  }, { timeout: 15_000 });

  test("ask --save human output shows first-answer trust guidance", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const savedHuman = runCli(
      [
        "ask",
        "sqlite-demo",
        "Are SQLite transactions atomic?",
        "--save",
        "--label",
        "first-answer-human",
        "--root",
        root,
      ],
      mockAskProviderEnv(),
    );
    expect(savedHuman.status).toBe(0);
    expect(savedHuman.stderr).toBe("");
    expect(savedHuman.stdout).toContain("artifact:");
    expect(savedHuman.stdout).toContain("first answer:");
    expect(savedHuman.stdout).toContain("trust: saved cited answer");
    expect(savedHuman.stdout).toContain("quality: pass, 1 citation, 0 unsupported, 0 stale");
    expect(savedHuman.stdout).toContain(
      "almanac ask-replay sqlite-demo --from-runs --label first-answer-human",
    );
    expect(savedHuman.stdout).toContain(
      "almanac ask-fixtures add-from-run sqlite-demo answer-",
    );
    expect(savedHuman.stdout).toContain("almanac ask-suite sqlite-demo");

    const savedJson = runCli(
      [
        "ask",
        "sqlite-demo",
        "Are SQLite transactions atomic?",
        "--save",
        "--label",
        "first-answer-json",
        "--json",
        "--root",
        root,
      ],
      mockAskProviderEnv(),
    );
    expect(savedJson.status).toBe(0);
    expect(savedJson.stderr).toBe("");
    const artifact = JSON.parse(savedJson.stdout) as { kind: string; status: string };
    expect(artifact).toEqual(
      expect.objectContaining({ kind: "answer", status: "ok" }),
    );
    expect(savedJson.stdout).not.toContain("first answer:");
  }, { timeout: 15_000 });

  test("ask --save human output treats abstention as first-class guidance", async () => {
    const demo = runCli(["demo", "--root", root]);
    expect(demo.status).toBe(0);

    const savedHuman = runCli(
      [
        "ask",
        "sqlite-demo",
        "Should I rely on a fact that is not in the almanac?",
        "--save",
        "--label",
        "first-answer-abstain",
        "--root",
        root,
      ],
      mockAbstainAskProviderEnv(),
    );
    expect(savedHuman.status).toBe(1);
    expect(savedHuman.stderr).toBe("");
    expect(savedHuman.stdout).toContain("status: abstained");
    expect(savedHuman.stdout).toContain("first answer:");
    expect(savedHuman.stdout).toContain("trust: saved abstention");
    expect(savedHuman.stdout).toContain("abstention:");
    expect(savedHuman.stdout).toContain("recovery:");
    expect(savedHuman.stdout).toContain(
      "Do not fabricate or force an unsupported answer.",
    );
    expect(savedHuman.stdout).toContain(
      "replay the saved abstention without provider calls",
    );
    expect(savedHuman.stdout).toContain(
      "promote this expected abstention into answer checks",
    );

    const answerId = savedHuman.stdout.match(/\.runs\/(answer-[^\s/]+)\.json/)?.[1];
    expect(answerId).toBeDefined();
    const runDetail = runCli([
      "runs",
      "sqlite-demo",
      answerId!,
      "--root",
      root,
    ]);
    expect(runDetail.status).toBe(0);
    expect(runDetail.stdout).toContain("recovery:");
    expect(runDetail.stdout).toContain("recovery next:");

    const statusJson = runCli(["status", "sqlite-demo", "--json", "--root", root]);
    expect(statusJson.status).toBe(0);
    const statusReport = JSON.parse(statusJson.stdout) as {
      firstAnswer: {
        recovery: {
          summary: string;
          nextSteps: string[];
          nextActions: Array<{ command: string; providerRequired: boolean }>;
        } | null;
      };
    };
    expect(statusReport.firstAnswer.recovery).toEqual(
      expect.objectContaining({
        summary: expect.any(String),
        nextSteps: expect.arrayContaining([
          "Do not fabricate or force an unsupported answer.",
        ]),
      }),
    );
    expect(statusReport.firstAnswer.recovery?.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("almanac runs sqlite-demo"),
          providerRequired: false,
        }),
      ]),
    );
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

    const firstAnswerStatus = runCli([
      "status",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(firstAnswerStatus.status).toBe(0);
    expect(
      (JSON.parse(firstAnswerStatus.stdout) as {
        activation: {
          milestone: string;
          nextMilestone: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
        firstUse: {
          status: string;
          stage: string;
          nextStage: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).activation,
    ).toEqual(
      expect.objectContaining({
        milestone: "first-answer",
        nextMilestone: "answer-ready",
        nextAction: expect.objectContaining({
          command: expect.stringContaining(
            "ask-fixtures init sqlite-demo",
          ),
          providerRequired: false,
        }),
      }),
    );
    expect(
      (JSON.parse(firstAnswerStatus.stdout) as {
        firstUse: {
          status: string;
          stage: string;
          nextStage: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).firstUse,
    ).toEqual(
      expect.objectContaining({
        status: "useful",
        stage: "first-answer",
        nextStage: "answer-ready",
        nextAction: expect.objectContaining({
          command: expect.stringContaining("ask-fixtures init sqlite-demo"),
          providerRequired: false,
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

    const refreshAskSuite = runCli([
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
    expect(refreshAskSuite.status).toBe(0);
    const replayableRefresh = JSON.parse(refreshAskSuite.stdout) as {
      refreshId: string;
      savedArtifact?: { relPath: string };
    };
    const replayableRefreshArtifact = replayableRefresh.savedArtifact!.relPath;
    const replayableRefreshRunId = replayableRefresh.refreshId;

    const replayableStatus = runCli([
      "status",
      "sqlite-demo",
      "--json",
      "--root",
      root,
    ]);
    expect(replayableStatus.status).toBe(0);
    expect(
      (JSON.parse(replayableStatus.stdout) as {
        firstUse: {
          status: string;
          stage: string;
          nextStage: string | null;
          nextAction: { command: string; providerRequired: boolean } | null;
        };
      }).firstUse,
    ).toEqual(
      expect.objectContaining({
        status: "useful",
        stage: "replayable",
        nextStage: "maintainable",
        nextAction: expect.objectContaining({
          command: expect.stringContaining("almanac maintain sqlite-demo --dry-run"),
          providerRequired: false,
        }),
      }),
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
        { kind: "refresh", runId: replayableRefreshRunId },
        { kind: "refresh", runId: refreshId },
      ].sort((a, b) => a.runId.localeCompare(b.runId)),
    );
    expect(
      (await readdir(join(almanacDirPath(root, "sqlite-demo"), ".runs")))
        .sort(),
    ).toEqual(
      [
        savedTool.artifactRelPath.split("/").pop()!,
        replayableRefreshArtifact.split("/").pop()!,
        `${refreshId}.json`,
      ]
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
      "answer readiness ready",
    );
    expect(answerProfileAfterSuite.stdout).toContain(
      "answer checks  1 found (tests/ask.jsonl:1)",
    );
    expect(answerProfileAfterSuite.stdout).toContain(
      "answer check suite passed, 1/1 passed",
    );
    expect(answerProfileAfterSuite.stdout).toContain("latest answer  none");
    expect(answerProfileAfterSuite.stdout).toContain("quality gate   pass");

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
        status: "ready",
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
    expect(doctorAfterSuite.stdout).toContain("ok   answer");
    expect(doctorAfterSuite.stdout).toContain("suite passed");
    expect(doctorAfterSuite.stdout).toContain("latest answer none");

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
    expect(profile.stdout).toContain("health         needs-validation");
    expect(profile.stdout).toContain(
      "high-trust accepted references contribute no extracted knowledge: sqlite-latest-docs (snapshot)",
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
    expect(profile.stdout).toContain("health         needs-validation");
    expect(profile.stdout).toContain(
      "checks coverage below minimum: 1 positive / 1 negative / 2 total",
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
