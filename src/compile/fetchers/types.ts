/**
 * Stage 4 — fetcher strategy interface.
 *
 * The Stage 4 orchestrator (`s04-source-fetch.ts`) walks an approved
 * `SourcesFile` and routes each `ApprovedSource` to one `Fetcher`. Each
 * fetcher knows how to ingest one *kind* of source (HTML page, PDF, github
 * repo, RSS/Atom feed, local file, …).
 *
 * Concrete fetchers live alongside this file (`html.ts`, `pdf.ts`,
 * `github-repo.ts`, `feed.ts`, `local-file.ts`). The interface is the
 * contract; orchestrator and fetchers implement it independently.
 */

import type {
  ApprovedSource,
  FetchedDocument,
  SourceFetchEntry,
} from "../../core/types.ts";

/**
 * Per-call context handed to every fetcher. Constructed once per Stage 4 run
 * by the orchestrator and shared across fetchers.
 */
export interface FetchContext {
  /** Absolute path to the almanac directory; raw files go in `<almanacDir>/sources/raw/`. */
  almanacDir: string;
  /**
   * Sandboxed `fetch`. The orchestrator may host-allowlist this per source
   * before passing it down (or pass the global `fetch` for v0.1).
   */
  fetch: typeof fetch;
  /** Returns the current time. Injected for determinism in tests. */
  now: () => Date;
  /** sha256-hex of the given bytes. Used to name `sources/raw/*` files. */
  hashContent: (bytes: Uint8Array) => string;
  /** Structured event logger (no-op by default). */
  log: (event: object) => void;
  /** Per-document byte cap; fetchers must reject anything larger. */
  maxBytes: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /**
   * Persist raw bytes under `<almanacDir>/sources/raw/<contentHash>.<ext>`
   * and return the metadata to embed in a `FetchedDocument`. Implementing
   * fetchers should call this rather than touching the filesystem directly.
   */
  writeRaw(input: {
    bytes: Uint8Array;
    mediaType: string;
    extension?: string;
  }): Promise<{
    contentHash: string;
    relPath: FetchedDocument["relPath"];
    byteLength: number;
  }>;
}

/**
 * A fetcher specializes in ingesting one ingestion mode / source kind.
 *
 * Implementations MUST:
 *   - never throw out of `fetch()` for upstream errors; convert them into
 *     a `SourceFetchEntry` with `status: "failed"`.
 *   - throw only for programmer errors (e.g., orchestrator misrouted a
 *     source whose `canHandle()` returned false).
 *   - hash + write raw bytes via `ctx.writeRaw()` (never bypass it).
 *   - respect `ctx.maxBytes` and `ctx.timeoutMs`.
 *   - record the upstream timestamp in `documents[*].sourceTimestamp` when
 *     available (HTTP `Last-Modified`, feed `pubDate`, file `mtime`).
 */
export interface Fetcher {
  /** Stable identifier (also used in `SourceFetchEntry.fetcher`). */
  readonly name: string;

  /**
   * Whether this fetcher can ingest the given source. The orchestrator picks
   * the first matching fetcher in registration order, so list more specific
   * fetchers (e.g., `github-repo`) before more general ones (e.g., `html`).
   */
  canHandle(source: ApprovedSource): boolean;

  /**
   * Perform the fetch. Always returns a `SourceFetchEntry`; never throws for
   * recoverable / categorized failures.
   */
  fetch(source: ApprovedSource, ctx: FetchContext): Promise<SourceFetchEntry>;
}

/** Typed error a fetcher may throw for programmer errors only. */
export class FetcherMisroutedError extends Error {
  constructor(
    public readonly fetcherName: string,
    public readonly sourceId: string,
  ) {
    super(
      `fetcher "${fetcherName}" cannot handle source "${sourceId}"; ` +
        "orchestrator should not have routed this source to this fetcher",
    );
    this.name = "FetcherMisroutedError";
  }
}

/** Typed error the orchestrator throws when no fetcher matches a source. */
export class NoFetcherForSourceError extends Error {
  constructor(public readonly sourceId: string) {
    super(`no fetcher matched source "${sourceId}"`);
    this.name = "NoFetcherForSourceError";
  }
}
