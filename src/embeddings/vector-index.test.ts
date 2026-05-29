import { describe, expect, test } from "bun:test";

import type { FactRecord } from "../core/types.ts";
import { createDeterministicEmbeddingProvider } from "./provider.ts";
import {
  KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH,
  KNOWLEDGE_VECTOR_INDEX_REL_PATH,
  buildVectorIndexArtifacts,
  createSkippedVectorIndexManifest,
  parseVectorIndexJsonl,
} from "./vector-index.ts";

const HASH = "abcdef".repeat(10) + "0001";

const facts: FactRecord[] = [
  {
    id: "01H00000000000000000000002",
    text: "Controllers reconcile observed Kubernetes state toward desired state.",
    type: "principle",
    entities: ["controller", "reconcile"],
    source: {
      sourceId: "k8s-docs",
      contentHash: HASH,
      url: "https://kubernetes.io/docs/",
      excerpt: "Controllers reconcile state.",
    },
    freshnessClass: "static",
    validUntil: null,
    confidence: 0.94,
    extractedAt: "2026-05-08T12:00:00.000Z",
    extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
  },
  {
    id: "01H00000000000000000000001",
    text: "An operator packages domain-specific operational knowledge.",
    type: "definition",
    entities: ["operator"],
    source: {
      sourceId: "k8s-docs",
      contentHash: HASH,
      url: "https://kubernetes.io/docs/",
      excerpt: "Operators package operational knowledge.",
    },
    freshnessClass: "static",
    validUntil: null,
    confidence: 0.95,
    extractedAt: "2026-05-08T12:00:00.000Z",
    extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
  },
];

describe("buildVectorIndexArtifacts", () => {
  test("builds deterministic vector records and manifest metadata", async () => {
    const provider = createDeterministicEmbeddingProvider({ dimensions: 6 });
    const built = await buildVectorIndexArtifacts({
      almanacId: "kubernetes",
      facts,
      provider,
      builtAt: new Date("2026-05-08T12:30:00.000Z"),
      sourceFactCorpusHash: "a".repeat(64),
    });

    expect(built.records).toHaveLength(2);
    expect(built.records[0]!.factId).toBe("01H00000000000000000000001");
    expect(built.records[0]!.values).toHaveLength(6);
    expect(built.jsonl.split("\n").filter(Boolean)).toHaveLength(2);
    expect(built.manifest).toMatchObject({
      status: "built",
      provider: "deterministic",
      model: "deterministic-hash-v1",
      dimensions: 6,
      factCount: 2,
      vectorCount: 2,
      vectorsRelPath: KNOWLEDGE_VECTOR_INDEX_REL_PATH,
      manifestRelPath: KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH,
      sourceFactCorpusHash: "a".repeat(64),
    });
    expect(built.manifest.vectorsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("empty corpus still produces built metadata and empty jsonl", async () => {
    const provider = createDeterministicEmbeddingProvider();
    const built = await buildVectorIndexArtifacts({
      almanacId: "kubernetes",
      facts: [],
      provider,
      builtAt: new Date("2026-05-08T12:30:00.000Z"),
      sourceFactCorpusHash: "b".repeat(64),
    });
    expect(built.records).toEqual([]);
    expect(built.jsonl).toBe("");
    expect(built.manifest.status).toBe("built");
    expect(built.manifest.vectorCount).toBe(0);
  });
});

describe("createSkippedVectorIndexManifest", () => {
  test("records skip reason without artifact paths", () => {
    const manifest = createSkippedVectorIndexManifest({
      reason: "not-configured",
      factCount: 2,
      sourceFactCorpusHash: "c".repeat(64),
      builtAt: new Date("2026-05-08T12:30:00.000Z"),
    });
    expect(manifest.status).toBe("skipped");
    expect(manifest.vectorsRelPath).toBeNull();
    expect(manifest.manifestRelPath).toBeNull();
  });
});

describe("parseVectorIndexJsonl", () => {
  test("parses vector records and rejects malformed rows", () => {
    expect(
      parseVectorIndexJsonl('{"factId":"01H00000000000000000000001","dimensions":2,"values":[1,0]}\n'),
    ).toEqual([
      {
        factId: "01H00000000000000000000001",
        dimensions: 2,
        values: [1, 0],
      },
    ]);
    expect(() => parseVectorIndexJsonl('{"factId":"x","dimensions":2,"values":[1]}\n')).toThrow(
      /values length mismatch/,
    );
  });
});
