/**
 * Generic HTTP fetcher — handles `ingestion.mode = "snapshot"` and
 * `ingestion.mode = "feed"` for any `kind` other than `repo` and `file`.
 *
 * Behavior:
 *   - GETs `source.url` with a `User-Agent` and follows redirects.
 *   - Streams the response into memory (capped at `ctx.maxBytes`).
 *   - Persists the bytes via `ctx.writeRaw` and produces one
 *     `FetchedDocument`.
 *   - Captures `Last-Modified` as `sourceTimestamp` when present.
 *   - For `text/html` responses, extracts the `<title>` (first 300 chars).
 *   - Returns a `failed` entry for any HTTP ≥400, network error, or timeout.
 *
 * This single fetcher handles HTML pages, RSS/Atom feeds, JSON dumps, PDF
 * downloads, etc. — anything reachable over HTTP whose payload Stage 5 can
 * later parse.
 */

import {
  FetcherMisroutedError,
  type FetchContext,
  type Fetcher,
} from "./types.ts";
import type {
  ApprovedSource,
  SourceFetchEntry,
} from "../../core/types.ts";

export class GenericHttpFetcher implements Fetcher {
  readonly name = "generic-http";

  canHandle(source: ApprovedSource): boolean {
    if (source.kind === "repo" || source.kind === "file") return false;
    if (source.ingestion.mode === "index-only") return false;
    if (!/^https?:\/\//i.test(source.url)) return false;
    return true;
  }

  async fetch(
    source: ApprovedSource,
    ctx: FetchContext,
  ): Promise<SourceFetchEntry> {
    if (!this.canHandle(source)) {
      throw new FetcherMisroutedError(this.name, source.id);
    }

    const attemptedAt = ctx.now().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs);

    let res: Response;
    try {
      res = await ctx.fetch(source.url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": "almanac/0.1 (compile pipeline)",
          accept: "*/*",
        },
      });
    } catch (e) {
      clearTimeout(timeout);
      const isTimeout = (e as { name?: string }).name === "AbortError";
      const message =
        e instanceof Error ? e.message : `non-Error thrown: ${String(e)}`;
      ctx.log({
        event: "fetcher:http:network-error",
        sourceId: source.id,
        message,
      });
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: isTimeout ? "timeout" : "network-error",
          message: message.slice(0, 2000),
          retryable: true,
          attempts: 1,
        },
      };
    }
    clearTimeout(timeout);

    const finalUrl = res.url || source.url;

    if (res.status >= 400) {
      ctx.log({
        event: "fetcher:http:status",
        sourceId: source.id,
        status: res.status,
      });
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: res.status === 429 ? "rate-limited" : "http-error",
          message: `HTTP ${res.status} from ${source.url}`,
          httpStatusCode: res.status,
          retryable: res.status >= 500 || res.status === 429,
          attempts: 1,
        },
      };
    }

    let body: ArrayBuffer;
    try {
      body = await res.arrayBuffer();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : `non-Error thrown: ${String(e)}`;
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "network-error",
          message: `error reading body: ${message}`.slice(0, 2000),
          retryable: true,
          attempts: 1,
        },
      };
    }

    if (body.byteLength > ctx.maxBytes) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: {
          code: "too-large",
          message: `body size ${body.byteLength} exceeds maxBytes ${ctx.maxBytes}`,
          httpStatusCode: res.status,
          retryable: false,
          attempts: 1,
        },
      };
    }

    const bytes = new Uint8Array(body);
    const mediaType = normalizeMediaType(
      res.headers.get("content-type") ?? "application/octet-stream",
    );
    const written = await ctx.writeRaw({ bytes, mediaType });

    const fetchedAt = ctx.now().toISOString();
    const lastModified = res.headers.get("last-modified");
    const sourceTimestamp = lastModified
      ? parseHttpDate(lastModified)
      : undefined;

    const title = extractTitleIfHtml(bytes, mediaType);

    ctx.log({
      event: "fetcher:http:ok",
      sourceId: source.id,
      mediaType,
      byteLength: bytes.byteLength,
    });

    return {
      sourceId: source.id,
      status: "fetched",
      fetchedAt,
      finalUrl,
      fetcher: this.name,
      documents: [
        {
          contentHash: written.contentHash,
          relPath: written.relPath,
          url: finalUrl,
          mediaType,
          byteLength: written.byteLength,
          fetchedAt,
          ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
          ...(title !== undefined ? { title } : {}),
        },
      ],
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers — exported for tests
// ──────────────────────────────────────────────────────────────────────────────

const TYPE_SUBTYPE = /^([a-z]+)\/([a-z0-9.+-]+)/i;

export function normalizeMediaType(raw: string): string {
  // Strip parameters (`; charset=utf-8`), lower-case the type/subtype.
  const head = raw.split(";")[0]?.trim() ?? "";
  const m = TYPE_SUBTYPE.exec(head);
  if (!m) return "application/octet-stream";
  return `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}`;
}

export function parseHttpDate(raw: string): string | undefined {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function extractTitleIfHtml(
  bytes: Uint8Array,
  mediaType: string,
): string | undefined {
  if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
    return undefined;
  }
  // Decode the first 64KB only — titles always live in <head>.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(0, 64 * 1024),
  );
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!m) return undefined;
  const decoded = decodeBasicEntities(m[1]!.trim()).slice(0, 300);
  return decoded.length > 0 ? decoded : undefined;
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}
