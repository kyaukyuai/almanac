/**
 * Stage 8 — pipeline adapter for knowledge-index build.
 *
 *   1. Reads `extracted/facts.jsonl` (one `FactRecord` per line).
 *   2. Validates each line via `FactRecordSchema`. Malformed lines are
 *      logged and skipped — this mirrors Stage 5's lenient policy and keeps
 *      a stray blank line from killing the whole index build.
 *   3. Deletes any prior `knowledge/almanac.sqlite`, then calls
 *      `buildKnowledgeIndex` to populate a fresh SQLite + FTS5 database.
 *   4. Optionally builds embedding vector artifacts when embeddings are
 *      explicitly configured.
 *   5. Persists the resulting `KnowledgeIndexManifest` to
 *      `knowledge/index-manifest.json` (the location the runtime reads).
 *
 * `outputHash` = sha256 of the canonical manifest JSON. The manifest already
 * carries `factCorpusHash` (sha256 over the sorted facts), so two runs over
 * an identical jsonl produce identical hashes (provided `ctx.now()` is
 * stable, which the orchestrator guarantees in tests).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  resolveEmbeddingProviderConfig,
  type EmbeddingProviderConfig,
} from "../../embeddings/config.ts";
import {
  createDeterministicEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderKind,
} from "../../embeddings/provider.ts";
import {
  KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH,
  KNOWLEDGE_VECTOR_INDEX_REL_PATH,
  buildVectorIndexArtifacts,
  createSkippedVectorIndexManifest,
} from "../../embeddings/vector-index.ts";
import {
  FactRecordSchema,
  KnowledgeIndexManifestSchema,
  type FactRecord,
  type KnowledgeVectorIndexManifest,
} from "../../core/types.ts";
import { knowledgeIndexManifestPath } from "../storage.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { factsJsonlPath } from "./s05-fact-extraction.ts";
import { buildKnowledgeIndex } from "./s08-knowledge-index.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────────

export const KNOWLEDGE_DB_REL_PATH = "knowledge/almanac.sqlite";

export function knowledgeDbPath(almanacDir: string): string {
  return join(almanacDir, KNOWLEDGE_DB_REL_PATH);
}

export function knowledgeVectorIndexPath(almanacDir: string): string {
  return join(almanacDir, KNOWLEDGE_VECTOR_INDEX_REL_PATH);
}

export function knowledgeVectorIndexManifestPath(almanacDir: string): string {
  return join(almanacDir, KNOWLEDGE_VECTOR_INDEX_MANIFEST_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingFactsError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 8 requires the Stage 5 facts.jsonl at ${path}; ` +
        "run Stage 5 first or restore the file",
    );
    this.name = "MissingFactsError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateKnowledgeIndexRunnerOptions {
  /** Test seam: read facts from a custom location. */
  readFacts?: (almanacDir: string, log: (e: object) => void) => Promise<FactRecord[]>;
  /** Test seam: force a deterministic embedding configuration. */
  resolveEmbeddingConfig?: () => EmbeddingProviderConfig;
  /** Test seam: inject future provider implementations without network calls. */
  createEmbeddingProvider?: (config: EmbeddingProviderConfig) => EmbeddingProvider | null;
}

/**
 * Build the Stage 8 `StageRunner`. Deterministic stage: `promptVersion = null`.
 */
export function createKnowledgeIndexRunner(
  opts: CreateKnowledgeIndexRunnerOptions = {},
): StageRunner {
  const readFacts = opts.readFacts ?? defaultReadFacts;
  const resolveEmbeddingConfig =
    opts.resolveEmbeddingConfig ?? (() => resolveVectorIndexEmbeddingConfig(process.env));
  const createEmbeddingProvider =
    opts.createEmbeddingProvider ?? createEmbeddingProviderFromConfig;

  return {
    promptVersion: null,
    async run(ctx) {
      const facts = await readFacts(ctx.almanacDir, ctx.log);

      ctx.log({ event: "stage8:start", facts: facts.length });

      const dbPath = knowledgeDbPath(ctx.almanacDir);
      await mkdir(dirname(dbPath), { recursive: true });
      // bun:sqlite would happily reopen an existing file, but Stage 8's
      // contract is "build from scratch" — leftover rows from a prior run
      // would corrupt FTS5's `rebuild` semantics.
      if (existsSync(dbPath)) {
        await unlink(dbPath);
      }

      const builtAt = ctx.now();
      const built = buildKnowledgeIndex({
        almanacId: ctx.manifest.almanacId,
        facts,
        dbPath,
        builtAt,
      });
      // Close immediately — runtime opens its own connection later.
      built.db.close();

      const vectorIndex = await buildStageVectorIndex({
        almanacDir: ctx.almanacDir,
        almanacId: ctx.manifest.almanacId,
        facts,
        builtAt,
        factCorpusHash: built.manifest.factCorpusHash,
        config: resolveEmbeddingConfig(),
        createEmbeddingProvider,
        log: ctx.log,
      });
      const manifest = KnowledgeIndexManifestSchema.parse({
        ...built.manifest,
        vectorIndex,
      });

      const manifestPath = knowledgeIndexManifestPath(ctx.almanacDir);
      const canonicalText = JSON.stringify(manifest, null, 2);
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage8:done",
        outputHash,
        factCount: manifest.factCount,
        factCorpusHash: manifest.factCorpusHash,
        sqliteVersion: manifest.sqliteVersion,
        vectorIndex: vectorIndex.status,
      });

      return {
        kind: "success",
        outputHash,
      };
    },
  };
}

export function createEmbeddingProviderFromConfig(
  config: EmbeddingProviderConfig,
): EmbeddingProvider | null {
  if (config.status === "configured" && config.provider === "deterministic") {
    return createDeterministicEmbeddingProvider({
      model: config.model,
      dimensions: config.dimensions,
    });
  }
  return null;
}

export function resolveVectorIndexEmbeddingConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProviderConfig {
  const requested = env["ALMANAC_EMBEDDINGS"]?.trim().toLowerCase();
  if (requested === undefined || requested.length === 0 || requested === "auto") {
    return {
      status: "disabled",
      reason: "not-configured",
      provider: null,
      model: null,
      dimensions: null,
      requiredEnv: null,
    };
  }
  return resolveEmbeddingProviderConfig(env);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function buildStageVectorIndex(input: {
  almanacDir: string;
  almanacId: string;
  facts: readonly FactRecord[];
  builtAt: Date;
  factCorpusHash: string;
  config: EmbeddingProviderConfig;
  createEmbeddingProvider: (config: EmbeddingProviderConfig) => EmbeddingProvider | null;
  log: (e: object) => void;
}): Promise<KnowledgeVectorIndexManifest> {
  const vectorPath = knowledgeVectorIndexPath(input.almanacDir);
  const vectorManifestPath = knowledgeVectorIndexManifestPath(input.almanacDir);
  await unlinkIfExists(vectorPath);
  await unlinkIfExists(vectorManifestPath);

  const provider = input.createEmbeddingProvider(input.config);
  if (provider === null) {
    const skipped = createSkippedVectorIndexManifest({
      ...embeddingConfigSummary(input.config),
      reason: vectorSkipReason(input.config),
      factCount: input.facts.length,
      sourceFactCorpusHash: input.factCorpusHash,
      builtAt: input.builtAt,
    });
    input.log({
      event: "stage8:vector-index-skipped",
      reason: skipped.reason,
      provider: skipped.provider,
      model: skipped.model,
    });
    return skipped;
  }

  const built = await buildVectorIndexArtifacts({
    almanacId: input.almanacId,
    facts: input.facts,
    provider,
    builtAt: input.builtAt,
    sourceFactCorpusHash: input.factCorpusHash,
  });

  await mkdir(dirname(vectorPath), { recursive: true });
  await writeFile(vectorPath, built.jsonl, "utf8");
  await writeFile(
    vectorManifestPath,
    JSON.stringify(built.manifest, null, 2) + "\n",
    "utf8",
  );
  input.log({
    event: "stage8:vector-index-built",
    provider: built.manifest.provider,
    model: built.manifest.model,
    dimensions: built.manifest.dimensions,
    vectors: built.manifest.vectorCount,
    vectorsHash: built.manifest.vectorsHash,
  });
  return built.manifest;
}

function vectorSkipReason(
  config: EmbeddingProviderConfig,
): Extract<KnowledgeVectorIndexManifest, { status: "skipped" }>["reason"] {
  if (config.status === "disabled") {
    return config.reason;
  }
  if (config.status === "missing-credentials") {
    return "missing-credentials";
  }
  if (config.status === "invalid-config") {
    return "invalid-config";
  }
  return "provider-unimplemented";
}

function embeddingConfigSummary(config: EmbeddingProviderConfig): {
  provider: EmbeddingProviderKind | null;
  model: string | null;
  dimensions: number | null;
} {
  if (
    config.status === "configured" ||
    config.status === "missing-credentials"
  ) {
    return {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
    };
  }
  return { provider: null, model: null, dimensions: null };
}

async function unlinkIfExists(path: string): Promise<void> {
  if (existsSync(path)) {
    await unlink(path);
  }
}

async function defaultReadFacts(
  almanacDir: string,
  log: (e: object) => void,
): Promise<FactRecord[]> {
  const path = factsJsonlPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingFactsError(path, cause);
    }
    throw cause;
  }

  const facts: FactRecord[] = [];
  let lineNo = 0;
  for (const line of body.split("\n")) {
    lineNo += 1;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      log({
        event: "stage8:malformed-line",
        reason: "json-parse-error",
        lineNo,
        error: (cause as Error).message,
      });
      continue;
    }
    const r = FactRecordSchema.safeParse(parsed);
    if (!r.success) {
      log({
        event: "stage8:malformed-line",
        reason: "schema-validation-error",
        lineNo,
        issues: r.error.issues,
      });
      continue;
    }
    facts.push(r.data);
  }
  return facts;
}
