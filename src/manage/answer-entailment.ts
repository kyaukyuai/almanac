import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { loadPromptTemplate } from "../compile/prompt-loader.ts";
import type { Citation } from "../core/types.ts";
import {
  completeJson,
  type LlmProvider,
  type LlmUsage,
} from "../llm/provider.ts";

export const ANSWER_ENTAILMENT_PROMPT_STAGE_ID = "answer-entailment";
export const ANSWER_ENTAILMENT_PROMPT_VERSION = "judge-v1";
export const ANSWER_ENTAILMENT_DEFAULT_MODEL = "claude-sonnet-4-5";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGE_PROMPTS_DIR = join(HERE, "prompts");

const EntailmentClaimSchema = z.object({
  claim: z.string().trim().min(1).max(1000),
  status: z.enum(["supported", "unsupported", "uncertain"]),
  citationIndexes: z.array(z.number().int().nonnegative()).max(20).optional(),
  reason: z.string().trim().min(1).max(1000),
});

const EntailmentJudgeDraftSchema = z.object({
  verdict: z.enum(["supported", "unsupported", "mixed", "uncertain"]),
  summary: z.string().trim().min(1).max(1000),
  claims: z.array(EntailmentClaimSchema).min(1).max(20),
});

type EntailmentJudgeDraft = z.infer<typeof EntailmentJudgeDraftSchema>;

export interface EvaluateAnswerEntailmentOptions {
  question: string;
  answer?: string;
  citations: Citation[];
  provider: LlmProvider;
  model?: string;
}

export interface AnswerEntailmentClaim {
  claim: string;
  status: "supported" | "unsupported" | "uncertain";
  citationIndexes: number[];
  reason: string;
}

export interface AnswerEntailmentResult {
  status: "pass" | "fail" | "warning";
  verdict: "supported" | "unsupported" | "mixed" | "uncertain";
  claimsChecked: number;
  unsupportedClaims: string[];
  uncertainClaims: string[];
  claims: AnswerEntailmentClaim[];
  reasons: string[];
  promptVersion: typeof ANSWER_ENTAILMENT_PROMPT_VERSION;
  provider: string;
  model: string;
  durationMs: number;
  usage?: LlmUsage & { totalTokens: number };
}

export async function evaluateAnswerEntailment(
  options: EvaluateAnswerEntailmentOptions,
): Promise<AnswerEntailmentResult> {
  const model = options.model ?? ANSWER_ENTAILMENT_DEFAULT_MODEL;
  const answer = options.answer?.trim();
  if (answer === undefined || answer.length === 0) {
    return skippedEntailment({
      reason: "entailment judge skipped: no answer text available",
      provider: options.provider.id,
      model,
    });
  }
  if (options.citations.length === 0) {
    return skippedEntailment({
      reason: "entailment judge skipped: no citations available",
      provider: options.provider.id,
      model,
    });
  }

  const prompt = loadPromptTemplate({
    stageId: ANSWER_ENTAILMENT_PROMPT_STAGE_ID,
    version: ANSWER_ENTAILMENT_PROMPT_VERSION,
    promptsDir: MANAGE_PROMPTS_DIR,
    vars: {
      question: options.question,
      answer,
      citations: JSON.stringify(renderCitations(options.citations), null, 2),
    },
  });
  const completion = await completeJson({
    provider: options.provider,
    schema: EntailmentJudgeDraftSchema,
    request: {
      model,
      maxTokens: 2000,
      temperature: 0,
      callName: `${ANSWER_ENTAILMENT_PROMPT_STAGE_ID}@${ANSWER_ENTAILMENT_PROMPT_VERSION}`,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    },
  });
  return resultFromDraft({
    draft: completion.result,
    provider: options.provider.id,
    model: completion.completion.model,
    durationMs: completion.completion.durationMs,
    usage: completion.completion.usage,
  });
}

function resultFromDraft(input: {
  draft: EntailmentJudgeDraft;
  provider: string;
  model: string;
  durationMs: number;
  usage: LlmUsage;
}): AnswerEntailmentResult {
  const claims = input.draft.claims.map((claim) => ({
    claim: claim.claim,
    status: claim.status,
    citationIndexes: claim.citationIndexes ?? [],
    reason: claim.reason,
  }));
  const unsupportedClaims = claims
    .filter((claim) => claim.status === "unsupported")
    .map((claim) => claim.claim);
  const uncertainClaims = claims
    .filter((claim) => claim.status === "uncertain")
    .map((claim) => claim.claim);
  const reasons = [
    input.draft.summary,
    ...claims
      .filter((claim) => claim.status !== "supported")
      .map((claim) => `${claim.status}: ${claim.claim} - ${claim.reason}`),
  ];
  return {
    status:
      unsupportedClaims.length > 0 || input.draft.verdict === "unsupported" ||
      input.draft.verdict === "mixed"
        ? "fail"
        : uncertainClaims.length > 0 || input.draft.verdict === "uncertain"
          ? "warning"
          : "pass",
    verdict: input.draft.verdict,
    claimsChecked: claims.length,
    unsupportedClaims,
    uncertainClaims,
    claims,
    reasons,
    promptVersion: ANSWER_ENTAILMENT_PROMPT_VERSION,
    provider: input.provider,
    model: input.model,
    durationMs: input.durationMs,
    usage: {
      ...input.usage,
      totalTokens: input.usage.inputTokens + input.usage.outputTokens,
    },
  };
}

function skippedEntailment(input: {
  reason: string;
  provider: string;
  model: string;
}): AnswerEntailmentResult {
  return {
    status: "warning",
    verdict: "uncertain",
    claimsChecked: 0,
    unsupportedClaims: [],
    uncertainClaims: [],
    claims: [],
    reasons: [input.reason],
    promptVersion: ANSWER_ENTAILMENT_PROMPT_VERSION,
    provider: input.provider,
    model: input.model,
    durationMs: 0,
  };
}

function renderCitations(citations: Citation[]) {
  return citations.map((citation, index) => ({
    index,
    sourceId: citation.sourceId,
    url: citation.url,
    fetchedAt: citation.fetchedAt,
    ...(citation.sourceTimestamp === undefined
      ? {}
      : { sourceTimestamp: citation.sourceTimestamp }),
    excerpt: citation.excerpt ?? "(no excerpt provided)",
  }));
}
