/**
 * Stage 11 — benchmark generation (LLM-driven).
 *
 *   1. Reads the Stage 1 `DomainSpec`         (`.compile/domain-spec.json`)
 *   2. Reads the Stage 7 final tool manifests (`tools/<name>.json`) and keeps
 *      only the enabled ones — these are exactly the names the LLM may
 *      reference in fixture invocations.
 *   3. Asks the LLM to author a `BenchmarkSet` (10 positive + 5 negative
 *      fixtures, roughly) plus a rationale, returning `Stage11Output`.
 *   4. Cross-validates every `invocation.tool` against the enabled tool set
 *      so a malformed fixture cannot land on disk.
 *
 * Persists:
 *   - `tests/positive.jsonl` — one PositiveFixture per line (design SoT)
 *   - `tests/negative.jsonl` — one NegativeFixture per line
 *   - `.compile/stage11-output.json` — full Stage11Output (rationale + set)
 *
 * `outputHash` = sha256 of the canonical Stage11Output JSON.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  FactRecordSchema,
  parseStage11Output,
  type BenchmarkReport,
  type BenchmarkSet,
  type DomainSpec,
  type FactRecord,
  type Stage11Output,
  type ToolManifest,
} from "../../core/types.ts";
import { factsJsonlPath } from "./s05-fact-extraction.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
  type LlmProvider,
} from "../../llm/provider.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { loadPromptTemplate } from "../prompt-loader.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { discoverToolNames, loadTool } from "../../serve/tool-loader.ts";
import { createAlmanacRuntimeAsync } from "../../serve/runtime.ts";
import { runBenchmark } from "./s12-benchmark-run.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE11_PROMPT_VERSION = "v3";
export const STAGE11_PROMPT_STAGE_ID = "11-benchmark-gen";

/** Matches `recommendedModel` in `prompts/11-benchmark-gen/v3.md`. */
export const STAGE11_DEFAULT_MODEL = "claude-sonnet-4-5";
export const STAGE11_DEFAULT_MAX_TOKENS = 6144;
export const STAGE11_DEFAULT_TEMPERATURE = 0.2;
/** 1 initial + 2 retries: schema repair plus optional runtime preflight repair. */
export const STAGE11_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Default size of the fact sample shown to the Stage 11 LLM.
 *
 * 60 is a working tradeoff: on a 600-fact corpus this samples 10 %
 * of the surface, which is enough to expose secondary terminology
 * (e.g. "vdbe", "wal transaction" in the sqlite smoke) that the
 * earlier 3 % sample (20 facts) systematically missed. The cost
 * impact on Stage 11 prompt tokens is ~2 KB — negligible against
 * the ~6 KB ToolManifest payload.
 */
export const STAGE11_DEFAULT_FACT_SAMPLE_SIZE = 60;
export const STAGE11_MIN_STABILIZED_POSITIVE_FIXTURES = 8;
export const STAGE11_MIN_STABILIZED_NEGATIVE_FIXTURES = 4;

export const STAGE11_OUTPUT_REL_PATH = ".compile/stage11-output.json";
export const POSITIVE_JSONL_REL_PATH = "tests/positive.jsonl";
export const NEGATIVE_JSONL_REL_PATH = "tests/negative.jsonl";

export function stage11OutputPath(almanacDir: string): string {
  return join(almanacDir, STAGE11_OUTPUT_REL_PATH);
}
export function positiveJsonlPath(almanacDir: string): string {
  return join(almanacDir, POSITIVE_JSONL_REL_PATH);
}
export function negativeJsonlPath(almanacDir: string): string {
  return join(almanacDir, NEGATIVE_JSONL_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingDomainSpecError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 11 requires the Stage 1 DomainSpec at ${path}; ` +
        "run Stage 1 first or restore the file",
    );
    this.name = "MissingDomainSpecError";
  }
}

export class NoEnabledToolsError extends Error {
  constructor(public readonly almanacDir: string) {
    super(
      `Stage 11 requires at least one enabled tool under ${almanacDir}/tools/; ` +
        "run Stage 7 first or fix the tool manifests",
    );
    this.name = "NoEnabledToolsError";
  }
}

export class InvalidFixtureInvocationError extends Error {
  constructor(
    public readonly fixtureId: string,
    public readonly toolName: string,
    public readonly enabledNames: readonly string[],
  ) {
    super(
      `Stage 11: fixture "${fixtureId}" invokes tool "${toolName}" which is not in the enabled tool set [${enabledNames.join(", ")}]`,
    );
    this.name = "InvalidFixtureInvocationError";
  }
}

export class BenchmarkPreflightValidationError extends Error {
  constructor(
    public readonly report: BenchmarkReport,
    public readonly failedFixtureIds: readonly string[],
  ) {
    super(
      `Stage 11: generated benchmark failed runtime preflight for fixture(s): ${failedFixtureIds.join(", ")}`,
    );
    this.name = "BenchmarkPreflightValidationError";
  }
}

export class BenchmarkPreflightCoverageError extends Error {
  constructor(
    public readonly skippedFixtureIds: readonly string[],
    public readonly blockedReason?: string,
  ) {
    super(
      blockedReason === undefined
        ? `Stage 11: generated benchmark included unpreflighted fixture(s): ${skippedFixtureIds.join(", ")}`
        : `Stage 11: generated benchmark included unpreflighted fixture(s): ${skippedFixtureIds.join(", ")}; ${blockedReason}`,
    );
    this.name = "BenchmarkPreflightCoverageError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Cross-validation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Verify that every fixture's `invocation.tool` references one of the enabled
 * tool names. Throws `InvalidFixtureInvocationError` on the first offender —
 * the schema validation in `parseStage11Output` cannot enforce this because
 * it doesn't know what tools are enabled.
 */
export function validateInvocations(
  set: Stage11Output["set"],
  enabledNames: ReadonlySet<string>,
): void {
  const enabledArr = [...enabledNames];
  for (const f of set.positive) {
    if (!enabledNames.has(f.invocation.tool)) {
      throw new InvalidFixtureInvocationError(f.id, f.invocation.tool, enabledArr);
    }
  }
  for (const f of set.negative) {
    if (!enabledNames.has(f.invocation.tool)) {
      throw new InvalidFixtureInvocationError(f.id, f.invocation.tool, enabledArr);
    }
  }
}

export function normalizePositiveContainsForFactsTools(
  output: Stage11Output,
  manifests: readonly ToolManifest[],
): { output: Stage11Output; changedFixtureIds: string[] } {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const changedFixtureIds: string[] = [];
  const positive = output.set.positive.map((fixture) => {
    const manifest = byName.get(fixture.invocation.tool);
    if (
      manifest?.knowledgeUsage.facts === true &&
      fixture.expected.contains.length > 0
    ) {
      changedFixtureIds.push(fixture.id);
      return {
        ...fixture,
        expected: {
          ...fixture.expected,
          contains: [],
        },
      };
    }
    return fixture;
  });

  if (changedFixtureIds.length === 0) {
    return { output, changedFixtureIds };
  }

  return {
    output: {
      ...output,
      set: {
        ...output.set,
        positive,
      },
    },
    changedFixtureIds,
  };
}

function preflightFailures(report: BenchmarkReport): BenchmarkReport["results"] {
  return report.results.filter((r) => r.status !== "pass");
}

export function isPreflightSafeToolManifest(manifest: ToolManifest): boolean {
  return (
    manifest.knowledgeUsage.facts === true &&
    manifest.capabilities.network.length === 0 &&
    manifest.capabilities.subprocess.length === 0 &&
    manifest.volatilityClass !== "fast" &&
    manifest.volatilityClass !== "live"
  );
}

export interface PreflightBenchmarkSetPlan {
  set: BenchmarkSet | null;
  includedFixtureIds: string[];
  skippedFixtureIds: string[];
}

export function buildPreflightBenchmarkSet(
  set: BenchmarkSet,
  manifests: readonly ToolManifest[],
): PreflightBenchmarkSetPlan {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const positive = set.positive.filter((fixture) => {
    const manifest = byName.get(fixture.invocation.tool);
    return manifest !== undefined && isPreflightSafeToolManifest(manifest);
  });
  const negative = set.negative.filter((fixture) => {
    const manifest = byName.get(fixture.invocation.tool);
    return manifest !== undefined && isPreflightSafeToolManifest(manifest);
  });

  const includedFixtureIds =
    positive.length > 0 && negative.length > 0
      ? [...positive.map((f) => f.id), ...negative.map((f) => f.id)]
      : [];
  const included = new Set(includedFixtureIds);
  const allFixtureIds = [
    ...set.positive.map((f) => f.id),
    ...set.negative.map((f) => f.id),
  ];
  const skippedFixtureIds = allFixtureIds.filter((id) => !included.has(id));

  if (positive.length === 0 || negative.length === 0) {
    return {
      set: null,
      includedFixtureIds: [],
      skippedFixtureIds,
    };
  }

  return {
    set: {
      ...set,
      positive,
      negative,
    },
    includedFixtureIds,
    skippedFixtureIds,
  };
}

function stabilizeByDroppingFixtureIds(
  output: Stage11Output,
  fixtureIds: readonly string[],
  rationalePrefix: string,
): { output: Stage11Output; droppedFixtureIds: string[]; blockedReason?: string } {
  const dropIds = new Set(fixtureIds);
  if (dropIds.size === 0) return { output, droppedFixtureIds: [] };

  const positive = output.set.positive.filter((f) => !dropIds.has(f.id));
  const negative = output.set.negative.filter((f) => !dropIds.has(f.id));
  const minPositive = Math.min(
    output.set.positive.length,
    STAGE11_MIN_STABILIZED_POSITIVE_FIXTURES,
  );
  const minNegative = Math.min(
    output.set.negative.length,
    STAGE11_MIN_STABILIZED_NEGATIVE_FIXTURES,
  );
  if (positive.length < minPositive || negative.length < minNegative) {
    return {
      output,
      droppedFixtureIds: [],
      blockedReason:
        `dropping failed fixtures would leave ${positive.length} positive / ${negative.length} negative, ` +
        `below required ${minPositive} positive / ${minNegative} negative`,
    };
  }

  return {
    output: {
      ...output,
      set: {
        ...output.set,
        positive,
        negative,
      },
      rationale: `${output.rationale} ${rationalePrefix}: ${[...dropIds].join(", ")}.`.slice(
        0,
        2000,
      ),
    },
    droppedFixtureIds: [...dropIds],
  };
}

function stabilizeFromPreflight(
  output: Stage11Output,
  report: BenchmarkReport,
): { output: Stage11Output; droppedFixtureIds: string[]; blockedReason?: string } {
  return stabilizeByDroppingFixtureIds(
    output,
    preflightFailures(report).map((r) => r.fixtureId),
    "Runtime preflight removed unstable fixtures",
  );
}

function stabilizeFromSkippedPreflightFixtures(
  output: Stage11Output,
  skippedFixtureIds: readonly string[],
): { output: Stage11Output; droppedFixtureIds: string[]; blockedReason?: string } {
  return stabilizeByDroppingFixtureIds(
    output,
    skippedFixtureIds,
    "Runtime preflight removed unverified fixtures",
  );
}

function formatPreflightFailures(
  report: BenchmarkReport,
  set: BenchmarkSet,
): string {
  const byId = new Map([
    ...set.positive.map((f) => [f.id, f.invocation] as const),
    ...set.negative.map((f) => [f.id, f.invocation] as const),
  ]);
  const lines = preflightFailures(report).slice(0, 10).map((r) => {
    const invocation = byId.get(r.fixtureId);
    return [
      `- ${r.kind} ${r.fixtureId}: ${r.reason}`,
      invocation
        ? `  invocation: ${JSON.stringify(invocation)}`
        : "  invocation: <unknown>",
      `  observed: ${JSON.stringify(r.observed)}`,
    ].join("\n");
  });
  return [
    "Runtime preflight failed these fixtures:",
    ...lines,
    "",
    "For positives, use only invocations that can pass against deterministic facts-backed tools.",
    "Avoid positive fixtures for facts-backed custom tools with empty sampleUrls unless the exact invocation passed preflight.",
    "Use refusalReason \"no-source\" for no-result negatives; \"no-results\" is an error code, not a refusalReason.",
  ].join("\n");
}

function formatPreflightCoverageError(error: BenchmarkPreflightCoverageError): string {
  return [
    "Runtime preflight could not verify these fixtures because their tools use live/network or otherwise non-deterministic execution:",
    ...error.skippedFixtureIds.map((id) => `- ${id}`),
    error.blockedReason ? `\n${error.blockedReason}` : "",
    "\nReplace them with facts-backed deterministic fixtures, or provide enough deterministic fixtures that the unverified ones can be removed.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateBenchmarkGenRunnerOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE11_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE11_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE11_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Defaults to `STAGE11_DEFAULT_MAX_ATTEMPTS` (1 initial + 1 retry). */
  maxAttempts?: number;
  /**
   * Defaults to `STAGE11_DEFAULT_FACT_SAMPLE_SIZE` (60). Sample of facts
   * shown to the LLM so positive fixture queries can target real corpus
   * vocabulary; v1 of the prompt ran "blind" against just the
   * `DomainSpec`, leading the LLM to invent fictional terms that the
   * indexed facts never contained.
   */
  factSampleSize?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;

  /** Test seam: read Stage 1 output. */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
  /** Test seam: list enabled tool manifests for the almanac. */
  readEnabledManifests?: (almanacDir: string) => Promise<ToolManifest[]>;
  /**
   * Test seam: read the fact sample. Defaults to evenly-spaced reading
   * of `extracted/facts.jsonl`. Returns an empty array (not throw) when
   * the file is missing — Stage 11 can still emit useful fixtures
   * driven by the live tools alone.
   */
  readFactSample?: (
    almanacDir: string,
    size: number,
  ) => Promise<FactSampleEntry[]>;
  /**
   * When true, execute the generated benchmark set against the current runtime
   * before persisting it. Failures are fed back to the LLM as a retry; on the
   * final attempt, failed fixtures may be dropped so Stage 12 receives a stable
   * smoke set.
   */
  preflightGeneratedSet?: boolean;
  /** Test seam for preflight execution. Defaults to the concrete runtime. */
  preflightBenchmarkSet?: (
    almanacDir: string,
    set: BenchmarkSet,
    ranAt: Date,
  ) => Promise<BenchmarkReport>;
}

/**
 * Compact projection of a `FactRecord` shown to the Stage 11 LLM. The
 * full record carries provenance + freshness fields the benchmark author
 * doesn't need; we only expose the routing-relevant text + entities + the
 * source the fact came from.
 */
export interface FactSampleEntry {
  text: string;
  type: string;
  entities: readonly string[];
  sourceId: string;
}

export interface TradeoffFixtureOpportunity {
  text: string;
  entities: readonly string[];
  sourceId: string;
}

export interface ComparisonToolHint {
  name: string;
  reason: "input-pair" | "description";
  inputFields: readonly string[];
  factsBacked: boolean;
}

export interface TradeoffBenchmarkGuidance {
  required: boolean;
  opportunities: readonly TradeoffFixtureOpportunity[];
  comparisonTools: readonly ComparisonToolHint[];
  fallbackFactsTools: readonly string[];
}

export function buildTradeoffBenchmarkGuidance(
  factSample: readonly FactSampleEntry[],
  manifests: readonly ToolManifest[],
): TradeoffBenchmarkGuidance {
  const opportunities = factSample
    .flatMap((fact): TradeoffFixtureOpportunity[] => {
      if (fact.type.toLowerCase() !== "tradeoff") return [];
      const entities = [...new Set(fact.entities)].filter((e) => e.length > 0);
      if (entities.length < 2) return [];
      return [{
        text: truncateForPrompt(fact.text, 360),
        entities: entities.slice(0, 4),
        sourceId: fact.sourceId,
      }];
    })
    .slice(0, 5);

  const comparisonTools = manifests
    .flatMap((manifest): ComparisonToolHint[] => {
      const inputFields = inputSchemaPropertyNames(manifest.inputSchema);
      const pairFields = comparisonPairFields(inputFields);
      if (pairFields.length > 0) {
        return [{
          name: manifest.name,
          reason: "input-pair",
          inputFields: pairFields,
          factsBacked: manifest.knowledgeUsage.facts,
        }];
      }
      if (mentionsComparisonShape(manifest)) {
        return [{
          name: manifest.name,
          reason: "description",
          inputFields: inputFields.slice(0, 8),
          factsBacked: manifest.knowledgeUsage.facts,
        }];
      }
      return [];
    })
    .slice(0, 5);

  const fallbackFactsTools = manifests
    .filter((manifest) => isFactsQueryFallbackTool(manifest))
    .map((manifest) => manifest.name)
    .slice(0, 3);

  return {
    required:
      opportunities.length > 0 &&
      (comparisonTools.length > 0 || fallbackFactsTools.length > 0),
    opportunities,
    comparisonTools,
    fallbackFactsTools,
  };
}

/**
 * Build the Stage 11 `StageRunner`. Records `promptVersion = "v1"`.
 */
export function createBenchmarkGenRunner(
  opts: CreateBenchmarkGenRunnerOptions,
): StageRunner {
  const model = opts.model ?? STAGE11_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE11_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE11_DEFAULT_TEMPERATURE;
  const maxAttempts = Math.max(
    1,
    opts.maxAttempts ?? STAGE11_DEFAULT_MAX_ATTEMPTS,
  );
  const readDomainSpec = opts.readDomainSpec ?? defaultReadDomainSpec;
  const readEnabledManifests =
    opts.readEnabledManifests ?? defaultReadEnabledManifests;
  const readFactSample = opts.readFactSample ?? defaultReadFactSample;
  const preflightBenchmarkSet =
    opts.preflightBenchmarkSet ?? defaultPreflightBenchmarkSet;
  const factSampleSize = Math.max(
    0,
    opts.factSampleSize ?? STAGE11_DEFAULT_FACT_SAMPLE_SIZE,
  );

  return {
    promptVersion: STAGE11_PROMPT_VERSION,
    async run(ctx) {
      const [domainSpec, manifests, factSample] = await Promise.all([
        readDomainSpec(ctx.almanacDir),
        readEnabledManifests(ctx.almanacDir),
        readFactSample(ctx.almanacDir, factSampleSize),
      ]);

      if (manifests.length === 0) {
        throw new NoEnabledToolsError(ctx.almanacDir);
      }

      const enabledNames = new Set(manifests.map((m) => m.name));
      const tradeoffGuidance = buildTradeoffBenchmarkGuidance(
        factSample,
        manifests,
      );

      // Reduce manifest size: the prompt only needs the routing-relevant fields.
      const promptManifests = manifests.map((m) => ({
        name: m.name,
        description: m.description,
        whenToUse: m.whenToUse,
        inputSchema: m.inputSchema,
        outputSchema: m.outputSchema,
        capabilities: m.capabilities,
        volatilityClass: m.volatilityClass,
        knowledgeUsage: m.knowledgeUsage,
        sourceDependencies: m.sourceDependencies,
        sampleUrls: m.sampleUrls,
      }));

      const prompt = loadPromptTemplate({
        stageId: STAGE11_PROMPT_STAGE_ID,
        version: STAGE11_PROMPT_VERSION,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          domainSpec: JSON.stringify(domainSpec),
          toolManifests: JSON.stringify(promptManifests),
          factSample: JSON.stringify(factSample),
          tradeoffGuidance: JSON.stringify(tradeoffGuidance),
        },
      });

      const callName = `${STAGE11_PROMPT_STAGE_ID}@${STAGE11_PROMPT_VERSION}`;
      if (tradeoffGuidance.required) {
        ctx.log({
          event: "stage11:tradeoff-guidance",
          opportunities: tradeoffGuidance.opportunities.length,
          comparisonTools: tradeoffGuidance.comparisonTools.map((t) => t.name),
          fallbackFactsTools: tradeoffGuidance.fallbackFactsTools,
        });
      }
      ctx.log({
        event: "stage11:llm:start",
        callName,
        model,
        toolCount: manifests.length,
        factSampleSize: factSample.length,
        maxAttempts,
      });

      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastError:
        | LlmJsonParseError
        | LlmSchemaValidationError
        | InvalidFixtureInvocationError
        | BenchmarkPreflightValidationError
        | BenchmarkPreflightCoverageError
        | null = null;
      let output: Stage11Output | null = null;
      let lastDurationMs = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const completion = await opts.provider.complete({
          model,
          maxTokens,
          temperature,
          callName,
          messages,
        });
        totalInputTokens += completion.usage.inputTokens;
        totalOutputTokens += completion.usage.outputTokens;
        lastDurationMs = completion.durationMs;

        const jsonText = stripFence(completion.text);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(jsonText);
        } catch (cause) {
          lastError = new LlmJsonParseError(
            `Stage 11: LLM output is not valid JSON: ${(cause as Error).message}`,
            completion.text,
            cause,
          );
          if (attempt < maxAttempts) {
            ctx.log({
              event: "stage11:llm:retry",
              callName,
              attempt,
              reason: "json-parse",
              message: (cause as Error).message,
            });
            messages.push(
              { role: "assistant", content: completion.text },
              {
                role: "user",
                content: buildRetryFeedback({
                  reason: "json-parse",
                  detail: (cause as Error).message,
                }),
              },
            );
            continue;
          }
          throw lastError;
        }

        try {
          const candidate = parseStage11Output(parsedJson);
          validateInvocations(candidate.set, enabledNames);
          const normalized = normalizePositiveContainsForFactsTools(
            candidate,
            manifests,
          );
          if (normalized.changedFixtureIds.length > 0) {
            ctx.log({
              event: "stage11:fixtures-normalized",
              reason: "facts-tool-contains-cleared",
              fixtures: normalized.changedFixtureIds,
            });
          }

          if (opts.preflightGeneratedSet === true) {
            const preflightPlan = buildPreflightBenchmarkSet(
              normalized.output.set,
              manifests,
            );
            if (preflightPlan.skippedFixtureIds.length > 0) {
              ctx.log({
                event: "stage11:preflight:filtered",
                included: preflightPlan.includedFixtureIds.length,
                skipped: preflightPlan.skippedFixtureIds.length,
                skippedFixtureIds: preflightPlan.skippedFixtureIds,
              });
            }
            if (preflightPlan.set === null) {
              ctx.log({
                event: "stage11:preflight:skipped",
                reason: "no-deterministic-fixtures",
                fixtures: normalized.output.set.positive.length +
                  normalized.output.set.negative.length,
              });
              output = normalized.output;
              lastError = null;
              break;
            }

            ctx.log({
              event: "stage11:preflight:start",
              positives: preflightPlan.set.positive.length,
              negatives: preflightPlan.set.negative.length,
            });
            const report = await preflightBenchmarkSet(
              ctx.almanacDir,
              preflightPlan.set,
              ctx.now(),
            );
            const failed = preflightFailures(report);
            ctx.log({
              event: "stage11:preflight:done",
              total: report.summary.total,
              passed: report.summary.passed,
              failed: report.summary.failed,
              errored: report.summary.errored,
            });
            if (failed.length > 0) {
              lastError = new BenchmarkPreflightValidationError(
                report,
                failed.map((f) => f.fixtureId),
              );
              if (attempt < maxAttempts) {
                const detail = formatPreflightFailures(report, normalized.output.set);
                ctx.log({
                  event: "stage11:llm:retry",
                  callName,
                  attempt,
                  reason: "preflight-failed",
                  message: detail,
                });
                messages.push(
                  { role: "assistant", content: completion.text },
                  {
                    role: "user",
                    content: buildRetryFeedback({
                      reason: "preflight-failed",
                      detail,
                    }),
                  },
                );
                continue;
              }

              const stabilized = stabilizeFromPreflight(
                normalized.output,
                report,
              );
              if (stabilized.blockedReason !== undefined) {
                ctx.log({
                  event: "stage11:preflight:stabilization-skipped",
                  reason: stabilized.blockedReason,
                  failedFixtureIds: failed.map((f) => f.fixtureId),
                });
              }
              if (stabilized.droppedFixtureIds.length > 0) {
                ctx.log({
                  event: "stage11:preflight:stabilized",
                  dropped: stabilized.droppedFixtureIds,
                  positives: stabilized.output.set.positive.length,
                  negatives: stabilized.output.set.negative.length,
                });
                const stabilizedPlan = buildPreflightBenchmarkSet(
                  stabilized.output.set,
                  manifests,
                );
                if (stabilizedPlan.set === null) {
                  output = stabilized.output;
                  lastError = null;
                  break;
                }
                const stabilizedReport = await preflightBenchmarkSet(
                  ctx.almanacDir,
                  stabilizedPlan.set,
                  ctx.now(),
                );
                const stabilizedFailed = preflightFailures(stabilizedReport);
                if (stabilizedFailed.length === 0) {
                  output = stabilized.output;
                  lastError = null;
                  break;
                }
                lastError = new BenchmarkPreflightValidationError(
                  stabilizedReport,
                  stabilizedFailed.map((f) => f.fixtureId),
                );
              }
              throw lastError;
            }
            if (preflightPlan.skippedFixtureIds.length > 0) {
              const stabilized = stabilizeFromSkippedPreflightFixtures(
                normalized.output,
                preflightPlan.skippedFixtureIds,
              );
              if (stabilized.blockedReason !== undefined) {
                const coverageError = new BenchmarkPreflightCoverageError(
                  preflightPlan.skippedFixtureIds,
                  stabilized.blockedReason,
                );
                lastError = coverageError;
                const detail = formatPreflightCoverageError(coverageError);
                ctx.log({
                  event: "stage11:preflight:stabilization-skipped",
                  reason: stabilized.blockedReason,
                  skippedFixtureIds: preflightPlan.skippedFixtureIds,
                });
                if (attempt < maxAttempts) {
                  ctx.log({
                    event: "stage11:llm:retry",
                    callName,
                    attempt,
                    reason: "preflight-failed",
                    message: detail,
                  });
                  messages.push(
                    { role: "assistant", content: completion.text },
                    {
                      role: "user",
                      content: buildRetryFeedback({
                        reason: "preflight-failed",
                        detail,
                      }),
                    },
                  );
                  continue;
                }
                throw coverageError;
              }
              if (stabilized.droppedFixtureIds.length > 0) {
                ctx.log({
                  event: "stage11:preflight:stabilized",
                  dropped: stabilized.droppedFixtureIds,
                  reason: "unverified-fixtures",
                  positives: stabilized.output.set.positive.length,
                  negatives: stabilized.output.set.negative.length,
                });
                output = stabilized.output;
                lastError = null;
                break;
              }
            }
          }

          output = normalized.output;
          lastError = null;
          break;
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          if (
            e instanceof InvalidFixtureInvocationError ||
            e instanceof BenchmarkPreflightValidationError ||
            e instanceof BenchmarkPreflightCoverageError
          ) {
            lastError = e;
          } else {
            lastError = new LlmSchemaValidationError(
              `Stage 11: LLM output does not match Stage11Output schema: ${detail}`,
              completion.text,
              parsedJson,
              e,
            );
          }
          if (attempt < maxAttempts) {
            ctx.log({
              event: "stage11:llm:retry",
              callName,
              attempt,
              reason:
                e instanceof BenchmarkPreflightValidationError ||
                e instanceof BenchmarkPreflightCoverageError
                  ? "preflight-failed"
                  : e instanceof InvalidFixtureInvocationError
                  ? "invalid-invocation"
                  : "schema-validation",
              message: detail,
            });
            messages.push(
              { role: "assistant", content: completion.text },
              {
                role: "user",
                content: buildRetryFeedback({
                  reason:
                    e instanceof BenchmarkPreflightValidationError ||
                    e instanceof BenchmarkPreflightCoverageError
                      ? "preflight-failed"
                      : e instanceof InvalidFixtureInvocationError
                      ? "invalid-invocation"
                      : "schema-validation",
                  detail,
                  enabledTools:
                    e instanceof InvalidFixtureInvocationError
                      ? [...enabledNames]
                      : undefined,
                }),
              },
            );
            continue;
          }
          throw lastError;
        }
      }

      if (output === null) {
        throw lastError ?? new Error("Stage 11: exhausted attempts with no result");
      }

      // Persist artifacts.
      const canonicalText = JSON.stringify(output, null, 2);
      const outPath = stage11OutputPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const posPath = positiveJsonlPath(ctx.almanacDir);
      const negPath = negativeJsonlPath(ctx.almanacDir);
      await mkdir(dirname(posPath), { recursive: true });
      const posJsonl =
        output.set.positive.map((f) => JSON.stringify(f)).join("\n") + "\n";
      const negJsonl =
        output.set.negative.map((f) => JSON.stringify(f)).join("\n") + "\n";
      await writeFile(posPath, posJsonl, "utf8");
      await writeFile(negPath, negJsonl, "utf8");

      const outputHash = sha256Hex(canonicalText);
      const llmCalls = (messages.length - 2) / 2 + 1;
      ctx.log({
        event: "stage11:llm:done",
        callName,
        outputHash,
        positives: output.set.positive.length,
        negatives: output.set.negative.length,
        durationMs: lastDurationMs,
        llmCalls,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      });

      return {
        kind: "success",
        outputHash,
        llmCalls,
        cost: {
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
          },
          usd: 0,
        },
      };
    },
  };
}

function buildRetryFeedback(args: {
  reason:
    | "json-parse"
    | "schema-validation"
    | "invalid-invocation"
    | "preflight-failed";
  detail: string;
  enabledTools?: readonly string[];
}): string {
  const header =
    args.reason === "json-parse"
      ? "Your previous response could not be parsed as JSON."
      : args.reason === "schema-validation"
        ? "Your previous response was valid JSON but did not match the required schema."
        : args.reason === "invalid-invocation"
          ? "Your previous response referenced a tool name that is not in the enabled tool set."
          : "Your previous response matched the schema but failed runtime benchmark preflight.";
  const lines = [
    header,
    "",
    "Validation error:",
    args.detail,
  ];
  if (args.enabledTools) {
    lines.push("", `Enabled tools: [${args.enabledTools.join(", ")}]`);
  }
  lines.push(
    "",
    args.reason === "preflight-failed"
      ? "Please re-emit a corrected benchmark set. Remove or replace every fixture that failed or was skipped by preflight; prefer deterministic facts-backed tools for benchmark fixtures."
      : "Please re-emit the SAME conceptual response, corrected to satisfy the schema and all invariants described in the original instructions.",
    "Return ONLY the JSON object — no prose, no code fences, no explanation.",
  );
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Default readers
// ──────────────────────────────────────────────────────────────────────────────

async function defaultReadDomainSpec(
  almanacDir: string,
): Promise<DomainSpec> {
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

/**
 * Read every `tools/<name>.{json,ts}` under `almanacDir` and return the
 * manifests of those that are not `disabled`. We use the full tool-loader
 * (rather than just reading JSON) because the loader is the runtime's own
 * source-of-truth for "what is dispatchable" — keeping these in lockstep
 * prevents Stage 11 from authoring fixtures Stage 12 cannot execute.
 */
async function defaultReadEnabledManifests(
  almanacDir: string,
): Promise<ToolManifest[]> {
  const names = await discoverToolNames(almanacDir);
  const enabled: ToolManifest[] = [];
  for (const n of names) {
    const t = await loadTool(almanacDir, n);
    if (!t.manifest.disabled) enabled.push(t.manifest);
  }
  return enabled;
}

async function defaultPreflightBenchmarkSet(
  almanacDir: string,
  set: BenchmarkSet,
  ranAt: Date,
): Promise<BenchmarkReport> {
  const runtime = await createAlmanacRuntimeAsync({ almanacDir });
  try {
    return await runBenchmark({
      almanacId: set.almanacId,
      set,
      runtime,
      ranAt,
    });
  } finally {
    const close = (runtime as unknown as { close?: () => void }).close;
    if (typeof close === "function") {
      close.call(runtime);
    }
  }
}

/**
 * Read `extracted/facts.jsonl` and return an evenly-spaced sample of size
 * `size`. Empty / missing file → empty array (Stage 11 still runs; the
 * prompt instructs the LLM to fall back to vocabulary from
 * `DomainSpec.entityTypes` when the sample is empty).
 *
 * Sampling: walk every `Math.floor(total / size)` rows. This gives the
 * LLM a view across the whole corpus rather than the first source only
 * (Stage 5 emits facts in source-then-chunk order, so the first 20 lines
 * typically cover one or two sources).
 */
export async function defaultReadFactSample(
  almanacDir: string,
  size: number,
): Promise<FactSampleEntry[]> {
  if (size <= 0) return [];
  let body: string;
  try {
    body = await readFile(factsJsonlPath(almanacDir), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const facts: FactRecord[] = [];
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const r = FactRecordSchema.safeParse(parsed);
    if (r.success) facts.push(r.data);
  }
  if (facts.length === 0) return [];

  const step = facts.length / Math.min(size, facts.length);
  const out: FactSampleEntry[] = [];
  for (let i = 0; i < size && i * step < facts.length; i++) {
    const fact = facts[Math.floor(i * step)];
    if (fact === undefined) continue;
    out.push({
      text: fact.text,
      type: fact.type,
      entities: fact.entities,
      sourceId: fact.source.sourceId,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const COMPARISON_TEXT_RE =
  /\b(compare|comparison|contrast|versus|vs\.?|trade-?offs?|differences?|between)\b/i;

const COMPARISON_FIELD_PAIRS: Array<readonly [string, string]> = [
  ["a", "b"],
  ["left", "right"],
  ["first", "second"],
  ["from", "to"],
  ["source", "target"],
  ["old", "new"],
  ["before", "after"],
  ["baseline", "candidate"],
  ["optiona", "optionb"],
];

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function inputSchemaPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!isRecord(properties)) return [];
  return Object.keys(properties);
}

function comparisonPairFields(fields: readonly string[]): string[] {
  const byNormalized = new Map(
    fields.map((field) => [normalizeFieldName(field), field] as const),
  );
  for (const [left, right] of COMPARISON_FIELD_PAIRS) {
    const leftField = byNormalized.get(left);
    const rightField = byNormalized.get(right);
    if (leftField !== undefined && rightField !== undefined) {
      return [leftField, rightField];
    }
  }

  for (const [normalized, original] of byNormalized) {
    if (normalized.length <= 1 || !normalized.endsWith("a")) continue;
    const counterpart = byNormalized.get(`${normalized.slice(0, -1)}b`);
    if (counterpart !== undefined) return [original, counterpart];
  }

  return [];
}

function mentionsComparisonShape(manifest: ToolManifest): boolean {
  const text = `${manifest.name} ${manifest.description} ${manifest.whenToUse}`;
  return COMPARISON_TEXT_RE.test(text);
}

function isFactsQueryFallbackTool(manifest: ToolManifest): boolean {
  if (!manifest.knowledgeUsage.facts) return false;
  if (manifest.name === "query_facts") return true;
  const fields = new Set(inputSchemaPropertyNames(manifest.inputSchema));
  return fields.has("q") || fields.has("query");
}

function normalizeFieldName(field: string): string {
  return field.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}

// Re-export for tests that want a single import path.
export type { Stage11Output };
