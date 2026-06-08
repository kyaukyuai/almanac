import type {
  AnswerTrace,
  AnswerTraceAbstainRecovery,
  AnswerTraceAbstainRecoveryActionHint,
} from "../core/types.ts";

type AbstainStage = NonNullable<AnswerTrace["abstain"]>["stage"];

export function buildAbstentionRecovery(input: {
  reason?: string;
  stage?: AbstainStage;
  toolCallsCount?: number;
  observedCitationsCount?: number;
}): AnswerTraceAbstainRecovery {
  const reason = input.reason ?? "unknown-abstention";
  const stage = input.stage ?? "evidence";
  const toolCallsCount = input.toolCallsCount ?? 0;
  const observedCitationsCount = input.observedCitationsCount ?? 0;
  const nextSteps = nextStepsForAbstention({
    reason,
    stage,
    observedCitationsCount,
  });
  const actionHints = actionHintsForAbstention({
    reason,
    toolCallsCount,
    observedCitationsCount,
  });
  return {
    summary: recoverySummaryForAbstention({
      reason,
      stage,
      observedCitationsCount,
    }),
    nextSteps,
    actionHints,
  };
}

function recoverySummaryForAbstention(input: {
  reason: string;
  stage: AbstainStage;
  observedCitationsCount: number;
}): string {
  if (input.reason === "tool-errors-only") {
    return "All attempted tools failed, so the answer was correctly abstained before unsupported prose could be returned.";
  }
  if (input.reason === "unobserved-citation") {
    return "The answer cited evidence that was not returned by tools, so the citation gate correctly rejected it.";
  }
  if (input.reason === "missing-answer") {
    return "Synthesis did not return answer text, so the run needs inspection or another saved answer attempt.";
  }
  if (input.reason === "model-abstained") {
    return "The model explicitly abstained; keep that result only if the almanac should not answer this question yet.";
  }
  if (input.reason === "no-citations" && input.observedCitationsCount > 0) {
    return "Tool evidence existed, but synthesis produced no usable citations; retry after inspecting the trace.";
  }
  if (input.reason === "no-citations") {
    return "No cited evidence was available for the question, so the abstention is valid until trusted sources are added.";
  }
  return `The answer abstained at the ${input.stage} stage with reason ${input.reason}; inspect before promotion.`;
}

function nextStepsForAbstention(input: {
  reason: string;
  stage: AbstainStage;
  observedCitationsCount: number;
}): string[] {
  const steps = ["Inspect the saved answer trace before changing fixtures."];
  if (input.reason === "tool-errors-only") {
    steps.push("Fix tool/runtime errors or run doctor before asking again.");
  } else if (
    input.reason === "no-citations" &&
    input.observedCitationsCount === 0
  ) {
    steps.push(
      "Add or refresh trusted sources if this question should be answerable.",
    );
  } else if (input.reason === "unobserved-citation") {
    steps.push("Retry with grounded citations instead of accepting fabricated sources.");
  } else if (input.reason === "missing-answer") {
    steps.push("Retry the question after inspecting synthesis and tool traces.");
  } else {
    steps.push("Ask again after improving evidence or narrowing the question.");
  }
  steps.push(
    "If the abstention is expected, promote it into answer checks and replay it without provider calls.",
  );
  steps.push("Do not fabricate or force an unsupported answer.");
  return steps;
}

function actionHintsForAbstention(input: {
  reason: string;
  toolCallsCount: number;
  observedCitationsCount: number;
}): AnswerTraceAbstainRecoveryActionHint[] {
  const hints: AnswerTraceAbstainRecoveryActionHint[] = [
    "inspect-answer-run",
    "replay-saved-run",
  ];
  if (input.reason === "tool-errors-only") {
    hints.push("run-doctor");
  }
  if (
    input.reason === "no-citations" &&
    input.observedCitationsCount === 0
  ) {
    hints.push("add-trusted-source");
  }
  hints.push("ask-new-question");
  if (input.toolCallsCount > 0) {
    hints.push("promote-abstention-check", "run-answer-checks");
  }
  return uniqueHints(hints);
}

function uniqueHints(
  hints: AnswerTraceAbstainRecoveryActionHint[],
): AnswerTraceAbstainRecoveryActionHint[] {
  const seen = new Set<AnswerTraceAbstainRecoveryActionHint>();
  return hints.filter((hint) => {
    if (seen.has(hint)) return false;
    seen.add(hint);
    return true;
  });
}
