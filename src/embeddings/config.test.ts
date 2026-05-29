import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  describeEmbeddingProviderConfig,
  resolveEmbeddingProviderConfig,
} from "./config.ts";

describe("resolveEmbeddingProviderConfig", () => {
  test("defaults to disabled when no provider is configured", () => {
    expect(resolveEmbeddingProviderConfig({})).toEqual({
      status: "disabled",
      reason: "not-configured",
      provider: null,
      model: null,
      dimensions: null,
      requiredEnv: null,
    });
  });

  test("uses Voyage by default when VOYAGE_API_KEY is present", () => {
    expect(resolveEmbeddingProviderConfig({ VOYAGE_API_KEY: "v" })).toEqual({
      status: "configured",
      provider: "voyage",
      model: DEFAULT_VOYAGE_EMBEDDING_MODEL,
      dimensions: null,
      requiredEnv: "VOYAGE_API_KEY",
    });
  });

  test("does not select OpenAI unless explicitly requested", () => {
    expect(resolveEmbeddingProviderConfig({ OPENAI_API_KEY: "o" }).status).toBe(
      "disabled",
    );
  });

  test("supports OpenAI opt-in and reports missing credentials", () => {
    expect(
      resolveEmbeddingProviderConfig({
        ALMANAC_EMBEDDINGS: "openai",
        OPENAI_API_KEY: "o",
      }),
    ).toEqual({
      status: "configured",
      provider: "openai",
      model: DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: null,
      requiredEnv: "OPENAI_API_KEY",
    });

    expect(resolveEmbeddingProviderConfig({ ALMANAC_EMBEDDINGS: "openai" }))
      .toEqual({
        status: "missing-credentials",
        provider: "openai",
        model: DEFAULT_OPENAI_EMBEDDING_MODEL,
        dimensions: null,
        requiredEnv: "OPENAI_API_KEY",
      });
  });

  test("supports deterministic and local modes without network credentials", () => {
    expect(
      resolveEmbeddingProviderConfig({
        ALMANAC_EMBEDDINGS: "deterministic",
        ALMANAC_EMBEDDING_DIMENSIONS: "12",
      }),
    ).toMatchObject({
      status: "configured",
      provider: "deterministic",
      dimensions: 12,
      requiredEnv: null,
    });

    expect(resolveEmbeddingProviderConfig({ ALMANAC_EMBEDDINGS: "local" }))
      .toMatchObject({
        status: "configured",
        provider: "local",
        dimensions: 384,
        packageName: "@xenova/transformers",
      });
  });

  test("reports unsupported provider requests", () => {
    const config = resolveEmbeddingProviderConfig({
      ALMANAC_EMBEDDINGS: "wat",
    });
    expect(config.status).toBe("invalid-config");
    expect(describeEmbeddingProviderConfig(config)).toContain(
      "unsupported ALMANAC_EMBEDDINGS=wat",
    );
  });
});
