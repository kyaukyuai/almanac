/**
 * Bounded answer-session tool planning.
 *
 * This is the v0.7 orchestration boundary before synthesis exists. It asks an
 * LLM for one tool call at a time, validates the selected compiled tool/input,
 * and executes only through `AlmanacRuntime.execTool`.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { loadPromptTemplate } from "../compile/prompt-loader.ts";
import { readManifest } from "../compile/storage.ts";
import {
  createAlmanacRuntime,
  ToolNotFoundError,
  type AlmanacRuntime,
  type AlmanacRuntimeOptions,
  type ToolLogger,
} from "../core/runtime.ts";
import {
  CitationSchema,
  ToolNameSchema,
  type AnswerArtifactStatus,
  type AnswerToolCallSummary,
  type Citation,
  type JsonSchemaObject,
  type ToolError,
  type ToolManifest,
  type ToolResult,
  type ToolResultFreshness,
} from "../core/types.ts";
import {
  completeJson,
  LlmJsonParseError,
  LlmSchemaValidationError,
  type LlmProvider,
  type LlmUsage,
} from "../llm/provider.ts";

export const ANSWER_PLANNER_PROMPT_STAGE_ID = "answer-planner";
export const ANSWER_PLANNER_PROMPT_VERSION = "planner-v1";
export const ANSWER_SYNTHESIS_PROMPT_STAGE_ID = "answer-synthesis";
export const ANSWER_SYNTHESIS_PROMPT_VERSION = "synthesis-v1";
export const ANSWER_PLANNER_DEFAULT_MODEL = "claude-sonnet-4-5";
export const DEFAULT_MAX_TOOL_CALLS = 4;
export const DEFAULT_MAX_DURATION_MS = 120_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGE_PROMPTS_DIR = join(HERE, "prompts");

const PlannerDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("call_tool"),
    toolName: ToolNameSchema,
    input: z.unknown().optional(),
  }),
  z.object({
    action: z.literal("stop"),
    reason: z.string().min(1).max(500),
  }),
]);
type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;

const SynthesisDraftSchema = z
  .object({
    status: z.enum(["ok", "abstained"]),
    answer: z.string().min(1).max(12000).optional(),
    abstentionReason: z.string().min(1).max(2000).optional(),
    citations: z.array(CitationSchema).max(20).optional(),
  })
  .superRefine((draft, ctx) => {
    if (draft.status === "abstained" && draft.abstentionReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abstentionReason"],
        message: "abstentionReason is required when status is abstained",
      });
    }
  });
type SynthesisDraftRaw = z.infer<typeof SynthesisDraftSchema>;
interface SynthesisDraft extends Omit<SynthesisDraftRaw, "citations"> {
  citations: Citation[];
}

export type AnswerPlanningStatus =
  | "ok"
  | "budget-exhausted"
  | "model-error";

export type AnswerPlanningStopReason =
  | "planner-stop"
  | "max-tool-calls"
  | "max-duration"
  | "model-error";

export interface AnswerToolCallObservation extends AnswerToolCallSummary {
  callIndex: number;
  result?: ToolResult;
  citations?: Citation[];
  freshness?: ToolResultFreshness;
}

export interface RunAnswerToolPlanningSessionOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  question: string;
  provider: LlmProvider;
  model?: string;
  maxToolCalls?: number;
  maxDurationMs?: number;
  /** Runtime override for focused tests. Omitted uses createAlmanacRuntime. */
  runtime?: AlmanacRuntime;
  resolveSecret?: AlmanacRuntimeOptions["resolveSecret"];
  fetchImpl?: AlmanacRuntimeOptions["fetchImpl"];
  log?: ToolLogger;
  now?: () => number;
}

export interface AnswerToolPlanningSession {
  almanacId: string;
  version: string;
  question: string;
  status: AnswerPlanningStatus;
  stopReason: AnswerPlanningStopReason;
  toolCalls: AnswerToolCallObservation[];
  plannerCalls: number;
  model: string;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  error?: ToolError;
}

export interface RunAnswerSessionOptions
  extends RunAnswerToolPlanningSessionOptions {
  synthesisModel?: string;
}

export interface AnswerSession {
  almanacId: string;
  version: string;
  question: string;
  status: AnswerArtifactStatus;
  answer?: string;
  abstentionReason?: string;
  citations: Citation[];
  freshness?: ToolResultFreshness;
  toolCalls: AnswerToolCallObservation[];
  plannerCalls: number;
  synthesisCalls: number;
  model: string;
  promptVersions: {
    planner: typeof ANSWER_PLANNER_PROMPT_VERSION;
    synthesis: typeof ANSWER_SYNTHESIS_PROMPT_VERSION;
  };
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  error?: ToolError;
}

export class AnswerSessionSetupError extends Error {
  constructor(
    public readonly code: "bad-almanac-dir" | "almanac-not-found",
    message: string,
  ) {
    super(message);
    this.name = "AnswerSessionSetupError";
  }
}

export async function runAnswerSession(
  options: RunAnswerSessionOptions,
): Promise<AnswerSession> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const planning = await runAnswerToolPlanningSession(options);
  const synthesisModel = options.synthesisModel ?? options.model ??
    ANSWER_PLANNER_DEFAULT_MODEL;

  if (planning.status === "model-error") {
    return answerSessionFromPlanning({
      planning,
      status: "model-error",
      synthesisCalls: 0,
      durationMs: elapsedMs(now, startedAt),
      error: planning.error ?? {
        code: "model-error",
        message: "planner failed before synthesis",
        retryable: false,
      },
    });
  }
  if (planning.status === "budget-exhausted") {
    return answerSessionFromPlanning({
      planning,
      status: "budget-exhausted",
      synthesisCalls: 0,
      durationMs: elapsedMs(now, startedAt),
      error: {
        code: "budget-exhausted",
        message: `answer planning stopped due to ${planning.stopReason}`,
        retryable: false,
      },
    });
  }

  const observed = collectObservedCitationEvidence(planning.toolCalls);
  if (observed.size === 0) {
    return answerSessionFromPlanning({
      planning,
      status: "abstained",
      synthesisCalls: 0,
      durationMs: elapsedMs(now, startedAt),
      abstentionReason: abstentionReasonForNoEvidence(planning.toolCalls),
    });
  }

  let draft: SynthesisDraft;
  let synthesisUsage: LlmUsage;
  try {
    const synthesized = await synthesizeAnswer({
      provider: options.provider,
      model: synthesisModel,
      planning,
      observed,
    });
    draft = synthesized.draft;
    synthesisUsage = synthesized.completionUsage;
  } catch (cause) {
    return answerSessionFromPlanning({
      planning,
      status: "model-error",
      synthesisCalls: 1,
      durationMs: elapsedMs(now, startedAt),
      usage: planning.usage,
      error: modelError(cause),
    });
  }

  const usage = addUsage(planning.usage, synthesisUsage);
  const gated = gateSynthesisDraft(draft, observed);
  return answerSessionFromPlanning({
    planning,
    status: gated.status,
    synthesisCalls: 1,
    durationMs: elapsedMs(now, startedAt),
    usage,
    answer: gated.answer,
    abstentionReason: gated.abstentionReason,
    citations: gated.citations,
    freshness: gated.freshness,
  });
}

export async function runAnswerToolPlanningSession(
  options: RunAnswerToolPlanningSessionOptions,
): Promise<AnswerToolPlanningSession> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const model = options.model ?? ANSWER_PLANNER_DEFAULT_MODEL;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const manifest = await readAnswerSessionManifest(options.almanacDir);
  const runtime =
    options.runtime ??
    await createAlmanacRuntime({
      almanacDir: options.almanacDir,
      resolveSecret: options.resolveSecret,
      fetchImpl: options.fetchImpl,
      log: options.log,
    });
  const ownsRuntime = options.runtime === undefined;
  const tools = await runtime.listTools();
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolCalls: AnswerToolCallObservation[] = [];
  let plannerCalls = 0;
  let usage = emptyUsage();

  try {
    while (toolCalls.length < maxToolCalls) {
      if (elapsedMs(now, startedAt) >= maxDurationMs) {
        return sessionResult({
          manifest,
          question: options.question,
          status: "budget-exhausted",
          stopReason: "max-duration",
          toolCalls,
          plannerCalls,
          model,
          startedAt,
          now,
          usage,
        });
      }

      let decision: PlannerDecision;
      plannerCalls += 1;
      try {
        const planned = await planNextToolCall({
          provider: options.provider,
          model,
          manifest,
          question: options.question,
          tools,
          observations: toolCalls,
        });
        decision = planned.decision;
        usage = addUsage(usage, planned.completionUsage);
      } catch (cause) {
        if (toolCalls.length > 0 && isPlannerJsonModeError(cause)) {
          return sessionResult({
            manifest,
            question: options.question,
            status: "ok",
            stopReason: "planner-stop",
            toolCalls,
            plannerCalls,
            model,
            startedAt,
            now,
            usage,
          });
        }
        return sessionResult({
          manifest,
          question: options.question,
          status: "model-error",
          stopReason: "model-error",
          toolCalls,
          plannerCalls,
          model,
          startedAt,
          now,
          usage,
          error: modelError(cause),
        });
      }

      if (decision.action === "stop") {
        return sessionResult({
          manifest,
          question: options.question,
          status: "ok",
          stopReason: "planner-stop",
          toolCalls,
          plannerCalls,
          model,
          startedAt,
          now,
          usage,
        });
      }

      if (elapsedMs(now, startedAt) >= maxDurationMs) {
        return sessionResult({
          manifest,
          question: options.question,
          status: "budget-exhausted",
          stopReason: "max-duration",
          toolCalls,
          plannerCalls,
          model,
          startedAt,
          now,
          usage,
        });
      }

      const observation = await executePlannedToolCall({
        runtime,
        toolsByName,
        decision,
        callIndex: toolCalls.length,
        now,
      });
      toolCalls.push(observation);
    }

    return sessionResult({
      manifest,
      question: options.question,
      status: "budget-exhausted",
      stopReason: "max-tool-calls",
      toolCalls,
      plannerCalls,
      model,
      startedAt,
      now,
      usage,
    });
  } finally {
    if (ownsRuntime) {
      closeRuntime(runtime);
    }
  }
}

async function synthesizeAnswer(input: {
  provider: LlmProvider;
  model: string;
  planning: AnswerToolPlanningSession;
  observed: Map<string, ObservedCitationEvidence>;
}): Promise<{ draft: SynthesisDraft; completionUsage: LlmUsage }> {
  const prompt = loadPromptTemplate({
    promptsDir: MANAGE_PROMPTS_DIR,
    stageId: ANSWER_SYNTHESIS_PROMPT_STAGE_ID,
    version: ANSWER_SYNTHESIS_PROMPT_VERSION,
    vars: {
      almanac: JSON.stringify({
        almanacId: input.planning.almanacId,
        version: input.planning.version,
      }, null, 2),
      question: input.planning.question,
      observations: JSON.stringify(
        input.planning.toolCalls.map(renderObservationForSynthesis),
        null,
        2,
      ),
      allowedCitations: JSON.stringify(
        Array.from(input.observed.values()).map((evidence) => evidence.citation),
        null,
        2,
      ),
    },
  });
  const completed = await completeJson({
    provider: input.provider,
    schema: SynthesisDraftSchema,
    request: {
      model: input.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      maxTokens: 3000,
      temperature: 0,
      callName: `${ANSWER_SYNTHESIS_PROMPT_STAGE_ID}@${ANSWER_SYNTHESIS_PROMPT_VERSION}`,
    },
  });
  return {
    draft: normalizeSynthesisDraft(completed.result),
    completionUsage: completed.completion.usage,
  };
}

async function planNextToolCall(input: {
  provider: LlmProvider;
  model: string;
  manifest: { almanacId: string; version: string; domain: string };
  question: string;
  tools: ToolManifest[];
  observations: AnswerToolCallObservation[];
}): Promise<{ decision: PlannerDecision; completionUsage: LlmUsage }> {
  const prompt = loadPromptTemplate({
    promptsDir: MANAGE_PROMPTS_DIR,
    stageId: ANSWER_PLANNER_PROMPT_STAGE_ID,
    version: ANSWER_PLANNER_PROMPT_VERSION,
    vars: {
      almanac: JSON.stringify({
        almanacId: input.manifest.almanacId,
        version: input.manifest.version,
        domain: input.manifest.domain,
      }, null, 2),
      question: input.question,
      tools: JSON.stringify(input.tools.map(renderToolForPlanner), null, 2),
      observations: JSON.stringify(
        input.observations.map(renderObservationForPlanner),
        null,
        2,
      ),
    },
  });
  const completed = await completeJson({
    provider: input.provider,
    schema: PlannerDecisionSchema,
    request: {
      model: input.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      maxTokens: 1000,
      temperature: 0,
      callName: `${ANSWER_PLANNER_PROMPT_STAGE_ID}@${ANSWER_PLANNER_PROMPT_VERSION}`,
    },
  });
  return {
    decision: completed.result,
    completionUsage: completed.completion.usage,
  };
}

async function executePlannedToolCall(input: {
  runtime: AlmanacRuntime;
  toolsByName: Map<string, ToolManifest>;
  decision: PlannerDecision & { action: "call_tool"; toolName: string };
  callIndex: number;
  now: () => number;
}): Promise<AnswerToolCallObservation> {
  const startedAt = input.now();
  const tool = input.toolsByName.get(input.decision.toolName);
  if (tool === undefined) {
    return {
      callIndex: input.callIndex,
      toolName: input.decision.toolName,
      input: normalizeObservationInput(input.decision.input),
      status: "tool-not-found",
      durationMs: elapsedMs(input.now, startedAt),
      citationsCount: 0,
      error: {
        code: "tool-not-found",
        message: `tool not found or disabled: "${input.decision.toolName}"`,
        retryable: false,
      },
    };
  }

  const normalizedInput = normalizeToolInput(input.decision.input);
  if (normalizedInput === null) {
    return badToolInputObservation({
      callIndex: input.callIndex,
      toolName: input.decision.toolName,
      rawInput: input.decision.input,
      durationMs: elapsedMs(input.now, startedAt),
      message: "tool input must be a JSON object",
    });
  }

  const schemaValidation = validateJsonSchemaInput(
    normalizedInput,
    tool.inputSchema,
  );
  if (!schemaValidation.ok) {
    return badToolInputObservation({
      callIndex: input.callIndex,
      toolName: input.decision.toolName,
      rawInput: normalizedInput,
      durationMs: elapsedMs(input.now, startedAt),
      message: schemaValidation.message,
    });
  }

  try {
    const result = await input.runtime.execTool(tool.name, normalizedInput);
    if (result.ok) {
      return {
        callIndex: input.callIndex,
        toolName: tool.name,
        input: normalizedInput,
        status: "ok",
        durationMs: elapsedMs(input.now, startedAt),
        citationsCount: result.citations.length,
        citations: result.citations,
        freshness: result.freshness,
        result,
      };
    }
    return {
      callIndex: input.callIndex,
      toolName: tool.name,
      input: normalizedInput,
      status:
        result.error.code === "bad-input"
          ? "bad-tool-input"
          : "tool-error",
      durationMs: elapsedMs(input.now, startedAt),
      citationsCount: 0,
      error: result.error,
      result,
    };
  } catch (cause) {
    if (cause instanceof ToolNotFoundError) {
      return {
        callIndex: input.callIndex,
        toolName: tool.name,
        input: normalizedInput,
        status: "tool-not-found",
        durationMs: elapsedMs(input.now, startedAt),
        citationsCount: 0,
        error: {
          code: "tool-not-found",
          message: cause.message,
          retryable: false,
        },
      };
    }
    return {
      callIndex: input.callIndex,
      toolName: tool.name,
      input: normalizedInput,
      status: "tool-error",
      durationMs: elapsedMs(input.now, startedAt),
      citationsCount: 0,
      error: {
        code: "tool-threw",
        message: errorMessage(cause).slice(0, 2000),
        retryable: false,
      },
    };
  }
}

function validateJsonSchemaInput(
  input: Record<string, unknown>,
  schema: JsonSchemaObject,
): { ok: true } | { ok: false; message: string } {
  const type = schemaType(schema);
  if (type !== undefined && type !== "object") {
    return { ok: false, message: "tool input schema must be type object" };
  }

  const required = stringArray(schema.required);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      return { ok: false, message: `missing required input field: ${key}` };
    }
  }

  const properties = objectRecord(schema.properties);
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const expected = schemaType(propertySchema);
    if (expected === undefined) continue;
    if (!jsonValueMatchesType(input[key], expected)) {
      return {
        ok: false,
        message: `input.${key} must be ${expected}`,
      };
    }
  }

  return { ok: true };
}

function badToolInputObservation(input: {
  callIndex: number;
  toolName: string;
  rawInput: unknown;
  durationMs: number;
  message: string;
}): AnswerToolCallObservation {
  return {
    callIndex: input.callIndex,
    toolName: input.toolName,
    input: normalizeObservationInput(input.rawInput),
    status: "bad-tool-input",
    durationMs: input.durationMs,
    citationsCount: 0,
    error: {
      code: "bad-tool-input",
      message: input.message,
      retryable: false,
    },
  };
}

function sessionResult(input: {
  manifest: { almanacId: string; version: string };
  question: string;
  status: AnswerPlanningStatus;
  stopReason: AnswerPlanningStopReason;
  toolCalls: AnswerToolCallObservation[];
  plannerCalls: number;
  model: string;
  startedAt: number;
  now: () => number;
  usage: AnswerToolPlanningSession["usage"];
  error?: ToolError;
}): AnswerToolPlanningSession {
  return {
    almanacId: input.manifest.almanacId,
    version: input.manifest.version,
    question: input.question,
    status: input.status,
    stopReason: input.stopReason,
    toolCalls: input.toolCalls,
    plannerCalls: input.plannerCalls,
    model: input.model,
    durationMs: elapsedMs(input.now, input.startedAt),
    usage: input.usage,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

async function readAnswerSessionManifest(almanacDir: string) {
  if (!isAbsolute(almanacDir)) {
    throw new AnswerSessionSetupError(
      "bad-almanac-dir",
      `almanacDir must be absolute: ${almanacDir}`,
    );
  }
  if (!existsSync(almanacDir)) {
    throw new AnswerSessionSetupError(
      "almanac-not-found",
      `almanac directory does not exist: ${almanacDir}`,
    );
  }
  return readManifest(almanacDir);
}

function renderToolForPlanner(tool: ToolManifest) {
  return {
    name: tool.name,
    description: tool.description,
    whenToUse: tool.whenToUse,
    returnsSummary: tool.returnsSummary,
    inputSchema: tool.inputSchema,
    volatilityClass: tool.volatilityClass,
  };
}

function renderObservationForPlanner(observation: AnswerToolCallObservation) {
  return {
    callIndex: observation.callIndex,
    toolName: observation.toolName,
    input: observation.input,
    status: observation.status,
    citationsCount: observation.citationsCount,
    error: observation.error,
  };
}

function renderObservationForSynthesis(observation: AnswerToolCallObservation) {
  return {
    callIndex: observation.callIndex,
    toolName: observation.toolName,
    input: observation.input,
    status: observation.status,
    citationsCount: observation.citationsCount,
    citations: observation.citations ?? [],
    freshness: observation.freshness,
    data: observation.result?.ok ? observation.result.data : undefined,
    error: observation.error,
  };
}

interface ObservedCitationEvidence {
  citation: Citation;
  freshness?: ToolResultFreshness;
}

function collectObservedCitationEvidence(
  observations: AnswerToolCallObservation[],
): Map<string, ObservedCitationEvidence> {
  const observed = new Map<string, ObservedCitationEvidence>();
  for (const observation of observations) {
    if (observation.status !== "ok") continue;
    for (const citation of observation.citations ?? []) {
      observed.set(citationKey(citation), {
        citation,
        ...(observation.freshness === undefined
          ? {}
          : { freshness: observation.freshness }),
      });
    }
  }
  return observed;
}

function gateSynthesisDraft(
  draft: SynthesisDraft,
  observed: Map<string, ObservedCitationEvidence>,
): {
  status: "ok" | "abstained";
  answer?: string;
  abstentionReason?: string;
  citations: Citation[];
  freshness?: ToolResultFreshness;
} {
  if (draft.status === "abstained") {
    return {
      status: "abstained",
      abstentionReason: draft.abstentionReason ?? "model-abstained",
      citations: [],
    };
  }
  if (draft.answer === undefined) {
    return {
      status: "abstained",
      abstentionReason: "missing-answer",
      citations: [],
    };
  }
  if (draft.citations.length === 0) {
    return {
      status: "abstained",
      abstentionReason: "no-citations",
      citations: [],
    };
  }

  const citations: Citation[] = [];
  const freshnesses: ToolResultFreshness[] = [];
  for (const citation of draft.citations) {
    const evidence = observed.get(citationKey(citation));
    if (evidence === undefined) {
      return {
        status: "abstained",
        abstentionReason: "unobserved-citation",
        citations: [],
      };
    }
    citations.push(evidence.citation);
    if (evidence.freshness !== undefined) {
      freshnesses.push(evidence.freshness);
    }
  }

  return {
    status: "ok",
    answer: draft.answer,
    citations: dedupeCitations(citations),
    ...(freshnesses.length === 0 ? {} : { freshness: worstFreshness(freshnesses) }),
  };
}

function normalizeSynthesisDraft(draft: SynthesisDraftRaw): SynthesisDraft {
  return {
    ...draft,
    citations: draft.citations ?? [],
  };
}

function answerSessionFromPlanning(input: {
  planning: AnswerToolPlanningSession;
  status: AnswerArtifactStatus;
  synthesisCalls: number;
  durationMs?: number;
  usage?: AnswerSession["usage"];
  answer?: string;
  abstentionReason?: string;
  citations?: Citation[];
  freshness?: ToolResultFreshness;
  error?: ToolError;
}): AnswerSession {
  return {
    almanacId: input.planning.almanacId,
    version: input.planning.version,
    question: input.planning.question,
    status: input.status,
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    ...(input.abstentionReason === undefined
      ? {}
      : { abstentionReason: input.abstentionReason }),
    citations: input.citations ?? [],
    ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
    toolCalls: input.planning.toolCalls,
    plannerCalls: input.planning.plannerCalls,
    synthesisCalls: input.synthesisCalls,
    model: input.planning.model,
    promptVersions: {
      planner: ANSWER_PLANNER_PROMPT_VERSION,
      synthesis: ANSWER_SYNTHESIS_PROMPT_VERSION,
    },
    durationMs: input.durationMs ?? input.planning.durationMs,
    usage: input.usage ?? input.planning.usage,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

function abstentionReasonForNoEvidence(
  observations: AnswerToolCallObservation[],
): string {
  if (observations.length > 0 && observations.every((o) => o.status !== "ok")) {
    return "tool-errors-only";
  }
  return "no-citations";
}

function citationKey(citation: Citation): string {
  return `${citation.sourceId}\n${citation.url}`;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of citations) {
    const key = citationKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

function worstFreshness(
  freshnesses: ToolResultFreshness[],
): ToolResultFreshness {
  return [...freshnesses].sort(compareFreshnessWorstFirst)[0]!;
}

function compareFreshnessWorstFirst(
  a: ToolResultFreshness,
  b: ToolResultFreshness,
): number {
  const byStaleness = stalenessRank(b.staleness) - stalenessRank(a.staleness);
  if (byStaleness !== 0) return byStaleness;
  return volatilityRank(b.class) - volatilityRank(a.class);
}

function stalenessRank(staleness: ToolResultFreshness["staleness"]): number {
  if (staleness === "stale") return 3;
  if (staleness === "warm") return 2;
  return 1;
}

function volatilityRank(klass: ToolResultFreshness["class"]): number {
  if (klass === "live") return 4;
  if (klass === "fast") return 3;
  if (klass === "slow") return 2;
  return 1;
}

function normalizeToolInput(input: unknown): Record<string, unknown> | null {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function normalizeObservationInput(input: unknown): Record<string, unknown> | null {
  return normalizeToolInput(input);
}

function schemaType(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  const value = (schema as { type?: unknown }).type;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string");
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function jsonValueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function addUsage(
  a: AnswerToolPlanningSession["usage"],
  b: LlmUsage,
): AnswerToolPlanningSession["usage"] {
  const inputTokens = a.inputTokens + b.inputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function emptyUsage(): AnswerToolPlanningSession["usage"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function modelError(cause: unknown): ToolError {
  return {
    code: "model-error",
    message: plannerErrorMessage(cause).slice(0, 2000),
    retryable: false,
  };
}

function plannerErrorMessage(cause: unknown): string {
  if (
    cause instanceof LlmJsonParseError ||
    cause instanceof LlmSchemaValidationError
  ) {
    return cause.message;
  }
  return errorMessage(cause);
}

function isPlannerJsonModeError(
  cause: unknown,
): cause is LlmJsonParseError | LlmSchemaValidationError {
  return (
    cause instanceof LlmJsonParseError ||
    cause instanceof LlmSchemaValidationError
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function elapsedMs(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

function closeRuntime(runtime: unknown): void {
  const candidate = runtime as { close?: unknown };
  if (typeof candidate.close === "function") {
    candidate.close();
  }
}
