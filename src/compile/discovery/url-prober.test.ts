/**
 * Tests for `createHttpUrlProber` + its HTML extraction helpers.
 */
import { describe, expect, test } from "bun:test";

import {
  classifyStatus,
  createHttpUrlProber,
  extractMetaDescription,
  extractRssLink,
  extractTitle,
  textPreview,
} from "./url-prober.ts";

describe("classifyStatus", () => {
  test("2xx → ok, 4xx → client-error, 5xx → server-error, 403/429 → blocked", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(301)).toBe("ok");
    expect(classifyStatus(404)).toBe("client-error");
    expect(classifyStatus(403)).toBe("blocked");
    expect(classifyStatus(429)).toBe("blocked");
    expect(classifyStatus(500)).toBe("server-error");
  });
});

describe("HTML extraction", () => {
  const HTML = `<html><head>
    <title>  Hello &amp; World  </title>
    <meta name="description" content="An example page." />
    <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
  </head><body><script>x()</script><p>Body <b>text</b> here.</p></body></html>`;

  test("extractTitle decodes entities and trims", () => {
    expect(extractTitle(HTML)).toBe("Hello & World");
  });
  test("extractMetaDescription handles `name=description` order", () => {
    expect(extractMetaDescription(HTML)).toBe("An example page.");
  });
  test("extractMetaDescription handles reversed attribute order", () => {
    const reversed = `<meta content="reversed-desc" name="description" />`;
    expect(extractMetaDescription(reversed)).toBe("reversed-desc");
  });
  test("extractMetaDescription falls back to og:description", () => {
    const ogOnly = `<meta property="og:description" content="og text" />`;
    expect(extractMetaDescription(ogOnly)).toBe("og text");
  });
  test("extractRssLink absolutizes against the page URL", () => {
    expect(extractRssLink(HTML, "https://example.com/path/")).toBe(
      "https://example.com/feed.xml",
    );
  });
  test("textPreview strips tags + script + collapses whitespace", () => {
    expect(textPreview(HTML, 60)).toBe("Hello & World Body text here.");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// probe(): full happy path / error categorization with stub fetch
// ──────────────────────────────────────────────────────────────────────────────

function makeFetch(
  body: string,
  init: { status?: number; contentType?: string; finalUrl?: string } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return new Response(body, {
      status: init.status ?? 200,
      headers: {
        "content-type": init.contentType ?? "text/html; charset=utf-8",
      },
    }) as Response & { url: string };
    void url;
  }) as unknown as typeof fetch;
}

describe("createHttpUrlProber", () => {
  test("happy path on text/html populates title/snippet/preview/meta", async () => {
    const prober = createHttpUrlProber({
      fetchImpl: makeFetch(
        `<html><head><title>T</title><meta name="description" content="D"/></head><body>hi</body></html>`,
      ),
    });
    const r = await prober.probe("https://example.com");
    expect(r.fetchStatus).toBe("ok");
    expect(r.title).toBe("T");
    expect(r.snippet).toBe("D");
    // The <meta> description's `content` attribute is stripped with the tag,
    // so the preview only carries the title text + body text.
    expect(r.preview).toBe("T hi");
    expect(r.meta.httpStatusCode).toBe(200);
    expect(r.meta.contentType).toContain("text/html");
  });

  test("non-HTML response leaves preview/title null but still records meta", async () => {
    const prober = createHttpUrlProber({
      fetchImpl: makeFetch("{}", {
        contentType: "application/json",
      }),
    });
    const r = await prober.probe("https://example.com/data.json");
    expect(r.fetchStatus).toBe("ok");
    expect(r.preview).toBeNull();
    expect(r.title).toBeNull();
    expect(r.meta.contentType).toBe("application/json");
  });

  test("4xx response yields fetchStatus client-error and null body fields", async () => {
    const prober = createHttpUrlProber({
      fetchImpl: makeFetch("not found", { status: 404 }),
    });
    const r = await prober.probe("https://example.com/missing");
    expect(r.fetchStatus).toBe("client-error");
    expect(r.preview).toBeNull();
  });

  test("network error returns network-error category", async () => {
    const prober = createHttpUrlProber({
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    const r = await prober.probe("https://nope.example.com");
    expect(r.fetchStatus).toBe("network-error");
    expect(r.title).toBeNull();
  });

  test("aborted (timeout) → timeout category", async () => {
    const prober = createHttpUrlProber({
      timeoutMs: 1,
      fetchImpl: (async (_url: unknown, init: RequestInit | undefined) => {
        // Wait long enough for the abort to fire.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 50);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return new Response("late");
      }) as unknown as typeof fetch,
    });
    const r = await prober.probe("https://slow.example.com");
    expect(r.fetchStatus).toBe("timeout");
  });
});
