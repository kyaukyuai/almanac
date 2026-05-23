/**
 * Stage 1 — domain analysis.
 *
 * Calls the LLM with `prompts/01-domain-analysis/v1.md`, parses the response
 * into a `DomainSpec`, and persists it to
 * `<almanacDir>/.compile/domain-spec.json`.
 *
 * The runner is exposed as a factory so the CLI can pick the provider
 * (Anthropic vs MockProvider) at startup and pass the same instance to every
 * LLM-driven stage.
 *
 * On `InsufficientDomainError` the runner re-throws — the orchestrator
 * marks the stage `failed` and (with `stopOnError`) halts the pipeline.
 *
 * Output artifacts:
 *   - `.compile/domain-spec.json`  — pretty-printed `DomainSpec`
 *
 * The `outputHash` returned to the orchestrator is the sha256 of the
 * canonicalized `DomainSpec` JSON (not the file body, so trailing-whitespace
 * drift does not perturb the hash).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  InsufficientDomainError,
  parseDomainSpec,
  type DomainSpec,
} from "../../core/types.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
  type LlmProvider,
} from "../../llm/provider.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { loadPromptTemplate } from "../prompt-loader.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE1_PROMPT_VERSION = "v2";
export const STAGE1_PROMPT_STAGE_ID = "01-domain-analysis";

/**
 * The model id passed to the provider. The Anthropic SDK accepts dated and
 * dateless aliases; we use the dateless alias so the choice survives Sonnet
 * point-releases. Override via `createDomainAnalysisRunner({ model })` in
 * tests or for cost tuning.
 */
export const STAGE1_DEFAULT_MODEL = "claude-sonnet-4-5";

/** Matches the `maxTokens` declared in `prompts/01-domain-analysis/v1.md`. */
export const STAGE1_DEFAULT_MAX_TOKENS = 4096;

/** Matches the `temperature` declared in `prompts/01-domain-analysis/v1.md`. */
export const STAGE1_DEFAULT_TEMPERATURE = 0.2;

/** On-disk location of the persisted DomainSpec, relative to almanacDir. */
export const DOMAIN_SPEC_REL_PATH = ".compile/domain-spec.json";

export function domainSpecPath(almanacDir: string): string {
  return join(almanacDir, DOMAIN_SPEC_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateDomainAnalysisRunnerOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE1_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE1_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE1_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;
}

/**
 * Build the Stage 1 `StageRunner`. The returned runner advertises
 * `promptVersion = "v1"` so the orchestrator records it on the `StageEntry`.
 */
export function createDomainAnalysisRunner(
  opts: CreateDomainAnalysisRunnerOptions,
): StageRunner {
  const model = opts.model ?? STAGE1_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE1_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE1_DEFAULT_TEMPERATURE;

  return {
    promptVersion: STAGE1_PROMPT_VERSION,
    async run(ctx) {
      const depth = ctx.state.options.depth;
      const sourcesHint = ctx.state.options.sourcesHint;
      const scopeHint = ctx.state.options.scopeHint ?? "";

      const prompt = loadPromptTemplate({
        stageId: STAGE1_PROMPT_STAGE_ID,
        version: STAGE1_PROMPT_VERSION,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          domain: ctx.manifest.domain,
          depth,
          sourcesHint: renderSourcesHint(sourcesHint),
          scopeHint: scopeHint.length > 0 ? scopeHint : "(none provided)",
        },
      });

      const callName = `${STAGE1_PROMPT_STAGE_ID}@${STAGE1_PROMPT_VERSION}`;
      ctx.log({
        event: "stage1:llm:start",
        callName,
        model,
        domain: ctx.manifest.domain,
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
          `Stage 1: LLM output is not valid JSON: ${(cause as Error).message}`,
          completion.text,
          cause,
        );
      }

      // Detect the INSUFFICIENT_DOMAIN sentinel BEFORE schema validation so we
      // surface the model's own diagnosis instead of a noisy zod failure.
      let domainSpec: DomainSpec;
      try {
        domainSpec = parseDomainSpec(parsedJson);
      } catch (e) {
        if (e instanceof InsufficientDomainError) throw e;
        // Any non-Insufficient parse failure is a schema mismatch.
        throw new LlmSchemaValidationError(
          `Stage 1: LLM output does not match DomainSpec schema: ${
            e instanceof Error ? e.message : String(e)
          }`,
          completion.text,
          parsedJson,
          e,
        );
      }

      // Re-canonicalize so the on-disk JSON and the hash agree on key order
      // and defaulted fields (e.g., maxAgeDays / maxAgeHours from zod).
      const canonical = DomainSpecSchema.parse(domainSpec);
      const canonicalText = JSON.stringify(canonical, null, 2);

      const outPath = domainSpecPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);

      ctx.log({
        event: "stage1:llm:done",
        callName,
        outputHash,
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
          // Concrete USD pricing depends on the provider; leave at 0 here
          // and let cost accounting plug in via a separate accounting layer.
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
 * Render the `sourcesHint` array as a readable YAML-ish list for inlining
 * inside the prompt's user-message YAML block.
 *   []          → "[]"
 *   ["a","b"]   → '["a", "b"]'
 *
 * Using a JSON-ish flow representation keeps the user message a single line
 * per field (matches the prompt's existing `key: {{value}}` shape).
 */
export function renderSourcesHint(hints: readonly string[]): string {
  if (hints.length === 0) return "[]";
  return JSON.stringify(hints);
}

/**
 * Strip a single leading/trailing markdown code fence. Mirrors the helper
 * in `provider.completeJson` but kept private here because Stage 1 needs to
 * intercept the parsed JSON before zod runs (so we can detect the
 * `INSUFFICIENT_DOMAIN:` sentinel).
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}
