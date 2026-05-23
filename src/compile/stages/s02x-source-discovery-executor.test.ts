/**
 * Tests for Stage 02x — source-discovery executor runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CandidatesSchema,
  CompileStateSchema,
  SourceDiscoveryPlanSchema,
  type AlmanacManifest,
  type CompileState,
  type SourceDiscoveryPlan,
} from "../../core/types.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import {
  MissingPlanError,
  sourceDiscoveryPlanPath,
} from "./s02a-source-discovery-planner.ts";
import {
  candidatesPath,
  createSourceDiscoveryExecutorRunner,
} from "./s02x-source-discovery-executor.ts";
import type { StageContext } from "../pipeline.ts";
import type {
  GithubSearcher,
  ProbeResult,
  UrlProber,
  WebSearcher,
} from "../discovery/types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const PLAN: SourceDiscoveryPlan = SourceDiscoveryPlanSchema.parse({
  schemaVersion: "0.1.0",
  domain: { canonicalSlug: "kubernetes", displayName: "Kubernetes" },
  budgets: {
    maxWebSearchQueries: 4,
    maxGithubQueries: 4,
    maxUrlProbes: 12,
    maxCandidatesPerKind: 4,
    targetAcceptedSources: 8,
  },
  directProbes: [
    { hint: "https://kubernetes.io/docs/", kind: "docs", rationale: "primary" },
  ],
  webSearchQueries: [],
  githubQueries: [
    {
      query: "topic:kubernetes stars:>500",
      type: "repos",
      rationale: "official repos",
    },
  ],
  coverageGoals: {
    docs: { min: 1, max: 3 },
    repo: { min: 1, max: 3 },
    news: { min: 0, max: 2 },
    community: { min: 0, max: 2 },
    academic: { min: 0, max: 1 },
    data: { min: 0, max: 2 },
    file: { min: 0, max: 0 },
    essay: { min: 0, max: 0 },
    book: { min: 0, max: 0 },
    talk: { min: 0, max: 0 },
  },
});

function silentProber(): UrlProber {
  return {
    name: "silent",
    async probe(url: string): Promise<ProbeResult> {
      return {
        url,
        fetchStatus: "ok",
        title: `Title of ${url}`,
        snippet: null,
        preview: null,
        meta: { httpStatusCode: 200 },
      };
    },
  };
}
function nullWebSearcher(): WebSearcher {
  return { name: "null", async search() { return []; } };
}
function singleGithubSearcher(): GithubSearcher {
  return {
    name: "single",
    async search() {
      return [
        {
          url: "https://github.com/kubernetes/kubernetes",
          fullName: "kubernetes/kubernetes",
          description: "K8s",
          stars: 100000,
          license: "Apache-2.0",
          lastCommitAt: "2026-04-01T00:00:00Z",
        },
      ];
    },
  };
}

async function freshFixture(opts?: { withPlan?: boolean }): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s02x-"));
  cleanup.push(root);
  const almanacDir = join(root, "kubernetes");
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "kubernetes",
    domain: "kubernetes",
    displayName: "Kubernetes",
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.0.0",
    options: {
      depth: "standard",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
  await ensureAlmanacLayout(almanacDir);
  if (opts?.withPlan !== false) {
    const p = sourceDiscoveryPlanPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(PLAN, null, 2), "utf8");
  }
  return {
    almanacDir,
    manifest: AlmanacManifestSchema.parse(manifest),
    state: CompileStateSchema.parse(compileState),
  };
}

function makeCtx(input: {
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}): StageContext {
  return {
    almanacDir: input.almanacDir,
    manifest: input.manifest,
    state: input.state,
    stageId: "02x-source-discovery-executor",
    log: () => {},
    now: () => new Date("2026-05-08T12:00:01.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createSourceDiscoveryExecutorRunner", () => {
  test("promptVersion is null (deterministic stage)", () => {
    const runner = createSourceDiscoveryExecutorRunner({
      prober: silentProber(),
      webSearcher: nullWebSearcher(),
      githubSearcher: singleGithubSearcher(),
    });
    expect(runner.promptVersion).toBeNull();
  });

  test("happy path: persists Candidate[] + deterministic outputHash", async () => {
    const fx = await freshFixture();
    const runner = createSourceDiscoveryExecutorRunner({
      prober: silentProber(),
      webSearcher: nullWebSearcher(),
      githubSearcher: singleGithubSearcher(),
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    const body = readFileSync(candidatesPath(fx.almanacDir), "utf8");
    const candidates = CandidatesSchema.parse(JSON.parse(body));
    expect(candidates.length).toBe(2); // 1 direct + 1 github
    expect(candidates.map((c) => c.kind)).toEqual(["docs", "repo"]);

    // Determinism
    const fx2 = await freshFixture();
    const outcome2 = await createSourceDiscoveryExecutorRunner({
      prober: silentProber(),
      webSearcher: nullWebSearcher(),
      githubSearcher: singleGithubSearcher(),
    }).run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("missing plan → MissingPlanError", async () => {
    const fx = await freshFixture({ withPlan: false });
    const runner = createSourceDiscoveryExecutorRunner({
      prober: silentProber(),
      webSearcher: nullWebSearcher(),
      githubSearcher: singleGithubSearcher(),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingPlanError,
    );
  });
});
