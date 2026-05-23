/**
 * Stage 5 — fact extraction.
 *
 *   1. Reads the Stage 1 `DomainSpec`           (`.compile/domain-spec.json`)
 *   2. Reads the Stage 3 approved `SourcesFile` (`sources/sources.json`)
 *   3. Reads the Stage 4 `SourceFetchManifest`  (`sources/manifest.summary.json`)
 *   4. For every `fetched` entry in the manifest, loads each document's raw
 *      bytes from `<almanacDir>/<doc.relPath>`, decodes UTF-8, splits the
 *      text into fixed-character chunks, and asks the LLM to emit an
 *      `ExtractionResult` per chunk. Drafts are materialized into canonical
 *      `FactRecord`s via `materializeFact()`.
 *   5. Streams every validated record as JSONL to
 *      `<almanacDir>/extracted/facts.jsonl` (one record per line).
 *
 * Per-record validation is **lenient**: a single malformed `ExtractedFactDraft`
 * is logged as `stage5:malformed-record` and skipped — the rest of the chunk's
 * facts are still written. A whole chunk that fails JSON.parse / schema is
 * logged as `stage5:malformed-chunk` and skipped. The stage only fails when
 * upstream artifacts are missing (typed errors).
 *
 * `outputHash` = sha256 of the concatenated JSONL body actually written.
 * Determinism: ULIDs are derived from `sha256(contentHash:chunkIdx:factIdx)`,
 * `extractedAt` is `ctx.now()`, sources are iterated in manifest order, and
 * chunks in encounter order — so identical inputs produce identical hashes.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  ExtractedFactDraftSchema,
  ExtractionResultSchema,
  SourceFetchManifestSchema,
  SourcesFileSchema,
  isFetchedEntry,
  materializeFact,
  type ApprovedSource,
  type DomainSpec,
  type ExtractionResult,
  type FactRecord,
  type SourceFetchManifest,
  type SourcesFile,
} from "../../core/types.ts";
import { type LlmProvider } from "../../llm/provider.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { loadPromptTemplate } from "../prompt-loader.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { approvedSourcesPath } from "./s03-approve-runner.ts";
import { sourceFetchManifestPath } from "./s04-source-fetch-runner.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE5_PROMPT_VERSION = "v1";
export const STAGE5_PROMPT_STAGE_ID = "05-fact-extraction";

/** Matches `recommendedModel` in `prompts/05-fact-extraction/v1.md`. */
export const STAGE5_DEFAULT_MODEL = "claude-sonnet-4-5";
export const STAGE5_DEFAULT_MAX_TOKENS = 6144;
export const STAGE5_DEFAULT_TEMPERATURE = 0.1;

/** Char-count chunk size for v0.1 (no sentence-boundary detection). */
export const STAGE5_DEFAULT_CHUNK_CHARS = 4000;
/** Overlap between adjacent chunks so claims spanning a boundary survive. */
export const STAGE5_DEFAULT_CHUNK_OVERLAP = 200;
/** Hard cap to keep a single huge document from exploding LLM cost. */
export const STAGE5_DEFAULT_MAX_CHUNKS_PER_DOC = 12;

export const FACTS_JSONL_REL_PATH = "extracted/facts.jsonl";

export function factsJsonlPath(almanacDir: string): string {
  return join(almanacDir, FACTS_JSONL_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingFetchManifestError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 5 requires the Stage 4 fetch manifest at ${path}; ` +
        "run Stage 4 first or restore the file",
    );
    this.name = "MissingFetchManifestError";
  }
}

export class MissingApprovedSourcesError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 5 requires the Stage 3 approved SourcesFile at ${path}; ` +
        "run Stage 3 first or restore the file",
    );
    this.name = "MissingApprovedSourcesError";
  }
}

export class MissingDomainSpecError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 5 requires the Stage 1 DomainSpec at ${path}; ` +
        "run Stage 1 first or restore the file",
    );
    this.name = "MissingDomainSpecError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateFactExtractionRunnerOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE5_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE5_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE5_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;
  /** Override the default chunk size (chars). */
  chunkChars?: number;
  /** Override the default chunk overlap (chars). */
  chunkOverlap?: number;
  /** Override the per-document chunk cap. */
  maxChunksPerDoc?: number;

  /** Test seam for reading Stage 1 output. */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
  /** Test seam for reading Stage 3 output. */
  readApproved?: (almanacDir: string) => Promise<SourcesFile>;
  /** Test seam for reading Stage 4 output. */
  readFetchManifest?: (almanacDir: string) => Promise<SourceFetchManifest>;
  /** Test seam for reading raw document bytes. */
  readDocument?: (
    almanacDir: string,
    relPath: string,
  ) => Promise<Uint8Array>;
}

/**
 * Build the Stage 5 `StageRunner`. Records `promptVersion = "v1"`.
 */
export function createFactExtractionRunner(
  opts: CreateFactExtractionRunnerOptions,
): StageRunner {
  const model = opts.model ?? STAGE5_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE5_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE5_DEFAULT_TEMPERATURE;
  const chunkChars = opts.chunkChars ?? STAGE5_DEFAULT_CHUNK_CHARS;
  const chunkOverlap = opts.chunkOverlap ?? STAGE5_DEFAULT_CHUNK_OVERLAP;
  const maxChunksPerDoc =
    opts.maxChunksPerDoc ?? STAGE5_DEFAULT_MAX_CHUNKS_PER_DOC;
  const readDomainSpec = opts.readDomainSpec ?? defaultReadDomainSpec;
  const readApproved = opts.readApproved ?? defaultReadApproved;
  const readFetchManifest =
    opts.readFetchManifest ?? defaultReadFetchManifest;
  const readDocument = opts.readDocument ?? defaultReadDocument;

  return {
    promptVersion: STAGE5_PROMPT_VERSION,
    async run(ctx) {
      const [domainSpec, approved, manifest] = await Promise.all([
        readDomainSpec(ctx.almanacDir),
        readApproved(ctx.almanacDir),
        readFetchManifest(ctx.almanacDir),
      ]);

      const sourcesById = new Map<string, ApprovedSource>(
        approved.sources.map((s) => [s.id, s]),
      );
      const domainSpecJson = indentBlock(
        JSON.stringify(domainSpec, null, 2),
        2,
      );

      const callName = `${STAGE5_PROMPT_STAGE_ID}@${STAGE5_PROMPT_VERSION}`;

      ctx.log({
        event: "stage5:start",
        callName,
        sources: manifest.entries.length,
      });

      const writtenLines: string[] = [];
      let llmCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      for (const entry of manifest.entries) {
        if (!isFetchedEntry(entry)) continue;
        const approvedSource = sourcesById.get(entry.sourceId);
        if (approvedSource === undefined) {
          ctx.log({
            event: "stage5:source-not-in-approved",
            sourceId: entry.sourceId,
          });
          continue;
        }

        const sourceJson = indentBlock(
          JSON.stringify(
            {
              id: approvedSource.id,
              url: approvedSource.url,
              kind: approvedSource.kind,
              volatility: approvedSource.volatility,
            },
            null,
            2,
          ),
          2,
        );

        for (const doc of entry.documents) {
          let text: string;
          try {
            const bytes = await readDocument(ctx.almanacDir, doc.relPath);
            text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          } catch (cause) {
            ctx.log({
              event: "stage5:document-read-failed",
              sourceId: entry.sourceId,
              relPath: doc.relPath,
              error: (cause as Error).message,
            });
            continue;
          }

          const chunks = chunkText(
            text,
            chunkChars,
            chunkOverlap,
            maxChunksPerDoc,
          );

          for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            const chunk = chunks[chunkIdx]!;
            const prompt = loadPromptTemplate({
              stageId: STAGE5_PROMPT_STAGE_ID,
              version: STAGE5_PROMPT_VERSION,
              ...(opts.promptsDir !== undefined
                ? { promptsDir: opts.promptsDir }
                : {}),
              vars: {
                domainSpecJson,
                sourceJson,
                content: indentBlock(chunk, 2),
              },
            });
            const completion = await opts.provider.complete({
              model,
              maxTokens,
              temperature,
              callName,
              messages: [
                { role: "system", content: prompt.system },
                { role: "user", content: prompt.user },
              ],
            });
            llmCalls += 1;
            inputTokens += completion.usage.inputTokens;
            outputTokens += completion.usage.outputTokens;

            const result = parseExtractionResult(
              completion.text,
              ctx.log,
              entry.sourceId,
              chunkIdx,
            );
            if (result === null) continue;
            if (result.status !== "extracted") {
              ctx.log({
                event: "stage5:chunk-skipped",
                sourceId: entry.sourceId,
                chunkIdx,
                status: result.status,
                skipReason: result.skipReason,
              });
              continue;
            }

            for (let factIdx = 0; factIdx < result.facts.length; factIdx++) {
              const draft = result.facts[factIdx]!;
              // Re-validate (defensive: ExtractionResultSchema already
              // validated, but a follow-up parser change shouldn't silently
              // bypass per-record validation here).
              const reparsed = ExtractedFactDraftSchema.safeParse(draft);
              if (!reparsed.success) {
                ctx.log({
                  event: "stage5:malformed-record",
                  sourceId: entry.sourceId,
                  chunkIdx,
                  factIdx,
                  issues: reparsed.error.issues,
                });
                continue;
              }
              let record: FactRecord;
              try {
                record = materializeFact(reparsed.data, {
                  id: deriveUlid(
                    `${doc.contentHash}:${chunkIdx}:${factIdx}`,
                  ),
                  sourceId: entry.sourceId,
                  contentHash: doc.contentHash,
                  url: doc.url,
                  extractedAt: ctx.now(),
                  extractor: {
                    model,
                    promptVersion: STAGE5_PROMPT_VERSION,
                  },
                });
              } catch (cause) {
                ctx.log({
                  event: "stage5:malformed-record",
                  sourceId: entry.sourceId,
                  chunkIdx,
                  factIdx,
                  error: (cause as Error).message,
                });
                continue;
              }
              writtenLines.push(JSON.stringify(record));
            }
          }
        }
      }

      const body =
        writtenLines.length === 0 ? "" : writtenLines.join("\n") + "\n";
      const outPath = factsJsonlPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, body, "utf8");

      const outputHash = sha256Hex(body);
      ctx.log({
        event: "stage5:done",
        outputHash,
        records: writtenLines.length,
        llmCalls,
      });

      return {
        kind: "success",
        outputHash,
        llmCalls,
        cost: {
          tokens: { input: inputTokens, output: outputTokens },
          usd: 0,
        },
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseExtractionResult(
  rawText: string,
  log: (e: object) => void,
  sourceId: string,
  chunkIdx: number,
): ExtractionResult | null {
  const jsonText = stripFence(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    log({
      event: "stage5:malformed-chunk",
      sourceId,
      chunkIdx,
      reason: "json-parse-error",
      error: (cause as Error).message,
    });
    return null;
  }
  const result = ExtractionResultSchema.safeParse(parsed);
  if (!result.success) {
    log({
      event: "stage5:malformed-chunk",
      sourceId,
      chunkIdx,
      reason: "schema-validation-error",
      issues: result.error.issues,
    });
    return null;
  }
  return result.data;
}

/**
 * Split `text` into fixed-character chunks with a constant overlap. Trims to
 * `maxChunks` and never yields an empty trailing chunk.
 */
export function chunkText(
  text: string,
  chunkChars: number,
  overlap: number,
  maxChunks: number,
): string[] {
  if (text.length === 0) return [];
  if (chunkChars <= 0) return [text];
  const stride = Math.max(1, chunkChars - Math.max(0, overlap));
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < maxChunks; i += stride) {
    const slice = text.slice(i, i + chunkChars);
    if (slice.length === 0) break;
    chunks.push(slice);
    if (i + chunkChars >= text.length) break;
  }
  return chunks;
}

/**
 * Crockford-base32 alphabet (no I, L, O, U). Matches the regex
 * `/^[0-9A-HJKMNP-TV-Z]{26}$/` used by `FactRecordSchema.id`.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Derive a deterministic 26-char ULID-shaped id from `seed`. Not a real ULID
 * (no embedded timestamp), but it satisfies the schema and is stable across
 * runs given identical inputs — which is what callers actually need.
 */
export function deriveUlid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  // 26 chars * 5 bits = 130 bits → 17 bytes (136 bits) is enough.
  let bits = "";
  for (let i = 0; i < 17; i++) {
    bits += hash[i]!.toString(2).padStart(8, "0");
  }
  bits = bits.slice(0, 130);
  let out = "";
  for (let i = 0; i < 130; i += 5) {
    out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

/** Indent every line by `n` spaces — re-used from earlier stage helpers. */
export function indentBlock(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}

// ──────────────────────────────────────────────────────────────────────────────
// Default readers
// ──────────────────────────────────────────────────────────────────────────────

async function defaultReadDomainSpec(
  almanacDir: string,
): Promise<DomainSpec> {
  const path = domainSpecPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingDomainSpecError(path, cause);
    }
    throw cause;
  }
  return DomainSpecSchema.parse(JSON.parse(body));
}

async function defaultReadApproved(
  almanacDir: string,
): Promise<SourcesFile> {
  const path = approvedSourcesPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingApprovedSourcesError(path, cause);
    }
    throw cause;
  }
  const parsed = SourcesFileSchema.parse(JSON.parse(body));
  if (parsed.status !== "approved") {
    throw new Error(
      `Stage 5: SourcesFile at ${path} has status="${parsed.status}", expected "approved"`,
    );
  }
  return parsed;
}

async function defaultReadFetchManifest(
  almanacDir: string,
): Promise<SourceFetchManifest> {
  const path = sourceFetchManifestPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingFetchManifestError(path, cause);
    }
    throw cause;
  }
  return SourceFetchManifestSchema.parse(JSON.parse(body));
}

async function defaultReadDocument(
  almanacDir: string,
  relPath: string,
): Promise<Uint8Array> {
  const abs = join(almanacDir, relPath);
  const buf = await readFile(abs);
  return new Uint8Array(buf);
}

// Re-export referenced types so tests can import everything from this module.
export type { ExtractionResult, FactRecord, SourceFetchManifest };
