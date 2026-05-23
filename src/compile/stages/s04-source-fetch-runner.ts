/**
 * Stage 4 — pipeline adapter for source fetch.
 *
 * Reads the approved `SourcesFile` written by Stage 3 (at
 * `<almanacDir>/sources/sources.json`), constructs a `FetchContext`, and
 * delegates to the existing `runSourceFetch` orchestrator with a default
 * fetcher chain:
 *
 *   1. `GithubRepoFetcher`   — `kind: repo`
 *   2. `LocalFileFetcher`    — `kind: file` / `file://` URLs
 *   3. `GenericHttpFetcher`  — everything else over HTTP(S)
 *
 * Persists the resulting `SourceFetchManifest` to
 * `<almanacDir>/sources/manifest.summary.json`. Per-document raw bytes are
 * written by the fetchers via `createWriteRaw` under
 * `<almanacDir>/sources/raw/<sha256>.<ext>`.
 *
 * `outputHash` is the sha256 of the canonical manifest JSON.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SourcesFileSchema,
  type SourcesFile,
} from "../../core/types.ts";
import { GenericHttpFetcher } from "../fetchers/generic-http.ts";
import { GithubRepoFetcher } from "../fetchers/github-repo.ts";
import { LocalFileFetcher } from "../fetchers/local-file.ts";
import { createWriteRaw } from "../fetchers/raw-writer.ts";
import type { FetchContext, Fetcher } from "../fetchers/types.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { runSourceFetch } from "./s04-source-fetch.ts";
import { approvedSourcesPath } from "./s03-approve-runner.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths + constants
// ──────────────────────────────────────────────────────────────────────────────

export const SOURCE_FETCH_MANIFEST_REL_PATH =
  "sources/manifest.summary.json";

export function sourceFetchManifestPath(almanacDir: string): string {
  return join(almanacDir, SOURCE_FETCH_MANIFEST_REL_PATH);
}

/** Default per-document byte cap (8 MiB). */
export const DEFAULT_FETCH_MAX_BYTES = 8 * 1024 * 1024;
/** Default per-request timeout (15s). */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingApprovedSourcesError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 4 requires an approved SourcesFile at ${path}; ` +
        "run Stage 3 first or restore the file",
    );
    this.name = "MissingApprovedSourcesError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateSourceFetchRunnerOptions {
  /** Override the fetcher chain. Default: github-repo → local-file → generic-http. */
  fetchers?: Fetcher[];
  /** `fetch`-compatible function. Default: global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default `DEFAULT_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Per-document byte cap. Default `DEFAULT_FETCH_MAX_BYTES`. */
  maxBytes?: number;
  /** Override the `writeRaw` factory (tests). */
  writeRawFactory?: (almanacDir: string) => FetchContext["writeRaw"];
  /** When true (default), record `failed` entries and continue past errors. */
  continueOnError?: boolean;
  /** Test seam: read approved sources from a custom location. */
  readApproved?: (almanacDir: string) => Promise<SourcesFile>;
}

/**
 * Build the Stage 4 `StageRunner`. Deterministic stage: `promptVersion = null`.
 */
export function createSourceFetchRunner(
  opts: CreateSourceFetchRunnerOptions = {},
): StageRunner {
  const fetchers = opts.fetchers ?? defaultFetchers();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
  const writeRawFactory = opts.writeRawFactory ?? createWriteRaw;
  const continueOnError = opts.continueOnError ?? true;
  const readApproved = opts.readApproved ?? defaultReadApproved;

  return {
    promptVersion: null,
    async run(ctx) {
      const sourcesFile = await readApproved(ctx.almanacDir);

      ctx.log({
        event: "stage4:start",
        sources: sourcesFile.sources.length,
      });

      const fetchContext: Omit<FetchContext, "almanacDir"> = {
        fetch: fetchImpl,
        now: ctx.now,
        hashContent: hashBytes,
        log: ctx.log,
        maxBytes,
        timeoutMs,
        writeRaw: writeRawFactory(ctx.almanacDir),
      };

      const manifest = await runSourceFetch({
        sourcesFile,
        almanacDir: ctx.almanacDir,
        fetchers,
        ctx: fetchContext,
        continueOnError,
      });

      const canonicalText = JSON.stringify(manifest, null, 2);
      const outPath = sourceFetchManifestPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage4:done",
        outputHash,
        fetched: manifest.summary.fetched,
        failed: manifest.summary.failed,
      });

      return { kind: "success", outputHash };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Default fetcher chain. Order matters: more-specific fetchers must precede
 * the catch-all `GenericHttpFetcher`.
 */
export function defaultFetchers(): Fetcher[] {
  return [new GithubRepoFetcher(), new LocalFileFetcher(), new GenericHttpFetcher()];
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function defaultReadApproved(almanacDir: string): Promise<SourcesFile> {
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
      `Stage 4: SourcesFile at ${path} has status="${parsed.status}", expected "approved"`,
    );
  }
  return parsed;
}
