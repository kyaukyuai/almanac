import { describe, expect, test } from "bun:test";

import {
  deriveProviderReadiness,
  formatProviderReadinessLines,
  summarizeProviderReadiness,
} from "./provider-readiness.ts";

function capability(report: ReturnType<typeof deriveProviderReadiness>, id: string) {
  const found = report.capabilities.find((item) => item.id === id);
  if (found === undefined) throw new Error(`capability not found: ${id}`);
  return found;
}

describe("provider readiness", () => {
  test("absent environment locks core capabilities with unlock env names", () => {
    const report = deriveProviderReadiness({});

    expect(report.llm).toEqual({ presence: "absent", detectedEnv: [] });
    expect(report.webSearch).toEqual({ configured: false, detectedEnv: [] });
    expect(report.embeddings.status).toBe("disabled");
    expect(capability(report, "compile")).toEqual(
      expect.objectContaining({
        status: "locked",
        optional: false,
        unlockEnv: ["ANTHROPIC_API_KEY"],
      }),
    );
    expect(capability(report, "answer").status).toBe("locked");
    expect(capability(report, "judge")).toEqual(
      expect.objectContaining({ status: "locked", optional: true }),
    );
    expect(capability(report, "web-discovery").unlockEnv).toEqual([
      "BRAVE_SEARCH_API_KEY",
    ]);
    expect(capability(report, "vector-retrieval").status).toBe("locked");
    expect(summarizeProviderReadiness(report)).toContain(
      "compile and answer locked (set ANTHROPIC_API_KEY)",
    );
  });

  test("anthropic key unlocks compile, answer, and judge", () => {
    const report = deriveProviderReadiness({
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    expect(report.llm).toEqual({
      presence: "anthropic",
      detectedEnv: ["ANTHROPIC_API_KEY"],
    });
    expect(capability(report, "compile").status).toBe("unlocked");
    expect(capability(report, "compile").unlockEnv).toEqual([]);
    expect(capability(report, "answer").status).toBe("unlocked");
    expect(capability(report, "judge").status).toBe("unlocked");
    expect(summarizeProviderReadiness(report)).toContain(
      "compile and answer unlocked",
    );
  });

  test("mock provider wins over a real key and reports mock-only core", () => {
    const report = deriveProviderReadiness({
      ALMANAC_LLM: "mock",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    expect(report.llm).toEqual({ presence: "mock", detectedEnv: ["ALMANAC_LLM"] });
    expect(capability(report, "compile").status).toBe("mock-only");
    expect(capability(report, "answer").status).toBe("mock-only");
    expect(capability(report, "judge").status).toBe("unlocked");
    expect(summarizeProviderReadiness(report)).toContain(
      "compile and answer mock-only",
    );
  });

  test("partial environment unlocks only the matching optional capabilities", () => {
    const report = deriveProviderReadiness({
      BRAVE_SEARCH_API_KEY: "brave-test",
      VOYAGE_API_KEY: "voyage-test",
    });

    expect(report.llm.presence).toBe("absent");
    expect(report.webSearch).toEqual({
      configured: true,
      detectedEnv: ["BRAVE_SEARCH_API_KEY"],
    });
    expect(report.embeddings).toEqual(
      expect.objectContaining({ status: "configured", provider: "voyage" }),
    );
    expect(capability(report, "compile").status).toBe("locked");
    expect(capability(report, "web-discovery").status).toBe("unlocked");
    expect(capability(report, "vector-retrieval").status).toBe("unlocked");
  });

  test("missing credentials for a requested embeddings provider name the env var", () => {
    const report = deriveProviderReadiness({ ALMANAC_EMBEDDINGS: "openai" });

    expect(report.embeddings.status).toBe("missing-credentials");
    expect(capability(report, "vector-retrieval")).toEqual(
      expect.objectContaining({
        status: "locked",
        unlockEnv: ["OPENAI_API_KEY"],
      }),
    );
  });

  test("report and rendered lines never contain credential values", () => {
    const secrets = {
      ANTHROPIC_API_KEY: "sk-ant-super-secret-0123456789",
      BRAVE_SEARCH_API_KEY: "brave-super-secret-0123456789",
      VOYAGE_API_KEY: "voyage-super-secret-0123456789",
    };
    const report = deriveProviderReadiness(secrets);
    const serialized =
      JSON.stringify(report) +
      summarizeProviderReadiness(report) +
      formatProviderReadinessLines(report).join("\n");

    for (const value of Object.values(secrets)) {
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(value.slice(-12));
    }
  });
});
