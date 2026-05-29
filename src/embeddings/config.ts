/**
 * Environment discovery for future embedding providers.
 *
 * This module does not instantiate network clients. It only reports which
 * provider would be usable so later vector-indexing stages can depend on a
 * stable, testable decision point.
 */

import type { EmbeddingProviderKind } from "./provider.ts";

export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-3-lite";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_DETERMINISTIC_EMBEDDING_MODEL = "deterministic-hash-v1";
export const DEFAULT_DETERMINISTIC_EMBEDDING_DIMENSIONS = 8;
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 384;

export type EmbeddingProviderConfig =
  | {
      status: "disabled";
      reason: "not-configured" | "explicitly-disabled";
      provider: null;
      model: null;
      dimensions: null;
      requiredEnv: null;
    }
  | {
      status: "invalid-config";
      reason: string;
      provider: null;
      model: null;
      dimensions: null;
      requiredEnv: null;
    }
  | {
      status: "missing-credentials";
      provider: "voyage" | "openai";
      model: string;
      dimensions: null;
      requiredEnv: "VOYAGE_API_KEY" | "OPENAI_API_KEY";
    }
  | {
      status: "configured";
      provider: "voyage" | "openai";
      model: string;
      dimensions: null;
      requiredEnv: "VOYAGE_API_KEY" | "OPENAI_API_KEY";
    }
  | {
      status: "configured";
      provider: "local";
      model: string;
      dimensions: number;
      requiredEnv: null;
      packageName: "@xenova/transformers";
    }
  | {
      status: "configured";
      provider: "deterministic";
      model: string;
      dimensions: number;
      requiredEnv: null;
    };

export function resolveEmbeddingProviderConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProviderConfig {
  const requested = normalizeProviderRequest(env["ALMANAC_EMBEDDINGS"]);
  const modelOverride = clean(env["ALMANAC_EMBEDDING_MODEL"]);

  if (
    requested === "off" ||
    requested === "none" ||
    requested === "disabled"
  ) {
    return {
      status: "disabled",
      reason: "explicitly-disabled",
      provider: null,
      model: null,
      dimensions: null,
      requiredEnv: null,
    };
  }

  if (requested === undefined || requested === "auto") {
    if (hasEnv(env, "VOYAGE_API_KEY")) {
      return configuredNetworkProvider(
        "voyage",
        modelOverride ?? DEFAULT_VOYAGE_EMBEDDING_MODEL,
      );
    }
    return {
      status: "disabled",
      reason: "not-configured",
      provider: null,
      model: null,
      dimensions: null,
      requiredEnv: null,
    };
  }

  if (requested === "voyage") {
    const model = modelOverride ?? DEFAULT_VOYAGE_EMBEDDING_MODEL;
    if (!hasEnv(env, "VOYAGE_API_KEY")) {
      return missingNetworkProvider("voyage", model);
    }
    return configuredNetworkProvider("voyage", model);
  }

  if (requested === "openai") {
    const model = modelOverride ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
    if (!hasEnv(env, "OPENAI_API_KEY")) {
      return missingNetworkProvider("openai", model);
    }
    return configuredNetworkProvider("openai", model);
  }

  if (requested === "local") {
    return {
      status: "configured",
      provider: "local",
      model: modelOverride ?? DEFAULT_LOCAL_EMBEDDING_MODEL,
      dimensions: parseDimensions(
        env["ALMANAC_EMBEDDING_DIMENSIONS"],
        DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
      ),
      requiredEnv: null,
      packageName: "@xenova/transformers",
    };
  }

  if (requested === "deterministic") {
    return {
      status: "configured",
      provider: "deterministic",
      model: modelOverride ?? DEFAULT_DETERMINISTIC_EMBEDDING_MODEL,
      dimensions: parseDimensions(
        env["ALMANAC_EMBEDDING_DIMENSIONS"],
        DEFAULT_DETERMINISTIC_EMBEDDING_DIMENSIONS,
      ),
      requiredEnv: null,
    };
  }

  return {
    status: "invalid-config",
    reason: `unsupported ALMANAC_EMBEDDINGS=${requested}`,
    provider: null,
    model: null,
    dimensions: null,
    requiredEnv: null,
  };
}

export function describeEmbeddingProviderConfig(
  config: EmbeddingProviderConfig,
): string {
  if (config.status === "disabled") {
    return config.reason === "explicitly-disabled"
      ? "disabled by ALMANAC_EMBEDDINGS"
      : "not configured; set VOYAGE_API_KEY or ALMANAC_EMBEDDINGS";
  }
  if (config.status === "invalid-config") {
    return config.reason;
  }
  if (config.status === "missing-credentials") {
    return `${config.provider} ${config.model} requested but ${config.requiredEnv} is unset`;
  }
  if (config.provider === "local") {
    return `local ${config.model} (${config.dimensions}d; ${config.packageName})`;
  }
  if (config.provider === "deterministic") {
    return `deterministic ${config.model} (${config.dimensions}d)`;
  }
  return `${config.provider} ${config.model} via ${config.requiredEnv}`;
}

function configuredNetworkProvider(
  provider: "voyage" | "openai",
  model: string,
): EmbeddingProviderConfig {
  return {
    status: "configured",
    provider,
    model,
    dimensions: null,
    requiredEnv: providerEnv(provider),
  };
}

function missingNetworkProvider(
  provider: "voyage" | "openai",
  model: string,
): EmbeddingProviderConfig {
  return {
    status: "missing-credentials",
    provider,
    model,
    dimensions: null,
    requiredEnv: providerEnv(provider),
  };
}

function providerEnv(
  provider: "voyage" | "openai",
): "VOYAGE_API_KEY" | "OPENAI_API_KEY" {
  return provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY";
}

function normalizeProviderRequest(
  value: string | undefined,
): EmbeddingProviderKind | "auto" | "off" | "none" | "disabled" | string | undefined {
  const cleaned = clean(value)?.toLowerCase();
  return cleaned;
}

function parseDimensions(value: string | undefined, fallback: number): number {
  const cleaned = clean(value);
  if (cleaned === undefined) return fallback;
  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 8192) {
    return fallback;
  }
  return parsed;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function hasEnv(env: Record<string, string | undefined>, key: string): boolean {
  return clean(env[key]) !== undefined;
}
