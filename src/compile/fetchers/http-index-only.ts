/**
 * HTTP index-only fetcher — handles any non-repo, non-file source whose
 * evaluator-picked `ingestion.mode` is `"index-only"`.
 *
 * The Stage 2b evaluator picks `index-only` whenever a source's licensing is
 * unclear or restrictive (the default for academic / community / essay /
 * book / talk kinds, plus the licensing-unclear fallback for everything
 * else). For those sources we deliberately do NOT store body bytes — we
 * just record that the URL exists, is reachable, and (when the server
 * cooperates) its `Last-Modified` timestamp. Downstream stages surface the
 * URL via SKILL.md / DOMAIN.md so host LLMs can route citations to it.
 *
 * Strategy:
 *   - Try HEAD first; some servers (notably 405-style strict ones) reject
 *     HEAD, in which case we fall back to a GET with a tiny range header
 *     (`Range: bytes=0-0`) so we still spend ~zero bandwidth.
 *   - 2xx + 3xx → status: "index-only" with finalUrl + lastUpdatedAt label
 *   - 4xx / 5xx / network / timeout → status: "failed" with categorized error
 *
 * No body bytes are persisted. The fetcher is intentionally tiny — its
 * value is in covering the "we accept the source but won't store it"
 * licensing case end-to-end.
 */

import {
  FetcherMisroutedError,
  type FetchContext,
  type Fetcher,
} from "./types.ts";
import type {
  ApprovedSource,
  SourceFetchEntry,
  SourceIndexMeta,
} from "../../core/types.ts";

export class HttpIndexOnlyFetcher implements Fetcher {
  readonly name = "http-index-only";

  canHandle(source: ApprovedSource): boolean {
    if (source.kind === "repo" || source.kind === "file") return false;
    if (source.ingestion.mode !== "index-only") return false;
    return /^https?:\/\//i.test(source.url);
  }

  async fetch(
    source: ApprovedSource,
    ctx: FetchContext,
  ): Promise<SourceFetchEntry> {
    if (!this.canHandle(source)) {
      throw new FetcherMisroutedError(this.name, source.id);
    }

    const attemptedAt = ctx.now().toISOString();

    // Try HEAD; on 405 / 501 fall back to a Range-bound GET.
    let res = await safeRequest(ctx, source.url, "HEAD");
    if (res.ok === false && res.statusForFallback !== null) {
      res = await safeRequest(ctx, source.url, "GET", true);
    }
    if (res.ok === false) {
      return {
        sourceId: source.id,
        status: "failed",
        attemptedAt,
        fetcher: this.name,
        error: res.error,
      };
    }

    const indexMeta: SourceIndexMeta = {
      label: source.url.slice(0, 200),
    };
    if (res.lastModified) {
      const t = Date.parse(res.lastModified);
      if (Number.isFinite(t)) {
        indexMeta.lastUpdatedAt = new Date(t).toISOString();
      }
    }

    ctx.log({
      event: "fetcher:http-index-only:ok",
      sourceId: source.id,
      finalUrl: res.finalUrl,
      httpStatus: res.httpStatus,
    });

    return {
      sourceId: source.id,
      status: "index-only",
      fetchedAt: ctx.now().toISOString(),
      finalUrl: res.finalUrl,
      fetcher: this.name,
      indexMeta,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

type SafeRequestResult =
  | {
      ok: true;
      finalUrl: string;
      lastModified: string | null;
      httpStatus: number;
    }
  | {
      ok: false;
      /** HTTP status when the server replied; null on network/timeout. */
      statusForFallback: number | null;
      error: import("../../core/types.ts").SourceFetchError;
    };

async function safeRequest(
  ctx: FetchContext,
  url: string,
  method: "HEAD" | "GET",
  withRangeHeader = false,
): Promise<SafeRequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "almanac/0.1 (compile pipeline)",
        accept: "*/*",
        ...(withRangeHeader ? { range: "bytes=0-0" } : {}),
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    const isTimeout = (e as { name?: string }).name === "AbortError";
    return {
      ok: false,
      statusForFallback: null,
      error: {
        code: isTimeout ? "timeout" : "network-error",
        message: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
        retryable: true,
        attempts: 1,
      },
    };
  }
  clearTimeout(timeout);

  // 200/206 (partial content) and 3xx (redirect already followed) are ok.
  // Some servers reject HEAD with 405 / 501 — bubble that up so the caller
  // can retry as GET.
  if (method === "HEAD" && (res.status === 405 || res.status === 501)) {
    return {
      ok: false,
      statusForFallback: res.status,
      error: {
        code: "http-error",
        message: `HEAD not allowed (HTTP ${res.status}); will retry as GET`,
        httpStatusCode: res.status,
        retryable: true,
        attempts: 1,
      },
    };
  }
  if (res.status === 429 || res.status === 403) {
    return {
      ok: false,
      statusForFallback: null,
      error: {
        code: "rate-limited",
        message: `HTTP ${res.status} from ${url}`,
        httpStatusCode: res.status,
        retryable: true,
        attempts: 1,
      },
    };
  }
  if (res.status >= 400) {
    return {
      ok: false,
      statusForFallback: null,
      error: {
        code: "http-error",
        message: `HTTP ${res.status} from ${url}`,
        httpStatusCode: res.status,
        retryable: res.status >= 500,
        attempts: 1,
      },
    };
  }

  // Drain the body for GET so the connection can be released. HEAD has no
  // body. Range-bound GET is at most 1 byte.
  if (method === "GET") {
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore; we already have the headers we need */
    }
  }

  return {
    ok: true,
    finalUrl: res.url && res.url.length > 0 ? res.url : url,
    lastModified: res.headers.get("last-modified"),
    httpStatus: res.status,
  };
}
