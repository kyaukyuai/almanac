/**
 * Tests for the runtime-contract schemas in `types.ts`:
 *   - `ToolManifestSchema` (and sub-schemas)
 *   - `ToolResultSchema` / `toolResultSchema()`
 *   - `CitationSchema`, `ToolResultFreshnessSchema`, `ToolErrorSchema`
 *   - `ResourceDescriptorSchema`
 *
 * Cross-field invariants (volatility ↔ cachePolicy, disabled ↔ disabledReason,
 * facts ↔ ftsQuery, static maxAge=null, etc.) are exercised explicitly here.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  CitationSchema,
  ResourceDescriptorSchema,
  ResourceUriSchema,
  StalenessSchema,
  ToolCachePolicySchema,
  ToolCapabilitiesSchema,
  ToolErrorSchema,
  ToolFreshnessConfigSchema,
  ToolKnowledgeUsageSchema,
  ToolManifestSchema,
  ToolResultFreshnessSchema,
  ToolResultSchema,
  toolResultSchema,
  type ToolManifest,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Reusable manifest factory — keeps tests focused on one invariant at a time
// ──────────────────────────────────────────────────────────────────────────────

const validManifest = (overrides: Partial<ToolManifest> = {}): unknown => ({
  name: "query_facts",
  version: "0.1.0",
  description: "Search the indexed fact store with FTS5.",
  whenToUse: "When the user asks a static or slow-volatility question.",
  returnsSummary: "Top-K facts with citations and freshness metadata.",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  },
  outputSchema: {
    type: "object",
    properties: { facts: { type: "array" } },
  },
  capabilities: {
    network: [],
    fs: "read",
    subprocess: [],
    secrets: [],
  },
  volatilityClass: "slow",
  freshness: {
    cachePolicy: "manual-refresh",
    ttlSeconds: null,
    sourceTimestamp: false,
  },
  knowledgeUsage: {
    facts: true,
    ftsQuery: "{q}",
    embeddings: false,
  },
  examples: [
    {
      description: "smoke: returns at least one fact for a known entity",
      input: { q: "maillard reaction" },
      expectedShape: "match-outputSchema",
    },
  ],
  designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
  disabled: false,
  ...overrides,
});

// ──────────────────────────────────────────────────────────────────────────────
// ToolManifestSchema
// ──────────────────────────────────────────────────────────────────────────────

describe("ToolManifestSchema", () => {
  test("accepts a valid query_facts-style manifest", () => {
    const parsed = ToolManifestSchema.parse(validManifest());
    expect(parsed.name).toBe("query_facts");
    expect(parsed.knowledgeUsage.facts).toBe(true);
    expect(parsed.implementedBy).toBeUndefined();
  });

  test("accepts a live tool with cachePolicy=no-cache", () => {
    const parsed = ToolManifestSchema.parse(
      validManifest({
        name: "price_now",
        volatilityClass: "live",
        freshness: {
          cachePolicy: "no-cache",
          ttlSeconds: null,
          sourceTimestamp: true,
        },
        capabilities: {
          network: ["api.coingecko.com"],
          fs: "none",
          subprocess: [],
          secrets: [],
        },
        knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
      }),
    );
    expect(parsed.volatilityClass).toBe("live");
  });

  test("rejects live tool with cachePolicy=ttl", () => {
    expect(() =>
      ToolManifestSchema.parse(
        validManifest({
          volatilityClass: "live",
          freshness: {
            cachePolicy: "ttl",
            ttlSeconds: 60,
            sourceTimestamp: false,
          },
          knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
        }),
      ),
    ).toThrow(/live tools must use cachePolicy/);
  });

  test("rejects static tool with cachePolicy=no-cache", () => {
    expect(() =>
      ToolManifestSchema.parse(
        validManifest({
          volatilityClass: "static",
          freshness: {
            cachePolicy: "no-cache",
            ttlSeconds: null,
            sourceTimestamp: false,
          },
        }),
      ),
    ).toThrow(/static tools should not use cachePolicy/);
  });

  test("rejects facts=true on a fast/live tool", () => {
    expect(() =>
      ToolManifestSchema.parse(
        validManifest({
          volatilityClass: "fast",
          freshness: {
            cachePolicy: "ttl",
            ttlSeconds: 86400,
            sourceTimestamp: false,
          },
          knowledgeUsage: { facts: true, ftsQuery: "{q}", embeddings: false },
        }),
      ),
    ).toThrow(/knowledgeUsage\.facts is only allowed/);
  });

  test("rejects disabled=true without disabledReason", () => {
    expect(() =>
      ToolManifestSchema.parse(validManifest({ disabled: true })),
    ).toThrow(/disabledReason is required/);
  });

  test("rejects disabled=false with disabledReason set", () => {
    expect(() =>
      ToolManifestSchema.parse(
        validManifest({ disabled: false, disabledReason: "n/a" }),
      ),
    ).toThrow(/disabledReason must be omitted/);
  });

  test("rejects ftsQuery non-null when facts=false", () => {
    expect(() =>
      ToolManifestSchema.parse(
        validManifest({
          knowledgeUsage: { facts: false, ftsQuery: "{q}", embeddings: false },
        }),
      ),
    ).toThrow(/ftsQuery must be null when facts === false/);
  });

  test("rejects non-snake_case tool name", () => {
    expect(() =>
      ToolManifestSchema.parse(validManifest({ name: "queryFacts" })),
    ).toThrow();
  });

  test("rejects non-semver version", () => {
    expect(() =>
      ToolManifestSchema.parse(validManifest({ version: "v0.1" })),
    ).toThrow();
  });

  test("accepts implementedBy after Stage 7 fills it in", () => {
    const parsed = ToolManifestSchema.parse(
      validManifest({
        implementedBy: {
          model: "claude-sonnet-4",
          promptVersion: "07-tool-impl/v1",
          tscPassed: true,
          smokePassed: true,
          attempts: 2,
        },
      }),
    );
    expect(parsed.implementedBy?.attempts).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ──────────────────────────────────────────────────────────────────────────────

describe("ToolFreshnessConfigSchema", () => {
  test("ttl requires positive ttlSeconds", () => {
    expect(() =>
      ToolFreshnessConfigSchema.parse({
        cachePolicy: "ttl",
        ttlSeconds: 0,
        sourceTimestamp: false,
      }),
    ).toThrow();
    expect(() =>
      ToolFreshnessConfigSchema.parse({
        cachePolicy: "ttl",
        ttlSeconds: null,
        sourceTimestamp: false,
      }),
    ).toThrow();
  });

  test("non-ttl forbids ttlSeconds", () => {
    expect(() =>
      ToolFreshnessConfigSchema.parse({
        cachePolicy: "no-cache",
        ttlSeconds: 60,
        sourceTimestamp: false,
      }),
    ).toThrow();
  });

  test("manual-refresh accepts ttlSeconds=null", () => {
    const parsed = ToolFreshnessConfigSchema.parse({
      cachePolicy: "manual-refresh",
      ttlSeconds: null,
      sourceTimestamp: true,
    });
    expect(parsed.cachePolicy).toBe("manual-refresh");
  });
});

describe("ToolKnowledgeUsageSchema", () => {
  test("rejects embeddings=true (reserved for v0.2)", () => {
    expect(() =>
      ToolKnowledgeUsageSchema.parse({
        facts: true,
        ftsQuery: "{q}",
        embeddings: true,
      }),
    ).toThrow(/reserved for v0\.2/);
  });
});

describe("ToolCapabilitiesSchema", () => {
  test("accepts hostname allowlist + SCREAMING_SNAKE secrets", () => {
    const parsed = ToolCapabilitiesSchema.parse({
      network: ["api.github.com", "raw.githubusercontent.com"],
      fs: "none",
      subprocess: [],
      secrets: ["GITHUB_TOKEN"],
    });
    expect(parsed.network).toHaveLength(2);
  });

  test("rejects URL-style entries in network allowlist", () => {
    expect(() =>
      ToolCapabilitiesSchema.parse({
        network: ["https://api.github.com/"],
        fs: "none",
        subprocess: [],
        secrets: [],
      }),
    ).toThrow();
  });

  test("rejects lowercase env-var name", () => {
    expect(() =>
      ToolCapabilitiesSchema.parse({
        network: [],
        fs: "none",
        subprocess: [],
        secrets: ["github_token"],
      }),
    ).toThrow();
  });
});

describe("ToolCachePolicySchema", () => {
  test("enumerates the 3 known policies", () => {
    expect(ToolCachePolicySchema.options).toEqual([
      "no-cache",
      "ttl",
      "manual-refresh",
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Citation, ToolResultFreshness, ToolError
// ──────────────────────────────────────────────────────────────────────────────

describe("CitationSchema", () => {
  test("accepts a minimal citation with required fetchedAt", () => {
    const parsed = CitationSchema.parse({
      sourceId: "kubernetes-docs",
      url: "https://kubernetes.io/docs/concepts/",
      fetchedAt: "2026-05-08T12:00:00.000Z",
    });
    expect(parsed.sourceId).toBe("kubernetes-docs");
  });

  test("rejects missing fetchedAt", () => {
    expect(() =>
      CitationSchema.parse({
        sourceId: "x",
        url: "https://example.com",
      }),
    ).toThrow();
  });

  test("rejects non-ISO fetchedAt", () => {
    expect(() =>
      CitationSchema.parse({
        sourceId: "x",
        url: "https://example.com",
        fetchedAt: "yesterday",
      }),
    ).toThrow();
  });
});

describe("ToolResultFreshnessSchema", () => {
  test("static must have maxAge=null and staleness=fresh", () => {
    const parsed = ToolResultFreshnessSchema.parse({
      class: "static",
      maxAge: null,
      staleness: "fresh",
    });
    expect(parsed.class).toBe("static");

    expect(() =>
      ToolResultFreshnessSchema.parse({
        class: "static",
        maxAge: 0,
        staleness: "fresh",
      }),
    ).toThrow();

    expect(() =>
      ToolResultFreshnessSchema.parse({
        class: "static",
        maxAge: null,
        staleness: "warm",
      }),
    ).toThrow();
  });

  test("slow/fast require maxAge", () => {
    expect(() =>
      ToolResultFreshnessSchema.parse({
        class: "slow",
        maxAge: null,
        staleness: "fresh",
      }),
    ).toThrow();

    const ok = ToolResultFreshnessSchema.parse({
      class: "fast",
      maxAge: 86400,
      staleness: "warm",
    });
    expect(ok.maxAge).toBe(86400);
  });
});

describe("StalenessSchema", () => {
  test("enumerates fresh|warm|stale", () => {
    expect(StalenessSchema.options).toEqual(["fresh", "warm", "stale"]);
  });
});

describe("ToolErrorSchema", () => {
  test("accepts kebab-case code", () => {
    const parsed = ToolErrorSchema.parse({
      code: "upstream-timeout",
      message: "Coingecko did not respond within 5s",
      retryable: true,
    });
    expect(parsed.retryable).toBe(true);
  });

  test("rejects uppercase code", () => {
    expect(() =>
      ToolErrorSchema.parse({
        code: "UpstreamTimeout",
        message: "x",
        retryable: false,
      }),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ToolResult — generic + factory
// ──────────────────────────────────────────────────────────────────────────────

describe("ToolResultSchema", () => {
  test("accepts an ok result with citations and freshness", () => {
    const parsed = ToolResultSchema.parse({
      ok: true,
      data: { facts: [{ id: "abc", text: "x" }] },
      citations: [
        {
          sourceId: "k8s-docs",
          url: "https://kubernetes.io/docs/",
          fetchedAt: "2026-05-08T12:00:00.000Z",
        },
      ],
      freshness: { class: "slow", maxAge: 2592000, staleness: "fresh" },
    });
    expect(parsed.ok).toBe(true);
  });

  test("accepts an error result", () => {
    const parsed = ToolResultSchema.parse({
      ok: false,
      error: {
        code: "no-results",
        message: "No facts matched the query",
        retryable: false,
      },
    });
    expect(parsed.ok).toBe(false);
  });

  test("rejects ok result without citations", () => {
    expect(() =>
      ToolResultSchema.parse({
        ok: true,
        data: {},
        citations: [],
        freshness: { class: "static", maxAge: null, staleness: "fresh" },
      }),
    ).toThrow();
  });

  test("rejects ok result without freshness", () => {
    expect(() =>
      ToolResultSchema.parse({
        ok: true,
        data: {},
        citations: [
          {
            sourceId: "x",
            url: "https://example.com",
            fetchedAt: "2026-05-08T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("toolResultSchema(<data>)", () => {
  test("typed factory validates the data shape", () => {
    const Schema = toolResultSchema(
      z.object({ price: z.number(), symbol: z.string() }),
    );
    const parsed = Schema.parse({
      ok: true,
      data: { price: 3500, symbol: "ETH" },
      citations: [
        {
          sourceId: "coingecko",
          url: "https://api.coingecko.com/api/v3/simple/price",
          fetchedAt: "2026-05-08T12:00:00.000Z",
        },
      ],
      freshness: { class: "live", maxAge: 0, staleness: "fresh" },
    });
    expect(parsed.ok && parsed.data.symbol).toBe("ETH");
  });

  test("typed factory rejects mismatched data", () => {
    const Schema = toolResultSchema(z.object({ price: z.number() }));
    expect(() =>
      Schema.parse({
        ok: true,
        data: { price: "expensive" },
        citations: [
          {
            sourceId: "x",
            url: "https://example.com",
            fetchedAt: "2026-05-08T12:00:00.000Z",
          },
        ],
        freshness: { class: "live", maxAge: 0, staleness: "fresh" },
      }),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ResourceDescriptor / ResourceUri
// ──────────────────────────────────────────────────────────────────────────────

describe("ResourceUriSchema / ResourceDescriptorSchema", () => {
  test("accepts well-formed almanac:// URI", () => {
    expect(() =>
      ResourceUriSchema.parse("almanac://cooking/DOMAIN.md"),
    ).not.toThrow();
    expect(() =>
      ResourceUriSchema.parse("almanac://k8s/sources/sources.yaml"),
    ).not.toThrow();
  });

  test("rejects file:// or http:// URIs", () => {
    expect(() => ResourceUriSchema.parse("file:///tmp/x")).toThrow();
    expect(() =>
      ResourceUriSchema.parse("https://example.com/x"),
    ).toThrow();
  });

  test("descriptor accepts optional description+size", () => {
    const parsed = ResourceDescriptorSchema.parse({
      uri: "almanac://cooking/DOMAIN.md",
      name: "DOMAIN.md",
      description: "Domain definition + freshness policy.",
      mimeType: "text/markdown",
      size: 4096,
    });
    expect(parsed.size).toBe(4096);
  });

  test("descriptor rejects bad URI", () => {
    expect(() =>
      ResourceDescriptorSchema.parse({
        uri: "not-a-uri",
        name: "x",
        mimeType: "text/plain",
      }),
    ).toThrow();
  });
});
