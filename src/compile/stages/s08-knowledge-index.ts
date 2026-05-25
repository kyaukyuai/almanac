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
export function openKnowledgeReader(db: Database): KnowledgeReader {
  return new SqliteKnowledgeReader(db);
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

class SqliteKnowledgeReader implements KnowledgeReader {
  constructor(private readonly db: Database) {}

  async searchFacts(
    query: string,
    opts?: SearchFactsOptions,
  ): Promise<FactRecord[]> {
    if (!query || query.trim().length === 0) {
      return [];
    }
    const limit = Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

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

  async getFactById(id: string): Promise<FactRecord | null> {
    const row = this.db
      .query("SELECT * FROM facts WHERE id = ?")
      .get(id) as RawFactRow | null;
    return row ? rowToFact(row) : null;
  }
}

/**
 * Convert a user-supplied free-text query into a safe FTS5 MATCH expression.
 *
 *   - Split on whitespace.
 *   - For each token, strip any character outside [a-zA-Z0-9_'] (collapsing
 *     hyphenated words: `full-text` → `fulltext`). FTS5 reserves `-`, `*`,
 *     `(`, `)`, `:`, `^`, `"`; we just drop them rather than try to escape.
 *   - Quote each token with double-quotes (escaping any embedded `"` as
 *     `""` per FTS5 rules) so reserved keywords (`NEAR`, `NOT`, `AND`, `OR`)
 *     don't trigger their operator behavior.
 *   - Join with spaces; FTS5 treats space as implicit AND when query tokens
 *     are quoted phrases — exactly what we want for "find facts mentioning
 *     all of these terms".
 *
 * Returns "" when the input has no usable tokens; callers short-circuit
 * to an empty result list in that case.
 *
 * Exported for unit tests.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens: string[] = [];
  for (const raw of query.split(/\s+/)) {
    // Keep only chars FTS5 understands inside a token; drop everything
    // operator-like. Apostrophes within words are common (e.g., "user's")
    // and FTS5 accepts them inside a quoted token without further escaping.
    const cleaned = raw.replace(/[^a-zA-Z0-9_']/g, "");
    if (cleaned.length === 0) continue;
    tokens.push(`"${cleaned.replace(/"/g, '""')}"`);
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
