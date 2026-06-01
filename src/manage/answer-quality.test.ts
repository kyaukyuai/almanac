import { describe, expect, test } from "bun:test";

import { evaluateAnswerQualityGate } from "./answer-quality.ts";

describe("answer quality gate", () => {
  test("passes cited ok answers", () => {
    const result = evaluateAnswerQualityGate({
      expectedStatus: "ok",
      observedStatus: "ok",
      citationsCount: 2,
      staleCitationCount: 0,
      minCitations: 1,
    });

    expect(result.status).toBe("pass");
    expect(result.citationRate).toBe(1);
    expect(result.unsupportedClaimCount).toBe(0);
  });

  test("fails ok answers with unsupported claims", () => {
    const result = evaluateAnswerQualityGate({
      expectedStatus: "ok",
      observedStatus: "ok",
      citationsCount: 1,
      staleCitationCount: 0,
      unsupportedClaims: ["SQLite encrypts all pages by default."],
    });

    expect(result.status).toBe("fail");
    expect(result.unsupportedClaimCount).toBe(1);
    expect(result.reasons).toContain(
      "expected at most 0 unsupported claims, observed 1",
    );
  });

  test("fails stale citations by default", () => {
    const result = evaluateAnswerQualityGate({
      expectedStatus: "ok",
      observedStatus: "ok",
      citationsCount: 1,
      staleCitationCount: 1,
    });

    expect(result.status).toBe("fail");
    expect(result.reasons).toContain(
      "expected at most 0 stale citations, observed 1",
    );
  });

  test("fails abstention reason mismatches", () => {
    const result = evaluateAnswerQualityGate({
      expectedStatus: "abstained",
      observedStatus: "abstained",
      citationsCount: 0,
      staleCitationCount: 0,
      expectedAbstentionReason: "no-citations",
      observedAbstentionReason: "tool-errors-only",
    });

    expect(result.status).toBe("fail");
    expect(result.abstention.matches).toBe(false);
    expect(result.reasons).toContain(
      "expected abstention no-citations, observed tool-errors-only",
    );
  });
});
