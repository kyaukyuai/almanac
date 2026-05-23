/**
 * Stage 8 — pipeline adapter for knowledge-index build.
 *
 *   1. Reads `extracted/facts.jsonl` (one `FactRecord` per line).
 *   2. Validates each line via `FactRecordSchema`. Malformed lines are
 *      logged and skipped — this mirrors Stage 5's lenient policy and keeps
 *      a stray blank line from killing the whole index build.
 *   3. Deletes any prior `knowledge/almanac.sqlite`, then calls
 *      `buildKnowledgeIndex` to populate a fresh SQLite + FTS5 database.
 *   4. Persists the resulting `KnowledgeIndexManifest` to
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
  FactRecordSchema,
  type FactRecord,
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
}

/**
 * Build the Stage 8 `StageRunner`. Deterministic stage: `promptVersion = null`.
 */
export function createKnowledgeIndexRunner(
  opts: CreateKnowledgeIndexRunnerOptions = {},
): StageRunner {
  const readFacts = opts.readFacts ?? defaultReadFacts;

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

      const built = buildKnowledgeIndex({
        almanacId: ctx.manifest.almanacId,
        facts,
        dbPath,
        builtAt: ctx.now(),
      });
      // Close immediately — runtime opens its own connection later.
      built.db.close();

      const manifestPath = knowledgeIndexManifestPath(ctx.almanacDir);
      const canonicalText = JSON.stringify(built.manifest, null, 2);
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage8:done",
        outputHash,
        factCount: built.manifest.factCount,
        factCorpusHash: built.manifest.factCorpusHash,
        sqliteVersion: built.manifest.sqliteVersion,
      });

      return {
        kind: "success",
        outputHash,
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

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
