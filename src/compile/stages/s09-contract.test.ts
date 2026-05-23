/**
 * Tests for Stage 9 — contract files renderer + orchestrator.
 *
 * Strategy:
 *   - end-to-end: build a realistic DomainSpec + narrative + manifests for the
 *     "cooking" example, run `runContractFiles`, and assert structural
 *     properties of each rendered file (sections, frontmatter, tool entries).
 *   - schema invariants: `Stage09Output` validates file ordering and
 *     UTF-8 byte-length agreement.
 *   - filtering: disabled tools are excluded from the rendered files.
 */

import { describe, expect, test } from "bun:test";

import {
  DomainSpecSchema,
  Stage09NarrativeSchema,
  Stage09OutputSchema,
  ToolManifestSchema,
  buildStage09Output,
  type DomainSpec,
  type Stage09Narrative,
  type ToolManifest,
} from "../../core/types.ts";
import { runContractFiles } from "./s09-contract.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const cookingSpec: DomainSpec = DomainSpecSchema.parse({
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
        examples: ["regional ingredient availability", "modern technique adoption (sous vide)"],
        maxAgeDays: 30,
      },
      fast: {
        examples: ["currently trending recipes", "latest cookbook releases"],
        maxAgeHours: 24,
      },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://www.seriouseats.com", kind: "docs" },
    { hint: "https://cooking.nytimes.com", kind: "docs" },
    { hint: "https://www.cooksillustrated.com", kind: "docs" },
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
});

const narrative: Stage09Narrative = Stage09NarrativeSchema.parse({
  schemaVersion: "0.1.0",
  domainOneLiner:
    "Sourced, freshness-aware retrieval and tools for cooking knowledge — from foundational techniques to modern adaptations.",
  scope: {
    covers: [
      "Techniques (sautéing, braising, fermentation, sous vide).",
      "Ingredients and substitutions across cuisines.",
      "Recipe lookup and procedural how-to.",
    ],
    outOfScope: [
      "Personalized meal planning or dietary medical advice.",
      "Live restaurant reservations or delivery status.",
    ],
  },
  toolSelectionGuidance:
    "Use `query_facts` for technique definitions, fundamental sauces, and other timeless knowledge. Use `ingredient_substitute` for substitution queries that require ranked alternatives. Reach for `web_search_recent` only when the user explicitly asks about a *current* trend or a recently published cookbook; default to the cached fact store first.",
});

const ingredientSubstituteManifest: ToolManifest = ToolManifestSchema.parse({
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
      ingredient: { type: "string" },
      context: { type: "string" },
    },
    required: ["ingredient"],
  },
  outputSchema: {
    type: "object",
    properties: { substitutes: { type: "array" } },
    required: ["substitutes"],
  },
  capabilities: { network: [], fs: "read", subprocess: [], secrets: [] },
  volatilityClass: "static",
  freshness: {
    cachePolicy: "manual-refresh",
    ttlSeconds: null,
    sourceTimestamp: false,
  },
  knowledgeUsage: { facts: true, ftsQuery: "substitute {q}", embeddings: false },
  examples: [
    {
      description: "buttermilk returns at least one substitute",
      input: { ingredient: "buttermilk", context: "baking" },
      expectedShape: "match-outputSchema",
    },
  ],
  designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
  implementedBy: {
    model: "claude-sonnet-4",
    promptVersion: "07-tool-impl/v1",
    tscPassed: true,
    smokePassed: true,
    attempts: 1,
  },
  disabled: false,
});

const queryFactsManifest: ToolManifest = ToolManifestSchema.parse({
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
  examples: [
    {
      description: "smoke",
      input: { q: "maillard" },
      expectedShape: "match-outputSchema",
    },
  ],
  designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
  disabled: false,
});

const disabledManifest: ToolManifest = ToolManifestSchema.parse({
  ...queryFactsManifest,
  name: "version_diff",
  disabled: true,
  disabledReason: "Stage 7 exhausted retries; tsc kept failing.",
});

// ──────────────────────────────────────────────────────────────────────────────
// runContractFiles — end-to-end
// ──────────────────────────────────────────────────────────────────────────────

describe("runContractFiles — cooking end-to-end", () => {
  const out = runContractFiles({
    domainSpec: cookingSpec,
    narrative,
    manifests: [queryFactsManifest, ingredientSubstituteManifest],
    compiledAt: new Date("2026-05-08T12:00:00.000Z"),
  });
  const byName = new Map(out.files.map((f) => [f.name, f.contents]));
  const domainMd = byName.get("DOMAIN.md")!;
  const agentsMd = byName.get("AGENTS.md")!;
  const skillsMd = byName.get("SKILLS.md")!;

  test("produces exactly DOMAIN.md, AGENTS.md, SKILLS.md in canonical order", () => {
    expect(out.files.map((f) => f.name)).toEqual([
      "DOMAIN.md",
      "AGENTS.md",
      "SKILLS.md",
    ]);
  });

  test("DOMAIN.md has frontmatter with required fields", () => {
    expect(domainMd.startsWith("---\n")).toBe(true);
    expect(domainMd).toContain('almanacId: "cooking"');
    expect(domainMd).toContain('freshnessProfile: "static-heavy"');
    expect(domainMd).toContain('defaultVolatilityClass: "static"');
    expect(domainMd).toContain("toolCount: 2");
    expect(domainMd).toContain('compiledAt: "2026-05-08T12:00:00.000Z"');
  });

  test("DOMAIN.md contains all canonical sections in order", () => {
    const required = [
      "# Cooking Almanac",
      "## Scope",
      "## Freshness Policy",
      "## Source Citation Rule",
      "## Tools",
      "## Cautions",
    ];
    let lastIdx = -1;
    for (const heading of required) {
      const idx = domainMd.indexOf(heading);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test("DOMAIN.md freshness table renders all four classes", () => {
    expect(domainMd).toContain("| static |");
    expect(domainMd).toContain("| slow |");
    expect(domainMd).toContain("| fast |");
    expect(domainMd).toContain("| live |");
    // The empty `live` class should render as n/a
    expect(domainMd).toContain("_n/a for this domain_");
  });

  test("DOMAIN.md tools table includes both enabled tools", () => {
    expect(domainMd).toContain("`query_facts`");
    expect(domainMd).toContain("`ingredient_substitute`");
  });

  test("AGENTS.md contains all canonical sections", () => {
    for (const heading of [
      "## Mission",
      "## Non-Negotiables",
      "## Tool Selection Guidance",
      "## Retrieval Discipline",
      "## Output Discipline",
      "## When to Refuse",
      "## Failure Modes to Surface",
    ]) {
      expect(agentsMd).toContain(heading);
    }
  });

  test("AGENTS.md inlines the LLM-authored tool selection guidance", () => {
    expect(agentsMd).toContain(narrative.toolSelectionGuidance);
  });

  test("SKILLS.md has one section per enabled tool with badge + capabilities + example", () => {
    expect(skillsMd).toContain("## `query_facts`");
    expect(skillsMd).toContain("## `ingredient_substitute`");
    expect(skillsMd).toContain("🟡 slow");      // query_facts badge
    expect(skillsMd).toContain("🟢 static");    // ingredient_substitute badge
    expect(skillsMd).toContain("**When to use:**");
    expect(skillsMd).toContain("**Capabilities:**");
    expect(skillsMd).toContain("**Freshness:**");
    expect(skillsMd).toContain("**Example:**");
  });

  test("UTF-8 byteLength agrees with the rendered contents", () => {
    const enc = new TextEncoder();
    for (const f of out.files) {
      expect(f.byteLength).toBe(enc.encode(f.contents).length);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Filtering: disabled tools excluded
// ──────────────────────────────────────────────────────────────────────────────

describe("runContractFiles — disabled tools are excluded", () => {
  const out = runContractFiles({
    domainSpec: cookingSpec,
    narrative,
    manifests: [queryFactsManifest, disabledManifest, ingredientSubstituteManifest],
    compiledAt: new Date("2026-05-08T12:00:00.000Z"),
  });
  const byName = new Map(out.files.map((f) => [f.name, f.contents]));

  test("toolCount in DOMAIN.md frontmatter excludes disabled", () => {
    expect(byName.get("DOMAIN.md")!).toContain("toolCount: 2");
  });

  test("SKILLS.md does not mention the disabled tool", () => {
    const md = byName.get("SKILLS.md")!;
    expect(md).not.toContain("version_diff");
    expect(md).toContain("`query_facts`");
    expect(md).toContain("`ingredient_substitute`");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe("runContractFiles — empty toolset", () => {
  test("renders SKILLS.md with an explicit 'no tools' note and toolCount=0", () => {
    const out = runContractFiles({
      domainSpec: cookingSpec,
      narrative,
      manifests: [],
      compiledAt: new Date("2026-05-08T12:00:00.000Z"),
    });
    const byName = new Map(out.files.map((f) => [f.name, f.contents]));
    expect(byName.get("DOMAIN.md")!).toContain("toolCount: 0");
    expect(byName.get("SKILLS.md")!).toContain("No enabled tools");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Stage09OutputSchema invariants
// ──────────────────────────────────────────────────────────────────────────────

describe("Stage09OutputSchema invariants", () => {
  test("rejects out-of-order file names", () => {
    expect(() =>
      Stage09OutputSchema.parse({
        schemaVersion: "0.1.0",
        almanacId: "cooking",
        generatedAt: "2026-05-08T12:00:00.000Z",
        files: [
          { name: "AGENTS.md", contents: "x", byteLength: 1 },
          { name: "DOMAIN.md", contents: "x", byteLength: 1 },
          { name: "SKILLS.md", contents: "x", byteLength: 1 },
        ],
      }),
    ).toThrow(/expected files\[0\]\.name/);
  });

  test("rejects mismatched byteLength", () => {
    expect(() =>
      Stage09OutputSchema.parse({
        schemaVersion: "0.1.0",
        almanacId: "cooking",
        generatedAt: "2026-05-08T12:00:00.000Z",
        files: [
          { name: "DOMAIN.md", contents: "hello", byteLength: 999 },
          { name: "AGENTS.md", contents: "x", byteLength: 1 },
          { name: "SKILLS.md", contents: "x", byteLength: 1 },
        ],
      }),
    ).toThrow(/byteLength.*UTF-8 size/);
  });

  test("buildStage09Output computes correct UTF-8 byte counts (multi-byte chars)", () => {
    const out = buildStage09Output({
      almanacId: "cooking",
      generatedAt: new Date("2026-05-08T12:00:00.000Z"),
      domainMd: "和食ドキュメント",   // multi-byte
      agentsMd: "agents",
      skillsMd: "skills",
    });
    expect(out.files[0]!.byteLength).toBe(
      new TextEncoder().encode("和食ドキュメント").length,
    );
    expect(out.files[1]!.byteLength).toBe(6);
    expect(out.files[2]!.byteLength).toBe(6);
  });
});
