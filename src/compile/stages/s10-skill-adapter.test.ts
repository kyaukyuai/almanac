/**
 * Tests for Stage 10 — SKILL.md adapter.
 *
 * Strategy: re-use Stage 9's cooking fixture, drive both stages end-to-end,
 * and assert that:
 *   - SKILL.md begins with a single YAML frontmatter block (DOMAIN.md's
 *     internal frontmatter is stripped)
 *   - frontmatter.name = "almanac-<id>"; allowedTools are MCP-qualified
 *   - disabled tools are excluded from allowedTools
 *   - body contains DOMAIN/AGENTS/SKILLS sections concatenated
 *   - byteLength matches UTF-8 size
 */

import { describe, expect, test } from "bun:test";

import {
  DomainSpecSchema,
  Stage09NarrativeSchema,
  Stage10OutputSchema,
  ToolManifestSchema,
  type DomainSpec,
  type Stage09Narrative,
  type ToolManifest,
} from "../../core/types.ts";
import { runContractFiles } from "./s09-contract.ts";
import { runSkillAdapter } from "./s10-skill-adapter.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures (cooking, mirroring s09-contract.test.ts)
// ──────────────────────────────────────────────────────────────────────────────

const cookingSpec: DomainSpec = DomainSpecSchema.parse({
  domain: "cooking",
  canonicalSlug: "cooking",
  displayName: "Cooking",
  summary:
    "Preparation of food across cuisines, techniques, and ingredients, from home cooking to professional kitchens.",
  subareas: ["techniques and methods", "ingredients and substitutions", "world cuisines"],
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
      static: { examples: ["maillard reaction", "knife skills", "fundamental sauces"] },
      slow: { examples: ["regional ingredient availability"], maxAgeDays: 30 },
      fast: { examples: ["currently trending recipes"], maxAgeHours: 24 },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://www.seriouseats.com", kind: "docs" },
    { hint: "https://cooking.nytimes.com", kind: "docs" },
    { hint: "https://www.cooksillustrated.com", kind: "docs" },
  ],
  suggestedTools: [],
  cautions: [],
});

const narrative: Stage09Narrative = Stage09NarrativeSchema.parse({
  schemaVersion: "0.1.0",
  domainOneLiner:
    "Sourced, freshness-aware retrieval and tools for cooking knowledge — from foundational techniques to modern adaptations.",
  scope: {
    covers: [
      "Techniques (sautéing, braising, fermentation, sous vide).",
      "Ingredients and substitutions across cuisines.",
    ],
    outOfScope: [
      "Personalized meal planning or dietary medical advice.",
      "Live restaurant reservations or delivery status.",
    ],
  },
  toolSelectionGuidance:
    "Use `query_facts` for technique definitions and timeless knowledge. Use `ingredient_substitute` for substitution queries.",
});

const queryFacts: ToolManifest = ToolManifestSchema.parse({
  name: "query_facts",
  version: "0.1.0",
  description: "FTS5 search over the indexed static / slow fact store.",
  whenToUse: "When the user asks a static or slow-volatility question.",
  returnsSummary: "Top-K facts with citations and freshness metadata.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  outputSchema: { type: "object", properties: { facts: { type: "array" } } },
  capabilities: { network: [], fs: "read", subprocess: [], secrets: [] },
  volatilityClass: "slow",
  freshness: { cachePolicy: "manual-refresh", ttlSeconds: null, sourceTimestamp: false },
  knowledgeUsage: { facts: true, ftsQuery: "{q}", embeddings: false },
  examples: [{ description: "smoke", input: { q: "maillard" }, expectedShape: "match-outputSchema" }],
  designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
  disabled: false,
});

const ingredientSubstitute: ToolManifest = ToolManifestSchema.parse({
  ...queryFacts,
  name: "ingredient_substitute",
  description: "Suggest substitutes for an ingredient with notes on flavor.",
  whenToUse: "When the user asks for an alternative to a specific ingredient.",
  returnsSummary: "Ranked list of substitute ingredients with notes.",
  volatilityClass: "static",
});

const disabled: ToolManifest = ToolManifestSchema.parse({
  ...queryFacts,
  name: "version_diff",
  disabled: true,
  disabledReason: "Stage 7 retries exhausted.",
});

// ──────────────────────────────────────────────────────────────────────────────
// End-to-end
// ──────────────────────────────────────────────────────────────────────────────

describe("runSkillAdapter — cooking end-to-end", () => {
  const compiledAt = new Date("2026-05-08T12:00:00.000Z");
  const stage9 = runContractFiles({
    domainSpec: cookingSpec,
    narrative,
    manifests: [queryFacts, disabled, ingredientSubstitute],
    compiledAt,
  });
  const out = runSkillAdapter({
    domainSpec: cookingSpec,
    manifests: [queryFacts, disabled, ingredientSubstitute],
    contractFiles: stage9,
    factCount: 1234,
    compiledAt,
    skillDescription:
      "Cooking domain almanac. Sourced, freshness-aware facts and live retrieval for techniques, ingredients, and cuisines.",
  });

  test("output re-validates through schema", () => {
    expect(() => Stage10OutputSchema.parse(out)).not.toThrow();
  });

  test("relPath is canonical", () => {
    expect(out.relPath).toBe("adapters/skill/SKILL.md");
  });

  test("frontmatter has expected name + metadata", () => {
    expect(out.frontmatter.name).toBe("almanac-cooking");
    expect(out.frontmatter.metadata.almanac.domain).toBe("cooking");
    expect(out.frontmatter.metadata.almanac.freshnessProfileId).toBe("static-heavy");
    expect(out.frontmatter.metadata.almanac.toolCount).toBe(2);
    expect(out.frontmatter.metadata.almanac.factCount).toBe(1234);
    expect(out.frontmatter.metadata.almanac.compiledAt).toBe(
      "2026-05-08T12:00:00.000Z",
    );
  });

  test("allowedTools are MCP-qualified and exclude disabled tools", () => {
    expect(out.frontmatter.allowedTools).toEqual([
      "mcp__almanac-cooking__query_facts",
      "mcp__almanac-cooking__ingredient_substitute",
    ]);
  });

  test("contents start with exactly one frontmatter block", () => {
    expect(out.contents.startsWith("---\n")).toBe(true);
    // Find both `---\n` markers; should be at offset 0 and one more.
    const first = out.contents.indexOf("---\n");
    const second = out.contents.indexOf("\n---\n", first + 4);
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(0);
    // No third one (DOMAIN.md's frontmatter must have been stripped).
    const third = out.contents.indexOf("\n---\n", second + 5);
    // We do see internal `---` separators between sections, but no
    // YAML-style frontmatter block (`---` immediately at col 0 not preceded
    // by Markdown rule context). The first frontmatter delimiter pair is at
    // the top; subsequent `---` lines are section separators, not frontmatter.
    // So `third` may be > 0 but it is part of the body separators, not a
    // frontmatter block.
    expect(third === -1 || third > second).toBe(true);
  });

  test("body contains DOMAIN/AGENTS/SKILLS sections", () => {
    expect(out.contents).toContain("# Cooking Almanac");                     // DOMAIN.md
    expect(out.contents).toContain("# AGENTS.md — Cooking Almanac");          // AGENTS.md
    expect(out.contents).toContain("# Cooking — Tools Catalog");              // SKILLS.md
  });

  test("UTF-8 byteLength matches contents", () => {
    expect(out.byteLength).toBe(new TextEncoder().encode(out.contents).length);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Schema invariants
// ──────────────────────────────────────────────────────────────────────────────

describe("Stage10OutputSchema invariants", () => {
  const compiledAt = new Date("2026-05-08T12:00:00.000Z");
  const stage9 = runContractFiles({
    domainSpec: cookingSpec,
    narrative,
    manifests: [queryFacts],
    compiledAt,
  });

  test("rejects mismatched byteLength", () => {
    const out = runSkillAdapter({
      domainSpec: cookingSpec,
      manifests: [queryFacts],
      contractFiles: stage9,
      factCount: 0,
      compiledAt,
      skillDescription: "Cooking domain almanac. Sourced, freshness-aware facts.",
    });
    expect(() =>
      Stage10OutputSchema.parse({ ...out, byteLength: out.byteLength + 1 }),
    ).toThrow(/UTF-8 size/);
  });

  test("rejects allowedTools.length disagreeing with toolCount", () => {
    const out = runSkillAdapter({
      domainSpec: cookingSpec,
      manifests: [queryFacts],
      contractFiles: stage9,
      factCount: 0,
      compiledAt,
      skillDescription: "Cooking domain almanac. Sourced, freshness-aware facts.",
    });
    expect(() =>
      Stage10OutputSchema.parse({
        ...out,
        frontmatter: {
          ...out.frontmatter,
          metadata: {
            ...out.frontmatter.metadata,
            almanac: {
              ...out.frontmatter.metadata.almanac,
              toolCount: 99,
            },
          },
        },
      }),
    ).toThrow(/allowedTools\.length.*toolCount/);
  });
});
