/**
 * Stage 4 — source fetch orchestrator.
 *
 * Reads an approved `SourcesFile` and routes each `ApprovedSource` to the
 * first matching `Fetcher`. Concatenates per-source `SourceFetchEntry`
 * results into a `SourceFetchManifest`.
 *
 * Persistence (to be wired by the CLI in Stage 7+):
 *   - one `SourceFetchEntry` per line in `<almanacDir>/sources/manifest.jsonl`
 *   - the full `SourceFetchManifest` in `<almanacDir>/sources/manifest.summary.json`
 *   - raw bytes via `FetchContext.writeRaw` under
 *     `<almanacDir>/sources/raw/<contentHash>.<ext>`
 *
 * **Skeleton only.** The function signature is fixed so callers and tests can
 * be written and type-checked now. The body throws `NotImplementedError`
 * until the per-mode fetchers land.
 */

import {
  buildSourceFetchManifest,
  type ApprovedSource,
  type SourceFetchEntry,
  type SourceFetchManifest,
  type SourcesFile,
} from "../../core/types.ts";
import {
  NoFetcherForSourceError,
  type FetchContext,
  type Fetcher,
} from "../fetchers/types.ts";

export interface RunSourceFetchInput {
  /** Must be `status: "approved"`. The orchestrator refuses drafts. */
  sourcesFile: SourcesFile;
  almanacDir: string;
  /**
   * Fetchers in priority order (first match wins). Specific fetchers (e.g.,
   * `github-repo`) should precede generic ones (e.g., `html`).
   */
  fetchers: Fetcher[];
  /**
   * Per-call context, sans `almanacDir` (the orchestrator fills that in from
   * its own input so the two cannot disagree).
   */
  ctx: Omit<FetchContext, "almanacDir">;
  /**
   * When true (default), record `failed` entries and continue on per-source
   * errors. When false, the orchestrator throws on the first failure.
   */
  continueOnError?: boolean;
}

export class SourcesNotApprovedError extends Error {
  constructor(public readonly status: SourcesFile["status"]) {
    super(
      `Stage 4 refuses to fetch a SourcesFile with status="${status}"; ` +
        "approve via Stage 3 first",
    );
    this.name = "SourcesNotApprovedError";
  }
}

export class FetchAbortedError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly entry: SourceFetchEntry,
  ) {
    super(
      `Stage 4 aborted: source "${sourceId}" failed and continueOnError=false`,
    );
    this.name = "FetchAbortedError";
  }
}

/**
 * Pick the first registered fetcher that claims the source.
 *
 * Pure: does not call the network. Exported for tests so they can verify the
 * routing decision without running the orchestrator.
 */
export function selectFetcher(
  source: ApprovedSource,
  fetchers: readonly Fetcher[],
): Fetcher {
  for (const f of fetchers) {
    if (f.canHandle(source)) return f;
  }
  throw new NoFetcherForSourceError(source.id);
}

/**
 * Walk every approved source, route to the first matching fetcher, and
 * aggregate the resulting `SourceFetchEntry[]` into a `SourceFetchManifest`.
 *
 * Behavior:
 *   - Refuses `status: "draft"` (`SourcesNotApprovedError`).
 *   - For each source: `selectFetcher` → `fetcher.fetch(source, fctx)`.
 *   - If `selectFetcher` throws (`NoFetcherForSourceError`), records a
 *     `failed` entry with code `unknown-mode` and continues.
 *   - If a fetcher throws (programmer error), the orchestrator catches and
 *     records a `failed` entry with code `unknown` so that one buggy
 *     fetcher cannot abort the whole run. Set `continueOnError: false` to
 *     re-throw via `FetchAbortedError`.
 *   - The whole run shares one `FetchContext` (with `almanacDir` injected
 *     here so the input cannot disagree with the orchestrator).
 */
export async function runSourceFetch(
  input: RunSourceFetchInput,
): Promise<SourceFetchManifest> {
  if (input.sourcesFile.status !== "approved") {
    throw new SourcesNotApprovedError(input.sourcesFile.status);
  }
  const continueOnError = input.continueOnError ?? true;
  const fctx: FetchContext = {
    ...input.ctx,
    almanacDir: input.almanacDir,
  };

  const startedAt = fctx.now();
  const entries: SourceFetchEntry[] = [];

  for (const source of input.sourcesFile.sources) {
    let entry: SourceFetchEntry;
    try {
      const fetcher = selectFetcher(source, input.fetchers);
      entry = await fetcher.fetch(source, fctx);
    } catch (e) {
      if (e instanceof NoFetcherForSourceError) {
        entry = {
          sourceId: source.id,
          status: "failed",
          attemptedAt: fctx.now().toISOString(),
          fetcher: "",
          error: {
            code: "unknown-mode",
            message: e.message.slice(0, 2000),
            retryable: false,
            attempts: 1,
          },
        };
      } else {
        entry = {
          sourceId: source.id,
          status: "failed",
          attemptedAt: fctx.now().toISOString(),
          fetcher: "",
          error: {
            code: "unknown",
            message:
              e instanceof Error
                ? e.message.slice(0, 2000)
                : `non-Error thrown: ${String(e)}`.slice(0, 2000),
            retryable: false,
            attempts: 1,
          },
        };
      }
    }

    entries.push(entry);
    if (entry.status === "failed" && !continueOnError) {
      throw new FetchAbortedError(source.id, entry);
    }
  }

  const finishedAt = fctx.now();
  return buildSourceFetchManifest({
    almanacId: deriveAlmanacIdFromDir(input.almanacDir),
    startedAt,
    finishedAt,
    entries,
  });
}

/**
 * Derive a canonical-slug almanacId from the directory basename. The Stage 4
 * orchestrator does not have direct access to `AlmanacManifest.almanacId`,
 * so we re-derive from the path. The CLI always names directories by their
 * `almanacId`, so this is stable.
 *
 * Exposed via a separate function so the (unlikely) case of a custom output
 * dir whose basename is not a valid slug surfaces with a clear error rather
 * than producing a malformed manifest.
 */
function deriveAlmanacIdFromDir(almanacDir: string): string {
  const base = almanacDir.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(base)) {
    throw new Error(
      `Stage 4: almanacDir basename "${base}" is not a valid canonicalSlug; ` +
        `pass an explicit almanacId via the orchestrator if you customize the output dir`,
    );
  }
  return base;
}
