import type {
  AnswerArtifactStatus,
  AnswerTraceQuality,
} from "../core/types.ts";

export interface EvaluateAnswerQualityGateOptions {
  expectedStatus: AnswerArtifactStatus;
  observedStatus: AnswerArtifactStatus;
  citationsCount: number;
  staleCitationCount: number;
  expectedAbstentionReason?: string;
  observedAbstentionReason?: string;
  minCitations?: number;
  maxStaleCitations?: number;
  unsupportedClaims?: string[];
  maxUnsupportedClaims?: number;
}

export type AnswerQualityGateResult = AnswerTraceQuality;

export function evaluateAnswerQualityGate(
  options: EvaluateAnswerQualityGateOptions,
): AnswerQualityGateResult {
  const minCitations =
    options.minCitations ?? (options.expectedStatus === "ok" ? 1 : 0);
  const maxStaleCitations = options.maxStaleCitations ?? 0;
  const unsupportedClaimCount = options.unsupportedClaims?.length ?? 0;
  const maxUnsupportedClaims = options.maxUnsupportedClaims ?? 0;
  const reasons: string[] = [];

  if (options.observedStatus !== options.expectedStatus) {
    reasons.push(
      `expected status ${options.expectedStatus}, observed ${options.observedStatus}`,
    );
  }
  if (options.citationsCount < minCitations) {
    reasons.push(
      `expected at least ${minCitations} citations, observed ${options.citationsCount}`,
    );
  }
  if (options.staleCitationCount > maxStaleCitations) {
    reasons.push(
      `expected at most ${maxStaleCitations} stale citations, observed ${options.staleCitationCount}`,
    );
  }
  if (unsupportedClaimCount > maxUnsupportedClaims) {
    reasons.push(
      `expected at most ${maxUnsupportedClaims} unsupported claims, observed ${unsupportedClaimCount}`,
    );
  }

  const abstentionExpected = options.expectedStatus === "abstained";
  const abstentionActual = options.observedStatus === "abstained";
  const reasonMatches =
    options.expectedAbstentionReason === undefined ||
    options.observedAbstentionReason === options.expectedAbstentionReason;
  const abstentionMatches =
    abstentionExpected === abstentionActual &&
    (!abstentionExpected || reasonMatches);
  if (
    options.expectedAbstentionReason !== undefined &&
    options.observedAbstentionReason !== options.expectedAbstentionReason
  ) {
    reasons.push(
      `expected abstention ${options.expectedAbstentionReason}, observed ${options.observedAbstentionReason ?? "(none)"}`,
    );
  }

  return {
    status: reasons.length === 0 ? "pass" : "fail",
    citationRate: citationRate(options.citationsCount, minCitations),
    unsupportedClaimCount,
    staleCitationCount: options.staleCitationCount,
    reasons,
    abstention: {
      expected: abstentionExpected,
      actual: abstentionActual,
      matches: abstentionMatches,
      ...(options.expectedAbstentionReason === undefined
        ? {}
        : { expectedReason: options.expectedAbstentionReason }),
      ...(options.observedAbstentionReason === undefined
        ? {}
        : { actualReason: options.observedAbstentionReason }),
    },
  };
}

function citationRate(citationsCount: number, minCitations: number): number {
  if (minCitations <= 0) return 1;
  return Math.min(1, citationsCount / minCitations);
}
