import {
  describeEmbeddingProviderConfig,
  type EmbeddingProviderConfig,
} from "../embeddings/config.ts";
import type { KnowledgeVectorIndexManifest } from "../core/types.ts";

export type RetrievalMode =
  | "fts-only"
  | "hybrid"
  | "vector-configured-but-skipped";

export interface RetrievalReadiness {
  mode: RetrievalMode;
  status: "ready" | "needs-attention";
  summary: string;
  details: string;
  vectorIndex: KnowledgeVectorIndexManifest | null;
  embeddingConfig: EmbeddingProviderConfig;
}

export function getRetrievalReadiness(input: {
  vectorIndex: KnowledgeVectorIndexManifest | null | undefined;
  embeddingConfig: EmbeddingProviderConfig;
}): RetrievalReadiness {
  const vectorIndex = input.vectorIndex ?? null;
  if (vectorIndex?.status === "built") {
    return {
      mode: "hybrid",
      status: "ready",
      summary:
        `hybrid: SQLite FTS + ${vectorIndex.provider}/${vectorIndex.model} ` +
        `${vectorIndex.dimensions}d vectors`,
      details:
        `hybrid retrieval is active with ${vectorIndex.vectorCount} vector(s); ` +
        "FTS remains the anchor for cite-or-abstain behavior.",
      vectorIndex,
      embeddingConfig: input.embeddingConfig,
    };
  }

  if (isVectorConfiguredButSkipped(vectorIndex)) {
    return {
      mode: "vector-configured-but-skipped",
      status: "needs-attention",
      summary:
        `vector-configured-but-skipped: ${describeSkippedVector(input.embeddingConfig, vectorIndex)}`,
      details:
        "semantic retrieval was requested or is available, but this almanac is currently using SQLite FTS only.",
      vectorIndex,
      embeddingConfig: input.embeddingConfig,
    };
  }

  return {
    mode: "fts-only",
    status: "ready",
    summary: "fts-only: SQLite FTS is active; embeddings are optional",
    details:
      "FTS-only retrieval is the default and is valid for deterministic/local workflows.",
    vectorIndex,
    embeddingConfig: input.embeddingConfig,
  };
}

export function embeddingReadinessLevel(
  config: EmbeddingProviderConfig,
): "ok" | "warn" {
  return config.status === "invalid-config" ||
    config.status === "missing-credentials"
    ? "warn"
    : "ok";
}

export function formatEmbeddingReadiness(config: EmbeddingProviderConfig): string {
  if (config.status === "disabled" && config.reason === "not-configured") {
    return "optional; FTS-only is the default. Set VOYAGE_API_KEY or ALMANAC_EMBEDDINGS to request semantic retrieval.";
  }
  return describeEmbeddingProviderConfig(config);
}

function isVectorConfiguredButSkipped(
  vectorIndex: KnowledgeVectorIndexManifest | null,
): boolean {
  if (vectorIndex?.status === "skipped") {
    return (
      vectorIndex.reason === "missing-credentials" ||
      vectorIndex.reason === "invalid-config" ||
      vectorIndex.reason === "provider-unimplemented"
    );
  }
  return false;
}

function describeSkippedVector(
  config: EmbeddingProviderConfig,
  vectorIndex: KnowledgeVectorIndexManifest | null,
): string {
  if (vectorIndex?.status === "skipped") {
    const provider = vectorIndex.provider === null
      ? "unknown provider"
      : `${vectorIndex.provider}/${vectorIndex.model}`;
    return `${provider} skipped (${vectorIndex.reason.replace(/-/g, " ")})`;
  }
  return describeEmbeddingProviderConfig(config);
}
