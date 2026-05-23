/**
 * Tests for `DomainSpec` zod schema.
 *
 * The first three tests are critical: they parse the worked examples embedded
 * in `src/compile/prompts/01-domain-analysis/v1.md` to ensure the prompt and
 * the schema do not drift. If a prompt example fails to parse, fix the prompt.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  DomainSpecSchema,
  InsufficientDomainError,
  parseDomainSpec,
  type DomainSpec,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Worked examples from prompt v1 — must parse successfully
// ──────────────────────────────────────────────────────────────────────────────

const KUBERNETES_EXAMPLE = {
  domain: "kubernetes",
  canonicalSlug: "kubernetes",
  displayName: "Kubernetes",
  summary:
    "Container orchestration platform for automating deployment, scaling, and management of containerized workloads.",
  subareas: [
    "core api and controllers",
    "scheduling and resource management",
    "networking",
    "storage",
    "security and policy",
  ],
  intents: [
    {
      kind: "howto",
      example: "how do I write a controller for a custom resource?",
    },
    {
      kind: "lookup",
      example: "what are the default kubelet eviction thresholds?",
    },
    { kind: "explain", example: "why does my pod stay in CrashLoopBackOff?" },
    {
      kind: "compare",
      example: "what changed between Kubernetes 1.29 and 1.30?",
    },
  ],
  verbs: [
    "explain",
    "diagnose",
    "compare-versions",
    "lookup-spec",
    "design",
  ],
  entityTypes: [
    "resource",
    "controller",
    "version",
    "feature-gate",
    "api-group",
  ],
  freshnessProfile: {
    profileId: "mixed",
    defaultClass: "fast",
    classes: {
      static: {
        examples: [
          "controller pattern",
          "container runtime concepts",
          "raft consensus basics",
        ],
      },
      slow: {
        examples: [
          "RBAC design patterns",
          "operator framework conventions",
          "stable api versioning policy",
        ],
        maxAgeDays: 30,
      },
      fast: {
        examples: [
          "latest minor release features",
          "current deprecation timeline",
          "recently published CVEs",
        ],
        maxAgeHours: 24,
      },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://kubernetes.io/docs/", kind: "docs" },
    { hint: "https://kubernetes.io/blog/", kind: "news" },
    {
      hint: "https://github.com/kubernetes/kubernetes/releases",
      kind: "repo",
    },
    { hint: "https://github.com/kubernetes/community", kind: "repo" },
    { hint: "https://github.com/kubernetes/enhancements", kind: "repo" },
    { hint: "https://www.cncf.io/blog/", kind: "news" },
    { hint: "site:reddit.com/r/kubernetes recent", kind: "community" },
    { hint: "https://kubernetes.io/docs/reference/", kind: "docs" },
  ],
  suggestedTools: [
    {
      name: "lookup_resource_spec",
      purpose:
        "Look up the OpenAPI schema for a Kubernetes resource at a specific version.",
      verbs: ["lookup-spec"],
      expectedVolatility: "fast",
    },
    {
      name: "version_diff",
      purpose:
        "Diff features and breaking changes between two Kubernetes minor versions.",
      verbs: ["compare-versions"],
      expectedVolatility: "fast",
    },
  ],
  cautions: [],
};

const COOKING_EXAMPLE = {
  domain: "cooking",
  canonicalSlug: "cooking",
  displayName: "Cooking",
  summary:
    "Preparation of food across cuisines, techniques, and ingredients, from home cooking to professional kitchens.",
  subareas: [
    "techniques and methods",
    "ingredients and substitutions",
    "world cuisines",
  ],
  intents: [
    { kind: "lookup", example: "how do I make a proper dashi?" },
    { kind: "explain", example: "why does salting onions extract water?" },
    { kind: "compare", example: "italian vs japanese pasta" },
  ],
  verbs: ["lookup-recipe", "explain-technique", "substitute"],
  entityTypes: ["recipe", "ingredient", "technique", "cuisine"],
  freshnessProfile: {
    profileId: "static-heavy",
    defaultClass: "static",
    classes: {
      static: {
        examples: ["maillard reaction", "knife skills", "fundamental sauces"],
      },
      slow: {
        examples: [
          "regional ingredient availability",
          "modern technique adoption (sous vide)",
        ],
        maxAgeDays: 30,
      },
      fast: {
        examples: [
          "currently trending recipes",
          "latest cookbook releases",
        ],
        maxAgeHours: 24,
      },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://www.seriouseats.com", kind: "docs" },
    { hint: "https://cooking.nytimes.com", kind: "docs" },
    { hint: "https://www.cooksillustrated.com", kind: "docs" },
    { hint: "Cooking Issues podcast notes", kind: "community" },
    { hint: "https://github.com/topics/recipes", kind: "repo" },
  ],
  suggestedTools: [
    {
      name: "ingredient_substitute",
      purpose:
        "Suggest substitutes for an ingredient with notes on flavor, texture, and cooking impact.",
      verbs: ["substitute"],
      expectedVolatility: "static",
    },
  ],
  cautions: [],
};

const CRYPTO_TRADING_EXAMPLE = {
  domain: "crypto-trading",
  canonicalSlug: "crypto-trading",
  displayName: "Crypto Trading",
  summary:
    "Trading and analysis of cryptocurrencies and DeFi protocols across centralized and on-chain venues.",
  subareas: [
    "spot and derivatives trading",
    "on-chain analysis",
    "defi protocols and yields",
    "market microstructure",
    "risk management",
  ],
  intents: [
    { kind: "lookup", example: "what is the current ETH price?" },
    { kind: "explain", example: "how do AMM curves work?" },
    {
      kind: "track",
      example: "what is the highest yield USDC pool right now?",
    },
    {
      kind: "compare",
      example: "uniswap v3 vs curve for stablecoin swaps",
    },
  ],
  verbs: ["price-check", "explain", "compare-yields", "track"],
  entityTypes: ["asset", "protocol", "venue", "pool", "wallet"],
  freshnessProfile: {
    profileId: "live-heavy",
    defaultClass: "live",
    classes: {
      static: { examples: ["amm math", "consensus mechanisms"] },
      slow: { examples: ["protocol design patterns"], maxAgeDays: 30 },
      fast: {
        examples: [
          "recent protocol upgrades",
          "current best-practice strategies",
        ],
        maxAgeHours: 24,
      },
      live: {
        examples: [
          "spot prices",
          "gas fees",
          "tvl",
          "funding rates",
          "pool yields",
        ],
      },
    },
  },
  suggestedSources: [
    { hint: "https://defillama.com", kind: "data" },
    { hint: "https://docs.uniswap.org", kind: "docs" },
    { hint: "https://www.coingecko.com", kind: "data" },
    { hint: "https://github.com/ethereum/EIPs", kind: "repo" },
    { hint: "https://blog.chain.link", kind: "news" },
    { hint: "https://dune.com", kind: "data" },
    { hint: "site:twitter.com crypto trading recent", kind: "community" },
  ],
  suggestedTools: [
    {
      name: "price_now",
      purpose: "Get the current spot price and 24-hour change for an asset.",
      verbs: ["price-check"],
      expectedVolatility: "live",
    },
    {
      name: "stablecoin_yields",
      purpose:
        "List current top stablecoin yield pools across major protocols with TVL and APR.",
      verbs: ["compare-yields"],
      expectedVolatility: "live",
    },
  ],
  cautions: [
    {
      area: "financial",
      rationale:
        "Trading decisions in this domain involve real capital loss risk; prices and yields are highly volatile and adversarial.",
    },
  ],
};

describe("DomainSpec — prompt v1 worked examples", () => {
  test("kubernetes example parses", () => {
    const spec = DomainSpecSchema.parse(KUBERNETES_EXAMPLE);
    expect(spec.canonicalSlug).toBe("kubernetes");
    expect(spec.freshnessProfile.profileId).toBe("mixed");
    expect(spec.freshnessProfile.defaultClass).toBe("fast");
  });

  test("cooking example parses", () => {
    const spec = DomainSpecSchema.parse(COOKING_EXAMPLE);
    expect(spec.canonicalSlug).toBe("cooking");
    expect(spec.freshnessProfile.profileId).toBe("static-heavy");
    expect(spec.freshnessProfile.defaultClass).toBe("static");
    expect(spec.freshnessProfile.classes.live.examples).toEqual([]);
  });

  test("crypto-trading example parses", () => {
    const spec = DomainSpecSchema.parse(CRYPTO_TRADING_EXAMPLE);
    expect(spec.canonicalSlug).toBe("crypto-trading");
    expect(spec.freshnessProfile.profileId).toBe("live-heavy");
    expect(spec.freshnessProfile.defaultClass).toBe("live");
    expect(spec.cautions[0]?.area).toBe("financial");
  });
});

describe("DomainSpec — INSUFFICIENT_DOMAIN sentinel", () => {
  test("parseDomainSpec throws InsufficientDomainError", () => {
    const raw = {
      ...COOKING_EXAMPLE,
      summary: "INSUFFICIENT_DOMAIN: domain is gibberish ('asdfgh')",
    };
    expect(() => parseDomainSpec(raw)).toThrow(InsufficientDomainError);
    try {
      parseDomainSpec(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientDomainError);
      expect((err as InsufficientDomainError).reason).toBe(
        "domain is gibberish ('asdfgh')"
      );
    }
  });

  test("parseDomainSpec passes valid input through", () => {
    const spec = parseDomainSpec(COOKING_EXAMPLE);
    expect(spec.canonicalSlug).toBe("cooking");
  });

  test("leading whitespace before sentinel is tolerated", () => {
    const raw = {
      ...COOKING_EXAMPLE,
      summary: "  INSUFFICIENT_DOMAIN: leading-whitespace test",
    };
    expect(() => parseDomainSpec(raw)).toThrow(InsufficientDomainError);
  });
});

describe("DomainSpec — validation rejections", () => {
  test("rejects suggestedTool name that collides with default tool", () => {
    const bad: DomainSpec = structuredClone(KUBERNETES_EXAMPLE) as DomainSpec;
    bad.suggestedTools = [
      {
        name: "query_facts", // collides
        purpose: "duplicate of default tool, should be rejected",
        verbs: ["lookup"],
        expectedVolatility: "static",
      },
    ];
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects non-snake-case suggestedTool name", () => {
    const bad = structuredClone(KUBERNETES_EXAMPLE);
    bad.suggestedTools = [
      {
        name: "Camel_Case",
        purpose: "this should be rejected for casing",
        verbs: ["lookup"],
        expectedVolatility: "fast",
      },
    ];
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects canonicalSlug with uppercase or special chars", () => {
    const bad = structuredClone(COOKING_EXAMPLE);
    bad.canonicalSlug = "Cooking_World";
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects canonicalSlug longer than 32 chars", () => {
    const bad = structuredClone(COOKING_EXAMPLE);
    bad.canonicalSlug = "a".repeat(33);
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects profileId / defaultClass inconsistency", () => {
    const bad = structuredClone(COOKING_EXAMPLE);
    bad.freshnessProfile = {
      ...bad.freshnessProfile,
      profileId: "live-heavy", // expects fast/live default
      defaultClass: "static", // inconsistent
    };
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects empty examples on the defaultClass", () => {
    const bad = structuredClone(COOKING_EXAMPLE);
    bad.freshnessProfile = {
      profileId: "static-heavy",
      defaultClass: "static",
      classes: {
        static: { examples: [] }, // empty but designated default
        slow: { examples: ["a", "b"], maxAgeDays: 30 },
        fast: { examples: ["c"], maxAgeHours: 24 },
        live: { examples: [] },
      },
    };
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects freshnessProfile with only one non-empty class", () => {
    const bad = structuredClone(COOKING_EXAMPLE);
    bad.freshnessProfile = {
      profileId: "static-heavy",
      defaultClass: "static",
      classes: {
        static: { examples: ["only this one"] },
        slow: { examples: [], maxAgeDays: 30 },
        fast: { examples: [], maxAgeHours: 24 },
        live: { examples: [] },
      },
    };
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects duplicate suggestedTool names", () => {
    const bad = structuredClone(KUBERNETES_EXAMPLE);
    bad.suggestedTools = [
      {
        name: "version_diff",
        purpose: "first occurrence is fine",
        verbs: ["compare-versions"],
        expectedVolatility: "fast",
      },
      {
        name: "version_diff",
        purpose: "second occurrence should be rejected",
        verbs: ["compare-versions"],
        expectedVolatility: "fast",
      },
    ];
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });

  test("rejects too few subareas (<2)", () => {
    const bad = structuredClone(COOKING_EXAMPLE);
    bad.subareas = ["only-one"];
    expect(() => DomainSpecSchema.parse(bad)).toThrow(z.ZodError);
  });
});
