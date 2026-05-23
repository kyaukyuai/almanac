/**
 * Stage 02x — source-discovery executor (deterministic).
 *
 * Sits between Stage 2a (planner) and Stage 2b (evaluator). Reads the plan
 * from `.compile/source-discovery-plan.json`, runs the deterministic
 * `runDiscoveryExecutor` (URL probes + web search + GitHub search), and
 * persists `Candidate[]` to `.compile/candidates.json` for the evaluator to
 * consume.
 *
 * Deterministic stage: `promptVersion = null`. The orchestrator records the
 * sha256 of the canonical candidates JSON as `outputHash` so any drift
 * between executor runs is immediately visible in `compile-state.json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SourceDiscoveryPlanSchema,
  type SourceDiscoveryPlan,
} from "../../core/types.ts";
import { runDiscoveryExecutor } from "../discovery/executor.ts";
import type {
  GithubSearcher,
  UrlProber,
  WebSearcher,
} from "../discovery/types.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import {
  MissingPlanError,
  sourceDiscoveryPlanPath,
} from "./s02a-source-discovery-planner.ts";

export const CANDIDATES_REL_PATH = ".compile/candidates.json";

export function candidatesPath(almanacDir: string): string {
  return join(almanacDir, CANDIDATES_REL_PATH);
}

export interface CreateSourceDiscoveryExecutorRunnerOptions {
  prober: UrlProber;
  webSearcher: WebSearcher;
  githubSearcher: GithubSearcher;
  /** Test seam: read plan from a custom location. */
  readPlan?: (almanacDir: string) => Promise<SourceDiscoveryPlan>;
}

/**
 * Build the Stage 02x `StageRunner`. Pure orchestration around
 * `runDiscoveryExecutor` + filesystem persistence.
 */
export function createSourceDiscoveryExecutorRunner(
  opts: CreateSourceDiscoveryExecutorRunnerOptions,
): StageRunner {
  const readPlan = opts.readPlan ?? defaultReadPlan;
  return {
    promptVersion: null,
    async run(ctx) {
      const plan = await readPlan(ctx.almanacDir);

      ctx.log({
        event: "stage02x:start",
        directProbes: plan.directProbes.length,
        webSearchQueries: plan.webSearchQueries.length,
        githubQueries: plan.githubQueries.length,
      });
      const out = await runDiscoveryExecutor({
        plan,
        prober: opts.prober,
        webSearcher: opts.webSearcher,
        githubSearcher: opts.githubSearcher,
        now: ctx.now,
        log: ctx.log,
      });

      const canonicalText = JSON.stringify(out.candidates, null, 2);
      const outPath = candidatesPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage02x:done",
        outputHash,
        candidates: out.candidates.length,
        ...out.stats,
      });

      return { kind: "success", outputHash };
    },
  };
}

async function defaultReadPlan(
  almanacDir: string,
): Promise<SourceDiscoveryPlan> {
  const path = sourceDiscoveryPlanPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingPlanError(path, cause);
    }
    throw cause;
  }
  return SourceDiscoveryPlanSchema.parse(JSON.parse(body));
}
