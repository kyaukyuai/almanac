/**
 * Local-file fetcher — handles `kind: file` with `file://` URLs.
 *
 * Reads the bytes from disk, persists via `ctx.writeRaw`, and produces a
 * `FetchedDocument` whose `sourceTimestamp` is the file's mtime.
 *
 * Path safety: the URL is resolved via `fileURLToPath`. The fetcher does not
 * itself enforce a sandbox (the SourcesFile's approval gate is the trust
 * boundary). Failures map to `network-error` (file missing, permission
 * denied) or `too-large` (file > `ctx.maxBytes`).
 */

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";

import {
  FetcherMisroutedError,
  type FetchContext,
  type Fetcher,
} from "./types.ts";
import type {
  ApprovedSource,
  SourceFetchEntry,
} from "../../core/types.ts";

const EXT_TO_MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

export class LocalFileFetcher implements Fetcher {
  readonly name = "local-file";

  canHandle(source: ApprovedSource): boolean {
    return source.kind === "file" && source.url.startsWith("file://");
  }

  async fetch(
    source: ApprovedSource,
    ctx: FetchContext,
  ): Promise<SourceFetchEntry> {
    if (!this.canHandle(source)) {
      throw new FetcherMisroutedError(this.name, source.id);
    }
    const attemptedAt = ctx.now().toISOString();

    let path: string;
    try {
      path = fileURLToPath(source.url);
    } catch (e) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "parse-error",
          message: `invalid file:// URL: ${(e as Error).message}`.slice(0, 2000),
          retryable: false,
          attempts: 1,
        },
      };
    }

    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch (e) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "network-error",
          message: `cannot stat "${path}": ${(e as Error).message}`.slice(0, 2000),
          retryable: false,
          attempts: 1,
        },
      };
    }
    if (!st.isFile()) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "parse-error",
          message: `path is not a regular file: ${path}`,
          retryable: false,
          attempts: 1,
        },
      };
    }
    if (st.size > ctx.maxBytes) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "too-large",
          message: `file size ${st.size} exceeds maxBytes ${ctx.maxBytes}`,
          retryable: false,
          attempts: 1,
        },
      };
    }

    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch (e) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "network-error",
          message: `cannot read "${path}": ${(e as Error).message}`.slice(0, 2000),
          retryable: false,
          attempts: 1,
        },
      };
    }
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    const ext = extname(path).toLowerCase();
    const mediaType = EXT_TO_MIME[ext] ?? "application/octet-stream";

    const written = await ctx.writeRaw({ bytes, mediaType });
    const fetchedAt = ctx.now().toISOString();
    const sourceTimestamp = new Date(st.mtimeMs).toISOString();

    ctx.log({
      event: "fetcher:local:ok",
      sourceId: source.id,
      path,
      mediaType,
    });

    return {
      sourceId: source.id,
      status: "fetched",
      fetchedAt,
      finalUrl: source.url,
      fetcher: this.name,
      documents: [
        {
          contentHash: written.contentHash,
          relPath: written.relPath,
          url: source.url,
          mediaType,
          byteLength: written.byteLength,
          fetchedAt,
          sourceTimestamp,
        },
      ],
    };
  }
}
