/**
 * Vector artifact builder for fact embeddings.
 *
 * Stage 8 keeps SQLite/FTS5 as the active retrieval index. These artifacts are
 * opt-in groundwork for later hybrid retrieval: one jsonl vector per fact plus
 * a small manifest that pins provider/model/dimensions and the source fact
 * corpus hash.
 */

import { createHash } from "node:crypto";

import {
  KnowledgeVectorIndexManifestSchema,
  type FactRecord,
  type KnowledgeVectorIndexManifest,
} from "../core/types.ts";
import {
  EmbeddingProviderError,
  type EmbeddingInput,
  type EmbeddingProvider,
  type EmbeddingVector,
} from "./provider.ts";

export const KNOWLEDGE_VECTOR_INDEX_REL_PATH = "knowledge/vectors.jsonl";
export const KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH =
  "knowledge/vector-index.json";

export interface VectorIndexRecord {
  factId: string;
  dimensions: number;
  values: readonly number[];
}

export type BuiltVectorIndexManifest = Extract<
  KnowledgeVectorIndexManifest,
  { status: "built" }
>;

export type SkippedVectorIndexManifest = Extract<
  KnowledgeVectorIndexManifest,
  { status: "skipped" }
>;

export interface BuildVectorIndexArtifactsInput {
  almanacId: string;
  facts: readonly FactRecord[];
  provider: EmbeddingProvider;
  builtAt: Date;
  sourceFactCorpusHash: string;
}

export interface BuildVectorIndexArtifactsResult {
  manifest: BuiltVectorIndexManifest;
  records: readonly VectorIndexRecord[];
  jsonl: string;
}

export async function buildVectorIndexArtifacts(
  input: BuildVectorIndexArtifactsInput,
): Promise<BuildVectorIndexArtifactsResult> {
  const facts = [...input.facts].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const records =
    facts.length === 0
      ? []
      : buildRecords(
          facts,
          await input.provider.embed({
            inputs: facts.map(factToEmbeddingInput),
          }),
        );
  const jsonl =
    records.length === 0
      ? ""
      : records.map((record) => JSON.stringify(record)).join("\n") + "\n";

  const manifest = KnowledgeVectorIndexManifestSchema.parse({
    schemaVersion: "0.1.0",
    status: "built",
    provider: input.provider.model.provider,
    model: input.provider.model.model,
    dimensions: input.provider.model.dimensions,
    factCount: facts.length,
    vectorCount: records.length,
    sourceFactCorpusHash: input.sourceFactCorpusHash,
    vectorsRelPath: KNOWLEDGE_VECTOR_INDEX_REL_PATH,
    manifestRelPath: KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH,
    vectorsHash: sha256Hex(jsonl),
    builtAt: input.builtAt.toISOString(),
  }) as BuiltVectorIndexManifest;

  return { manifest, records, jsonl };
}

export function parseVectorIndexJsonl(text: string): VectorIndexRecord[] {
  const records: VectorIndexRecord[] = [];
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo += 1;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new Error(
        `invalid vector index jsonl at line ${lineNo}: ${(cause as Error).message}`,
      );
    }
    records.push(validateVectorIndexRecord(parsed, lineNo));
  }
  return records;
}

export function createSkippedVectorIndexManifest(input: {
  reason: SkippedVectorIndexManifest["reason"];
  factCount: number;
  sourceFactCorpusHash: string;
  builtAt: Date;
  provider?: KnowledgeVectorIndexManifest["provider"];
  model?: string | null;
  dimensions?: number | null;
}): SkippedVectorIndexManifest {
  return KnowledgeVectorIndexManifestSchema.parse({
    schemaVersion: "0.1.0",
    status: "skipped",
    reason: input.reason,
    provider: input.provider ?? null,
    model: input.model ?? null,
    dimensions: input.dimensions ?? null,
    factCount: input.factCount,
    vectorCount: 0,
    sourceFactCorpusHash: input.sourceFactCorpusHash,
    vectorsRelPath: null,
    manifestRelPath: null,
    builtAt: input.builtAt.toISOString(),
  }) as SkippedVectorIndexManifest;
}

function factToEmbeddingInput(fact: FactRecord): EmbeddingInput {
  return {
    id: fact.id,
    text: fact.text,
    metadata: {
      type: fact.type,
      sourceId: fact.source.sourceId,
      freshnessClass: fact.freshnessClass,
    },
  };
}

function buildRecords(
  facts: readonly FactRecord[],
  response: { vectors: readonly EmbeddingVector[] },
): VectorIndexRecord[] {
  const vectorsByInputId = new Map(response.vectors.map((v) => [v.inputId, v]));
  if (vectorsByInputId.size !== facts.length) {
    throw new EmbeddingProviderError(
      "bad-response",
      `embedding response returned ${vectorsByInputId.size} vectors for ${facts.length} facts`,
      false,
    );
  }

  return facts.map((fact) => {
    const vector = vectorsByInputId.get(fact.id);
    if (vector === undefined) {
      throw new EmbeddingProviderError(
        "bad-response",
        `embedding response missing vector for fact ${fact.id}`,
        false,
      );
    }
    if (vector.values.length !== vector.dimensions) {
      throw new EmbeddingProviderError(
        "bad-response",
        `embedding vector ${fact.id} dimensions mismatch`,
        false,
      );
    }
    return {
      factId: fact.id,
      dimensions: vector.dimensions,
      values: [...vector.values],
    };
  });
}

function validateVectorIndexRecord(
  value: unknown,
  lineNo: number,
): VectorIndexRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid vector index record at line ${lineNo}: expected object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.factId !== "string" || record.factId.length === 0) {
    throw new Error(`invalid vector index record at line ${lineNo}: factId is required`);
  }
  if (
    !Number.isInteger(record.dimensions) ||
    (record.dimensions as number) <= 0 ||
    (record.dimensions as number) > 8192
  ) {
    throw new Error(`invalid vector index record at line ${lineNo}: dimensions is invalid`);
  }
  if (!Array.isArray(record.values) || record.values.length !== record.dimensions) {
    throw new Error(`invalid vector index record at line ${lineNo}: values length mismatch`);
  }
  for (const value of record.values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`invalid vector index record at line ${lineNo}: values must be finite numbers`);
    }
  }
  return {
    factId: record.factId,
    dimensions: record.dimensions,
    values: record.values,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
