/**
 * Stage 6 — tool design.
 *
 *   1. Reads the Stage 1 `DomainSpec`         (`.compile/domain-spec.json`)
 *   2. Reads the Stage 3 approved `SourcesFile` (`sources/sources.json`)
 *   3. Reads the Stage 5 fact corpus            (`extracted/facts.jsonl`)
 *      and computes a coverage summary that the prompt expects:
 *      `{ factsExtracted, byFreshnessClass: { static, slow } }`.
 *   4. Asks the LLM to design 0–3 *domain-specific* tools, returning a
 *      `ToolDesignResult`. The four default tools are NOT designed here —
 *      `synthesizeDefaultToolManifest` (Stage 7) covers them.
 *
 * Persists the validated `ToolDesignResult` to `.compile/tool-design.json`.
 * Stage 7 reads from there to drive its tsc + bun-test loop.
 *
 * `outputHash` = sha256 of the canonical `ToolDesignResult` JSON.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  FactRecordSchema,
  SourcesFileSchema,
  ToolDesignSourceValidationError,
  parseToolDesignResultWithSources,
  type DomainSpec,
  type SourcesFile,
  type ToolDesignResult,
} from "../../core/types.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
  type LlmProvider,
} from "../../llm/provider.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { loadPromptTemplate } from "../prompt-loader.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { approvedSourcesPath } from "./s03-approve-runner.ts";
import { factsJsonlPath } from "./s05-fact-extraction.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE6_PROMPT_VERSION = "v2";
export const STAGE6_PROMPT_STAGE_ID = "06-tool-design";

/** Matches `recommendedModel` in `prompts/06-tool-design/v1.md`. */
export const STAGE6_DEFAULT_MODEL = "claude-sonnet-4-5";
export const STAGE6_DEFAULT_MAX_TOKENS = 4096;
export const STAGE6_DEFAULT_TEMPERATURE = 0.2;
/**
 * Default attempt budget for the LLM call. 1 initial + 1 retry-on-error;
 * second attempt feeds the prior bad output + validation error back into the
 * conversation and asks the model to emit corrected JSON. Set to `1` to
 * disable retry (legacy behavior).
 */
export const STAGE6_DEFAULT_MAX_ATTEMPTS = 2;

export const TOOL_DESIGN_REL_PATH = ".compile/tool-design.json";

export function toolDesignPath(almanacDir: string): string {
  return join(almanacDir, TOOL_DESIGN_REL_PATH);
}

export interface FactCoverage {
  factsExtracted: number;
  byFreshnessClass: { static: number; slow: number };
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingDomainSpecError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 6 requires the Stage 1 DomainSpec at ${path}; ` +
        "run Stage 1 first or restore the file",
    );
    this.name = "MissingDomainSpecError";
  }
}

export class MissingApprovedSourcesError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 6 requires the Stage 3 approved SourcesFile at ${path}; ` +
        "run Stage 3 first or restore the file",
    );
    this.name = "MissingApprovedSourcesError";
  }
}

export class MissingFactsError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 6 requires the Stage 5 facts.jsonl at ${path}; ` +
        "run Stage 5 first or restore the file",
    );
    this.name = "MissingFactsError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateToolDesignRunnerOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE6_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE6_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE6_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Defaults to `STAGE6_DEFAULT_MAX_ATTEMPTS` (1 initial + 1 retry). */
  maxAttempts?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;

  /** Test seam: read Stage 1 output. */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
  /** Test seam: read Stage 3 output. */
  readApproved?: (almanacDir: string) => Promise<SourcesFile>;
  /** Test seam: compute fact coverage from Stage 5 output. */
  readFactCoverage?: (almanacDir: string) => Promise<FactCoverage>;
}

/**
 * Build the Stage 6 `StageRunner`. Records `promptVersion = "v1"`.
 */
export function createToolDesignRunner(
  opts: CreateToolDesignRunnerOptions,
): StageRunner {
  const model = opts.model ?? STAGE6_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE6_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE6_DEFAULT_TEMPERATURE;
  const maxAttempts = Math.max(
    1,
    opts.maxAttempts ?? STAGE6_DEFAULT_MAX_ATTEMPTS,
  );
  const readDomainSpec = opts.readDomainSpec ?? defaultReadDomainSpec;
  const readApproved = opts.readApproved ?? defaultReadApproved;
  const readFactCoverage =
    opts.readFactCoverage ?? defaultReadFactCoverage;

  return {
    promptVersion: STAGE6_PROMPT_VERSION,
    async run(ctx) {
      const [domainSpec, approved, factCoverage] = await Promise.all([
        readDomainSpec(ctx.almanacDir),
        readApproved(ctx.almanacDir),
        readFactCoverage(ctx.almanacDir),
      ]);

      const prompt = loadPromptTemplate({
        stageId: STAGE6_PROMPT_STAGE_ID,
        version: STAGE6_PROMPT_VERSION,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          domainSpec: JSON.stringify(domainSpec),
          sourcesFile: JSON.stringify(approved),
          factCoverage: JSON.stringify(factCoverage),
        },
      });

      const callName = `${STAGE6_PROMPT_STAGE_ID}@${STAGE6_PROMPT_VERSION}`;
      ctx.log({
        event: "stage6:llm:start",
        callName,
        model,
        factsExtracted: factCoverage.factsExtracted,
        maxAttempts,
      });

      // Conversation grows on retry: we keep the original system + user, then
      // append (assistant=badOutput, user=feedback) pairs for each failed
      // attempt so the model can self-correct.
      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastError: LlmJsonParseError | LlmSchemaValidationError | null = null;
      let design: ToolDesignResult | null = null;
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
            `Stage 6: LLM output is not valid JSON: ${(cause as Error).message}`,
            completion.text,
            cause,
          );
          if (attempt < maxAttempts) {
            ctx.log({
              event: "stage6:llm:retry",
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
          design = parseToolDesignResultWithSources(parsedJson, approved);
          lastError = null;
          break;
        } catch (e) {
          const isSourceValidation =
            e instanceof ToolDesignSourceValidationError;
          const detail = e instanceof Error ? e.message : String(e);
          lastError = new LlmSchemaValidationError(
            `Stage 6: LLM output does not match ToolDesignResult schema: ${detail}`,
            completion.text,
            parsedJson,
            e,
          );
          if (attempt < maxAttempts) {
            ctx.log({
              event: "stage6:llm:retry",
              callName,
              attempt,
              reason: isSourceValidation
                ? "source-mode-validation"
                : "schema-validation",
              message: detail,
            });
            messages.push(
              { role: "assistant", content: completion.text },
              {
                role: "user",
                content: buildRetryFeedback({
                  reason: isSourceValidation
                    ? "source-mode-validation"
                    : "schema-validation",
                  detail,
                }),
              },
            );
            continue;
          }
          throw lastError;
        }
      }

      if (design === null) {
        // Defensive: loop guarantees either `design` set or `lastError` thrown.
        throw lastError ?? new Error("Stage 6: exhausted attempts with no result");
      }

      const canonicalText = JSON.stringify(design, null, 2);
      const outPath = toolDesignPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      const llmCalls = (messages.length - 2) / 2 + 1; // initial + (assistant,user) pairs
      ctx.log({
        event: "stage6:llm:done",
        callName,
        outputHash,
        customTools: design.customTools.length,
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

/**
 * Build the user message that asks the model to fix its previous output.
 * Kept short and explicit so the model focuses on the validation error
 * rather than re-reasoning the entire task.
 */
function buildRetryFeedback(args: {
  reason: "json-parse" | "schema-validation" | "source-mode-validation";
  detail: string;
}): string {
  const header =
    args.reason === "json-parse"
      ? "Your previous response could not be parsed as JSON."
      : args.reason === "source-mode-validation"
      ? "Your previous response was valid JSON and matched the schema, but one or more custom tools violated the source-mode invariants (see Hard invariant #4 in the original instructions)."
      : "Your previous response was valid JSON but did not match the required schema.";
  const lines = [
    header,
    "",
    "Validation error:",
    args.detail,
    "",
  ];
  if (args.reason === "source-mode-validation") {
    lines.push(
      "Remember: a fact-reading tool (knowledgeUsage.facts: true) must list at least one approved source whose ingestion.mode is \"snapshot\". If the relevant source is index-only, redesign the tool as a live-fetch wrapper (volatilityClass: \"fast\", knowledgeUsage.facts: false, sourceDependencies listing that source id), or drop the tool entirely.",
      "",
    );
  }
  lines.push(
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

async function defaultReadApproved(
  almanacDir: string,
): Promise<SourcesFile> {
  const path = approvedSourcesPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingApprovedSourcesError(path, cause);
    }
    throw cause;
  }
  const parsed = SourcesFileSchema.parse(JSON.parse(body));
  if (parsed.status !== "approved") {
    throw new Error(
      `Stage 6: SourcesFile at ${path} has status="${parsed.status}", expected "approved"`,
    );
  }
  return parsed;
}

/**
 * Walk `extracted/facts.jsonl` and count records by `freshnessClass`.
 * Malformed lines are skipped silently — Stage 5 already validated, and a
 * stray blank line shouldn't fail Stage 6.
 */
export async function defaultReadFactCoverage(
  almanacDir: string,
): Promise<FactCoverage> {
  const path = factsJsonlPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingFactsError(path, cause);
    }
    throw cause;
  }
  const coverage: FactCoverage = {
    factsExtracted: 0,
    byFreshnessClass: { static: 0, slow: 0 },
  };
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const r = FactRecordSchema.safeParse(parsed);
    if (!r.success) continue;
    coverage.factsExtracted += 1;
    coverage.byFreshnessClass[r.data.freshnessClass] += 1;
  }
  return coverage;
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
export type { ToolDesignResult };
