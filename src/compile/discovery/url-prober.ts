/**
 * Concrete `UrlProber` backed by `fetch`.
 *
 * Probes are intentionally light: we GET the URL with a short byte cap,
 * extract `<title>`, `<meta description>` (or open-graph), and the first
 * ~2000 chars of HTML body. Non-HTML responses still produce a probe with
 * the response's content-type / status — only `preview` differs.
 *
 * Routine failures (network, timeout, 4xx, 5xx) are categorized into
 * `fetchStatus` rather than thrown — the executor folds the result straight
 * into a `Candidate`. The probe is read-only; nothing is persisted.
 */

import type { CandidateMeta, FetchStatus } from "../../core/types.ts";
import type { ProbeResult, UrlProber } from "./types.ts";

export interface CreateHttpUrlProberOptions {
  /** `fetch`-compatible function. Tests inject a stub. Defaults to global. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 8000. */
  timeoutMs?: number;
  /** Per-response byte cap. Default 256 KiB. */
  maxBytes?: number;
  /** Custom user-agent. Default `"almanac-discovery/0.1"`. */
  userAgent?: string;
}

export const PROBE_PREVIEW_MAX_CHARS = 2000;

/**
 * Build an HTTP-backed prober. The returned object is stateless except for
 * the captured options; callers may share one instance across many probes.
 */
export function createHttpUrlProber(
  opts: CreateHttpUrlProberOptions = {},
): UrlProber {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const userAgent = opts.userAgent ?? "almanac-discovery/0.1";

  return {
    name: "http",
    async probe(url: string): Promise<ProbeResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
      } catch (e) {
        clearTimeout(timeout);
        const isTimeout = (e as { name?: string }).name === "AbortError";
        return failed(url, isTimeout ? "timeout" : "network-error");
      }

      let httpStatusCode: number;
      let contentType: string | undefined;
      let bytes: Uint8Array;
      try {
        httpStatusCode = res.status;
        contentType = res.headers.get("content-type") ?? undefined;
        bytes = await readCappedBody(res, maxBytes);
      } catch (e) {
        clearTimeout(timeout);
        const isTimeout = (e as { name?: string }).name === "AbortError";
        return failed(url, isTimeout ? "timeout" : "network-error");
      }
      clearTimeout(timeout);

      const fetchStatus = classifyStatus(httpStatusCode);
      // `fetch` follows redirects transparently; if the final URL differs we
      // surface that as `redirect`, but ONLY when the final response was ok.
      // A redirect chain that ends at a 4xx/5xx page reports the terminal
      // status (client-error / server-error / blocked) and MUST NOT set
      // `finalUrl` — `CandidateSchema` requires `finalUrl` to be present iff
      // `fetchStatus === "redirect"`.
      const redirected = Boolean(res.url) && res.url !== url;
      const effectiveStatus: FetchStatus =
        redirected && fetchStatus === "ok" ? "redirect" : fetchStatus;
      const finalUrl =
        effectiveStatus === "redirect" ? res.url : undefined;

      const meta: CandidateMeta = {
        ...(contentType !== undefined ? { contentType } : {}),
        contentLengthBytes: bytes.length,
        httpStatusCode,
      };

      // Only parse HTML-ish bodies for title/snippet/preview; everything else
      // (JSON dumps, PDFs, …) gets a metadata-only probe.
      const isHtml =
        (contentType ?? "").toLowerCase().includes("html") ||
        (contentType ?? "").toLowerCase().includes("xml");
      let title: string | null = null;
      let snippet: string | null = null;
      let preview: string | null = null;
      let rssUrl: string | undefined;
      if (
        (effectiveStatus === "ok" || effectiveStatus === "redirect") &&
        isHtml
      ) {
        const text = decodeUtf8Lossy(bytes);
        title = extractTitle(text);
        snippet = extractMetaDescription(text);
        preview = textPreview(text, PROBE_PREVIEW_MAX_CHARS);
        rssUrl = extractRssLink(text, finalUrl ?? url);
      }

      return {
        url,
        fetchStatus: effectiveStatus,
        ...(finalUrl !== undefined ? { finalUrl } : {}),
        title,
        snippet,
        preview,
        meta: {
          ...meta,
          ...(rssUrl !== undefined ? { rssUrl } : {}),
        },
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────────

function failed(url: string, status: FetchStatus): ProbeResult {
  return {
    url,
    fetchStatus: status,
    title: null,
    snippet: null,
    preview: null,
    meta: {},
  };
}

/** Map an HTTP status code to a `FetchStatus`. */
export function classifyStatus(code: number): FetchStatus {
  if (code >= 200 && code < 400) return "ok";
  if (code === 403 || code === 429) return "blocked";
  if (code >= 400 && code < 500) return "client-error";
  if (code >= 500) return "server-error";
  return "ok";
}

/**
 * Read up to `maxBytes` from a Response body. Aborts the underlying read
 * once the cap is exceeded; the returned buffer contains exactly `maxBytes`
 * bytes when truncation happens (no padding, no overshoot).
 */
async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.slice(0, maxBytes) : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      total = maxBytes;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function decodeUtf8Lossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_DESC_RE =
  /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i;
const META_DESC_REVERSED_RE =
  /<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i;
const META_OG_DESC_RE =
  /<meta\s+[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i;

export function extractTitle(html: string): string | null {
  const m = html.match(TITLE_RE);
  if (!m) return null;
  const decoded = decodeHtmlEntities(stripTags(m[1]!)).trim();
  return decoded.length === 0 ? null : decoded.slice(0, 300);
}

export function extractMetaDescription(html: string): string | null {
  const m =
    html.match(META_DESC_RE) ??
    html.match(META_DESC_REVERSED_RE) ??
    html.match(META_OG_DESC_RE);
  if (!m) return null;
  const decoded = decodeHtmlEntities(m[1]!).trim();
  return decoded.length === 0 ? null : decoded.slice(0, 500);
}

const RSS_LINK_RE =
  /<link\s+[^>]*rel\s*=\s*["']alternate["'][^>]*type\s*=\s*["'](application\/rss\+xml|application\/atom\+xml)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i;
const RSS_LINK_REVERSED_RE =
  /<link\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*type\s*=\s*["'](application\/rss\+xml|application\/atom\+xml)["'][^>]*>/i;

/** Find an `<link rel="alternate" type="application/rss+xml">` href. */
export function extractRssLink(
  html: string,
  baseUrl: string,
): string | undefined {
  const m = html.match(RSS_LINK_RE);
  if (m) return absolutize(m[2]!, baseUrl);
  const m2 = html.match(RSS_LINK_REVERSED_RE);
  if (m2) return absolutize(m2[1]!, baseUrl);
  return undefined;
}

function absolutize(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return undefined;
  }
}

/** Strip HTML tags + collapse whitespace, then take first `n` chars. */
export function textPreview(html: string, n: number): string | null {
  const text = decodeHtmlEntities(stripTags(html))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;
  return text.slice(0, n);
}

function stripTags(html: string): string {
  // Remove script/style blocks entirely, then strip remaining tags.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? full;
  });
}
