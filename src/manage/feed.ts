/**
 * `almanac feed <id> <url>` — add a single source incrementally.
 *
 * The pipeline that `almanac new` runs is one-shot: it produces a complete
 * almanac from a domain string. `feed` is the opposite shape — given an
 * already-compiled almanac, add ONE new source URL without re-running the
 * LLM-heavy upstream stages (domain analysis, source discovery, tool design,
 * benchmark generation).
 *
 * Flow:
 *
 *   1. Read existing state — manifest, sources.json, sources/manifest.summary.json,
 *      extracted/facts.jsonl.
 *   2. Construct an `ApprovedSource` from the user's URL + flags. Smart
 *      defaults: kind=docs, trust=0.85, mode=snapshot, snapshot scope=["/"]
 *      (or ["docs/**","README.md"] for repos). The source id is derived
 *      from the hostname + path; the user can override with --source-id.
 *   3. Refuse if the URL or id already lives in sources.json, unless
 *      `replaceExisting` is set. Replacement is for promoting an accepted
 *      index-only source to a better snapshot URL without exceeding the
 *      accepted-source budget.
 *   4. Dry-run by default: print the plan, write nothing.
 *   5. Apply path:
 *      - Append or replace the source in sources/sources.json (recompute
 *        coverage + acceptedCount via the standard normalize pass).
 *      - Run Stage 4's `runSourceFetch` over a one-element SourcesFile so
 *        the existing fetcher chain handles it (no special-case code).
 *      - Append or replace the resulting `SourceFetchEntry` in
 *        sources/manifest.summary.json with summary counts recomputed.
 *      - Run Stage 5 via `createFactExtractionRunner` with seamed inputs
 *        that point at JUST the new source. The runner writes a fresh
 *        facts.jsonl containing only the new facts; this function then
 *        prepends the retained pre-existing facts so the on-disk file remains
 *        the full corpus. During replacement, facts from the old source id are
 *        removed before new facts are merged.
 *      - Rebuild Stage 8's `knowledge/almanac.sqlite` + index-manifest
 *        from the merged jsonl via the standard runner.
 *      - Bump `manifest.factCount` + patch the semver, persist.
 *
 * `feed` deliberately does NOT touch:
 *   - DOMAIN.md / AGENTS.md / SKILLS.md — tool list and contract unchanged
 *   - adapters/skill/SKILL.md
 *   - tools/* — tool design + impl come from Stage 6/7, not the source list
 *   - tests/positive.jsonl + tests/negative.jsonl — benchmark unchanged
 *
 * If you DO want those refreshed (e.g., the new source justifies a new
 * tool), run `almanac update <id> --from-stage=06-tool-design` afterwards.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AlmanacManifestSchema,
  ApprovedSourceSchema,
  SourceFetchManifestSchema,
  SourcesFileSchema,
  SOURCE_KINDS,
  buildSourceFetchManifest,
  type AlmanacManifest,
  type ApprovedSource,
  type IngestionMode,
  type SourceFetchEntry,
  type SourceFetchManifest,
  type SourceKind,
  type SourcesFile,
} from "../core/types.ts";
import {
  knowledgeIndexManifestPath,
  readManifest,
  writeManifest,
} from "../compile/storage.ts";
import { approvedSourcesPath } from "../compile/stages/s03-approve-runner.ts";
import { runSourceFetch } from "../compile/stages/s04-source-fetch.ts";
import {
  createFactExtractionRunner,
  factsJsonlPath,
} from "../compile/stages/s05-fact-extraction.ts";
import {
  createKnowledgeIndexRunner,
  knowledgeDbPath,
} from "../compile/stages/s08-knowledge-index-runner.ts";
import { sourceFetchManifestPath } from "../compile/stages/s04-source-fetch-runner.ts";
import {
  createWriteRaw,
  sha256HexBytes,
} from "../compile/fetchers/raw-writer.ts";
import type { FetchContext, Fetcher } from "../compile/fetchers/types.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { bumpSemver } from "../compile/pipeline.ts";
import type { StageContext } from "../compile/pipeline.ts";
import { domainSpecPath } from "../compile/stages/s01-domain-analysis.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────────────

export interface RunFeedInput {
  almanacDir: string;
  /** External URL to add. http(s) only for v0.2; file:// can come later. */
  url: string;
  /** Source kind. Defaults to `"docs"`. */
  kind?: SourceKind;
  /** Trust score in `[0, 1]`. Defaults to `0.85`. */
  trust?: number;
  /** Ingestion mode. Defaults to `"snapshot"`. */
  mode?: IngestionMode;
  /** One-line rationale recorded on the new ApprovedSource. */
  rationale?: string;
  /**
   * Override the derived source id. Must match the SourcesFile id format
   * (lowercase kebab; see SOURCE_ID regex in core/types.ts).
   */
  sourceId?: string;
  /**
   * Glob patterns for `ingestion.scope`. Defaults vary by kind: repos get
   * `["docs/**", "README.md"]`; everything else gets `["/"]`.
   */
  scope?: readonly string[];
  /** Dry-run by default; pass `true` to commit changes to disk. */
  apply: boolean;
  /**
   * Replace an existing source with the same id instead of appending a new
   * source. Useful when promoting `index-only` official sources to `snapshot`
   * PDFs/pages after the first compile.
   */
  replaceExisting?: boolean;
  /** LLM provider for Stage 5 fact extraction. */
  llm: LlmProvider;
  /** Stage 4 fetcher chain (same as `defaultFetchers()` from cli). */
  fetchers: Fetcher[];
  /** Structured event log. Defaults to no-op. */
  log?: (event: object) => void;
  /** Wall-clock provider. Defaults to `new Date()`. */
  now?: () => Date;
  /** Per-request HTTP timeout passed to fetcher ctx. Defaults to 10s. */
  fetchTimeoutMs?: number;
  /** Per-document byte cap passed to fetcher ctx. Defaults to 256 KiB. */
  fetchMaxBytes?: number;
}

export type FeedResult =
  | {
      kind: "dry-run";
      operation: "add" | "replace";
      newSource: ApprovedSource;
      replacedSource: ApprovedSource | null;
      existingSourcesCount: number;
    }
  | {
      kind: "skipped";
      reason: string;
      newSource: ApprovedSource;
    }
  | {
      kind: "applied";
      operation: "add" | "replace";
      newSource: ApprovedSource;
      replacedSource: ApprovedSource | null;
      fetchEntry: SourceFetchEntry;
      factsAdded: number;
      newFactCount: number;
      newVersion: string;
    };

export class FeedAlreadyExistsError extends Error {
  constructor(
    public readonly conflictBy: "id" | "url",
    public readonly value: string,
  ) {
    super(
      `source already in sources.json (matched by ${conflictBy}: "${value}")`,
    );
    this.name = "FeedAlreadyExistsError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core
// ──────────────────────────────────────────────────────────────────────────────

export async function runFeed(input: RunFeedInput): Promise<FeedResult> {
  const log = input.log ?? (() => {});
  const now = input.now ?? (() => new Date());

  // ── 1. Read existing state ────────────────────────────────────────────────
  const manifest = await readManifest(input.almanacDir);
  const sourcesFile = await readApprovedSourcesFile(input.almanacDir);
  const existingFetchManifest = await readFetchManifestIfPresent(
    input.almanacDir,
    manifest.almanacId,
    now(),
  );

  // ── 2. Build the ApprovedSource ───────────────────────────────────────────
  const newSource = buildApprovedSource(input);
  const validatedSource = ApprovedSourceSchema.parse(newSource);
  const operation = input.replaceExisting === true ? "replace" : "add";

  // ── 3. Idempotency: refuse if id or url already exists ────────────────────
  let replacedSource: ApprovedSource | null = null;
  for (const s of sourcesFile.sources) {
    if (s.id === validatedSource.id) {
      if (input.replaceExisting === true) {
        replacedSource = s;
        continue;
      }
      log({
        event: "feed:skipped",
        reason: "duplicate-id",
        sourceId: validatedSource.id,
      });
      return {
        kind: "skipped",
        reason: `source id "${validatedSource.id}" already exists; pass --source-id to override`,
        newSource: validatedSource,
      };
    }
    if (s.url === validatedSource.url) {
      if (input.replaceExisting === true && s.id === validatedSource.id) {
        continue;
      }
      log({
        event: "feed:skipped",
        reason: "duplicate-url",
        url: validatedSource.url,
      });
      return {
        kind: "skipped",
        reason: `url "${validatedSource.url}" already exists as source "${s.id}"`,
        newSource: validatedSource,
      };
    }
  }
  if (input.replaceExisting === true && replacedSource === null) {
    log({
      event: "feed:skipped",
      reason: "replace-missing",
      sourceId: validatedSource.id,
    });
    return {
      kind: "skipped",
      reason: `--replace requested but source id "${validatedSource.id}" does not exist`,
      newSource: validatedSource,
    };
  }

  // ── 4. Dry-run ────────────────────────────────────────────────────────────
  if (!input.apply) {
    log({
      event: "feed:dry-run",
      operation,
      sourceId: validatedSource.id,
      url: validatedSource.url,
      kind: validatedSource.kind,
      mode: validatedSource.ingestion.mode,
    });
    return {
      kind: "dry-run",
      operation,
      newSource: validatedSource,
      replacedSource,
      existingSourcesCount: sourcesFile.sources.length,
    };
  }

  // ── 5a. Persist updated sources.json ──────────────────────────────────────
  const updatedSourcesFile =
    input.replaceExisting === true
      ? replaceSourceInSourcesFile(sourcesFile, validatedSource)
      : appendSourceToSourcesFile(sourcesFile, validatedSource);
  const sourcesPath = approvedSourcesPath(input.almanacDir);
  await writeFile(
    sourcesPath,
    JSON.stringify(updatedSourcesFile, null, 2) + "\n",
    "utf8",
  );
  log({
    event: "feed:sources-updated",
    operation,
    sourceId: validatedSource.id,
    totalSources: updatedSourcesFile.sources.length,
  });

  // ── 5b. Fetch the new source via Stage 4's runSourceFetch ─────────────────
  const singleSourceFile: SourcesFile = {
    ...updatedSourcesFile,
    sources: [validatedSource],
  };
  const fetchCtxBase: Omit<FetchContext, "almanacDir"> = {
    fetch: globalThis.fetch,
    now,
    hashContent: sha256HexBytes,
    log,
    maxBytes: input.fetchMaxBytes ?? 256 * 1024,
    timeoutMs: input.fetchTimeoutMs ?? 10_000,
    writeRaw: createWriteRaw(input.almanacDir),
  };
  const fetchManifest = await runSourceFetch({
    sourcesFile: singleSourceFile,
    almanacDir: input.almanacDir,
    fetchers: input.fetchers,
    ctx: fetchCtxBase,
    continueOnError: true,
  });
  const newEntry = fetchManifest.entries[0];
  if (newEntry === undefined) {
    throw new Error(
      "feed: Stage 4 produced no fetch entry for the single new source (internal error)",
    );
  }
  log({
    event: "feed:fetched",
    sourceId: newEntry.sourceId,
    status: newEntry.status,
  });

  // ── 5c. Merge fetch entry into the persistent manifest.summary.json ──────
  const retainedFetchEntries =
    input.replaceExisting === true
      ? (existingFetchManifest?.entries ?? []).filter(
          (entry) => entry.sourceId !== validatedSource.id,
        )
      : (existingFetchManifest?.entries ?? []);
  const mergedFetchManifest = buildSourceFetchManifest({
    almanacId: manifest.almanacId,
    startedAt: parseISOOrNow(existingFetchManifest?.startedAt) ?? now(),
    finishedAt: now(),
    entries: [...retainedFetchEntries, newEntry],
  });
  const fetchManifestOut = sourceFetchManifestPath(input.almanacDir);
  await mkdir(dirname(fetchManifestOut), { recursive: true });
  await writeFile(
    fetchManifestOut,
    JSON.stringify(mergedFetchManifest, null, 2) + "\n",
    "utf8",
  );

  // ── 5d. Extract facts for the new source (Stage 5) ────────────────────────
  // Strategy: back up the existing facts.jsonl, run the standard Stage 5
  // runner with seamed reads that expose ONLY the new source's fetch entry,
  // then prepend the retained old facts onto the new lines the runner wrote.
  const factsPath = factsJsonlPath(input.almanacDir);
  const existingFactsBody = (await readFile(factsPath, "utf8").catch(() => "")).trimEnd();
  const retainedFactsBody =
    input.replaceExisting === true
      ? removeFactsForSource(existingFactsBody, validatedSource.id)
      : existingFactsBody;
  // Back up so we can restore on any failure mid-stage.
  const backupPath = `${factsPath}.feed-backup`;
  if (existingFactsBody.length > 0) {
    await copyFile(factsPath, backupPath);
  }

  let factsAdded = 0;
  try {
    const stageRunner = createFactExtractionRunner({
      provider: input.llm,
      readDomainSpec: async () => {
        const body = await readFile(domainSpecPath(input.almanacDir), "utf8");
        return JSON.parse(body);
      },
      readApproved: async () => singleSourceFile,
      readFetchManifest: async () =>
        buildSourceFetchManifest({
          almanacId: manifest.almanacId,
          startedAt: now(),
          finishedAt: now(),
          entries: [newEntry],
        }),
    });

    await stageRunner.run({
      almanacDir: input.almanacDir,
      manifest,
      state: synthesizeStubState(),
      stageId: "05-fact-extraction",
      log,
      now,
    } as unknown as StageContext);

    // The runner wrote a fresh facts.jsonl with ONLY the new lines. Read it
    // back, prepend the existing facts, and write the merged corpus.
    const newOnly = (await readFile(factsPath, "utf8")).trimEnd();
    const newLines = newOnly.length === 0 ? [] : newOnly.split("\n");
    factsAdded = newLines.length;
    const mergedBody =
      retainedFactsBody.length === 0 && newLines.length === 0
        ? ""
        : [retainedFactsBody, newOnly].filter((s) => s.length > 0).join("\n") +
          "\n";
    await writeFile(factsPath, mergedBody, "utf8");
    log({
      event: "feed:facts-merged",
      added: newLines.length,
      total: mergedBody.split("\n").filter((l) => l.length > 0).length,
    });
  } catch (cause) {
    if (existsSync(backupPath)) {
      await copyFile(backupPath, factsPath);
    }
    throw cause;
  } finally {
    if (existsSync(backupPath)) {
      // Best-effort cleanup of the backup.
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(backupPath);
      } catch {
        /* ignore */
      }
    }
  }

  // ── 5e. Rebuild Stage 8 knowledge index from the merged jsonl ─────────────
  const indexRunner = createKnowledgeIndexRunner();
  await indexRunner.run({
    almanacDir: input.almanacDir,
    manifest,
    state: synthesizeStubState(),
    stageId: "08-knowledge-index",
    log,
    now,
  } as unknown as StageContext);

  // ── 5f. Bump manifest.factCount + version, persist ────────────────────────
  const finalFacts = (await readFile(factsPath, "utf8"))
    .split("\n")
    .filter((l) => l.length > 0).length;
  const newVersion = bumpSemver(manifest.version, "patch");
  const updatedManifest: AlmanacManifest = AlmanacManifestSchema.parse({
    ...manifest,
    factCount: finalFacts,
    version: newVersion,
    compiledAt: now().toISOString(),
  });
  await writeManifest(input.almanacDir, updatedManifest);

  log({
    event: "feed:done",
    sourceId: validatedSource.id,
    factsAdded,
    newFactCount: finalFacts,
    newVersion,
  });

  return {
    kind: "applied",
    operation,
    newSource: validatedSource,
    replacedSource,
    fetchEntry: newEntry,
    factsAdded,
    newFactCount: finalFacts,
    newVersion,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Construct an `ApprovedSource` from the user's URL + flags. Smart defaults
 * fill in the parts the user didn't supply.
 */
export function buildApprovedSource(input: RunFeedInput): ApprovedSource {
  const kind: SourceKind = input.kind ?? "docs";
  const mode: IngestionMode = input.mode ?? "snapshot";
  const id =
    input.sourceId !== undefined ? input.sourceId : deriveSourceId(input.url, kind);
  const trust = input.trust ?? 0.85;
  const rationale = input.rationale ?? `User-added via 'almanac feed'.`;
  const scope =
    input.scope !== undefined
      ? Array.from(input.scope)
      : kind === "repo"
        ? ["docs/**", "README.md"]
        : ["/"];

  const volatility =
    kind === "news"
      ? "fast"
      : kind === "repo"
        ? "slow"
        : kind === "community"
          ? "fast"
          : "slow";

  // The schema requires id length 1..64 and the SOURCE_ID regex.
  return {
    id,
    url: input.url,
    kind,
    trust,
    volatility,
    rationale,
    ingestion: {
      mode,
      scope,
      refreshIntervalHours: kind === "news" || kind === "community" ? 24 : 168,
    },
    notes: null,
  };
}

/**
 * Best-effort source id from a URL.
 *
 *   - GitHub repos: `gh-<owner>-<repo>`
 *   - Generic HTTP: hostname (dots → dashes, trimmed) + first path segment
 *     when present. e.g. https://www.sqlite.org/whentouse.html
 *                          → "sqlite-org-whentouse"
 *
 * Falls back to a sha256-prefixed id when no usable shape can be derived.
 * Output always matches the `SourcesFile.id` regex (lowercase kebab).
 */
export function deriveSourceId(url: string, kind: SourceKind): string {
  try {
    const u = new URL(url);
    if (
      kind === "repo" &&
      /^github\.com$/i.test(u.hostname) &&
      u.pathname.split("/").filter(Boolean).length >= 2
    ) {
      const [owner, repo] = u.pathname.split("/").filter(Boolean);
      return slug(`gh-${owner}-${repo}`).slice(0, 64);
    }
    const host = u.hostname.replace(/^www\./i, "").replace(/\./g, "-");
    const firstSeg = u.pathname.split("/").filter(Boolean)[0];
    let baseSeg = "";
    if (firstSeg !== undefined && firstSeg.length > 0) {
      const noExt = firstSeg.replace(/\.[a-zA-Z0-9]+$/, "");
      baseSeg = noExt;
    }
    const out = slug(baseSeg.length > 0 ? `${host}-${baseSeg}` : host);
    return (out.length > 0 ? out : `src-${sha256HexBytes(new TextEncoder().encode(url)).slice(0, 8)}`).slice(0, 64);
  } catch {
    return `src-${sha256HexBytes(new TextEncoder().encode(url)).slice(0, 8)}`;
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

/**
 * Append a source to a SourcesFile and recompute the derivable counters
 * (acceptedCount + coverage). Returns a schema-validated copy.
 */
export function appendSourceToSourcesFile(
  current: SourcesFile,
  newSource: ApprovedSource,
): SourcesFile {
  return buildSourcesFileWithSources(current, [...current.sources, newSource]);
}

export function replaceSourceInSourcesFile(
  current: SourcesFile,
  replacement: ApprovedSource,
): SourcesFile {
  let replaced = false;
  const sources = current.sources.map((source) => {
    if (source.id !== replacement.id) return source;
    replaced = true;
    return replacement;
  });
  if (!replaced) {
    throw new Error(`source id "${replacement.id}" not found`);
  }
  return buildSourcesFileWithSources(current, sources);
}

export function removeFactsForSource(body: string, sourceId: string): string {
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { source?: { sourceId?: unknown } };
      if (parsed.source?.sourceId === sourceId) continue;
    } catch {
      // Preserve malformed lines; feed should not silently delete data it
      // cannot attribute.
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function buildSourcesFileWithSources(
  current: SourcesFile,
  sources: ApprovedSource[],
): SourcesFile {
  const coverage = Object.fromEntries(
    SOURCE_KINDS.map((kind) => [kind, 0]),
  ) as SourcesFile["coverage"];
  for (const source of sources) {
    coverage[source.kind] += 1;
  }
  return SourcesFileSchema.parse({
    ...current,
    sources,
    coverage,
    generatedBy: {
      ...current.generatedBy,
      acceptedCount: sources.length,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

async function readApprovedSourcesFile(almanacDir: string): Promise<SourcesFile> {
  const body = await readFile(approvedSourcesPath(almanacDir), "utf8");
  const file = SourcesFileSchema.parse(JSON.parse(body));
  if (file.status !== "approved") {
    throw new Error(
      `feed: sources/sources.json status is "${file.status}" — expected "approved". ` +
        "Re-run `almanac new` or fix the file before feeding.",
    );
  }
  return file;
}

async function readFetchManifestIfPresent(
  almanacDir: string,
  almanacId: string,
  fallbackTime: Date,
): Promise<SourceFetchManifest | null> {
  const path = sourceFetchManifestPath(almanacDir);
  if (!existsSync(path)) {
    // Stage 4 never ran. Synthesize an empty manifest with the supplied id.
    void almanacId;
    void fallbackTime;
    return null;
  }
  const body = await readFile(path, "utf8");
  return SourceFetchManifestSchema.parse(JSON.parse(body));
}

function parseISOOrNow(iso: string | undefined): Date | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t);
}

/**
 * Build a minimal `CompileState`-shaped stub for stage runners that read it.
 * `feed` doesn't track compile-state transitions per se — the manifest is the
 * canonical source of truth — so we hand the runners a shell that they'll
 * accept but won't act on. The cast at the call site narrows the type.
 */
function synthesizeStubState(): unknown {
  // The runners we use (Stage 5 + Stage 8) read `ctx.state` only for
  // bookkeeping that doesn't gate execution. An object with the bare-minimum
  // schema-loose shape is fine.
  return {};
}
