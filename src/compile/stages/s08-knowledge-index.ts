/**
 * Stage 8 — knowledge index (bun:sqlite + FTS5).
 *
 * Builds `<almanacDir>/knowledge/almanac.sqlite` from the canonical
 * `extracted/facts.jsonl` (a `FactRecord[]`).
 *
 * Schema:
 *
 *   facts {
 *     id PK, text, type, entities (JSON array),
 *     source_id, content_hash, url, excerpt,
 *     freshness_class, valid_until (NULLable ISO),
 *     confidence, extracted_at, extractor_model, extractor_prompt_version,
 *     volatility_notes (NULLable)
 *   }
 *   facts_fts USING fts5(text, entities, content='facts', content_rowid='rowid')
 *
 * The FTS5 index is rebuilt after a bulk insert (no triggers needed because
 * the index is immutable for the lifetime of the almanac — `almanac update`
 * rebuilds it from scratch).
 *
 * Also exports `SqliteKnowledgeReader`, the concrete `KnowledgeReader`
 * implementation the runtime injects into tools whose manifest declares
 * `knowledgeUsage.facts === true`.
 */

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

import {
  KnowledgeIndexManifestSchema,
  type CacheableVolatility,
  type FactRecord,
  type FactType,
  type KnowledgeFactCounts,
  type KnowledgeIndexManifest,
} from "../../core/types.ts";
import type {
  KnowledgeReader,
  SearchFactsOptions,
} from "../../core/runtime.ts";
import type { EmbeddingProvider } from "../../embeddings/provider.ts";
import type { VectorIndexRecord } from "../../embeddings/vector-index.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Build
// ──────────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE facts (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    type TEXT NOT NULL,
    entities TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    url TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    freshness_class TEXT NOT NULL,
    valid_until TEXT,
    confidence REAL NOT NULL,
    extracted_at TEXT NOT NULL,
    extractor_model TEXT NOT NULL,
    extractor_prompt_version TEXT NOT NULL,
    volatility_notes TEXT
  );
  CREATE INDEX idx_facts_class ON facts(freshness_class);
  CREATE INDEX idx_facts_valid_until ON facts(valid_until);
  CREATE VIRTUAL TABLE facts_fts USING fts5(
    text, entities,
    content='facts', content_rowid='rowid'
  );
`;

export interface BuildKnowledgeIndexInput {
  almanacId: string;
  facts: FactRecord[];
  /** ":memory:" for tests; absolute filesystem path in production. */
  dbPath: string;
  builtAt?: Date;
}

export interface BuildKnowledgeIndexResult {
  manifest: KnowledgeIndexManifest;
  /** Caller closes when done. Tests can introspect via {@link openKnowledgeReader}. */
  db: Database;
}

/**
 * Build the SQLite + FTS5 index in one shot. Pure (no side effects beyond the
 * supplied database). Returns both the open `Database` and the validated
 * `KnowledgeIndexManifest`. The CLI is expected to:
 *
 *   1. ensure the almanac's `knowledge/` directory exists
 *   2. delete any prior `knowledge/almanac.sqlite`
 *   3. call this function with the absolute db path
 *   4. write the manifest to `knowledge/index-manifest.json`
 *   5. close the returned database
 */
export function buildKnowledgeIndex(
  input: BuildKnowledgeIndexInput,
): BuildKnowledgeIndexResult {
  const builtAt = input.builtAt ?? new Date();

  const db = new Database(input.dbPath);
  // Single multi-statement script; bun:sqlite's `exec` runs all of them.
  db.exec(SCHEMA_SQL);

  if (input.facts.length > 0) {
    const insert = db.prepare(`
      INSERT INTO facts (
        id, text, type, entities,
        source_id, content_hash, url, excerpt,
        freshness_class, valid_until, confidence,
        extracted_at, extractor_model, extractor_prompt_version,
        volatility_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const f of input.facts) {
        insert.run(
          f.id,
          f.text,
          f.type,
          JSON.stringify(f.entities),
          f.source.sourceId,
          f.source.contentHash,
          f.source.url,
          f.source.excerpt,
          f.freshnessClass,
          f.validUntil,
          f.confidence,
          f.extractedAt,
          f.extractor.model,
          f.extractor.promptVersion,
          f.volatilityNotes ?? null,
        );
      }
    })();
    // Populate FTS5 from the populated facts table.
    db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`);
  }

  const counts = computeCounts(input.facts);
  const sqliteVersion = (
    db.query("SELECT sqlite_version() AS v").get() as { v: string }
  ).v;

  const manifest = KnowledgeIndexManifestSchema.parse({
    schemaVersion: "0.1.0" as const,
    almanacId: input.almanacId,
    dbRelPath: "knowledge/almanac.sqlite" as const,
    factCount: input.facts.length,
    counts,
    builtAt: builtAt.toISOString(),
    sqliteVersion,
    factCorpusHash: hashFactCorpus(input.facts),
  });

  return { manifest, db };
}

function computeCounts(facts: readonly FactRecord[]): KnowledgeFactCounts {
  const byClass: KnowledgeFactCounts["byClass"] = { static: 0, slow: 0 };
  const byType: KnowledgeFactCounts["byType"] = {
    fact: 0,
    definition: 0,
    procedure: 0,
    opinion: 0,
    reference: 0,
    principle: 0,
    heuristic: 0,
    tradeoff: 0,
    framework: 0,
  };
  for (const f of facts) {
    byClass[f.freshnessClass as CacheableVolatility] += 1;
    byType[f.type as FactType] += 1;
  }
  return { byClass, byType };
}

/**
 * Stable hash of the canonicalized fact corpus. Sorting by `id` makes this
 * order-insensitive so re-running the pipeline against the same facts
 * produces the same hash regardless of fact emission order.
 */
function hashFactCorpus(facts: readonly FactRecord[]): string {
  const sorted = [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(JSON.stringify(f));
    h.update("\n");
  }
  return h.digest("hex");
}

// ──────────────────────────────────────────────────────────────────────────────
// Read — concrete `KnowledgeReader` over the built index
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Open a `Database` and wrap it as a `KnowledgeReader`. The CLI uses this in
 * `serve/`; tests use it against an in-memory database returned by
 * {@link buildKnowledgeIndex}.
 */
export interface KnowledgeVectorSearchIndex {
  provider: EmbeddingProvider;
  records: readonly VectorIndexRecord[];
}

export interface OpenKnowledgeReaderOptions {
  vectorIndex?: KnowledgeVectorSearchIndex | null;
}

export function openKnowledgeReader(
  db: Database,
  opts: OpenKnowledgeReaderOptions = {},
): KnowledgeReader {
  return new SqliteKnowledgeReader(db, opts.vectorIndex ?? null);
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RRF_K = 60;

class SqliteKnowledgeReader implements KnowledgeReader {
  constructor(
    private readonly db: Database,
    private readonly vectorIndex: KnowledgeVectorSearchIndex | null,
  ) {}

  async searchFacts(
    query: string,
    opts?: SearchFactsOptions,
  ): Promise<FactRecord[]> {
    if (!query || query.trim().length === 0) {
      return [];
    }
    const limit = normalizeLimit(opts?.limit);
    if (this.vectorIndex === null || this.vectorIndex.records.length === 0) {
      return this.searchFactsFts(query, opts, limit);
    }

    const ftsHits = await this.searchFactsFts(query, opts, MAX_LIMIT);
    if (ftsHits.length === 0) {
      return [];
    }

    const vectorHits = await this.searchFactsVector(query, opts, MAX_LIMIT);
    if (vectorHits.length === 0) {
      return ftsHits.slice(0, limit);
    }

    return mergeFactsByRrf(ftsHits, vectorHits, limit);
  }

  private async searchFactsFts(
    query: string,
    opts: SearchFactsOptions | undefined,
    limit: number,
  ): Promise<FactRecord[]> {
    // Sanitize the user-supplied query into a safe FTS5 expression. FTS5
    // interprets `-`, `NEAR`, `NOT`, etc. as operators, so raw input like
    // "full-text search" parses as `full NOT text` and throws
    // `syntax error near "search"`. Token-quote each whitespace-separated
    // word and OR them; FTS5's MATCH semantics with quoted tokens is "find
    // any of these tokens", which matches what users naturally want from
    // free-text search.
    const sanitized = sanitizeFtsQuery(query);
    if (sanitized.length === 0) return [];

    // Build SQL with optional filters. We bind via placeholders so the
    // sanitized expression rides through SQLite parameter binding.
    const filters: string[] = [];
    const params: Array<string | number> = [sanitized];
    if (opts?.freshnessClass) {
      filters.push("AND f.freshness_class = ?");
      params.push(opts.freshnessClass);
    }
    if (opts?.notExpiredAt) {
      filters.push("AND (f.valid_until IS NULL OR f.valid_until > ?)");
      params.push(opts.notExpiredAt);
    }
    params.push(limit);

    const sql = `
      SELECT f.*
      FROM facts f
      JOIN facts_fts fts ON fts.rowid = f.rowid
      WHERE facts_fts MATCH ?
      ${filters.join(" ")}
      ORDER BY bm25(facts_fts)
      LIMIT ?
    `;
    const rows = this.db.query(sql).all(...params) as RawFactRow[];
    return rows.map(rowToFact);
  }

  private async searchFactsVector(
    query: string,
    opts: SearchFactsOptions | undefined,
    limit: number,
  ): Promise<FactRecord[]> {
    if (this.vectorIndex === null) return [];
    let queryVector: readonly number[];
    try {
      const response = await this.vectorIndex.provider.embed({
        inputs: [{ id: "__query__", text: query }],
      });
      const vector = response.vectors[0];
      if (vector === undefined) return [];
      queryVector = vector.values;
    } catch {
      return [];
    }

    const scored = this.vectorIndex.records
      .filter((record) => record.dimensions === queryVector.length)
      .map((record) => ({
        factId: record.factId,
        score: cosineSimilarity(queryVector, record.values),
      }))
      .filter((record) => Number.isFinite(record.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (scored.length === 0) return [];

    const factsById = this.getFactsByIds(scored.map((record) => record.factId));
    const out: FactRecord[] = [];
    for (const record of scored) {
      const fact = factsById.get(record.factId);
      if (fact === undefined) continue;
      if (!factMatchesFilters(fact, opts)) continue;
      out.push(fact);
    }
    return out;
  }

  async getFactById(id: string): Promise<FactRecord | null> {
    const row = this.db
      .query("SELECT * FROM facts WHERE id = ?")
      .get(id) as RawFactRow | null;
    return row ? rowToFact(row) : null;
  }

  private getFactsByIds(ids: readonly string[]): Map<string, FactRecord> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .query(`SELECT * FROM facts WHERE id IN (${placeholders})`)
      .all(...ids) as RawFactRow[];
    return new Map(rows.map((row) => [row.id, rowToFact(row)]));
  }
}

export function mergeFactsByRrf(
  ftsRanked: readonly FactRecord[],
  vectorRanked: readonly FactRecord[],
  limit: number,
  k = RRF_K,
): FactRecord[] {
  const byId = new Map<
    string,
    { fact: FactRecord; score: number; bestRank: number; firstSeen: number }
  >();
  let firstSeen = 0;

  const add = (facts: readonly FactRecord[]) => {
    facts.forEach((fact, index) => {
      const rank = index + 1;
      const score = 1 / (k + rank);
      const current = byId.get(fact.id);
      if (current === undefined) {
        byId.set(fact.id, {
          fact,
          score,
          bestRank: rank,
          firstSeen: firstSeen++,
        });
      } else {
        current.score += score;
        current.bestRank = Math.min(current.bestRank, rank);
      }
    });
  };

  add(ftsRanked);
  add(vectorRanked);

  return [...byId.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.bestRank - b.bestRank ||
        a.firstSeen - b.firstSeen,
    )
    .slice(0, normalizeLimit(limit))
    .map((entry) => entry.fact);
}

function normalizeLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
}

function factMatchesFilters(
  fact: FactRecord,
  opts: SearchFactsOptions | undefined,
): boolean {
  if (opts?.freshnessClass && fact.freshnessClass !== opts.freshnessClass) {
    return false;
  }
  if (
    opts?.notExpiredAt &&
    fact.validUntil !== null &&
    fact.validUntil <= opts.notExpiredAt
  ) {
    return false;
  }
  return true;
}

function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length || a.length === 0) return Number.NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return Number.NaN;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Convert a user-supplied free-text query into a safe FTS5 MATCH expression.
 *
 *   - Split on whitespace AND on hyphens: `full-text` → `["full", "text"]`.
 *     This matches the indexer side, which also splits on hyphens at
 *     tokenize time.
 *   - For each sub-token, strip any remaining char outside
 *     `[a-zA-Z0-9_']`. FTS5 reserves `*`, `(`, `)`, `:`, `^`, `"`; we drop
 *     them rather than try to escape. Apostrophes inside words (`user's`)
 *     are kept.
 *   - Quote each token with double-quotes (escaping any embedded `"` as
 *     `""` per FTS5 rules) so reserved keywords (`NEAR`, `NOT`, `AND`, `OR`)
 *     don't trigger their operator behavior.
 *   - Join with spaces — FTS5's implicit AND between quoted tokens.
 *
 * Why AND not OR? Both have problems with verbose natural-language
 * queries: AND is strict and may miss relevant single-aspect facts (the
 * user types 6 words and no single fact happens to mention all 6); OR is
 * permissive and pulls junk into the result set, which catastrophically
 * breaks negative-fixture expectations (`maxCitations: 0` queries find
 * something for any input). We pick precision (AND) over recall here.
 * The right long-term fix is to keep AND + add `bm25` score threshold
 * filtering or n-of-m partial matching; tracked for v0.3+.
 *
 * Returns "" when the input has no usable tokens; callers short-circuit
 * to an empty result list in that case.
 *
 * Exported for unit tests.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens: string[] = [];
  for (const word of query.split(/\s+/)) {
    for (const sub of word.split(/-+/)) {
      // Keep only chars FTS5 understands inside a token; drop everything
      // operator-like.
      const cleaned = sub.replace(/[^a-zA-Z0-9_']/g, "");
      if (cleaned.length === 0) continue;
      tokens.push(`"${cleaned.replace(/"/g, '""')}"`);
    }
  }
  return tokens.join(" ");
}

interface RawFactRow {
  id: string;
  text: string;
  type: FactType;
  entities: string; // JSON
  source_id: string;
  content_hash: string;
  url: string;
  excerpt: string;
  freshness_class: CacheableVolatility;
  valid_until: string | null;
  confidence: number;
  extracted_at: string;
  extractor_model: string;
  extractor_prompt_version: string;
  volatility_notes: string | null;
}

function rowToFact(r: RawFactRow): FactRecord {
  const fact: FactRecord = {
    id: r.id,
    text: r.text,
    type: r.type,
    entities: JSON.parse(r.entities) as string[],
    source: {
      sourceId: r.source_id,
      contentHash: r.content_hash,
      url: r.url,
      excerpt: r.excerpt,
    },
    freshnessClass: r.freshness_class,
    validUntil: r.valid_until,
    confidence: r.confidence,
    extractedAt: r.extracted_at,
    extractor: {
      model: r.extractor_model,
      promptVersion: r.extractor_prompt_version,
    },
    ...(r.volatility_notes !== null
      ? { volatilityNotes: r.volatility_notes }
      : {}),
  };
  return fact;
}
