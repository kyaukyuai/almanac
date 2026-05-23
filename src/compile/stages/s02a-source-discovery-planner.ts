/**
 * Stage 2a — source-discovery planner.
 *
 * Reads the Stage 1 `DomainSpec` from `<almanacDir>/.compile/domain-spec.json`
 * and asks the LLM to produce a `SourceDiscoveryPlan` (per
 * `prompts/02-source-discovery/planner-v1.md`). The plan is the input to the
 * deterministic discovery executor between 2a and 2b — it lists URL probes,
 * web searches, and GitHub queries, all bounded by depth-derived budgets.
 *
 * Output:
 *   `<almanacDir>/.compile/source-discovery-plan.json`
 *
 * Like Stage 1, this runner persists a canonicalized JSON body and returns
 * an `outputHash = sha256(canonical text)` so downstream stages can detect
 * drift across re-runs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  SourceDiscoveryPlanSchema,
  type DomainSpec,
  type SourceDiscoveryPlan,
} from "../../core/types.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
  type LlmProvider,
} from "../../llm/provider.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { loadPromptTemplate } from "../prompt-loader.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE2A_PROMPT_VERSION = "planner-v1";
export const STAGE2A_PROMPT_STAGE_ID = "02-source-discovery";

/** Matches `recommendedModel` in `prompts/02-source-discovery/planner-v1.md`. */
export const STAGE2A_DEFAULT_MODEL = "claude-sonnet-4-5";
/** Matches `maxTokens`. */
export const STAGE2A_DEFAULT_MAX_TOKENS = 3072;
/** Matches `temperature`. */
export const STAGE2A_DEFAULT_TEMPERATURE = 0.1;

/** On-disk location of the persisted plan, relative to almanacDir. */
export const SOURCE_DISCOVERY_PLAN_REL_PATH =
  ".compile/source-discovery-plan.json";

export function sourceDiscoveryPlanPath(almanacDir: string): string {
  return join(almanacDir, SOURCE_DISCOVERY_PLAN_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Stage 1's `domain-spec.json` is missing or unreadable. Distinct from
 * schema/parse errors so the CLI can guide the user back to Stage 1.
 */
export class MissingDomainSpecError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 2a requires a Stage 1 DomainSpec at ${path}; ` +
        "run Stage 1 (`almanac new`) first or restore the file",
    );
    this.name = "MissingDomainSpecError";
  }
}

/**
 * Stage 2a's `source-discovery-plan.json` is missing or unreadable.
 * Surfaced by both Stages 02x and 2b which consume the plan.
 */
export class MissingPlanError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `consumer requires a Stage 2a SourceDiscoveryPlan at ${path}; ` +
        "run Stage 2a first or restore the file",
    );
    this.name = "MissingPlanError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateSourceDiscoveryPlannerRunnerOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE2A_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE2A_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE2A_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;
  /**
   * Test seam: read the upstream DomainSpec from a custom location instead of
   * `<almanacDir>/.compile/domain-spec.json`. Defaults to that path.
   */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
}

/**
 * Build the Stage 2a `StageRunner`. Records `promptVersion = "planner-v1"`
 * on the `StageEntry` so the output is reproducible from prompt + DomainSpec.
 */
export function createSourceDiscoveryPlannerRunner(
  opts: CreateSourceDiscoveryPlannerRunnerOptions,
): StageRunner {
  const model = opts.model ?? STAGE2A_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE2A_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE2A_DEFAULT_TEMPERATURE;
  const readSpec = opts.readDomainSpec ?? defaultReadDomainSpec;

  return {
    promptVersion: STAGE2A_PROMPT_VERSION,
    async run(ctx) {
      const depth = ctx.state.options.depth;
      const domainSpec = await readSpec(ctx.almanacDir);

      const prompt = loadPromptTemplate({
        stageId: STAGE2A_PROMPT_STAGE_ID,
        version: STAGE2A_PROMPT_VERSION,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          depth,
          domainSpecJson: indentBlock(JSON.stringify(domainSpec, null, 2), 2),
        },
      });

      const callName = `${STAGE2A_PROMPT_STAGE_ID}@${STAGE2A_PROMPT_VERSION}`;
      ctx.log({
        event: "stage2a:llm:start",
        callName,
        model,
        canonicalSlug: domainSpec.canonicalSlug,
        depth,
      });

      const completion = await opts.provider.complete({
        model,
        maxTokens,
        temperature,
        callName,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      });

      const jsonText = stripFence(completion.text);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonText);
      } catch (cause) {
        throw new LlmJsonParseError(
          `Stage 2a: LLM output is not valid JSON: ${(cause as Error).message}`,
          completion.text,
          cause,
        );
      }

      let plan: SourceDiscoveryPlan;
      try {
        plan = SourceDiscoveryPlanSchema.parse(parsedJson);
      } catch (e) {
        throw new LlmSchemaValidationError(
          `Stage 2a: LLM output does not match SourceDiscoveryPlan schema: ${
            e instanceof Error ? e.message : String(e)
          }`,
          completion.text,
          parsedJson,
          e,
        );
      }

      // Cross-check: planner must echo the exact DomainSpec identity so that
      // downstream stages can trust `plan.domain.canonicalSlug` without
      // re-reading the spec. A mismatch here is an LLM hallucination.
      if (
        plan.domain.canonicalSlug !== domainSpec.canonicalSlug ||
        plan.domain.displayName !== domainSpec.displayName
      ) {
        throw new LlmSchemaValidationError(
          `Stage 2a: plan.domain (${plan.domain.canonicalSlug}/${plan.domain.displayName}) ` +
            `does not match DomainSpec (${domainSpec.canonicalSlug}/${domainSpec.displayName})`,
          completion.text,
          parsedJson,
        );
      }

      const canonicalText = JSON.stringify(plan, null, 2);
      const outPath = sourceDiscoveryPlanPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);

      ctx.log({
        event: "stage2a:llm:done",
        callName,
        outputHash,
        directProbes: plan.directProbes.length,
        webSearchQueries: plan.webSearchQueries.length,
        githubQueries: plan.githubQueries.length,
        durationMs: completion.durationMs,
        usage: completion.usage,
      });

      return {
        kind: "success",
        outputHash,
        llmCalls: 1,
        cost: {
          tokens: {
            input: completion.usage.inputTokens,
            output: completion.usage.outputTokens,
          },
          usd: 0,
        },
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Default DomainSpec reader. Loads `<almanacDir>/.compile/domain-spec.json`,
 * re-validates via `DomainSpecSchema`, and converts ENOENT into the typed
 * `MissingDomainSpecError`.
 */
async function defaultReadDomainSpec(almanacDir: string): Promise<DomainSpec> {
  const path = domainSpecPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingDomainSpecError(path, cause);
    }
    throw cause;
  }
  return DomainSpecSchema.parse(JSON.parse(body));
}

/** Indent every line of `text` by `n` spaces. Used for the YAML block scalar. */
export function indentBlock(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/** See note on the matching helper in `s01-domain-analysis.ts`. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}
