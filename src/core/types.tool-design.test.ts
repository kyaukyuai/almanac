/**
 * Tests for `ToolDesignResultSchema` (Stage 6 output).
 *
 * The first three tests parse the worked examples embedded in
 * `src/compile/prompts/06-tool-design/v1.md`. If a prompt example fails to
 * parse, fix the prompt — these examples are the contract the LLM is asked to
 * match.
 */

import { describe, expect, test } from "bun:test";

import {
  ToolDesignResultSchema,
  parseToolDesignResult,
  type ToolDesignResult,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Worked examples from prompt v1
// ──────────────────────────────────────────────────────────────────────────────

const KUBERNETES_EXAMPLE: unknown = {
  schemaVersion: "0.1.0",
  customTools: [
    {
      name: "lookup_resource_spec",
      version: "0.1.0",
      description:
        "Look up the OpenAPI schema for a Kubernetes resource at a specific minor version.",
      whenToUse:
        "When the user asks about the fields, defaults, or validation rules of a Kubernetes resource at a specific version (e.g., Pod in 1.30).",
      returnsSummary:
        "JSON schema fragment for the requested resource with field descriptions and version metadata.",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", description: "Resource kind (e.g., Pod, Deployment)" },
          apiVersion: { type: "string", description: "Group/version (e.g., apps/v1)" },
          k8sVersion: { type: "string", description: "Kubernetes minor version (e.g., 1.30)" },
        },
        required: ["resource", "k8sVersion"],
      },
      outputSchema: {
        type: "object",
        properties: {
          resource: { type: "string" },
          apiVersion: { type: "string" },
          k8sVersion: { type: "string" },
          schema: { type: "object" },
        },
        required: ["resource", "apiVersion", "k8sVersion", "schema"],
      },
      capabilities: {
        network: ["raw.githubusercontent.com", "kubernetes.io"],
        fs: "none",
        subprocess: [],
        secrets: [],
      },
      volatilityClass: "fast",
      freshness: { cachePolicy: "ttl", ttlSeconds: 86400, sourceTimestamp: false },
      knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
      examples: [
        {
          description: "Pod in 1.30 returns a non-empty schema",
          input: { resource: "Pod", k8sVersion: "1.30" },
          expectedShape: "match-outputSchema",
        },
      ],
      designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
      disabled: false,
    },
    {
      name: "version_diff",
      version: "0.1.0",
      description:
        "Diff features, deprecations, and breaking changes between two Kubernetes minor versions.",
      whenToUse:
        "When the user wants to compare two Kubernetes versions or understand what changed between them.",
      returnsSummary:
        "Categorized list of additions, deprecations, removals, and CVEs between the two versions.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Lower minor version (e.g., 1.29)" },
          to: { type: "string", description: "Higher minor version (e.g., 1.30)" },
        },
        required: ["from", "to"],
      },
      outputSchema: {
        type: "object",
        properties: {
          additions: { type: "array" },
          deprecations: { type: "array" },
          removals: { type: "array" },
          cves: { type: "array" },
        },
        required: ["additions", "deprecations", "removals"],
      },
      capabilities: {
        network: ["api.github.com", "raw.githubusercontent.com"],
        fs: "none",
        subprocess: [],
        secrets: ["GITHUB_TOKEN"],
      },
      volatilityClass: "fast",
      freshness: { cachePolicy: "ttl", ttlSeconds: 86400, sourceTimestamp: false },
      knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
      examples: [
        {
          description: "1.29 -> 1.30 returns at least one entry per category",
          input: { from: "1.29", to: "1.30" },
          expectedShape: { contains: ["additions", "deprecations"] },
        },
      ],
      designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
      disabled: false,
    },
  ],
  rationale:
    "Kubernetes users frequently need version-aware spec lookups and minor-version diffs that the four defaults cannot resolve directly. Both tools are scoped fast (24h TTL) because the underlying release cadence is monthly to quarterly.",
};

const COOKING_EXAMPLE: unknown = {
  schemaVersion: "0.1.0",
  customTools: [
    {
      name: "ingredient_substitute",
      version: "0.1.0",
      description:
        "Suggest substitutes for an ingredient with notes on flavor, texture, and cooking impact.",
      whenToUse:
        "When the user asks for an alternative to a specific ingredient, especially due to allergies, availability, or dietary restrictions.",
      returnsSummary:
        "Ranked list of substitute ingredients with ratio guidance and trade-off notes.",
      inputSchema: {
        type: "object",
        properties: {
          ingredient: { type: "string", description: "The ingredient to substitute (e.g., buttermilk)" },
          context: { type: "string", description: "Optional dish/technique context (e.g., baking)" },
        },
        required: ["ingredient"],
      },
      outputSchema: {
        type: "object",
        properties: {
          ingredient: { type: "string" },
          substitutes: { type: "array" },
        },
        required: ["ingredient", "substitutes"],
      },
      capabilities: { network: [], fs: "read", subprocess: [], secrets: [] },
      volatilityClass: "static",
      freshness: { cachePolicy: "manual-refresh", ttlSeconds: null, sourceTimestamp: false },
      knowledgeUsage: { facts: true, ftsQuery: "substitute {q}", embeddings: false },
      examples: [
        {
          description: "buttermilk returns at least one substitute",
          input: { ingredient: "buttermilk", context: "baking" },
          expectedShape: "match-outputSchema",
        },
      ],
      designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
      disabled: false,
    },
  ],
  rationale:
    "Substitution is the one composition pattern over the cooking fact store that the default query_facts cannot perform on its own (it requires entity-typed retrieval and ranking). Other workflows in cooking (technique lookup, recipe search) are fully covered by query_facts and web_search_recent.",
};

const CRYPTO_EXAMPLE: unknown = {
  schemaVersion: "0.1.0",
  customTools: [
    {
      name: "price_now",
      version: "0.1.0",
      description: "Get the current spot price and 24-hour change for a crypto asset.",
      whenToUse:
        "When the user asks for the current price, recent change, or 24h volume of a specific asset.",
      returnsSummary:
        "Spot price, 24h change percentage, and 24h volume for the requested asset.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Asset symbol (e.g., ETH, BTC)" },
          vs: { type: "string", description: "Quote currency (default: USD)" },
        },
        required: ["symbol"],
      },
      outputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          vs: { type: "string" },
          price: { type: "number" },
          change24h: { type: "number" },
          volume24h: { type: "number" },
        },
        required: ["symbol", "vs", "price"],
      },
      capabilities: {
        network: ["api.coingecko.com"],
        fs: "none",
        subprocess: [],
        secrets: [],
      },
      volatilityClass: "live",
      freshness: { cachePolicy: "no-cache", ttlSeconds: null, sourceTimestamp: true },
      knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
      examples: [
        {
          description: "ETH spot price is positive",
          input: { symbol: "ETH" },
          expectedShape: "match-outputSchema",
        },
      ],
      designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
      disabled: false,
    },
    {
      name: "stablecoin_yields",
      version: "0.1.0",
      description:
        "List current top stablecoin yield pools across major DeFi protocols with TVL and APR.",
      whenToUse:
        "When the user asks about current stablecoin yield opportunities, top APR pools, or TVL-weighted yield comparisons.",
      returnsSummary:
        "Ranked list of stablecoin pools with protocol, asset, APR, TVL, and risk notes.",
      inputSchema: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Stablecoin (USDC, USDT, DAI). Optional: omit for all" },
          minTvlUsd: { type: "number", description: "Minimum TVL filter (default: 10000000)" },
          limit: { type: "integer", description: "Max pools to return (default: 10, max: 50)" },
        },
        required: [],
      },
      outputSchema: {
        type: "object",
        properties: { pools: { type: "array" } },
        required: ["pools"],
      },
      capabilities: {
        network: ["yields.llama.fi"],
        fs: "none",
        subprocess: [],
        secrets: [],
      },
      volatilityClass: "live",
      freshness: { cachePolicy: "no-cache", ttlSeconds: null, sourceTimestamp: true },
      knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
      examples: [
        {
          description: "USDC pools returned",
          input: { asset: "USDC", limit: 5 },
          expectedShape: "match-outputSchema",
        },
      ],
      designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
      disabled: false,
    },
  ],
  rationale:
    "Crypto trading is live-heavy; the four defaults cannot reach price feeds or DeFi yield aggregators. Both tools are scoped to specific upstream hosts (api.coingecko.com, yields.llama.fi) with no-cache to ensure prices and yields are always fetched fresh. No custom static/slow tools are warranted because educational content (AMM math, consensus mechanisms) is fully served by query_facts.",
};

// ──────────────────────────────────────────────────────────────────────────────

describe("ToolDesignResult — prompt v1 worked examples", () => {
  test("kubernetes example parses", () => {
    const r = ToolDesignResultSchema.parse(KUBERNETES_EXAMPLE);
    expect(r.customTools).toHaveLength(2);
    expect(r.customTools.map((t) => t.name)).toEqual([
      "lookup_resource_spec",
      "version_diff",
    ]);
    expect(r.customTools[1]!.capabilities.secrets).toEqual(["GITHUB_TOKEN"]);
  });

  test("cooking example parses", () => {
    const r = ToolDesignResultSchema.parse(COOKING_EXAMPLE);
    expect(r.customTools).toHaveLength(1);
    const t = r.customTools[0]!;
    expect(t.knowledgeUsage.facts).toBe(true);
    expect(t.knowledgeUsage.ftsQuery).toBe("substitute {q}");
    expect(t.volatilityClass).toBe("static");
  });

  test("crypto-trading example parses", () => {
    const r = ToolDesignResultSchema.parse(CRYPTO_EXAMPLE);
    expect(r.customTools).toHaveLength(2);
    for (const t of r.customTools) {
      expect(t.volatilityClass).toBe("live");
      expect(t.freshness.cachePolicy).toBe("no-cache");
      expect(t.knowledgeUsage.facts).toBe(false);
    }
  });

  test("empty customTools is valid (correct answer for some domains)", () => {
    const r = ToolDesignResultSchema.parse({
      schemaVersion: "0.1.0",
      customTools: [],
      rationale:
        "The four defaults (query_facts, fetch_official_docs, web_search_recent, latest_releases) fully cover this domain's workflows.",
    });
    expect(r.customTools).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("ToolDesignResult — validation rejections", () => {
  const minimalLiveTool: ToolDesignResult["customTools"][number] = {
    name: "ping",
    version: "0.1.0",
    description: "Ping a service for liveness.",
    whenToUse: "When the user wants to check whether a service is responsive.",
    returnsSummary: "Round-trip latency in milliseconds and HTTP status.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    capabilities: { network: ["example.com"], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: "live",
    freshness: { cachePolicy: "no-cache", ttlSeconds: null, sourceTimestamp: false },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    examples: [
      {
        description: "smoke",
        input: { host: "example.com" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
    disabled: false,
  };

  test("rejects customTool name colliding with a default", () => {
    expect(() =>
      parseToolDesignResult({
        schemaVersion: "0.1.0",
        customTools: [{ ...minimalLiveTool, name: "query_facts" }],
        rationale: "x".repeat(40),
      }),
    ).toThrow(/collides with a default tool/);
  });

  test("rejects duplicate customTool names", () => {
    expect(() =>
      parseToolDesignResult({
        schemaVersion: "0.1.0",
        customTools: [
          { ...minimalLiveTool, name: "ping_a" },
          { ...minimalLiveTool, name: "ping_a" },
        ],
        rationale: "x".repeat(40),
      }),
    ).toThrow(/duplicate customTool name/);
  });

  test("rejects implementedBy at design time (Stage 7 fills it)", () => {
    expect(() =>
      parseToolDesignResult({
        schemaVersion: "0.1.0",
        customTools: [
          {
            ...minimalLiveTool,
            implementedBy: {
              model: "claude-sonnet-4",
              promptVersion: "07-tool-impl/v1",
              tscPassed: true,
              smokePassed: true,
              attempts: 1,
            },
          },
        ],
        rationale: "x".repeat(40),
      }),
    ).toThrow(/implementedBy must be omitted/);
  });

  test("rejects more than 3 customTools", () => {
    expect(() =>
      parseToolDesignResult({
        schemaVersion: "0.1.0",
        customTools: [
          { ...minimalLiveTool, name: "ping_a" },
          { ...minimalLiveTool, name: "ping_b" },
          { ...minimalLiveTool, name: "ping_c" },
          { ...minimalLiveTool, name: "ping_d" },
        ],
        rationale: "x".repeat(40),
      }),
    ).toThrow();
  });

  test("rejects missing rationale", () => {
    expect(() =>
      parseToolDesignResult({
        schemaVersion: "0.1.0",
        customTools: [],
      }),
    ).toThrow();
  });

  test("rejects wrong schemaVersion", () => {
    expect(() =>
      parseToolDesignResult({
        schemaVersion: "0.2.0",
        customTools: [],
        rationale: "x".repeat(40),
      }),
    ).toThrow();
  });
});
