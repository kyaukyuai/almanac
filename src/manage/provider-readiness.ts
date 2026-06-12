/**
 * Provider readiness reporting for doctor, status, and Studio.
 *
 * Derives, from the current process environment, which provider credentials
 * are present and which operations they unlock. The report carries env var
 * NAMES only — never values or fragments — so it is safe to serialize into
 * JSON output, Studio responses, and saved artifacts.
 *
 * Readiness is derived per call and never persisted. Starting the process
 * with credentials in the environment is the only way a capability unlocks;
 * there is no credential input or storage anywhere downstream.
 */

import {
  resolveEmbeddingProviderConfig,
  type EmbeddingProviderConfig,
} from "../embeddings/config.ts";
import { formatEmbeddingReadiness } from "./retrieval-readiness.ts";

export type ProviderReadinessEnv = Record<string, string | undefined>;

export type LlmProviderPresence = "anthropic" | "mock" | "absent";

export type ProviderCapabilityId =
  | "compile"
  | "answer"
  | "judge"
  | "web-discovery"
  | "vector-retrieval";

export type ProviderCapabilityStatus = "unlocked" | "mock-only" | "locked";

export interface ProviderCapabilityReadiness {
  id: ProviderCapabilityId;
  label: string;
  status: ProviderCapabilityStatus;
  /** Optional capabilities improve results but never block the core flow. */
  optional: boolean;
  detail: string;
  /** Env var names that would unlock the capability. Empty when unlocked. */
  unlockEnv: string[];
}

export interface ProviderReadinessReport {
  schemaVersion: "0.1.0";
  llm: {
    presence: LlmProviderPresence;
    /** Names of the env vars that produced this presence. Never values. */
    detectedEnv: string[];
  };
  webSearch: {
    configured: boolean;
    detectedEnv: string[];
  };
  embeddings: {
    status: EmbeddingProviderConfig["status"];
    provider: string | null;
    detail: string;
  };
  capabilities: ProviderCapabilityReadiness[];
}

function hasValue(env: ProviderReadinessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.length > 0;
}

/**
 * Mirror of the CLI's provider selection: `ALMANAC_LLM=mock` wins over a
 * real key so smoke tests stay deterministic; otherwise `ANTHROPIC_API_KEY`
 * selects the real provider.
 */
function llmPresence(env: ProviderReadinessEnv): ProviderReadinessReport["llm"] {
  if (env["ALMANAC_LLM"] === "mock") {
    return { presence: "mock", detectedEnv: ["ALMANAC_LLM"] };
  }
  if (hasValue(env, "ANTHROPIC_API_KEY")) {
    return { presence: "anthropic", detectedEnv: ["ANTHROPIC_API_KEY"] };
  }
  return { presence: "absent", detectedEnv: [] };
}

export function deriveProviderReadiness(
  env: ProviderReadinessEnv = process.env,
): ProviderReadinessReport {
  const llm = llmPresence(env);
  const webSearchConfigured = hasValue(env, "BRAVE_SEARCH_API_KEY");
  const embeddingConfig = resolveEmbeddingProviderConfig(env);

  const llmStatus: ProviderCapabilityStatus =
    llm.presence === "anthropic"
      ? "unlocked"
      : llm.presence === "mock"
        ? "mock-only"
        : "locked";
  const llmDetail =
    llm.presence === "anthropic"
      ? "ANTHROPIC_API_KEY is set"
      : llm.presence === "mock"
        ? "ALMANAC_LLM=mock uses the in-process mock provider; no tokens are spent"
        : "set ANTHROPIC_API_KEY to unlock";
  const llmUnlockEnv = llm.presence === "anthropic" ? [] : ["ANTHROPIC_API_KEY"];

  const capabilities: ProviderCapabilityReadiness[] = [
    {
      id: "compile",
      label: "provider-backed compile",
      status: llmStatus,
      optional: false,
      detail: llmDetail,
      unlockEnv: llmUnlockEnv,
    },
    {
      id: "answer",
      label: "real answer generation (ask)",
      status: llmStatus,
      optional: false,
      detail: llmDetail,
      unlockEnv: llmUnlockEnv,
    },
    {
      id: "judge",
      label: "answer entailment judging",
      status: llm.presence === "absent" ? "locked" : "unlocked",
      optional: true,
      detail:
        llm.presence === "absent"
          ? "optional; needs ANTHROPIC_API_KEY or ALMANAC_LLM=mock when running --judge"
          : llm.presence === "mock"
            ? "ALMANAC_LLM=mock provides the explicit --judge provider"
            : "ANTHROPIC_API_KEY provides the explicit --judge provider",
      unlockEnv: llm.presence === "absent" ? ["ANTHROPIC_API_KEY"] : [],
    },
    {
      id: "web-discovery",
      label: "web source discovery",
      status: webSearchConfigured ? "unlocked" : "locked",
      optional: true,
      detail: webSearchConfigured
        ? "BRAVE_SEARCH_API_KEY is set"
        : "optional; set BRAVE_SEARCH_API_KEY to improve source discovery",
      unlockEnv: webSearchConfigured ? [] : ["BRAVE_SEARCH_API_KEY"],
    },
    vectorRetrievalCapability(embeddingConfig),
  ];

  return {
    schemaVersion: "0.1.0",
    llm,
    webSearch: {
      configured: webSearchConfigured,
      detectedEnv: webSearchConfigured ? ["BRAVE_SEARCH_API_KEY"] : [],
    },
    embeddings: {
      status: embeddingConfig.status,
      provider: embeddingConfig.provider,
      detail: formatEmbeddingReadiness(embeddingConfig),
    },
    capabilities,
  };
}

function vectorRetrievalCapability(
  config: EmbeddingProviderConfig,
): ProviderCapabilityReadiness {
  const detail = formatEmbeddingReadiness(config);
  if (config.status === "configured") {
    return {
      id: "vector-retrieval",
      label: "vector retrieval artifacts",
      status: "unlocked",
      optional: true,
      detail,
      unlockEnv: [],
    };
  }
  const unlockEnv =
    config.status === "missing-credentials"
      ? [config.requiredEnv]
      : config.status === "disabled" && config.reason === "not-configured"
        ? ["VOYAGE_API_KEY", "ALMANAC_EMBEDDINGS"]
        : ["ALMANAC_EMBEDDINGS"];
  return {
    id: "vector-retrieval",
    label: "vector retrieval artifacts",
    status: "locked",
    optional: true,
    detail,
    unlockEnv,
  };
}

/** One-line summary for status output and the Studio header. */
export function summarizeProviderReadiness(
  report: ProviderReadinessReport,
): string {
  const core = report.capabilities.filter((capability) => !capability.optional);
  const coreLabel = "compile and answer";
  const coreState =
    report.llm.presence === "anthropic"
      ? `${coreLabel} unlocked`
      : report.llm.presence === "mock"
        ? `${coreLabel} mock-only`
        : `${coreLabel} locked (set ${core[0]?.unlockEnv[0] ?? "ANTHROPIC_API_KEY"})`;
  return (
    `llm ${report.llm.presence}, ` +
    `web search ${report.webSearch.configured ? "set" : "unset"}, ` +
    `embeddings ${report.embeddings.provider ?? report.embeddings.status}; ` +
    coreState
  );
}

/** Multi-line rendering shared by doctor's human output. */
export function formatProviderReadinessLines(
  report: ProviderReadinessReport,
): string[] {
  const lines = [
    `  llm              ${report.llm.presence}${
      report.llm.detectedEnv.length > 0
        ? ` (${report.llm.detectedEnv.join(", ")})`
        : ""
    }`,
    `  web search       ${report.webSearch.configured ? "set" : "unset"}`,
    `  embeddings       ${report.embeddings.detail}`,
  ];
  for (const capability of report.capabilities) {
    lines.push(
      `  ${capability.status.padEnd(10)} ${capability.id.padEnd(18)} ${capability.detail}`,
    );
  }
  return lines;
}
