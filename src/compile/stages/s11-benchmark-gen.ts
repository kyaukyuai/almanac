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

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE11_PROMPT_VERSION = "v2";
export const STAGE11_PROMPT_STAGE_ID = "11-benchmark-gen";

/** Matches `recommendedModel` in `prompts/11-benchmark-gen/v2.md`. */
export const STAGE11_DEFAULT_MODEL = "claude-sonnet-4-5";
export const STAGE11_DEFAULT_MAX_TOKENS = 6144;
export const STAGE11_DEFAULT_TEMPERATURE = 0.2;
/** 1 initial + 1 retry-on-error. Mirrors Stage 6. */
export const STAGE11_DEFAULT_MAX_ATTEMPTS = 2;

/** Default size of the fact sample shown to the Stage 11 LLM. */
export const STAGE11_DEFAULT_FACT_SAMPLE_SIZE = 20;

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
   * Defaults to `STAGE11_DEFAULT_FACT_SAMPLE_SIZE` (20). Sample of facts
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

      // Reduce manifest size: the prompt only needs the routing-relevant fields.
      const promptManifests = manifests.map((m) => ({
        name: m.name,
        description: m.description,
        whenToUse: m.whenToUse,
        inputSchema: m.inputSchema,
        volatilityClass: m.volatilityClass,
      }));

      const prompt = loadPromptTemplate({
        stageId: STAGE11_PROMPT_STAGE_ID,
        version: STAGE11_PROMPT_VERSION,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          domainSpec: JSON.stringify(domainSpec),
          toolManifests: JSON.stringify(promptManifests),
          factSample: JSON.stringify(factSample),
        },
      });

      const callName = `${STAGE11_PROMPT_STAGE_ID}@${STAGE11_PROMPT_VERSION}`;
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
          output = candidate;
          lastError = null;
          break;
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          if (e instanceof InvalidFixtureInvocationError) {
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
                e instanceof InvalidFixtureInvocationError
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
                    e instanceof InvalidFixtureInvocationError
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
  reason: "json-parse" | "schema-validation" | "invalid-invocation";
  detail: string;
  enabledTools?: readonly string[];
}): string {
  const header =
    args.reason === "json-parse"
      ? "Your previous response could not be parsed as JSON."
      : args.reason === "schema-validation"
        ? "Your previous response was valid JSON but did not match the required schema."
        : "Your previous response referenced a tool name that is not in the enabled tool set.";
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
    "Please re-emit the SAME conceptual response, corrected to satisfy the schema and all invariants described in the original instructions.",
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

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}

// Re-export for tests that want a single import path.
export type { Stage11Output };
