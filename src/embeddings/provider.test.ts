import { describe, expect, test } from "bun:test";

import {
  EmbeddingProviderError,
  createDeterministicEmbeddingProvider,
} from "./provider.ts";

describe("createDeterministicEmbeddingProvider", () => {
  test("returns stable vectors with the configured dimensions", async () => {
    const provider = createDeterministicEmbeddingProvider({ dimensions: 6 });

    const first = await provider.embed({
      inputs: [{ id: "fact-1", text: "SQLite supports FTS5 virtual tables." }],
    });
    const second = await provider.embed({
      inputs: [{ id: "fact-1", text: "SQLite supports FTS5 virtual tables." }],
    });

    expect(first.model).toEqual({
      provider: "deterministic",
      model: "deterministic-hash-v1",
      dimensions: 6,
    });
    expect(first.vectors[0]!.dimensions).toBe(6);
    expect(first.vectors[0]!.values).toEqual(second.vectors[0]!.values);
    expect(first.usage).toEqual({
      inputCount: 1,
      inputCharacters: "SQLite supports FTS5 virtual tables.".length,
    });
  });

  test("different inputs produce different vectors", async () => {
    const provider = createDeterministicEmbeddingProvider({ dimensions: 4 });
    const response = await provider.embed({
      inputs: [
        { id: "fact-1", text: "WAL improves reader concurrency." },
        { id: "fact-2", text: "Rollback journals preserve atomic commits." },
      ],
    });

    expect(response.vectors).toHaveLength(2);
    expect(response.vectors[0]!.values).not.toEqual(response.vectors[1]!.values);
  });

  test("rejects duplicate ids and empty text", async () => {
    const provider = createDeterministicEmbeddingProvider();

    await expect(
      provider.embed({
        inputs: [
          { id: "dup", text: "first" },
          { id: "dup", text: "second" },
        ],
      }),
    ).rejects.toBeInstanceOf(EmbeddingProviderError);

    await expect(
      provider.embed({ inputs: [{ id: "empty", text: "   " }] }),
    ).rejects.toBeInstanceOf(EmbeddingProviderError);
  });
});
