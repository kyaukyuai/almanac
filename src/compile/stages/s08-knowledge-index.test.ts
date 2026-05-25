/**
 * Tests for Stage 8 — knowledge index.
 *
 *   - happy path: build :memory: db from sample facts, validate manifest
 *   - SqliteKnowledgeReader.searchFacts returns FTS5 matches
 *   - SqliteKnowledgeReader.searchFacts respects freshnessClass / notExpiredAt
 *   - SqliteKnowledgeReader.getFactById round-trips a single fact
 *   - empty input produces a valid empty manifest
 *   - corpus hash is stable across emission order
 */

import { describe, expect, test } from "bun:test";

import {
  KnowledgeIndexManifestSchema,
  type FactRecord,
} from "../../core/types.ts";
import {
  buildKnowledgeIndex,
  openKnowledgeReader,
  sanitizeFtsQuery,
} from "./s08-knowledge-index.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const ULID = (n: number) => `01H000000000000000000000${n.toString(36).toUpperCase().padStart(2, "0")}`;
const HASH = (n: number) => "abcdef".repeat(10) + n.toString().padStart(4, "0");

const facts: FactRecord[] = [
  {
    id: ULID(1),
    text: "The Maillard reaction is a chemical reaction between amino acids and reducing sugars that gives browned food its distinctive flavor.",
    type: "definition",
    entities: ["maillard", "browning", "amino-acids"],
    source: {
      sourceId: "seriouseats-docs",
      contentHash: HASH(1),
      url: "https://www.seriouseats.com/maillard-reaction",
      excerpt: "The Maillard reaction occurs at temperatures above 140°C.",
    },
    freshnessClass: "static",
    validUntil: null,
    confidence: 0.95,
    extractedAt: "2026-05-08T12:00:00.000Z",
    extractor: { model: "claude-sonnet-4", promptVersion: "05-fact-extraction/v1" },
  },
  {
    id: ULID(2),
    text: "Buttermilk can be substituted with whole milk plus one tablespoon of lemon juice or vinegar per cup.",
    type: "procedure",
    entities: ["buttermilk", "substitution", "lemon"],
    source: {
      sourceId: "seriouseats-docs",
      contentHash: HASH(2),
      url: "https://www.seriouseats.com/buttermilk",
      excerpt: "Substitute 1 cup buttermilk with 1 cup milk + 1 tbsp lemon juice.",
    },
    freshnessClass: "static",
    validUntil: null,
    confidence: 0.9,
    extractedAt: "2026-05-08T12:00:00.000Z",
    extractor: { model: "claude-sonnet-4", promptVersion: "05-fact-extraction/v1" },
  },
  {
    id: ULID(3),
    text: "Sous vide circulators commonly recommend 60°C for medium steak based on contemporary professional kitchen practice.",
    type: "fact",
    entities: ["sous-vide", "steak", "temperature"],
    source: {
      sourceId: "cooks-illustrated-docs",
      contentHash: HASH(3),
      url: "https://www.cooksillustrated.com/sous-vide-steak",
      excerpt: "60°C yields a medium doneness in beef.",
    },
    freshnessClass: "slow",
    validUntil: "2026-06-08T12:00:00.000Z",
    confidence: 0.85,
    extractedAt: "2026-05-08T12:00:00.000Z",
    extractor: { model: "claude-sonnet-4", promptVersion: "05-fact-extraction/v1" },
    volatilityNotes: "Refresh when new cookbook editions land.",
  },
  {
    id: ULID(4),
    text: "Older sous vide guidance from the 1990s recommended 65°C, before contemporary precision-cooking norms.",
    type: "fact",
    entities: ["sous-vide", "steak", "temperature", "history"],
    source: {
      sourceId: "cooks-illustrated-docs",
      contentHash: HASH(4),
      url: "https://www.cooksillustrated.com/sous-vide-history",
      excerpt: "Earlier guidance recommended higher temperatures.",
    },
    freshnessClass: "slow",
    validUntil: "2026-04-01T00:00:00.000Z", // already expired relative to test "now"
    confidence: 0.8,
    extractedAt: "2026-04-01T00:00:00.000Z",
    extractor: { model: "claude-sonnet-4", promptVersion: "05-fact-extraction/v1" },
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Build
// ──────────────────────────────────────────────────────────────────────────────

describe("buildKnowledgeIndex", () => {
  test("produces a validated manifest with correct counts", () => {
    const { manifest, db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
      builtAt: new Date("2026-05-08T12:30:00.000Z"),
    });
    expect(() => KnowledgeIndexManifestSchema.parse(manifest)).not.toThrow();
    expect(manifest.factCount).toBe(4);
    expect(manifest.counts.byClass).toEqual({ static: 2, slow: 2 });
    expect(manifest.counts.byType).toEqual({
      fact: 2,
      definition: 1,
      procedure: 1,
      opinion: 0,
      reference: 0,
      principle: 0,
      heuristic: 0,
      tradeoff: 0,
      framework: 0,
    });
    expect(manifest.sqliteVersion).toMatch(/^\d+\.\d+(?:\.\d+)?$/);
    expect(manifest.builtAt).toBe("2026-05-08T12:30:00.000Z");
    db.close();
  });

  test("empty corpus produces a valid empty manifest", () => {
    const { manifest, db } = buildKnowledgeIndex({
      almanacId: "x",
      facts: [],
      dbPath: ":memory:",
    });
    expect(manifest.factCount).toBe(0);
    expect(manifest.counts.byClass).toEqual({ static: 0, slow: 0 });
    db.close();
  });

  test("corpus hash is stable across emission order", () => {
    const a = buildKnowledgeIndex({
      almanacId: "x",
      facts,
      dbPath: ":memory:",
    });
    const b = buildKnowledgeIndex({
      almanacId: "x",
      facts: [...facts].reverse(),
      dbPath: ":memory:",
    });
    expect(a.manifest.factCorpusHash).toBe(b.manifest.factCorpusHash);
    a.db.close();
    b.db.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SqliteKnowledgeReader
// ──────────────────────────────────────────────────────────────────────────────

describe("SqliteKnowledgeReader.searchFacts", () => {
  test("FTS5 returns matching facts", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    const r = await reader.searchFacts("maillard");
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0]!.entities).toContain("maillard");
    db.close();
  });

  test("respects limit", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    const r = await reader.searchFacts("sous vide", { limit: 1 });
    expect(r).toHaveLength(1);
    db.close();
  });

  test("freshnessClass filter excludes other classes", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    const onlyStatic = await reader.searchFacts("buttermilk", {
      freshnessClass: "static",
    });
    expect(onlyStatic.length).toBeGreaterThan(0);
    for (const f of onlyStatic) expect(f.freshnessClass).toBe("static");

    const onlySlow = await reader.searchFacts("sous", {
      freshnessClass: "slow",
    });
    expect(onlySlow.length).toBeGreaterThan(0);
    for (const f of onlySlow) expect(f.freshnessClass).toBe("slow");
    db.close();
  });

  test("notExpiredAt filter drops facts past validUntil", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    // Without filter both sous-vide facts return.
    const all = await reader.searchFacts("sous");
    expect(all.length).toBe(2);
    // With filter at "2026-05-08", the 2026-04-01 fact is expired.
    const fresh = await reader.searchFacts("sous", {
      notExpiredAt: "2026-05-08T00:00:00.000Z",
    });
    expect(fresh.length).toBe(1);
    expect(fresh[0]!.id).toBe(facts[2]!.id);
    db.close();
  });

  test("empty query returns []", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    expect(await reader.searchFacts("")).toEqual([]);
    expect(await reader.searchFacts("   ")).toEqual([]);
    db.close();
  });

  test("hyphenated query no longer trips FTS5 (regression)", async () => {
    // Real-LLM smoke run: "create full-text search index fts5" threw
    // `fts5: syntax error near "search"` because '-' is an FTS5 operator.
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    const result = await reader.searchFacts(
      "create full-text search index fts5",
    );
    expect(Array.isArray(result)).toBe(true);
    db.close();
  });

  test("FTS5-reserved keywords don't trigger operator behavior", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    // Bare AND/OR/NOT/NEAR used to short-circuit the query. With quoting
    // they're treated as ordinary tokens.
    const result = await reader.searchFacts("AND OR NOT NEAR");
    expect(Array.isArray(result)).toBe(true);
    db.close();
  });
});

describe("sanitizeFtsQuery", () => {
  test("plain ASCII tokens are quoted and joined", () => {
    expect(sanitizeFtsQuery("buttermilk substitute")).toBe(
      '"buttermilk" "substitute"',
    );
  });

  test("hyphens split tokens (full-text → full + text, matching indexer behavior)", () => {
    expect(sanitizeFtsQuery("full-text search")).toBe(
      '"full" "text" "search"',
    );
  });

  test("multiple hyphens within a single word all split", () => {
    expect(sanitizeFtsQuery("foo-bar-baz")).toBe('"foo" "bar" "baz"');
  });

  test("FTS5 operator chars are dropped", () => {
    // *, (, ), :, ^, " are reserved FTS5 chars.
    expect(sanitizeFtsQuery("foo* (bar) baz:qux")).toBe(
      '"foo" "bar" "bazqux"',
    );
  });

  test("apostrophes inside words are kept", () => {
    expect(sanitizeFtsQuery("user's manual")).toBe(`"user's" "manual"`);
  });

  test("empty + whitespace-only input → empty string", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
    expect(sanitizeFtsQuery("** -- !!")).toBe("");
  });
});

describe("SqliteKnowledgeReader.getFactById", () => {
  test("round-trips a fact (incl. entities, validUntil, volatilityNotes)", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    const got = await reader.getFactById(facts[2]!.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(facts[2]!.id);
    expect(got!.entities).toEqual(facts[2]!.entities);
    expect(got!.validUntil).toBe(facts[2]!.validUntil);
    expect(got!.volatilityNotes).toBe(facts[2]!.volatilityNotes);
    db.close();
  });

  test("returns null for unknown id", async () => {
    const { db } = buildKnowledgeIndex({
      almanacId: "cooking",
      facts,
      dbPath: ":memory:",
    });
    const reader = openKnowledgeReader(db);
    expect(await reader.getFactById("01H0000000000000000000000Z")).toBeNull();
    db.close();
  });
});
