import { describe, expect, test } from "bun:test";

import type {
  EmbeddingProviderConfig,
} from "../embeddings/config.ts";
import type { KnowledgeVectorIndexManifest } from "../core/types.ts";
import {
  embeddingReadinessLevel,
  formatEmbeddingReadiness,
  getRetrievalReadiness,
} from "./retrieval-readiness.ts";

const disabledConfig: EmbeddingProviderConfig = {
  status: "disabled",
  reason: "not-configured",
  provider: null,
  model: null,
  dimensions: null,
  requiredEnv: null,
};

const deterministicConfig: EmbeddingProviderConfig = {
  status: "configured",
  provider: "deterministic",
  model: "deterministic-hash-v1",
  dimensions: 8,
  requiredEnv: null,
};

describe("getRetrievalReadiness", () => {
  test("treats FTS-only as ready when embeddings are not configured", () => {
    const readiness = getRetrievalReadiness({
      vectorIndex: {
        schemaVersion: "0.1.0",
        status: "skipped",
        reason: "not-configured",
        provider: null,
        model: null,
        dimensions: null,
        factCount: 2,
        vectorCount: 0,
        sourceFactCorpusHash: "a".repeat(64),
        vectorsRelPath: null,
        manifestRelPath: null,
        builtAt: "2026-05-08T12:00:04.000Z",
      },
      embeddingConfig: disabledConfig,
    });

    expect(readiness.mode).toBe("fts-only");
    expect(readiness.status).toBe("ready");
    expect(readiness.summary).toContain("embeddings are optional");
  });

  test("reports hybrid when vector artifacts are built", () => {
    const vectorIndex: KnowledgeVectorIndexManifest = {
      schemaVersion: "0.1.0",
      status: "built",
      provider: "deterministic",
      model: "deterministic-hash-v1",
      dimensions: 8,
      factCount: 2,
      vectorCount: 2,
      sourceFactCorpusHash: "a".repeat(64),
      vectorsRelPath: "knowledge/vectors.jsonl",
      manifestRelPath: "knowledge/vector-index.json",
      vectorsHash: "b".repeat(64),
      builtAt: "2026-05-08T12:00:04.000Z",
    };

    const readiness = getRetrievalReadiness({
      vectorIndex,
      embeddingConfig: deterministicConfig,
    });

    expect(readiness.mode).toBe("hybrid");
    expect(readiness.status).toBe("ready");
    expect(readiness.summary).toContain("SQLite FTS");
  });

  test("does not change active mode from environment config alone", () => {
    const readiness = getRetrievalReadiness({
      vectorIndex: null,
      embeddingConfig: deterministicConfig,
    });

    expect(readiness.mode).toBe("fts-only");
    expect(readiness.status).toBe("ready");
  });

  test("warns when semantic retrieval is configured but skipped", () => {
    const readiness = getRetrievalReadiness({
      vectorIndex: {
        schemaVersion: "0.1.0",
        status: "skipped",
        reason: "provider-unimplemented",
        provider: "voyage",
        model: "voyage-3-lite",
        dimensions: null,
        factCount: 2,
        vectorCount: 0,
        sourceFactCorpusHash: "a".repeat(64),
        vectorsRelPath: null,
        manifestRelPath: null,
        builtAt: "2026-05-08T12:00:04.000Z",
      },
      embeddingConfig: {
        status: "configured",
        provider: "voyage",
        model: "voyage-3-lite",
        dimensions: null,
        requiredEnv: "VOYAGE_API_KEY",
      },
    });

    expect(readiness.mode).toBe("vector-configured-but-skipped");
    expect(readiness.status).toBe("needs-attention");
    expect(readiness.summary).toContain("provider unimplemented");
  });
});

describe("embedding readiness formatting", () => {
  test("does not warn for missing optional embeddings", () => {
    expect(embeddingReadinessLevel(disabledConfig)).toBe("ok");
    expect(formatEmbeddingReadiness(disabledConfig)).toContain("FTS-only");
  });

  test("warns only when embeddings were requested but cannot run", () => {
    const missing: EmbeddingProviderConfig = {
      status: "missing-credentials",
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: null,
      requiredEnv: "OPENAI_API_KEY",
    };

    expect(embeddingReadinessLevel(missing)).toBe("warn");
    expect(formatEmbeddingReadiness(missing)).toContain("OPENAI_API_KEY");
  });
});
