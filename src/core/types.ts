/**
 * Canonical type definitions for `almanac-core`.
 *
 * This file is the single source of truth for types shared across:
 *   - the compile pipeline (Stages 1–12)
 *   - the runtime (`almanac serve`)
 *   - the management CLI (`almanac list`, `inspect`, …)
 *
 * Schemas are defined with zod so that LLM-produced artifacts (prompt outputs,
 * tool manifests, fact records) can be parsed and validated at runtime, and
 * static TypeScript types are derived via `z.infer<...>`.
 *
 * If a prompt-template's JSON schema diverges from a zod schema here, the zod
 * schema wins. Update the prompt to match.
 */

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────────
// Volatility model — used everywhere freshness matters
// ──────────────────────────────────────────────────────────────────────────────

export const VolatilityClassSchema = z.enum([
  "static",
  "slow",
  "fast",
  "live",
]);
export type VolatilityClass = z.infer<typeof VolatilityClassSchema>;

/** Coarse staleness bucket surfaced to the host LLM via `ToolResult.freshness`. */
export const StalenessSchema = z.enum(["fresh", "warm", "stale"]);
export type Staleness = z.infer<typeof StalenessSchema>;

export const FreshnessProfileIdSchema = z.enum([
  "static-heavy",
  "mixed",
  "live-heavy",
]);
export type FreshnessProfileId = z.infer<typeof FreshnessProfileIdSchema>;

/**
 * Per-class freshness configuration. `examples` lists 2–4 representative topics
 * in the domain that fall into this class. An empty array means the class does
 * not meaningfully apply to this domain (valid for `live: []` in static
 * domains, etc.).
 */
export const FreshnessClassesSchema = z.object({
  static: z.object({
    examples: z.array(z.string().min(1)),
  }),
  slow: z.object({
    examples: z.array(z.string().min(1)),
    maxAgeDays: z.number().int().positive().default(30),
  }),
  fast: z.object({
    examples: z.array(z.string().min(1)),
    maxAgeHours: z.number().int().positive().default(24),
  }),
  live: z.object({
    examples: z.array(z.string().min(1)),
  }),
});
export type FreshnessClasses = z.infer<typeof FreshnessClassesSchema>;

export const FreshnessProfileSchema = z
  .object({
    profileId: FreshnessProfileIdSchema,
    defaultClass: VolatilityClassSchema,
    classes: FreshnessClassesSchema,
  })
  .superRefine((profile, ctx) => {
    // profileId ↔ defaultClass consistency
    const allowedDefaults: Record<FreshnessProfileId, VolatilityClass[]> = {
      "static-heavy": ["static", "slow"],
      mixed: ["static", "slow", "fast", "live"],
      "live-heavy": ["fast", "live"],
    };
    if (!allowedDefaults[profile.profileId].includes(profile.defaultClass)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultClass"],
        message: `defaultClass "${profile.defaultClass}" is inconsistent with profileId "${profile.profileId}". Expected one of: ${allowedDefaults[profile.profileId].join(", ")}.`,
      });
    }

    // The class designated as default must be non-empty
    const defaultExamples = profile.classes[profile.defaultClass].examples;
    if (defaultExamples.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classes", profile.defaultClass, "examples"],
        message: `defaultClass "${profile.defaultClass}" must have at least one example topic.`,
      });
    }

    // At least 2 classes overall must be non-empty (otherwise the freshness
    // model is degenerate)
    const nonEmptyClassCount = (
      ["static", "slow", "fast", "live"] as const
    ).filter((c) => profile.classes[c].examples.length > 0).length;
    if (nonEmptyClassCount < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classes"],
        message: `at least two volatility classes must have non-empty examples (found ${nonEmptyClassCount}).`,
      });
    }
  });
export type FreshnessProfile = z.infer<typeof FreshnessProfileSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// DomainSpec — output of Stage 1 (domain analysis)
//
// This is the seed artifact for an almanac. Every later stage reads it.
// Prompt template: src/compile/prompts/01-domain-analysis/v1.md
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A user query "shape" the domain expects to handle.
 *
 * `debug` (added in v0.2.6) covers diagnostic / troubleshooting
 * queries — interpreting compiler errors, reading stack traces,
 * mapping symptom to root cause. It was added after the Rust
 * smoke (v0.2.5) consistently triggered a Stage 11
 * schema-validation retry as the LLM tried to emit values like
 * `diagnose-error` for compiler-error fixtures.
 */
export const IntentKindSchema = z.enum([
  "lookup",
  "howto",
  "compare",
  "calc",
  "explain",
  "track",
  "debug",
]);
export type IntentKind = z.infer<typeof IntentKindSchema>;

export const IntentSchema = z.object({
  kind: IntentKindSchema,
  example: z.string().min(1),
});
export type Intent = z.infer<typeof IntentSchema>;

/**
 * Categorization of a source as Stage 4 needs to know how to fetch it. The
 * first seven kinds are technical-domain staples; the last three
 * (`essay`, `book`, `talk`) are for abstract / opinion-heavy domains where
 * authoritative knowledge lives in long-form prose rather than documentation
 * sites or repositories.
 *
 * Fetch model for the abstract kinds:
 *  - `essay`: blog post / Substack / company-blog article (HTML snapshot)
 *  - `book`: book chapter excerpt or canonical book reference page
 *  - `talk`: conference / podcast transcript page (HTML snapshot)
 *
 * All three are handled by the same generic-HTTP fetcher as `docs` — the kind
 * is a *categorization* signal for Stage 5 (which adjusts extraction
 * defaults) and Stage 2b (which adjusts trust scoring), not a different
 * fetch path.
 */
export const SourceKindSchema = z.enum([
  "docs",
  "community",
  "academic",
  "data",
  "news",
  "repo",
  "file",
  "essay",
  "book",
  "talk",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SuggestedSourceSchema = z.object({
  /** Either a fully-qualified URL or a search query string. */
  hint: z.string().min(1),
  kind: SourceKindSchema,
});
export type SuggestedSource = z.infer<typeof SuggestedSourceSchema>;

/** Names reserved for default tools. Stage 1 must not propose these. */
export const DEFAULT_TOOL_NAMES = [
  "query_facts",
  "fetch_official_docs",
  "web_search_recent",
  "latest_releases",
] as const;
export type DefaultToolName = (typeof DEFAULT_TOOL_NAMES)[number];

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

export const SuggestedToolSchema = z.object({
  name: z
    .string()
    .regex(SNAKE_CASE, "tool name must be snake_case ([a-z][a-z0-9_]*)")
    .max(48)
    .refine(
      (n) => !(DEFAULT_TOOL_NAMES as readonly string[]).includes(n),
      (n) => ({
        message: `"${n}" collides with a default tool; suggest only domain-specific tool names`,
      })
    ),
  purpose: z.string().min(10).max(200),
  verbs: z.array(z.string().min(1)).min(1).max(6),
  expectedVolatility: VolatilityClassSchema,
});
export type SuggestedTool = z.infer<typeof SuggestedToolSchema>;

export const CautionAreaSchema = z.enum([
  "legal",
  "medical",
  "financial",
  "safety",
  "privacy",
]);
export type CautionArea = z.infer<typeof CautionAreaSchema>;

export const CautionSchema = z.object({
  area: CautionAreaSchema,
  rationale: z.string().min(10).max(300),
});
export type Caution = z.infer<typeof CautionSchema>;

/**
 * Lowercase kebab-case identifier, ≤32 chars, used for the on-disk almanac
 * directory name and as the MCP server / skill name suffix.
 */
const CANONICAL_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const DomainSpecSchema = z
  .object({
    domain: z.string().min(1),
    canonicalSlug: z
      .string()
      .max(32)
      .regex(
        CANONICAL_SLUG,
        "canonicalSlug must be lowercase kebab-case (a–z, 0–9, '-'), no leading/trailing '-'"
      ),
    displayName: z.string().min(1).max(80),
    summary: z.string().min(10).max(500),

    subareas: z.array(z.string().min(1)).min(2).max(12),
    intents: z.array(IntentSchema).min(2).max(10),
    verbs: z.array(z.string().min(1)).min(2).max(12),
    entityTypes: z.array(z.string().min(1)).min(2).max(12),

    freshnessProfile: FreshnessProfileSchema,

    suggestedSources: z.array(SuggestedSourceSchema).min(3).max(20),
    suggestedTools: z.array(SuggestedToolSchema).max(5),

    cautions: z.array(CautionSchema).max(5),
  })
  .superRefine((spec, ctx) => {
    // canonicalSlug must not collapse to empty
    if (spec.canonicalSlug.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalSlug"],
        message: "canonicalSlug must not be empty",
      });
    }

    // suggestedTools should have unique names
    const seen = new Set<string>();
    for (const t of spec.suggestedTools) {
      if (seen.has(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suggestedTools"],
          message: `duplicate suggestedTool name: "${t.name}"`,
        });
      }
      seen.add(t.name);
    }
  });
export type DomainSpec = z.infer<typeof DomainSpecSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// INSUFFICIENT_DOMAIN sentinel handling
//
// When the analysis prompt cannot produce a meaningful spec, it returns a
// JSON object whose `summary` begins with "INSUFFICIENT_DOMAIN: ". Detect this
// before attempting full validation so the compiler can halt with a clear
// reason instead of failing on schema constraints.
// ──────────────────────────────────────────────────────────────────────────────

export const INSUFFICIENT_DOMAIN_PREFIX = "INSUFFICIENT_DOMAIN:";

export class InsufficientDomainError extends Error {
  constructor(public readonly reason: string) {
    super(`Insufficient domain: ${reason}`);
    this.name = "InsufficientDomainError";
  }
}

/**
 * Parse a raw LLM JSON response into a validated `DomainSpec`.
 *
 * - Throws `InsufficientDomainError` if the LLM signaled an unanalyzable
 *   domain via the `INSUFFICIENT_DOMAIN:` sentinel in `summary`.
 * - Throws `z.ZodError` if the JSON does not satisfy `DomainSpecSchema`.
 */
export function parseDomainSpec(raw: unknown): DomainSpec {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "summary" in raw &&
    typeof (raw as { summary: unknown }).summary === "string" &&
    (raw as { summary: string }).summary
      .trimStart()
      .startsWith(INSUFFICIENT_DOMAIN_PREFIX)
  ) {
    const summary = (raw as { summary: string }).summary.trimStart();
    const reason = summary.slice(INSUFFICIENT_DOMAIN_PREFIX.length).trim();
    throw new InsufficientDomainError(reason || "no reason provided");
  }
  return DomainSpecSchema.parse(raw);
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage 2 — source discovery
//
// Stage 2 has two LLM sub-stages, separated by a deterministic fetch step:
//
//   2a planner  : DomainSpec               → SourceDiscoveryPlan (this file)
//   --- fetch ---: web search + GitHub + URL probes → Candidate[]
//   2b evaluator: DomainSpec + Plan + Cand → SourcesFile         (this file)
//
// Prompt templates:
//   src/compile/prompts/02-source-discovery/planner-v1.md
//   src/compile/prompts/02-source-discovery/evaluator-v1.md
// ──────────────────────────────────────────────────────────────────────────────

/** All source kinds the system understands (matches `SourceKindSchema`). */
export const SOURCE_KINDS = [
  "docs",
  "community",
  "academic",
  "data",
  "news",
  "repo",
  "file",
  "essay",
  "book",
  "talk",
] as const;

/**
 * Stage 2a / 2b coverage map: count of accepted (or budgeted) sources per kind.
 * Always carries every kind to make downstream arithmetic predictable.
 */
export const CoverageMapSchema = z.object({
  docs: z.number().int().nonnegative(),
  repo: z.number().int().nonnegative(),
  news: z.number().int().nonnegative(),
  community: z.number().int().nonnegative(),
  academic: z.number().int().nonnegative(),
  data: z.number().int().nonnegative(),
  file: z.number().int().nonnegative(),
  essay: z.number().int().nonnegative(),
  book: z.number().int().nonnegative(),
  talk: z.number().int().nonnegative(),
});
export type CoverageMap = z.infer<typeof CoverageMapSchema>;

const CoverageGoalSchema = z
  .object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .refine((g) => g.min <= g.max, {
    message: "coverageGoal.min must be ≤ coverageGoal.max",
  });

export const CoverageGoalsSchema = z.object({
  docs: CoverageGoalSchema,
  repo: CoverageGoalSchema,
  news: CoverageGoalSchema,
  community: CoverageGoalSchema,
  academic: CoverageGoalSchema,
  data: CoverageGoalSchema,
  file: CoverageGoalSchema,
  essay: CoverageGoalSchema,
  book: CoverageGoalSchema,
  talk: CoverageGoalSchema,
});
export type CoverageGoals = z.infer<typeof CoverageGoalsSchema>;

// ── Stage 2a: SourceDiscoveryPlan ────────────────────────────────────────────

/** Echoed `suggestedSource` from Stage 1 — the executor will probe `hint`. */
export const DirectProbeSchema = z.object({
  hint: z.string().min(1),
  kind: SourceKindSchema,
  rationale: z.string().min(1).max(300),
});
export type DirectProbe = z.infer<typeof DirectProbeSchema>;

/** Source kinds the planner may target with a web search; "any" is allowed. */
export const WebSearchTargetKindSchema = z.enum([
  ...SOURCE_KINDS,
  "any",
]);
export type WebSearchTargetKind = z.infer<typeof WebSearchTargetKindSchema>;

export const WebSearchQuerySchema = z.object({
  query: z.string().min(1).max(200),
  targetKind: WebSearchTargetKindSchema,
  rationale: z.string().min(1).max(300),
  recencyDays: z.number().int().positive().nullable(),
});
export type WebSearchQuery = z.infer<typeof WebSearchQuerySchema>;

export const GithubQuerySchema = z.object({
  query: z.string().min(1).max(200),
  /** v0.1 supports `repos`; `code` and `issues` are reserved for v0.2. */
  type: z.enum(["repos", "code", "issues"]),
  rationale: z.string().min(1).max(300),
});
export type GithubQuery = z.infer<typeof GithubQuerySchema>;

export const PlanBudgetsSchema = z.object({
  maxWebSearchQueries: z.number().int().nonnegative().max(20),
  maxGithubQueries: z.number().int().nonnegative().max(20),
  maxUrlProbes: z.number().int().nonnegative().max(60),
  maxCandidatesPerKind: z.number().int().positive().max(32),
  /** Hard ceiling for v0.1 — see roadmap. */
  targetAcceptedSources: z.number().int().positive().max(12),
});
export type PlanBudgets = z.infer<typeof PlanBudgetsSchema>;

export const SourceDiscoveryPlanSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    domain: z.object({
      canonicalSlug: z
        .string()
        .max(32)
        .regex(CANONICAL_SLUG, "canonicalSlug must be lowercase kebab-case"),
      displayName: z.string().min(1).max(80),
    }),
    budgets: PlanBudgetsSchema,
    directProbes: z.array(DirectProbeSchema).max(60),
    webSearchQueries: z.array(WebSearchQuerySchema).max(20),
    githubQueries: z.array(GithubQuerySchema).max(20),
    coverageGoals: CoverageGoalsSchema,
  })
  .superRefine((plan, ctx) => {
    // Budget enforcement
    if (plan.directProbes.length > plan.budgets.maxUrlProbes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["directProbes"],
        message: `directProbes (${plan.directProbes.length}) exceeds budget.maxUrlProbes (${plan.budgets.maxUrlProbes})`,
      });
    }
    if (plan.webSearchQueries.length > plan.budgets.maxWebSearchQueries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["webSearchQueries"],
        message: `webSearchQueries (${plan.webSearchQueries.length}) exceeds budget.maxWebSearchQueries (${plan.budgets.maxWebSearchQueries})`,
      });
    }
    if (plan.githubQueries.length > plan.budgets.maxGithubQueries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["githubQueries"],
        message: `githubQueries (${plan.githubQueries.length}) exceeds budget.maxGithubQueries (${plan.budgets.maxGithubQueries})`,
      });
    }
  });
export type SourceDiscoveryPlan = z.infer<typeof SourceDiscoveryPlanSchema>;

// ── Stage 2b: SourcesFile (draft → approved) ─────────────────────────────────

export const IngestionModeSchema = z.enum([
  "index-only",
  "snapshot",
  "feed",
]);
export type IngestionMode = z.infer<typeof IngestionModeSchema>;

export const IngestionSchema = z.object({
  mode: IngestionModeSchema,
  scope: z.array(z.string()),
  refreshIntervalHours: z.number().positive().max(24 * 365),
});
export type Ingestion = z.infer<typeof IngestionSchema>;

const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const ApprovedSourceSchema = z.object({
  id: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "source id must be lowercase kebab-case"),
  url: z.string().url(),
  kind: SourceKindSchema,
  trust: z.number().min(0).max(1),
  volatility: VolatilityClassSchema,
  rationale: z.string().min(1).max(300),
  ingestion: IngestionSchema,
  notes: z.string().nullable(),
});
export type ApprovedSource = z.infer<typeof ApprovedSourceSchema>;

export const RejectedSourceSchema = z.object({
  url: z.string(),
  reason: z.enum([
    "low-trust",
    "duplicate",
    "out-of-scope",
    "dead-link",
    "paywall-only",
    "ai-slop",
    "licensing-unclear",
    "over-budget",
  ]),
});
export type RejectedSource = z.infer<typeof RejectedSourceSchema>;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const SourcesFileSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    /**
     * `draft` after Stage 2; flipped to `approved` by Stage 3 (auto by default,
     * gated when `--require-approval` is set).
     */
    status: z.enum(["draft", "approved"]),
    generatedAt: z.string().regex(ISO_8601, "must be ISO-8601 timestamp"),
    /** Set by Stage 3 when status flips to `approved`. */
    approvedAt: z.string().regex(ISO_8601).optional(),
    approvedBy: z.enum(["auto", "human"]).optional(),
    generatedBy: z.object({
      stage: z.literal("02-source-discovery"),
      evaluatorPromptVersion: z.string().min(1),
      candidateCount: z.number().int().nonnegative(),
      acceptedCount: z.number().int().nonnegative(),
    }),
    coverage: CoverageMapSchema,
    warnings: z.array(z.string()),
    sources: z.array(ApprovedSourceSchema).max(12),
    rejected: z.array(RejectedSourceSchema).max(50),
  })
  .superRefine((file, ctx) => {
    // sources length must equal generatedBy.acceptedCount
    if (file.sources.length !== file.generatedBy.acceptedCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generatedBy", "acceptedCount"],
        message: `acceptedCount (${file.generatedBy.acceptedCount}) does not match sources.length (${file.sources.length})`,
      });
    }

    // coverage[kind] must equal actual count by kind
    const actual: CoverageMap = {
      docs: 0,
      repo: 0,
      news: 0,
      community: 0,
      academic: 0,
      data: 0,
      file: 0,
      essay: 0,
      book: 0,
      talk: 0,
    };
    for (const s of file.sources) actual[s.kind] += 1;
    for (const kind of SOURCE_KINDS) {
      if (file.coverage[kind] !== actual[kind]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coverage", kind],
          message: `coverage.${kind} (${file.coverage[kind]}) does not match actual count (${actual[kind]}) in sources[]`,
        });
      }
    }

    // unique source ids
    const seen = new Set<string>();
    for (const s of file.sources) {
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources"],
          message: `duplicate source id: "${s.id}"`,
        });
      }
      seen.add(s.id);
    }

    // approval fields consistency
    if (file.status === "approved") {
      if (!file.approvedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedAt"],
          message: "approvedAt is required when status is 'approved'",
        });
      }
      if (!file.approvedBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedBy"],
          message: "approvedBy is required when status is 'approved'",
        });
      }
    } else {
      if (file.approvedAt || file.approvedBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message:
            "approvedAt/approvedBy must not be set while status is 'draft'",
        });
      }
    }
  });
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

const SOURCES_FILE_MAX_ACCEPTED = 12;
const SOURCES_FILE_MAX_REJECTED = 50;

/**
 * Parse the evaluator's raw JSON output into a validated `SourcesFile`.
 * Stage 2b emits `status: "draft"`; the function asserts that.
 *
 * Counts that are mechanically derivable from `sources[]`
 * (`generatedBy.acceptedCount` and `coverage[kind]`) are normalized BEFORE
 * schema validation: a real-LLM smoke run produced an off-by-one count
 * (LLM emitted `acceptedCount: 12` for a `sources` array of length 11) and
 * the strict schema rejected the otherwise-valid output. We don't want a
 * stage to crash on the model's arithmetic — we recompute and trust the
 * sources list. The schema invariants still catch real consistency bugs in
 * our own code.
 */
export function parseDraftSourcesFile(raw: unknown): SourcesFile {
  const normalized = normalizeDerivableCounts(raw);
  const file = SourcesFileSchema.parse(normalized);
  if (file.status !== "draft") {
    throw new Error(
      `Stage 2b evaluator must emit status="draft", got "${file.status}"`,
    );
  }
  return file;
}

/**
 * Recompute `generatedBy.acceptedCount` and `coverage[kind]` from `sources[]`
 * before schema validation. Returns a shallow-copy with the two derived
 * fields overwritten; all other fields are passed through unchanged. Non-
 * object inputs are returned as-is (the schema parse will then reject them
 * with the appropriate error).
 *
 * Exported for unit tests; not part of the canonical API surface.
 */
export function normalizeDerivableCounts(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const r = raw as Record<string, unknown>;
  const rawSources = Array.isArray(r.sources) ? r.sources : [];
  const sources = rawSources.slice(0, SOURCES_FILE_MAX_ACCEPTED);

  const coverage: CoverageMap = {
    docs: 0,
    repo: 0,
    news: 0,
    community: 0,
    academic: 0,
    data: 0,
    file: 0,
    essay: 0,
    book: 0,
    talk: 0,
  };
  for (const s of sources) {
    if (typeof s !== "object" || s === null) continue;
    const kind = (s as Record<string, unknown>).kind;
    if (
      typeof kind === "string" &&
      (SOURCE_KINDS as readonly string[]).includes(kind)
    ) {
      coverage[kind as SourceKind] += 1;
    }
  }

  const generatedBy =
    typeof r.generatedBy === "object" && r.generatedBy !== null
      ? { ...(r.generatedBy as Record<string, unknown>) }
      : ({} as Record<string, unknown>);
  generatedBy.acceptedCount = sources.length;

  const warnings = Array.isArray(r.warnings) ? [...r.warnings] : [];
  const rejected = Array.isArray(r.rejected) ? [...r.rejected] : [];
  if (rawSources.length > SOURCES_FILE_MAX_ACCEPTED) {
    warnings.push(
      `sources_truncated: evaluator emitted ${rawSources.length} accepted sources; kept ${SOURCES_FILE_MAX_ACCEPTED} and marked the rest over-budget`,
    );
    for (const source of rawSources.slice(SOURCES_FILE_MAX_ACCEPTED)) {
      const url =
        typeof source === "object" &&
        source !== null &&
        typeof (source as Record<string, unknown>).url === "string"
          ? ((source as Record<string, unknown>).url as string)
          : "(unknown)";
      rejected.push({ url, reason: "over-budget" as const });
    }
  }
  const cappedRejected = rejected.slice(0, SOURCES_FILE_MAX_REJECTED);
  if (rejected.length > SOURCES_FILE_MAX_REJECTED) {
    warnings.push(
      `rejected_truncated: ${rejected.length} rejected sources produced, ${SOURCES_FILE_MAX_REJECTED} shown`,
    );
  }

  return {
    ...r,
    generatedBy,
    coverage,
    warnings,
    sources,
    rejected: cappedRejected,
  };
}

// ── Candidate (input to Stage 2b) ────────────────────────────────────────────
//
// The deterministic discovery executor (between 2a and 2b) emits a list of
// `Candidate`s by fanning out the planner's `directProbes`, `webSearchQueries`,
// and `githubQueries`. Each candidate captures:
//   - the canonical URL (after redirects)
//   - a best-guess `kind` derived from the origin
//   - the search engine snippet OR a short content preview
//   - fetch status (so the evaluator can short-circuit `dead-link` rejections)
//   - provenance (which planner item produced it, with rank)
//   - meta hints used by the evaluator (RSS feed presence, GitHub license, etc.)
//
// Candidates are NOT a SoT artifact: they live only in `.compile/` while
// Stage 2 is running. Stage 5 will fetch full content separately.

/** Outcome of attempting to fetch the candidate URL during discovery. */
export const FetchStatusSchema = z.enum([
  "ok",
  "redirect",      // followed; `finalUrl` set
  "client-error",  // HTTP 4xx
  "server-error",  // HTTP 5xx
  "network-error", // DNS / TLS / connection refused
  "timeout",
  "blocked",       // rate limit or robots.txt disallow
]);
export type FetchStatus = z.infer<typeof FetchStatusSchema>;

/** Discriminated union: where this candidate came from in the plan. */
export const CandidateOriginSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("direct-probe"),
    /** Index into `SourceDiscoveryPlan.directProbes`. */
    probeIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("web-search"),
    /** Index into `SourceDiscoveryPlan.webSearchQueries`. */
    queryIndex: z.number().int().nonnegative(),
    /** 0-based result rank within that query. */
    rank: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("github"),
    /** Index into `SourceDiscoveryPlan.githubQueries`. */
    queryIndex: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("community-search"),
    /** Stable adapter name, e.g. `hackernews` or `reddit`. */
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(32),
    /** Which planner input produced this search. */
    inputType: z.enum(["direct-probe", "web-search"]),
    /** Index into the corresponding planner array. */
    inputIndex: z.number().int().nonnegative(),
    /** 0-based result rank returned by the provider. */
    rank: z.number().int().nonnegative(),
  }),
]);
export type CandidateOrigin = z.infer<typeof CandidateOriginSchema>;

/** Optional metadata used by the evaluator for trust / volatility / mode. */
export const CandidateMetaSchema = z.object({
  contentType: z.string().max(120).optional(),
  contentLengthBytes: z.number().int().nonnegative().optional(),
  httpStatusCode: z.number().int().min(100).max(599).optional(),
  /** Discovered RSS/Atom feed URL on the page (informs `ingestion.mode=feed`). */
  rssUrl: z.string().url().optional(),
  /** GitHub-only fields, populated when origin is github or URL is a github repo. */
  githubStars: z.number().int().nonnegative().optional(),
  /** SPDX id when detectable; informs `licensing-unclear` rejection. */
  githubLicense: z.string().max(64).optional(),
  githubLastCommitAt: z.string().regex(ISO_8601).optional(),
  /** ISO 639-1 (e.g., "en", "ja") if detected. */
  languageDetected: z.string().min(2).max(8).optional(),
  /** Public community provider that supplied this candidate, if any. */
  discoveryProvider: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32).optional(),
  /** Source-level author / handle when returned by a community provider. */
  author: z.string().max(120).optional(),
  /** Source container, e.g. `r/kubernetes` or `news.ycombinator.com`. */
  container: z.string().max(160).optional(),
  /** Original publication timestamp returned by a community provider. */
  publishedAt: z.string().regex(ISO_8601).optional(),
  /**
   * Provider-native engagement metrics. Used as salience hints by Stage 2b;
   * not a substitute for trust.
   */
  engagement: z.record(z.number()).optional(),
});
export type CandidateMeta = z.infer<typeof CandidateMetaSchema>;

export const CandidateSchema = z
  .object({
    /** URL as initially probed/queried (before any redirect). */
    url: z.string().url(),
    /** Best-guess kind based on origin (planner's intent). */
    kind: SourceKindSchema,
    /** Page <title> or search result title; null if not extractable. */
    title: z.string().min(1).max(300).nullable(),
    /** Search-engine snippet or page meta description. */
    snippet: z.string().max(500).nullable(),
    /**
     * Optional first ~2000 chars of fetched HTML body. Used by the evaluator
     * to detect ai-slop, paywall walls, etc. Omitted for `kind: repo`,
     * `kind: data`, and when fetchStatus !== "ok"/"redirect".
     */
    preview: z.string().max(2000).nullable(),
    fetchedAt: z.string().regex(ISO_8601),
    fetchStatus: FetchStatusSchema,
    /** Set when fetchStatus is "redirect"; the URL after redirect chain. */
    finalUrl: z.string().url().optional(),
    origin: CandidateOriginSchema,
    meta: CandidateMetaSchema.default({}),
  })
  .superRefine((c, ctx) => {
    // finalUrl ↔ fetchStatus="redirect" consistency
    if (c.fetchStatus === "redirect" && !c.finalUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalUrl"],
        message: 'finalUrl is required when fetchStatus === "redirect"',
      });
    }
    if (c.fetchStatus !== "redirect" && c.finalUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalUrl"],
        message: `finalUrl must be omitted when fetchStatus === "${c.fetchStatus}"`,
      });
    }

    // preview should be null for non-ok/non-redirect statuses
    if (
      c.preview !== null &&
      c.fetchStatus !== "ok" &&
      c.fetchStatus !== "redirect"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preview"],
        message: `preview must be null when fetchStatus is "${c.fetchStatus}"`,
      });
    }

    // GitHub-specific meta should accompany github origin (advisory: not a hard
    // requirement because rate-limited probes may return without metadata)
    if (
      c.origin.type === "github" &&
      c.meta.githubStars === undefined &&
      c.fetchStatus === "ok"
    ) {
      // Soft hint via path; emit as info-level via custom issue with note
      // (treated as warning by callers if they choose; zod still validates)
    }
  });
export type Candidate = z.infer<typeof CandidateSchema>;

/** A bundle of candidates passed from the executor to the evaluator. */
export const CandidatesSchema = z.array(CandidateSchema).max(200);
export type Candidates = z.infer<typeof CandidatesSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Stage 8 — knowledge index (bun:sqlite + FTS5)
//
// Stage 8 reads `extracted/facts.jsonl` and builds
// `knowledge/almanac.sqlite` containing:
//   - a `facts` table with one row per `FactRecord`
//   - a `facts_fts` virtual table (FTS5) over `text` + `entities`
//
// Output manifest (`KnowledgeIndexManifest`) lives next to the database as
// `knowledge/index-manifest.json` and feeds into the runtime so it can
// surface counts via `almanac inspect`.
//
// Implementation: `src/compile/stages/s08-knowledge-index.ts`.
// ──────────────────────────────────────────────────────────────────────────────

export const KnowledgeFactCountsSchema = z.object({
  byClass: z.object({
    static: z.number().int().nonnegative(),
    slow: z.number().int().nonnegative(),
  }),
  byType: z.object({
    fact: z.number().int().nonnegative(),
    definition: z.number().int().nonnegative(),
    procedure: z.number().int().nonnegative(),
    opinion: z.number().int().nonnegative(),
    reference: z.number().int().nonnegative(),
    principle: z.number().int().nonnegative(),
    heuristic: z.number().int().nonnegative(),
    tradeoff: z.number().int().nonnegative(),
    framework: z.number().int().nonnegative(),
  }),
});
export type KnowledgeFactCounts = z.infer<typeof KnowledgeFactCountsSchema>;

export const KnowledgeVectorIndexManifestSchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal("0.1.0"),
    status: z.literal("built"),
    provider: z.enum(["voyage", "openai", "local", "deterministic"]),
    model: z.string().min(1).max(160),
    dimensions: z.number().int().positive().max(8192),
    factCount: z.number().int().nonnegative(),
    vectorCount: z.number().int().nonnegative(),
    sourceFactCorpusHash: z.string().regex(SHA256_HEX, "must be sha256 hex"),
    vectorsRelPath: z.literal("knowledge/vectors.jsonl"),
    manifestRelPath: z.literal("knowledge/vector-index.json"),
    vectorsHash: z.string().regex(SHA256_HEX, "must be sha256 hex"),
    builtAt: z.string().regex(ISO_8601),
  }),
  z.object({
    schemaVersion: z.literal("0.1.0"),
    status: z.literal("skipped"),
    reason: z.enum([
      "not-configured",
      "explicitly-disabled",
      "missing-credentials",
      "invalid-config",
      "provider-unimplemented",
    ]),
    provider: z.enum(["voyage", "openai", "local", "deterministic"]).nullable(),
    model: z.string().min(1).max(160).nullable(),
    dimensions: z.number().int().positive().max(8192).nullable(),
    factCount: z.number().int().nonnegative(),
    vectorCount: z.literal(0),
    sourceFactCorpusHash: z.string().regex(SHA256_HEX, "must be sha256 hex"),
    vectorsRelPath: z.null(),
    manifestRelPath: z.null(),
    builtAt: z.string().regex(ISO_8601),
  }),
]);
export type KnowledgeVectorIndexManifest = z.infer<
  typeof KnowledgeVectorIndexManifestSchema
>;

export const KnowledgeIndexManifestSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    /** Always `knowledge/almanac.sqlite` for v0.1; reserved for future paths. */
    dbRelPath: z.literal("knowledge/almanac.sqlite"),
    factCount: z.number().int().nonnegative(),
    counts: KnowledgeFactCountsSchema,
    builtAt: z.string().regex(ISO_8601),
    /** SQLite engine version used to build the index (e.g., "3.45.1"). */
    sqliteVersion: z.string().min(3).max(40),
    /** sha256 of the canonicalized fact corpus that produced this index. */
    factCorpusHash: z.string().regex(SHA256_HEX, "must be sha256 hex"),
    /** Optional vector artifact metadata. Omitted by pre-v0.4 manifests. */
    vectorIndex: KnowledgeVectorIndexManifestSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const sumClass = m.counts.byClass.static + m.counts.byClass.slow;
    if (sumClass !== m.factCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counts", "byClass"],
        message: `byClass total (${sumClass}) !== factCount (${m.factCount})`,
      });
    }
    const sumType =
      m.counts.byType.fact +
      m.counts.byType.definition +
      m.counts.byType.procedure +
      m.counts.byType.opinion +
      m.counts.byType.reference +
      m.counts.byType.principle +
      m.counts.byType.heuristic +
      m.counts.byType.tradeoff +
      m.counts.byType.framework;
    if (sumType !== m.factCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counts", "byType"],
        message: `byType total (${sumType}) !== factCount (${m.factCount})`,
      });
    }
  });
export type KnowledgeIndexManifest = z.infer<
  typeof KnowledgeIndexManifestSchema
>;

// ──────────────────────────────────────────────────────────────────────────────
// Stage 0 — bootstrap
//
// Stage 0 lays the empty almanac directory and seeds two artifacts:
//
//   - <almanacDir>/manifest.json          (`AlmanacManifest`)
//   - <almanacDir>/.compile/compile-state.json  (`CompileState`)
//
// Counts (`toolCount`, `factCount`) start at 0 and are updated by later
// stages; the same `manifest.json` is rewritten on every `almanac update`.
//
// Orchestrator: `src/compile/stages/s00-bootstrap.ts`.
// ──────────────────────────────────────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The runtime-facing manifest at the root of every compiled almanac. The MCP
 * server (`almanac serve`) and `almanac inspect` both read this for identity
 * and counts; the full freshness model lives in `DOMAIN.md`.
 */
export const AlmanacManifestSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    /** Semver of the *almanac contents* (bumped on `almanac update`). */
    version: z.string().regex(SEMVER_RE, "must be semver"),
    domain: z.string().min(1),
    displayName: z.string().min(1).max(80),
    freshnessProfileId: FreshnessProfileIdSchema,
    /** Count of enabled tools at the time of last write. */
    toolCount: z.number().int().nonnegative(),
    /** Count of facts in `extracted/facts.jsonl` at the time of last write. */
    factCount: z.number().int().nonnegative(),
    /** Wall-clock when the almanac was first compiled. Stable across updates. */
    bootstrappedAt: z.string().regex(ISO_8601),
    /** Wall-clock of the most recent successful pipeline run. */
    compiledAt: z.string().regex(ISO_8601),
    /** Version of the `almanac` CLI that produced the current state. */
    forgerVersion: z.string().min(1).max(40),
  })
  .superRefine((m, ctx) => {
    if (Date.parse(m.compiledAt) < Date.parse(m.bootstrappedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compiledAt"],
        message: "compiledAt must be >= bootstrappedAt",
      });
    }
  });
export type AlmanacManifest = z.infer<typeof AlmanacManifestSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Stage 4 — source fetch (deterministic)
//
// The Stage 4 orchestrator reads `sources/sources.yaml` (approved) and fans
// out to a set of `Fetcher` implementations (one per ingestion mode / kind).
// Each fetcher returns a `SourceFetchEntry`; the orchestrator concatenates
// them into `sources/manifest.jsonl`. Raw bytes are written to
// `sources/raw/<sha256>.<ext>`.
//
// No LLM is involved. Failures are captured in `status: "failed"` entries so
// downstream stages can decide whether to halt or continue.
//
// Interfaces (Fetcher / FetchContext) live in `src/compile/fetchers/types.ts`.
// Orchestrator entry point: `src/compile/stages/s04-source-fetch.ts`.
// ──────────────────────────────────────────────────────────────────────────────

const MEDIA_TYPE_RE = /^[a-z]+\/[a-z0-9.+-]+$/;
/** Lowercase MIME type (`type/subtype`). Open-ended; the schema only validates shape. */
export const MediaTypeSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(MEDIA_TYPE_RE, "must be a lowercase MIME type");
export type MediaType = z.infer<typeof MediaTypeSchema>;

/** Path of a written raw artifact, relative to the almanac directory. */
const RAW_REL_PATH_RE = /^sources\/raw\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/;
export const RawRelPathSchema = z
  .string()
  .regex(
    RAW_REL_PATH_RE,
    "must be 'sources/raw/<sha256-hex>[.<ext>]' relative to the almanac directory",
  );

/** A single fetched document written to disk. */
export const FetchedDocumentSchema = z.object({
  /** sha256 hex of the raw bytes; same hash used as filename. */
  contentHash: z.string().regex(SHA256_HEX, "must be sha256 hex"),
  /** Path under the almanac directory where the bytes were written. */
  relPath: RawRelPathSchema,
  /** Final URL after redirects (or the original URL when none). */
  url: z.string().url(),
  mediaType: MediaTypeSchema,
  byteLength: z.number().int().nonnegative(),
  fetchedAt: z.string().regex(ISO_8601),
  /** Upstream-provided per-record timestamp (HTTP Last-Modified, feed pubDate, etc.). */
  sourceTimestamp: z.string().regex(ISO_8601).optional(),
  /** Page <title>, document title, or feed-entry title. Truncated to 300. */
  title: z.string().min(1).max(300).optional(),
});
export type FetchedDocument = z.infer<typeof FetchedDocumentSchema>;

/**
 * Outcome category for a single source's fetch attempt.
 *
 * - `fetched`    — ≥1 document written under `sources/raw/`.
 * - `index-only` — source is tracked by metadata only (e.g., a github repo
 *                  whose commit SHA we record but whose blobs we don't ingest).
 *                  No documents are written.
 * - `failed`     — fetch could not be completed; `error` carries the reason.
 */
export const SourceFetchStatusSchema = z.enum([
  "fetched",
  "index-only",
  "failed",
]);
export type SourceFetchStatus = z.infer<typeof SourceFetchStatusSchema>;

/** Categorical fetch error. New codes can be added as fetchers grow. */
export const SourceFetchErrorCodeSchema = z.enum([
  "network-error",
  "http-error",
  "timeout",
  "unsupported-media-type",
  "parse-error",
  "robots-disallowed",
  "rate-limited",
  "too-large",
  "unknown-mode",
  "unknown",
]);
export type SourceFetchErrorCode = z.infer<typeof SourceFetchErrorCodeSchema>;

export const SourceFetchErrorSchema = z.object({
  code: SourceFetchErrorCodeSchema,
  message: z.string().min(1).max(2000),
  /** HTTP status when applicable (4xx/5xx); omitted otherwise. */
  httpStatusCode: z.number().int().min(100).max(599).optional(),
  /** Whether re-running the fetcher might succeed (advisory). */
  retryable: z.boolean(),
  /** Number of attempts already made by the fetcher. */
  attempts: z.number().int().positive(),
});
export type SourceFetchError = z.infer<typeof SourceFetchErrorSchema>;

/** Light metadata for `index-only` entries (e.g., the head commit of a repo). */
export const SourceIndexMetaSchema = z.object({
  /** Git commit SHA when the source is a repo. */
  commitSha: z.string().regex(/^[a-f0-9]{40}$/, "must be a git sha-1 hex").optional(),
  /** Latest known upstream change timestamp (HEAD commit, feed pubDate, etc.). */
  lastUpdatedAt: z.string().regex(ISO_8601).optional(),
  /** Human-readable note (e.g., "1.31.0 release"). */
  label: z.string().min(1).max(200).optional(),
});
export type SourceIndexMeta = z.infer<typeof SourceIndexMetaSchema>;

const FetchedEntryShape = z.object({
  sourceId: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "must match SourcesFile source id format"),
  status: z.literal("fetched"),
  /** Wall-clock time the fetch finished. */
  fetchedAt: z.string().regex(ISO_8601),
  /** Final URL after redirects. */
  finalUrl: z.string().url(),
  /** Name of the fetcher that produced this entry. */
  fetcher: z.string().min(1).max(64),
  documents: z.array(FetchedDocumentSchema).min(1).max(200),
});

const IndexOnlyEntryShape = z.object({
  sourceId: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "must match SourcesFile source id format"),
  status: z.literal("index-only"),
  fetchedAt: z.string().regex(ISO_8601),
  finalUrl: z.string().url(),
  fetcher: z.string().min(1).max(64),
  indexMeta: SourceIndexMetaSchema,
});

const FailedEntryShape = z.object({
  sourceId: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "must match SourcesFile source id format"),
  status: z.literal("failed"),
  /** Wall-clock time the failure was recorded. */
  attemptedAt: z.string().regex(ISO_8601),
  /** Name of the fetcher that attempted; empty when no fetcher matched. */
  fetcher: z.string().max(64),
  error: SourceFetchErrorSchema,
});

/** Discriminated union: one entry per source in `sources/manifest.jsonl`. */
export const SourceFetchEntrySchema = z.discriminatedUnion("status", [
  FetchedEntryShape,
  IndexOnlyEntryShape,
  FailedEntryShape,
]);
export type SourceFetchEntry = z.infer<typeof SourceFetchEntrySchema>;

/** Type guards per branch of the discriminated union. */
export const isFetchedEntry = (
  e: SourceFetchEntry,
): e is z.infer<typeof FetchedEntryShape> => e.status === "fetched";
export const isIndexOnlyEntry = (
  e: SourceFetchEntry,
): e is z.infer<typeof IndexOnlyEntryShape> => e.status === "index-only";
export const isFailedEntry = (
  e: SourceFetchEntry,
): e is z.infer<typeof FailedEntryShape> => e.status === "failed";

/** Aggregate counters for the run. */
export const SourceFetchSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  indexOnly: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  totalDocuments: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type SourceFetchSummary = z.infer<typeof SourceFetchSummarySchema>;

/**
 * The whole Stage 4 output. Persisted as `sources/manifest.jsonl` (one entry
 * per line) plus a sibling `sources/manifest.summary.json` with the summary
 * counters and run identity.
 */
export const SourceFetchManifestSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    /** Wall-clock time the orchestrator started. */
    startedAt: z.string().regex(ISO_8601),
    /** Wall-clock time the orchestrator finished. */
    finishedAt: z.string().regex(ISO_8601),
    summary: SourceFetchSummarySchema,
    entries: z.array(SourceFetchEntrySchema).max(12),
  })
  .superRefine((m, ctx) => {
    // finishedAt monotonicity
    if (Date.parse(m.finishedAt) < Date.parse(m.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt must be >= startedAt",
      });
    }

    // summary counts must equal actual entries
    let fetched = 0;
    let indexOnly = 0;
    let failed = 0;
    let docs = 0;
    let bytes = 0;
    const seenIds = new Set<string>();

    for (let i = 0; i < m.entries.length; i++) {
      const e = m.entries[i]!;
      if (seenIds.has(e.sourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", i, "sourceId"],
          message: `duplicate sourceId in manifest: "${e.sourceId}"`,
        });
      }
      seenIds.add(e.sourceId);

      if (e.status === "fetched") {
        fetched += 1;
        docs += e.documents.length;
        for (const d of e.documents) bytes += d.byteLength;
      } else if (e.status === "index-only") {
        indexOnly += 1;
      } else {
        failed += 1;
      }
    }

    if (m.summary.total !== m.entries.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "total"],
        message: `summary.total (${m.summary.total}) !== entries.length (${m.entries.length})`,
      });
    }
    const checks: Array<[keyof SourceFetchSummary, number]> = [
      ["fetched", fetched],
      ["indexOnly", indexOnly],
      ["failed", failed],
      ["totalDocuments", docs],
      ["totalBytes", bytes],
    ];
    for (const [field, actual] of checks) {
      if (m.summary[field] !== actual) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["summary", field],
          message: `summary.${field} (${m.summary[field]}) !== actual (${actual})`,
        });
      }
    }
  });
export type SourceFetchManifest = z.infer<typeof SourceFetchManifestSchema>;

/**
 * Aggregate fetch entries into a `SourceFetchManifest`, computing summary
 * counters from the entries themselves. Pure: returns a new object.
 */
export function buildSourceFetchManifest(input: {
  almanacId: string;
  startedAt: Date;
  finishedAt: Date;
  entries: SourceFetchEntry[];
}): SourceFetchManifest {
  let fetched = 0;
  let indexOnly = 0;
  let failed = 0;
  let docs = 0;
  let bytes = 0;
  for (const e of input.entries) {
    if (e.status === "fetched") {
      fetched += 1;
      docs += e.documents.length;
      for (const d of e.documents) bytes += d.byteLength;
    } else if (e.status === "index-only") {
      indexOnly += 1;
    } else {
      failed += 1;
    }
  }
  return SourceFetchManifestSchema.parse({
    schemaVersion: "0.1.0" as const,
    almanacId: input.almanacId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    summary: {
      total: input.entries.length,
      fetched,
      indexOnly,
      failed,
      totalDocuments: docs,
      totalBytes: bytes,
    },
    entries: input.entries,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage 5 — fact extraction
//
// The fact extractor produces one `ExtractionResult` per source, containing
// `ExtractedFactDraft[]`. The LLM does NOT generate ULIDs, timestamps, or
// source-binding fields. Those are injected by the pipeline via
// `materializeFact()` to produce the canonical `FactRecord` written to
// `extracted/facts.jsonl`.
//
// Hard rule: only `static` and `slow` facts are extracted. `fast` and `live`
// content is never cached; it is reached at runtime through live tools.
//
// Prompt template: src/compile/prompts/05-fact-extraction/v1.md
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Taxonomy of fact types. The first five ("fact", "definition", "procedure",
 * "opinion", "reference") are universal and apply to any domain. The last
 * four ("principle", "heuristic", "tradeoff", "framework") are added for
 * abstract / opinion-heavy domains (leadership, design thinking, strategy,
 * etc.) where the dominant knowledge format is conceptual rather than
 * empirical. `opinion` is allowed only with explicit attribution.
 */
export const FactTypeSchema = z.enum([
  "fact",         // empirical, verifiable claim
  "definition",   // terminology
  "procedure",    // stable how-to
  "opinion",      // attributed to a named authority
  "reference",    // pointer to canonical material (RFCs, papers, etc.)
  "principle",    // durable normative rule (e.g., "favor composition over inheritance")
  "heuristic",    // rule of thumb that usually holds (not always)
  "tradeoff",     // explicit "X vs Y" comparison along an axis
  "framework",    // named multi-step model or schema (e.g., "OKR", "RACI")
]);
export type FactType = z.infer<typeof FactTypeSchema>;

/**
 * Volatility classes that are durable enough to cache as facts.
 * `fast` and `live` are intentionally excluded — they belong to live tools.
 */
export const CacheableVolatilitySchema = z.enum(["static", "slow"]);
export type CacheableVolatility = z.infer<typeof CacheableVolatilitySchema>;

export const FactSourceSchema = z.object({
  /** `sources.yaml` id; `ApprovedSource.id`. */
  sourceId: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "must match SourcesFile source id format"),
  /** sha256 of the raw content (hex). Same hash that names `sources/raw/*`. */
  contentHash: z.string().regex(SHA256_HEX, "must be sha256 hex"),
  /** Citation URL — what the host LLM links to in answers. */
  url: z.string().url(),
  /** Verbatim excerpt from the source supporting `text`. */
  excerpt: z.string().min(1).max(300),
});
export type FactSource = z.infer<typeof FactSourceSchema>;

/**
 * What the LLM emits per fact (no identity, no timestamps, no source binding).
 * The pipeline materializes this into `FactRecord`.
 */
export const ExtractedFactDraftSchema = z
  .object({
    text: z.string().min(10).max(500),
    type: FactTypeSchema,
    entities: z.array(z.string().min(1)).max(10),
    /** Verbatim from source content. The pipeline does not check verbatim-ness. */
    excerpt: z.string().min(1).max(300),
    freshnessClass: CacheableVolatilitySchema,
    /**
     * Caller-controlled relative TTL.
     * - Must be `null` when `freshnessClass === "static"`.
     * - Must be `{days: N>0}` when `freshnessClass === "slow"`.
     */
    validUntilRelative: z
      .object({ days: z.number().int().positive().max(366 * 5) })
      .nullable(),
    confidence: z.number().min(0.5).max(1),
    volatilityNotes: z.string().max(200).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.freshnessClass === "static" && d.validUntilRelative !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntilRelative"],
        message: "validUntilRelative must be null when freshnessClass is 'static'",
      });
    }
    if (d.freshnessClass === "slow" && d.validUntilRelative === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntilRelative"],
        message:
          "validUntilRelative must be {days:N} when freshnessClass is 'slow'",
      });
    }
  });
export type ExtractedFactDraft = z.infer<typeof ExtractedFactDraftSchema>;

/** Reason the extractor declined to produce facts for a source. */
export const ExtractionStatusSchema = z.enum([
  "extracted", // ≥1 fact emitted
  "skipped",   // content was entirely fast/live or out-of-scope
  "no-content", // source body was empty or unparseable
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

/** Raw extractor output for one source. */
export const ExtractionResultSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    status: ExtractionStatusSchema,
    skipReason: z.string().max(120).nullable(),
    /** Traceability: what the LLM judged was/wasn't extractable. */
    coverage: z.object({
      extractable: z.string().max(300),
      nonExtractable: z.string().max(300),
    }),
    facts: z.array(ExtractedFactDraftSchema).max(50),
  })
  .superRefine((r, ctx) => {
    if (r.status === "extracted" && r.facts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: "facts must be non-empty when status is 'extracted'",
      });
    }
    if (r.status !== "extracted" && r.facts.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: `facts must be empty when status is '${r.status}'`,
      });
    }
    if (r.status !== "extracted" && r.skipReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipReason"],
        message: `skipReason is required when status is '${r.status}'`,
      });
    }
  });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * Lenient remap from common LLM-emitted fact-type values to canonical
 * `FactTypeSchema` values. The Stage 5 prompt instructs the model to use the
 * canonical 9 types, but real-LLM runs against opinion-heavy domains
 * (e.g., Enterprise AI) consistently produced `"pattern"` / `"antipattern"`
 * / `"practice"` plus governance/security labels such as `"control"` or
 * `"risk"` — terms that come straight from the DomainSpec's `entityTypes`
 * list. These are clean concept overlaps, so we coerce them at the parse
 * boundary rather than reject otherwise-valid facts.
 *
 * Exported for unit tests; the runtime path goes through
 * `normalizeExtractionResult` below.
 */
export const FACT_TYPE_LENIENT_REMAP: Readonly<Record<string, FactType>> = {
  pattern: "framework",
  antipattern: "tradeoff",
  practice: "procedure",
  "deployment-pattern": "framework",
  control: "principle",
  policy: "principle",
  risk: "fact",
  vulnerability: "fact",
  // Entity-shaped types that occasionally leak in from DomainSpec.entityTypes;
  // map all to "reference" (a pointer to canonical material).
  role: "reference",
  vendor: "reference",
  platform: "reference",
};

/**
 * Best-effort normalization of raw extractor output BEFORE schema validation.
 * Mistakes that show up repeatedly in real-LLM runs:
 *
 *   - `facts[i].type` set to a domain-entity term (`pattern`, `practice`,
 *     etc.) rather than the canonical 9 fact-type enum.
 *   - `facts[i].excerpt` longer than the 300-char cap — the model includes
 *     full paragraphs instead of single-sentence snippets.
 *   - `coverage.extractable` / `coverage.nonExtractable` longer than the
 *     300-char cap. Same root cause as the excerpt overflow: the model
 *     writes a paragraph where the schema wants a single sentence. First
 *     observed on `blog-rust-lang-org` during the v0.2.5 Rust smoke,
 *     which dropped one otherwise-fine chunk on `nonExtractable`.
 *
 * All three are recoverable: remap the type via `FACT_TYPE_LENIENT_REMAP`,
 * truncate the excerpt, truncate the coverage strings. Other malformed
 * shapes (missing required fields, bad freshnessClass) still surface as
 * schema errors so the chunk gets logged and dropped.
 *
 * Non-object input is returned unchanged so the schema parse can produce
 * its normal error.
 */
export function normalizeExtractionResult(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.facts)) return raw;
  const normalizedFacts = r.facts.map((f) => {
    if (typeof f !== "object" || f === null) return f;
    const fact = { ...(f as Record<string, unknown>) };
    if (typeof fact.type === "string") {
      const lower = fact.type.toLowerCase();
      const remapped = FACT_TYPE_LENIENT_REMAP[lower];
      if (remapped !== undefined) {
        fact.type = remapped;
      }
    }
    if (typeof fact.excerpt === "string" && fact.excerpt.length > 300) {
      fact.excerpt = fact.excerpt.slice(0, 300);
    }
    return fact;
  });
  const out: Record<string, unknown> = { ...r, facts: normalizedFacts };
  if (typeof r.coverage === "object" && r.coverage !== null) {
    const cov = { ...(r.coverage as Record<string, unknown>) };
    if (typeof cov.extractable === "string" && cov.extractable.length > 300) {
      cov.extractable = cov.extractable.slice(0, 300);
    }
    if (
      typeof cov.nonExtractable === "string" &&
      cov.nonExtractable.length > 300
    ) {
      cov.nonExtractable = cov.nonExtractable.slice(0, 300);
    }
    out.coverage = cov;
  }
  return out;
}

/** The canonical durable fact record written to `extracted/facts.jsonl`. */
export const FactRecordSchema = z
  .object({
    id: z.string().regex(ULID_RE, "must be ULID"),
    text: z.string().min(10).max(500),
    type: FactTypeSchema,
    entities: z.array(z.string().min(1)).max(10),
    source: FactSourceSchema,
    freshnessClass: CacheableVolatilitySchema,
    /** ISO-8601 expiry (UTC). `null` iff `freshnessClass === "static"`. */
    validUntil: z.string().regex(ISO_8601).nullable(),
    confidence: z.number().min(0.5).max(1),
    extractedAt: z.string().regex(ISO_8601),
    extractor: z.object({
      model: z.string().min(1).max(80),
      promptVersion: z.string().min(1).max(40),
    }),
    volatilityNotes: z.string().max(200).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.freshnessClass === "static" && r.validUntil !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: "validUntil must be null when freshnessClass is 'static'",
      });
    }
    if (r.freshnessClass === "slow" && r.validUntil === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: "validUntil must be ISO-8601 when freshnessClass is 'slow'",
      });
    }
  });
export type FactRecord = z.infer<typeof FactRecordSchema>;

/**
 * Pipeline binding context — provided per source/per LLM call to convert
 * `ExtractedFactDraft` into the canonical `FactRecord`.
 *
 * `id` is caller-supplied (typically `ulid()` in production, deterministic in
 * tests). `extractedAt` is also caller-supplied for the same reason.
 */
export interface FactBindingContext {
  id: string;
  sourceId: string;
  contentHash: string;
  url: string;
  extractedAt: Date;
  extractor: { model: string; promptVersion: string };
}

/**
 * Materialize a draft fact into a canonical `FactRecord`.
 *
 * - Computes `validUntil` from the draft's relative TTL and `extractedAt`.
 * - Binds source identity (sourceId, contentHash, url) and excerpt.
 * - Re-validates the result through `FactRecordSchema` to catch drift.
 *
 * Pure function: does not mutate input; deterministic given identical inputs.
 */
export function materializeFact(
  draft: ExtractedFactDraft,
  ctx: FactBindingContext,
): FactRecord {
  const validUntil =
    draft.freshnessClass === "static"
      ? null
      : new Date(
          ctx.extractedAt.getTime() +
            // `validUntilRelative` is non-null when freshnessClass is "slow"
            // (enforced by ExtractedFactDraftSchema's superRefine).
            (draft.validUntilRelative as { days: number }).days *
              24 *
              60 *
              60 *
              1000,
        ).toISOString();

  const record = {
    id: ctx.id,
    text: draft.text,
    type: draft.type,
    entities: draft.entities,
    source: {
      sourceId: ctx.sourceId,
      contentHash: ctx.contentHash,
      url: ctx.url,
      excerpt: draft.excerpt,
    },
    freshnessClass: draft.freshnessClass,
    validUntil,
    confidence: draft.confidence,
    extractedAt: ctx.extractedAt.toISOString(),
    extractor: ctx.extractor,
    ...(draft.volatilityNotes !== undefined
      ? { volatilityNotes: draft.volatilityNotes }
      : {}),
  };

  return FactRecordSchema.parse(record);
}

// ──────────────────────────────────────────────────────────────────────────────
// CompileState — `.compile/compile-state.json`
//
// Tracks per-stage status, input/output hashes, prompt versions, and (optional)
// LLM cost. The pipeline reads this file on every stage boundary to support:
//   - `--resume`: pick up after a failure or interruption
//   - `--from-stage <id>`: re-run a specific stage and everything after it
//   - replay / debugging: reproduce an LLM call with the recorded promptVersion
//
// File location: `<almanac>/.compile/compile-state.json`
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Canonical stage IDs in execution order.
 *
 * Stage 2 has three sub-stages; Stage 0 is bootstrap. Anything that the
 * pipeline does in a separately-tracked unit gets an id here.
 */
export const STAGE_IDS = [
  "00-bootstrap",
  "01-domain-analysis",
  "02a-source-discovery-planner",
  "02x-source-discovery-executor", // deterministic; no promptVersion
  "02b-source-discovery-evaluator",
  "03-source-approve",
  "04-source-fetch",
  "05-fact-extraction",
  "06-tool-design",
  "07-tool-impl",
  "08-knowledge-index",
  "09-contract-files",
  "10-adapter-generation",
  "11-benchmark-gen",
  "12-benchmark-run",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const StageIdSchema = z.enum(STAGE_IDS);

/** Lifecycle status of a single stage. */
export const StageStatusSchema = z.enum([
  "pending",   // not yet started
  "running",   // in progress; only one stage may be running at a time
  "completed", // finished successfully
  "failed",    // gave up after retries
  "skipped",   // explicitly skipped (e.g., approval gate auto-resolved, or feature off)
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

/** Optional accounting for a stage. */
const StageCostSchema = z.object({
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  usd: z.number().nonnegative(),
});

const StageErrorSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(2000),
  attempt: z.number().int().positive(),
  occurredAt: z.string().regex(ISO_8601),
});

const SHA256_HEX_NULLABLE = z
  .string()
  .regex(SHA256_HEX, "must be sha256 hex")
  .nullable();

export const StageEntrySchema = z
  .object({
    status: StageStatusSchema,
    /** First time this stage transitioned to "running". */
    startedAt: z.string().regex(ISO_8601).nullable(),
    /** Last time this stage transitioned to "completed" / "failed" / "skipped". */
    finishedAt: z.string().regex(ISO_8601).nullable(),
    /** sha256 over concatenated input artifacts; null while pending. */
    inputHash: SHA256_HEX_NULLABLE,
    /** sha256 over concatenated output artifacts; null until completed. */
    outputHash: SHA256_HEX_NULLABLE,
    /** Prompt version recorded for replayability; null for deterministic stages. */
    promptVersion: z.string().min(1).max(40).nullable(),
    /** Number of LLM API calls made by this stage so far. */
    llmCalls: z.number().int().nonnegative(),
    /** Number of execution attempts (retries) so far. */
    attempt: z.number().int().nonnegative(),
    cost: StageCostSchema.optional(),
    /** Present when `status === "failed"` (or last failure before retry). */
    error: StageErrorSchema.optional(),
    /** Present when `status === "skipped"`; explains why. */
    skipReason: z.string().min(1).max(200).optional(),
  })
  .superRefine((s, ctx) => {
    // pending → no timestamps, no hashes, no error
    if (s.status === "pending") {
      if (s.startedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: "startedAt must be null when status is 'pending'",
        });
      }
      if (s.finishedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finishedAt"],
          message: "finishedAt must be null when status is 'pending'",
        });
      }
    }

    // running → startedAt set, finishedAt null
    if (s.status === "running") {
      if (s.startedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: "startedAt is required when status is 'running'",
        });
      }
      if (s.finishedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finishedAt"],
          message: "finishedAt must be null when status is 'running'",
        });
      }
    }

    // completed → both timestamps + outputHash
    if (s.status === "completed") {
      if (s.startedAt === null || s.finishedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finishedAt"],
          message:
            "startedAt and finishedAt are required when status is 'completed'",
        });
      }
      if (s.outputHash === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputHash"],
          message: "outputHash is required when status is 'completed'",
        });
      }
    }

    // failed → error must be present
    if (s.status === "failed" && s.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "error is required when status is 'failed'",
      });
    }

    // skipped → skipReason must be present
    if (s.status === "skipped" && s.skipReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipReason"],
        message: "skipReason is required when status is 'skipped'",
      });
    }

    // finishedAt monotonicity (best-effort: same-millisecond OK)
    if (s.startedAt !== null && s.finishedAt !== null) {
      if (Date.parse(s.finishedAt) < Date.parse(s.startedAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finishedAt"],
          message: "finishedAt must be >= startedAt",
        });
      }
    }
  });
export type StageEntry = z.infer<typeof StageEntrySchema>;

/** Compile-time options recorded with the run for reproducibility. */
export const CompileOptionsSchema = z.object({
  depth: z.enum(["quick", "standard", "deep"]),
  /** User-supplied source hints (URLs or queries); empty when none. */
  sourcesHint: z.array(z.string()),
  /**
   * Optional one-paragraph scope narrowing supplied by the user. Stage 1
   * feeds this verbatim into the domain-analysis prompt so the LLM can
   * disambiguate abstract or broad domain terms (e.g.,
   * `"for senior engineering leaders at series B+ startups"`).
   * Omitted when not provided.
   */
  scopeHint: z.string().max(500).optional(),
  /** Which adapter(s) to install. v0.1: skill is always written; mcp is generic. */
  target: z.enum(["mcp", "skill", "both"]),
  /** v0.1 default: true (--auto-approve is on). */
  autoApprove: z.boolean(),
  /** v0.1 generated tools language. Reserved enum for v0.2 expansion. */
  language: z.literal("ts"),
});
export type CompileOptions = z.infer<typeof CompileOptionsSchema>;

/**
 * Build a `stages` schema with every `StageId` required as a key.
 *
 * Static type is recovered via `as` because `Object.fromEntries` widens to
 * `Record<string, ...>`. The runtime check is exact.
 */
const StagesShape = Object.fromEntries(
  STAGE_IDS.map((id) => [id, StageEntrySchema]),
) as { [K in StageId]: typeof StageEntrySchema };
export const StagesSchema = z.object(StagesShape);
export type Stages = z.infer<typeof StagesSchema>;

export const CompileStateSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    runId: z.string().min(1).max(64),
    /** Almanac canonical slug — matches the directory name. */
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    /** Original domain string as the user typed it. */
    domain: z.string().min(1),
    /** Version of the `almanac` CLI that started this run. */
    forgerVersion: z.string().min(1).max(40),
    startedAt: z.string().regex(ISO_8601),
    /** Last time this state file was written. */
    updatedAt: z.string().regex(ISO_8601),
    options: CompileOptionsSchema,
    /** The currently-running stage id, or null when no stage is running. */
    currentStageId: StageIdSchema.nullable(),
    stages: StagesSchema,
  })
  .superRefine((state, ctx) => {
    // updatedAt >= startedAt
    if (Date.parse(state.updatedAt) < Date.parse(state.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must be >= startedAt",
      });
    }

    // currentStageId ↔ stages[*].status === "running" consistency
    const running = STAGE_IDS.filter(
      (id) => state.stages[id].status === "running",
    );

    if (running.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: `at most one stage may be 'running' at once; found ${running.length}: ${running.join(", ")}`,
      });
    }

    if (state.currentStageId === null && running.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentStageId"],
        message: `currentStageId is null but stages contain a running entry: ${running[0]}`,
      });
    }

    if (state.currentStageId !== null) {
      const entry = state.stages[state.currentStageId];
      if (entry.status !== "running") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["currentStageId"],
          message: `currentStageId='${state.currentStageId}' but its status is '${entry.status}', not 'running'`,
        });
      }
    }
  });
export type CompileState = z.infer<typeof CompileStateSchema>;

/**
 * Build a fresh `CompileState` with every stage marked `"pending"`.
 *
 * The caller is responsible for persisting it and supplying a `now` Date
 * (defaulting to `new Date()` for production).
 */
export interface InitCompileStateInput {
  runId: string;
  almanacId: string;
  domain: string;
  forgerVersion: string;
  options: CompileOptions;
  now?: Date;
}

export function initCompileState(input: InitCompileStateInput): CompileState {
  const ts = (input.now ?? new Date()).toISOString();
  const blank: StageEntry = {
    status: "pending",
    startedAt: null,
    finishedAt: null,
    inputHash: null,
    outputHash: null,
    promptVersion: null,
    llmCalls: 0,
    attempt: 0,
  };
  const stages = Object.fromEntries(
    STAGE_IDS.map((id) => [id, structuredClone(blank)]),
  ) as Stages;

  const state = {
    schemaVersion: "0.1.0" as const,
    runId: input.runId,
    almanacId: input.almanacId,
    domain: input.domain,
    forgerVersion: input.forgerVersion,
    startedAt: ts,
    updatedAt: ts,
    options: input.options,
    currentStageId: null,
    stages,
  };
  return CompileStateSchema.parse(state);
}

// ──────────────────────────────────────────────────────────────────────────────
// Runtime contract — ToolManifest, ToolResult, ResourceDescriptor
//
// The operation contract that `serve/`, `manage/`, and the SKILL.md adapter
// all share. Generic to any compiled almanac.
//
// The corresponding interface (`AlmanacRuntime`, `ToolContext`,
// `KnowledgeReader`, `ToolModule`) lives in `src/core/runtime.ts`.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Loose JSON Schema. MCP passes this through to clients verbatim; we do not
 * validate the inner schema shape here (that is the job of zod-to-JSON-schema
 * generators in Stage 6/7).
 */
export const JsonSchemaSchema = z.record(z.unknown());
export type JsonSchemaObject = z.infer<typeof JsonSchemaSchema>;

/**
 * Tool name — same snake_case rule as `SuggestedTool.name`. Reserved to
 * `[a-z][a-z0-9_]*`, ≤48 chars. Default tool names are allowed here (unlike
 * `SuggestedToolSchema`, which forbids them).
 */
export const ToolNameSchema = z
  .string()
  .regex(SNAKE_CASE, "tool name must be snake_case ([a-z][a-z0-9_]*)")
  .max(48);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Hostname (lowercase, dotted, no scheme/path). Used for network allowlists. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
const ERROR_CODE = /^[a-z][a-z0-9_-]*$/;
// (SEMVER_RE is declared earlier, in the Stage 0 section)

/**
 * Capability declarations carved out of the manifest. The `serve/` runtime
 * uses these to construct a sandboxed `ToolContext` per call:
 *
 * - `network: []` ⇒ no `fetch` is provided.
 * - `secrets: ["GITHUB_TOKEN"]` ⇒ only `GITHUB_TOKEN` is read from env and
 *   injected; nothing else is exposed.
 * - `fs: "none"` ⇒ no fs access (tools that touch fs at all must declare).
 */
export const ToolCapabilitiesSchema = z.object({
  /** Allowed network hostnames; `[]` means no network access. */
  network: z.array(z.string().regex(HOSTNAME, "must be a hostname")).max(20),
  fs: z.enum(["none", "read", "write"]),
  /** Allowed subprocess executables (basename only); `[]` = no subprocess. */
  subprocess: z.array(z.string().min(1).max(80)).max(8),
  /** Required env-var names (e.g., "GITHUB_TOKEN"); `[]` = no secrets. */
  secrets: z
    .array(z.string().regex(ENV_VAR_NAME, "must be SCREAMING_SNAKE_CASE"))
    .max(8),
});
export type ToolCapabilities = z.infer<typeof ToolCapabilitiesSchema>;

export const ToolCachePolicySchema = z.enum([
  "no-cache",       // every call hits the upstream; result is never cached
  "ttl",            // cache for `ttlSeconds`
  "manual-refresh", // cache indefinitely; refreshed only by `almanac update`
]);
export type ToolCachePolicy = z.infer<typeof ToolCachePolicySchema>;

/** Manifest-level freshness configuration. */
export const ToolFreshnessConfigSchema = z
  .object({
    cachePolicy: ToolCachePolicySchema,
    /** Required and >0 when cachePolicy="ttl"; otherwise null. */
    ttlSeconds: z.number().int().nonnegative().nullable(),
    /**
     * Whether the upstream provides a per-record timestamp the tool should
     * surface in `Citation.sourceTimestamp`. Informs runtime staleness checks
     * for `manual-refresh` caches.
     */
    sourceTimestamp: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (c.cachePolicy === "ttl") {
      if (c.ttlSeconds === null || c.ttlSeconds <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ttlSeconds"],
          message: 'ttlSeconds must be a positive integer when cachePolicy is "ttl"',
        });
      }
    } else {
      if (c.ttlSeconds !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ttlSeconds"],
          message: `ttlSeconds must be null when cachePolicy is "${c.cachePolicy}"`,
        });
      }
    }
  });
export type ToolFreshnessConfig = z.infer<typeof ToolFreshnessConfigSchema>;

/** How a tool consumes the indexed fact store. */
export const ToolKnowledgeUsageSchema = z
  .object({
    /** True when the tool reads from `knowledge/almanac.sqlite`. */
    facts: z.boolean(),
    /**
     * Optional default FTS5 query template (with `{q}` placeholder). Required
     * to be null when `facts === false`.
     */
    ftsQuery: z.string().min(1).max(500).nullable(),
    /** Reserved for v0.2; must be `false` in v0.1 manifests. */
    embeddings: z.boolean(),
  })
  .superRefine((u, ctx) => {
    if (!u.facts && u.ftsQuery !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ftsQuery"],
        message: "ftsQuery must be null when facts === false",
      });
    }
    if (u.embeddings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddings"],
        message: "embeddings is reserved for v0.2; must be false in v0.1",
      });
    }
  });
export type ToolKnowledgeUsage = z.infer<typeof ToolKnowledgeUsageSchema>;

/** A smoke-test fixture embedded in the manifest. Used by Stage 7. */
export const ToolExampleSchema = z.object({
  description: z.string().min(1).max(200),
  input: z.unknown(),
  expectedShape: z.union([
    z.literal("match-outputSchema"),
    z.object({
      contains: z.array(z.string().min(1).max(200)).min(1).max(10),
    }),
  ]),
});
export type ToolExample = z.infer<typeof ToolExampleSchema>;

/** "Designed by" / "Implemented by" provenance written by Stage 6 / 7. */
export const ToolProvenanceSchema = z.object({
  model: z.string().min(1).max(80),
  promptVersion: z.string().min(1).max(40),
});
export type ToolProvenance = z.infer<typeof ToolProvenanceSchema>;

export const ToolImplementationProvenanceSchema = ToolProvenanceSchema.extend({
  tscPassed: z.boolean(),
  smokePassed: z.boolean(),
  attempts: z.number().int().positive(),
});
export type ToolImplementationProvenance = z.infer<
  typeof ToolImplementationProvenanceSchema
>;

/**
 * Canonical tool manifest written to `tools/<name>.json`. Stage 6 produces a
 * draft (without `implementedBy`); Stage 7 fills `implementedBy` after the
 * `tsc + bun test` loop succeeds.
 */
export const ToolManifestSchema = z
  .object({
    name: ToolNameSchema,
    version: z.string().regex(SEMVER_RE, "must be semver"),
    description: z.string().min(10).max(500),
    whenToUse: z.string().min(10).max(500),
    returnsSummary: z.string().min(10).max(300),
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema,
    capabilities: ToolCapabilitiesSchema,
    volatilityClass: VolatilityClassSchema,
    freshness: ToolFreshnessConfigSchema,
    knowledgeUsage: ToolKnowledgeUsageSchema,
    examples: z.array(ToolExampleSchema).min(1).max(10),
    designedBy: ToolProvenanceSchema,
    implementedBy: ToolImplementationProvenanceSchema.optional(),
    disabled: z.boolean(),
    disabledReason: z.string().min(1).max(300).optional(),
    /**
     * Approved source ids the tool reads content from. Empty for tools that
     * hit only live external APIs and never depend on indexed/snapshotted
     * source material. Cross-validation against `SourcesFile.sources[*].id`
     * lives in `parseToolDesignResultWithSources`; the schema itself only
     * checks shape and uniqueness.
     */
    sourceDependencies: z
      .array(
        z
          .string()
          .max(64)
          .regex(SOURCE_ID, "must match SourcesFile source id format"),
      )
      .max(12)
      .default([]),
    /**
     * Real, documented URLs of pages this tool will plausibly fetch. Used by
     * Stage 7 as ground truth: the generated smoke test must mock at least
     * one of these to a 200 response, which forces the impl's URL builder to
     * actually hit a real-world URL pattern (not a confabulated one) for the
     * smoke to pass. Empty `[]` for tools that don't call out (knowledge-only,
     * subprocess-only, etc.) — the validator skips the check in that case.
     *
     * Each URL's host SHOULD appear in `capabilities.network`; cross-validation
     * is advisory because Stage 6 may sample URLs from documentation that
     * lives on a host the tool reaches via a redirect (e.g., docs.rs → static
     * doc CDN).
     */
    sampleUrls: z.array(z.string().url()).max(5).default([]),
  })
  .superRefine((m, ctx) => {
    // disabled ↔ disabledReason
    if (m.disabled && m.disabledReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "disabledReason is required when disabled === true",
      });
    }
    if (!m.disabled && m.disabledReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "disabledReason must be omitted when disabled === false",
      });
    }

    // volatilityClass ↔ cachePolicy invariants
    if (m.volatilityClass === "live" && m.freshness.cachePolicy !== "no-cache") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["freshness", "cachePolicy"],
        message:
          'live tools must use cachePolicy "no-cache" (live data is never cached)',
      });
    }
    if (m.volatilityClass === "static" && m.freshness.cachePolicy === "no-cache") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["freshness", "cachePolicy"],
        message:
          'static tools should not use cachePolicy "no-cache" (defeats the point of caching timeless data)',
      });
    }

    // facts-backed tools must be at most as volatile as the cache supports
    if (m.knowledgeUsage.facts && m.volatilityClass !== "static" && m.volatilityClass !== "slow") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeUsage", "facts"],
        message:
          'knowledgeUsage.facts is only allowed when volatilityClass is "static" or "slow" (the fact store does not cache fast/live)',
      });
    }

    // sourceDependencies entries must be unique
    if (m.sourceDependencies.length > 0) {
      const seen = new Set<string>();
      for (let i = 0; i < m.sourceDependencies.length; i++) {
        const id = m.sourceDependencies[i]!;
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sourceDependencies", i],
            message: `duplicate sourceDependencies entry: "${id}"`,
          });
        }
        seen.add(id);
      }
    }

    // sampleUrls only meaningful for tools that actually do network I/O.
    if (m.sampleUrls.length > 0 && m.capabilities.network.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sampleUrls"],
        message:
          "sampleUrls is only meaningful when capabilities.network is non-empty (a tool with no network access cannot fetch URLs)",
      });
    }
  });
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/**
 * Stage 6 (tool design) — top-level LLM output.
 *
 * The LLM emits 0–3 *domain-specific* tool manifests. The compiler
 * deterministically synthesizes the four default tools
 * (`query_facts`, `fetch_official_docs`, `web_search_recent`,
 * `latest_releases`) from `DomainSpec` + `SourcesFile`, so the LLM must NOT
 * include those names in `customTools`.
 *
 * Stage 6 produces *design only* — `implementedBy` must be omitted; Stage 7
 * (tool implementation) fills it in after the `tsc + bun test` loop succeeds.
 *
 * Prompt template: src/compile/prompts/06-tool-design/v1.md
 */
export const ToolDesignResultSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    customTools: z.array(ToolManifestSchema).max(3),
    /** One paragraph: why these tools (or why none). */
    rationale: z.string().min(10).max(1000),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < r.customTools.length; i++) {
      const t = r.customTools[i]!;

      // Disallow names that collide with the four defaults.
      if ((DEFAULT_TOOL_NAMES as readonly string[]).includes(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customTools", i, "name"],
          message: `customTool name "${t.name}" collides with a default tool name; use a domain-specific name`,
        });
      }

      // Unique within customTools[].
      if (seen.has(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customTools", i, "name"],
          message: `duplicate customTool name: "${t.name}"`,
        });
      }
      seen.add(t.name);

      // implementedBy must be undefined at design time.
      if (t.implementedBy !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customTools", i, "implementedBy"],
          message: "implementedBy must be omitted in Stage 6 output (Stage 7 fills it)",
        });
      }
    }
  });
export type ToolDesignResult = z.infer<typeof ToolDesignResultSchema>;

/** Parse the raw Stage 6 LLM JSON output into a validated `ToolDesignResult`. */
export function parseToolDesignResult(raw: unknown): ToolDesignResult {
  return ToolDesignResultSchema.parse(raw);
}

/**
 * Stage 6 cross-validation against the approved `SourcesFile`.
 *
 * v0.3 source-mode awareness — the empirical 80 % ceiling in v0.2.6 came from
 * Stage 6 designing fact-store-reading tools (`pragma_lookup`,
 * `lookup_std_item`) on top of sources that Stage 4 had fetched in
 * `index-only` mode. The fact store never saw their content, so the runtime
 * tool calls returned empty.
 *
 * Two rules enforced here (cannot live in the pure schema because they need
 * the approved sources to resolve ids):
 *
 *   1. Every `sourceDependencies[*]` must reference an approved
 *      `sources[*].id`.
 *   2. If `knowledgeUsage.facts === true`, `sourceDependencies` must be
 *      non-empty AND contain at least one source whose
 *      `ingestion.mode === "snapshot"`. A facts-backed tool that only lists
 *      index-only / feed sources will return empty at runtime — the model
 *      should redesign it around `fetch_official_docs` instead.
 *
 * Live-API tools (`knowledgeUsage.facts === false`) may keep
 * `sourceDependencies: []` — they don't touch the indexed corpus.
 */
export function parseToolDesignResultWithSources(
  raw: unknown,
  sources: SourcesFile,
): ToolDesignResult {
  const parsed = ToolDesignResultSchema.parse(raw);
  const sourceById = new Map(sources.sources.map((s) => [s.id, s] as const));
  const issues: string[] = [];

  for (let i = 0; i < parsed.customTools.length; i++) {
    const t = parsed.customTools[i]!;

    for (let j = 0; j < t.sourceDependencies.length; j++) {
      const id = t.sourceDependencies[j]!;
      if (!sourceById.has(id)) {
        issues.push(
          `customTools[${i}] "${t.name}": sourceDependencies[${j}] "${id}" ` +
            `does not match any approved source id`,
        );
      }
    }

    if (t.knowledgeUsage.facts) {
      if (t.sourceDependencies.length === 0) {
        issues.push(
          `customTools[${i}] "${t.name}": knowledgeUsage.facts is true but ` +
            `sourceDependencies is empty; a facts-backed tool must declare ` +
            `which approved sources its fact retrieval depends on`,
        );
      } else {
        const hasSnapshot = t.sourceDependencies.some((id) => {
          const s = sourceById.get(id);
          return s !== undefined && s.ingestion.mode === "snapshot";
        });
        if (!hasSnapshot) {
          const modes = t.sourceDependencies
            .map((id) => {
              const s = sourceById.get(id);
              return `${id}=${s?.ingestion.mode ?? "missing"}`;
            })
            .join(", ");
          issues.push(
            `customTools[${i}] "${t.name}": knowledgeUsage.facts is true ` +
              `but no listed sourceDependencies is in snapshot mode ` +
              `(modes: ${modes}); index-only sources do not contribute ` +
              `content to the fact store, so the tool will return empty ` +
              `at runtime. Redesign this tool around fetch_official_docs ` +
              `(volatilityClass: "fast", facts: false) or pick a ` +
              `snapshot-mode source.`,
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new ToolDesignSourceValidationError(issues);
  }

  return parsed;
}

/**
 * Raised by `parseToolDesignResultWithSources` when one or more custom tools
 * violate the source-mode invariants (unknown source id, or facts-backed
 * tool whose dependencies do not include a snapshot-mode source).
 */
export class ToolDesignSourceValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      "Stage 6 source-dependency validation failed:\n" +
        issues.map((i) => `  - ${i}`).join("\n"),
    );
    this.name = "ToolDesignSourceValidationError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage 7 — tool implementation (tsc + bun test loop)
//
// Stage 7 takes each `ToolManifest` from Stage 6 and produces:
//   - `<almanac>/tools/<name>.ts`        (executable implementation)
//   - `<almanac>/tools/<name>.test.ts`   (smoke tests derived from manifest.examples)
//   - the manifest with `implementedBy` filled in (on success) OR
//     `disabled: true` + `disabledReason` (on give-up)
//
// The work is performed in a retry loop (`maxAttempts`, default 3):
//   1. LLM generates code + tests
//   2. write files
//   3. run `tsc --noEmit <files>`
//   4. run `bun test <test-file>`
//   5. on any failure, feed diagnostics back to the next iteration
//
// Default tools (`query_facts`, `fetch_official_docs`, `web_search_recent`,
// `latest_releases`) are implemented from canonical templates — no LLM, no
// retry loop. The pluggable `ToolImplementer` interface accommodates both.
//
// Interfaces / orchestrator: `src/compile/stages/s07-tool-impl.ts`.
// ──────────────────────────────────────────────────────────────────────────────

/** Outcome bucket for one attempt within Stage 7's retry loop. */
export const ImplementationOutcomeSchema = z.enum([
  "success",          // wrote files, tsc passed, validator passed, smoke passed
  "llm-failed",       // LLM call errored or returned malformed code
  "write-failed",     // could not write files (fs error)
  "tsc-failed",       // type-check failed
  "validator-failed", // static check on generated source flagged a hallucination pattern
  "smoke-failed",     // tsc + validator passed but `bun test` failed
]);
export type ImplementationOutcome = z.infer<typeof ImplementationOutcomeSchema>;

export const ImplementationAttemptSchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    /** Model that generated this attempt. Empty for template-driven defaults. */
    model: z.string().max(80),
    promptVersion: z.string().max(40),
    startedAt: z.string().regex(ISO_8601),
    finishedAt: z.string().regex(ISO_8601),
    outcome: ImplementationOutcomeSchema,
    /** Compiler/test diagnostics; present when outcome !== "success". */
    diagnostics: z.string().max(20_000).nullable(),
  })
  .superRefine((a, ctx) => {
    if (Date.parse(a.finishedAt) < Date.parse(a.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt must be >= startedAt",
      });
    }
    if (a.outcome === "success" && a.diagnostics !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnostics"],
        message: "diagnostics must be null when outcome is 'success'",
      });
    }
    if (a.outcome !== "success" && a.diagnostics === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnostics"],
        message: `diagnostics is required when outcome is '${a.outcome}'`,
      });
    }
  });
export type ImplementationAttempt = z.infer<typeof ImplementationAttemptSchema>;

export const ToolImplementationStatusSchema = z.enum([
  "implemented", // final attempt succeeded; tools/<name>.ts is on disk
  "disabled",    // gave up after maxAttempts; tools/<name>.json has disabled:true
]);
export type ToolImplementationStatus = z.infer<
  typeof ToolImplementationStatusSchema
>;

/** Per-tool result of Stage 7. */
export const ToolImplementationResultSchema = z
  .object({
    toolName: ToolNameSchema,
    status: ToolImplementationStatusSchema,
    attempts: z.array(ImplementationAttemptSchema).min(1).max(10),
    /**
     * The manifest as it stands after Stage 7. For "implemented" results this
     * has `implementedBy` populated; for "disabled" results this has
     * `disabled: true` + `disabledReason`.
     */
    finalManifest: ToolManifestSchema,
  })
  .superRefine((r, ctx) => {
    const last = r.attempts[r.attempts.length - 1]!;

    // attemptNumber monotonicity (1, 2, 3, …)
    for (let i = 0; i < r.attempts.length; i++) {
      if (r.attempts[i]!.attemptNumber !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attempts", i, "attemptNumber"],
          message: `attemptNumber must be sequential starting at 1 (expected ${i + 1}, got ${r.attempts[i]!.attemptNumber})`,
        });
      }
    }

    // status ↔ last attempt outcome
    if (r.status === "implemented" && last.outcome !== "success") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: `status="implemented" requires the last attempt's outcome to be "success" (got "${last.outcome}")`,
      });
    }
    if (r.status === "disabled" && last.outcome === "success") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: 'status="disabled" requires the last attempt to be a failure',
      });
    }

    // status ↔ finalManifest fields
    if (r.status === "implemented") {
      if (r.finalManifest.implementedBy === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finalManifest", "implementedBy"],
          message: 'implementedBy must be set when status="implemented"',
        });
      }
      if (r.finalManifest.disabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finalManifest", "disabled"],
          message: 'disabled must be false when status="implemented"',
        });
      }
    } else {
      if (!r.finalManifest.disabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finalManifest", "disabled"],
          message: 'disabled must be true when status="disabled"',
        });
      }
    }

    // finalManifest.name must match toolName
    if (r.finalManifest.name !== r.toolName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalManifest", "name"],
        message: `finalManifest.name "${r.finalManifest.name}" does not match toolName "${r.toolName}"`,
      });
    }
  });
export type ToolImplementationResult = z.infer<
  typeof ToolImplementationResultSchema
>;

export const Stage07SummarySchema = z.object({
  total: z.number().int().nonnegative(),
  implemented: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
  totalAttempts: z.number().int().nonnegative(),
});
export type Stage07Summary = z.infer<typeof Stage07SummarySchema>;

export const Stage07OutputSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    startedAt: z.string().regex(ISO_8601),
    finishedAt: z.string().regex(ISO_8601),
    summary: Stage07SummarySchema,
    results: z.array(ToolImplementationResultSchema).min(1).max(7),
  })
  .superRefine((s, ctx) => {
    if (Date.parse(s.finishedAt) < Date.parse(s.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt must be >= startedAt",
      });
    }

    // unique tool names
    const seen = new Set<string>();
    for (let i = 0; i < s.results.length; i++) {
      const r = s.results[i]!;
      if (seen.has(r.toolName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["results", i, "toolName"],
          message: `duplicate toolName: "${r.toolName}"`,
        });
      }
      seen.add(r.toolName);
    }

    // summary derivation
    let implemented = 0;
    let disabled = 0;
    let totalAttempts = 0;
    for (const r of s.results) {
      if (r.status === "implemented") implemented += 1;
      else disabled += 1;
      totalAttempts += r.attempts.length;
    }
    if (s.summary.total !== s.results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "total"],
        message: `summary.total (${s.summary.total}) !== results.length (${s.results.length})`,
      });
    }
    const checks: Array<[keyof Stage07Summary, number]> = [
      ["implemented", implemented],
      ["disabled", disabled],
      ["totalAttempts", totalAttempts],
    ];
    for (const [field, actual] of checks) {
      if (s.summary[field] !== actual) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["summary", field],
          message: `summary.${field} (${s.summary[field]}) !== actual (${actual})`,
        });
      }
    }
  });
export type Stage07Output = z.infer<typeof Stage07OutputSchema>;

/** Aggregate per-tool results into a Stage 7 output. Pure. */
export function buildStage07Output(input: {
  startedAt: Date;
  finishedAt: Date;
  results: ToolImplementationResult[];
}): Stage07Output {
  let implemented = 0;
  let disabled = 0;
  let totalAttempts = 0;
  for (const r of input.results) {
    if (r.status === "implemented") implemented += 1;
    else disabled += 1;
    totalAttempts += r.attempts.length;
  }
  return Stage07OutputSchema.parse({
    schemaVersion: "0.1.0" as const,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    summary: {
      total: input.results.length,
      implemented,
      disabled,
      totalAttempts,
    },
    results: input.results,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage 9 — contract files (DOMAIN.md / AGENTS.md / SKILLS.md)
//
// Stage 9 renders three contract files at the root of the compiled almanac:
//
//   - DOMAIN.md  : what the almanac covers + freshness policy + tools catalog
//   - AGENTS.md  : operating contract for host LLMs (rules of engagement)
//   - SKILLS.md  : 100% deterministic tools catalog (from tools/*.json)
//
// SKILLS.md is fully deterministic. DOMAIN.md and AGENTS.md are mostly
// deterministic; the LLM contributes small marked sections via the
// `Stage09Narrative` artifact. The renderer is pure and lives in
// `src/compile/templates/contract.ts`. The orchestrator that wires inputs +
// narrative + manifests into the three rendered strings lives in
// `src/compile/stages/s09-contract.ts`.
//
// Prompt for the narrative call: src/compile/prompts/09-narrative/v1.md
// (deferred until Stage 9 actually needs its own LLM call).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The small LLM-authored fragments that DOMAIN.md and AGENTS.md need beyond
 * what `DomainSpec` already supplies.
 *
 * Everything else in the contract files is deterministic.
 */
export const Stage09NarrativeSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  /** A polished 1-line description for the top of DOMAIN.md. */
  domainOneLiner: z.string().min(10).max(300),
  /** Bullet items for the "Scope" section of DOMAIN.md. */
  scope: z.object({
    covers: z.array(z.string().min(3).max(200)).min(2).max(8),
    outOfScope: z.array(z.string().min(3).max(200)).min(1).max(6),
  }),
  /** Markdown body for AGENTS.md "Tool Selection Guidance" (one or more paragraphs). */
  toolSelectionGuidance: z.string().min(40).max(3000),
});
export type Stage09Narrative = z.infer<typeof Stage09NarrativeSchema>;

export function parseStage09Narrative(raw: unknown): Stage09Narrative {
  return Stage09NarrativeSchema.parse(raw);
}

/** Names of the three contract files Stage 9 emits. */
export const ContractFileNameSchema = z.enum([
  "DOMAIN.md",
  "AGENTS.md",
  "SKILLS.md",
]);
export type ContractFileName = z.infer<typeof ContractFileNameSchema>;

export const ContractFileSchema = z.object({
  name: ContractFileNameSchema,
  /** Rendered markdown body, ready to write to disk. */
  contents: z.string().min(1),
  /** Length of `contents` in bytes (UTF-8). */
  byteLength: z.number().int().nonnegative(),
});
export type ContractFile = z.infer<typeof ContractFileSchema>;

/** The whole Stage 9 output. */
export const Stage09OutputSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    generatedAt: z.string().regex(ISO_8601),
    files: z.array(ContractFileSchema).length(3),
  })
  .superRefine((s, ctx) => {
    // Exactly the three named files, in canonical order.
    const expected: readonly ContractFileName[] = [
      "DOMAIN.md",
      "AGENTS.md",
      "SKILLS.md",
    ];
    const actual = s.files.map((f) => f.name);
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", i, "name"],
          message: `expected files[${i}].name === "${expected[i]}", got "${actual[i]}"`,
        });
      }
    }

    // byteLength agrees with contents
    for (let i = 0; i < s.files.length; i++) {
      const f = s.files[i]!;
      const actualBytes = new TextEncoder().encode(f.contents).length;
      if (f.byteLength !== actualBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", i, "byteLength"],
          message: `byteLength (${f.byteLength}) !== UTF-8 size of contents (${actualBytes})`,
        });
      }
    }
  });
export type Stage09Output = z.infer<typeof Stage09OutputSchema>;

/** Aggregate three rendered file contents into a Stage 9 output. Pure. */
export function buildStage09Output(input: {
  almanacId: string;
  generatedAt: Date;
  domainMd: string;
  agentsMd: string;
  skillsMd: string;
}): Stage09Output {
  const enc = new TextEncoder();
  const files: ContractFile[] = [
    {
      name: "DOMAIN.md",
      contents: input.domainMd,
      byteLength: enc.encode(input.domainMd).length,
    },
    {
      name: "AGENTS.md",
      contents: input.agentsMd,
      byteLength: enc.encode(input.agentsMd).length,
    },
    {
      name: "SKILLS.md",
      contents: input.skillsMd,
      byteLength: enc.encode(input.skillsMd).length,
    },
  ];
  return Stage09OutputSchema.parse({
    schemaVersion: "0.1.0" as const,
    almanacId: input.almanacId,
    generatedAt: input.generatedAt.toISOString(),
    files,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage 10 — Claude Code Skill adapter (SKILL.md)
//
// Stage 10 produces `<almanacDir>/adapters/skill/SKILL.md`, the only
// per-almanac adapter. The MCP server is generic (single binary, different
// data); the Skill is per-almanac because Claude Code reads the SKILL.md
// frontmatter at registration time.
//
// SKILL.md = YAML frontmatter (modeled on `last30days-skill`) + concatenated
// DOMAIN.md / AGENTS.md / SKILLS.md body. Tool names in `allowed-tools` are
// MCP-prefixed: `mcp__almanac-<id>__<toolName>`.
//
// Renderer: `src/compile/templates/skill.ts`.
// Orchestrator: `src/compile/stages/s10-skill-adapter.ts`.
// ──────────────────────────────────────────────────────────────────────────────

/** A fully-qualified MCP tool name as Claude Code expects in `allowed-tools`. */
const MCP_QUALIFIED_TOOL = /^mcp__almanac-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?__[a-z][a-z0-9_]*$/;
export const McpQualifiedToolNameSchema = z
  .string()
  .max(120)
  .regex(
    MCP_QUALIFIED_TOOL,
    "must be 'mcp__almanac-<almanacId>__<tool_name>'",
  );
export type McpQualifiedToolName = z.infer<typeof McpQualifiedToolNameSchema>;

export const SkillFrontmatterSchema = z.object({
  /** Skill name (e.g., "almanac-cooking"). Always `almanac-<almanacId>`. */
  name: z
    .string()
    .max(40)
    .regex(/^almanac-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "must be 'almanac-<almanacId>'"),
  version: z.string().regex(SEMVER_RE, "must be semver"),
  description: z.string().min(20).max(500),
  allowedTools: z.array(McpQualifiedToolNameSchema).max(7),
  metadata: z.object({
    almanac: z.object({
      domain: z.string().min(1),
      freshnessProfileId: FreshnessProfileIdSchema,
      toolCount: z.number().int().nonnegative(),
      factCount: z.number().int().nonnegative(),
      compiledAt: z.string().regex(ISO_8601),
    }),
  }),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const Stage10OutputSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    /** Always `adapters/skill/SKILL.md`. */
    relPath: z.literal("adapters/skill/SKILL.md"),
    /** Full SKILL.md contents, ready to write. */
    contents: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    /** Parsed frontmatter (also embedded in `contents`). */
    frontmatter: SkillFrontmatterSchema,
  })
  .superRefine((s, ctx) => {
    const actualBytes = new TextEncoder().encode(s.contents).length;
    if (s.byteLength !== actualBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["byteLength"],
        message: `byteLength (${s.byteLength}) !== UTF-8 size of contents (${actualBytes})`,
      });
    }

    // Frontmatter name and metadata.almanac fields must agree with almanacId
    const expectedName = `almanac-${s.almanacId}`;
    if (s.frontmatter.name !== expectedName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frontmatter", "name"],
        message: `frontmatter.name "${s.frontmatter.name}" must equal "${expectedName}"`,
      });
    }

    // allowed-tools count must match toolCount
    if (s.frontmatter.allowedTools.length !== s.frontmatter.metadata.almanac.toolCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frontmatter", "allowedTools"],
        message: `allowedTools.length (${s.frontmatter.allowedTools.length}) !== metadata.almanac.toolCount (${s.frontmatter.metadata.almanac.toolCount})`,
      });
    }
  });
export type Stage10Output = z.infer<typeof Stage10OutputSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Stage 11 — benchmark generation (LLM-driven)
// Stage 12 — benchmark run (deterministic, runs against AlmanacRuntime)
//
// Stage 11's LLM produces a `BenchmarkSet` with two arrays:
//   - `positive`: in-scope fixtures that SHOULD return citable results
//   - `negative`: out-of-scope or unsupported fixtures that SHOULD NOT
//
// Stage 12 invokes each fixture's `invocation` against the runtime and emits
// a `BenchmarkReport` with per-fixture pass/fail.
//
// Prompt: src/compile/prompts/11-benchmark-gen/v1.md (deferred until needed).
// Stage code: src/compile/stages/{s11-benchmark-gen,s12-benchmark-run}.ts.
// ──────────────────────────────────────────────────────────────────────────────

const FIXTURE_ID_RE = /^[a-z][a-z0-9-]*$/;

/** A single tool call the benchmark runner will execute. */
export const BenchmarkInvocationSchema = z.object({
  /** Tool name as it appears in `tools/<name>.json`. */
  tool: ToolNameSchema,
  /** JSON-serializable input matching the tool's `inputSchema`. */
  input: z.unknown(),
});
export type BenchmarkInvocation = z.infer<typeof BenchmarkInvocationSchema>;

/** Expected outcome for a positive fixture. */
export const PositiveExpectationSchema = z.object({
  /** Minimum required citations on `ok: true`. Default 1. */
  minCitations: z.number().int().nonnegative().max(20).default(1),
  /** Substrings the stringified result must contain. */
  contains: z.array(z.string().min(1).max(200)).max(8).default([]),
  /** Acceptable freshness staleness buckets. Default ["fresh", "warm"]. */
  acceptableStaleness: z
    .array(StalenessSchema)
    .min(1)
    .max(3)
    .default(["fresh", "warm"]),
});
export type PositiveExpectation = z.infer<typeof PositiveExpectationSchema>;

/** Expected outcome for a negative fixture (out-of-scope / unsupported). */
export const NegativeExpectationSchema = z.object({
  /** Maximum allowed citations. Default 0 (negative ⇒ no citable answer). */
  maxCitations: z.number().int().nonnegative().max(20).default(0),
  /**
   * If set, the result MUST be `ok: false` with this error code. When unset,
   * the runner accepts either `ok: false` OR `ok: true` with 0 citations.
   */
  expectedErrorCode: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_-]*$/, "must be lowercase kebab/snake-case")
    .optional(),
});
export type NegativeExpectation = z.infer<typeof NegativeExpectationSchema>;

const BenchmarkFixtureBase = {
  id: z
    .string()
    .max(48)
    .regex(FIXTURE_ID_RE, "must be lowercase kebab-case starting with a letter"),
  /** Natural-language query a host LLM might forward to the runtime. */
  query: z.string().min(5).max(400),
  /** Why the LLM author chose this fixture. */
  rationale: z.string().min(10).max(400),
  invocation: BenchmarkInvocationSchema,
};

export const PositiveFixtureSchema = z.object({
  ...BenchmarkFixtureBase,
  intent: IntentKindSchema,
  expected: PositiveExpectationSchema,
});
export type PositiveFixture = z.infer<typeof PositiveFixtureSchema>;

export const NegativeFixtureSchema = z.object({
  ...BenchmarkFixtureBase,
  /** Why this is out of scope or not answerable. */
  refusalReason: z
    .enum(["out-of-scope", "stale-only", "no-source", "ambiguous"])
    .default("out-of-scope"),
  expected: NegativeExpectationSchema,
});
export type NegativeFixture = z.infer<typeof NegativeFixtureSchema>;

export const BenchmarkSetSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    positive: z.array(PositiveFixtureSchema).min(1).max(40),
    negative: z.array(NegativeFixtureSchema).min(1).max(20),
  })
  .superRefine((set, ctx) => {
    const allIds: string[] = [
      ...set.positive.map((f) => f.id),
      ...set.negative.map((f) => f.id),
    ];
    const seen = new Set<string>();
    for (const id of allIds) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [],
          message: `duplicate fixture id across positive/negative: "${id}"`,
        });
      }
      seen.add(id);
    }
  });
export type BenchmarkSet = z.infer<typeof BenchmarkSetSchema>;

/** Stage 11 output: just the benchmark set + a generation note. */
export const Stage11OutputSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  set: BenchmarkSetSchema,
  /** What the LLM said about its choices (one paragraph). */
  rationale: z.string().min(10).max(2000),
});
export type Stage11Output = z.infer<typeof Stage11OutputSchema>;

/**
 * Lenient remap for `intent` values the LLM hallucinates around the
 * canonical 7-value enum. Same pattern as `FACT_TYPE_LENIENT_REMAP`:
 * absorb the LLM's naming variance at the parse boundary instead of
 * paying for a schema-validation retry.
 *
 * The case that motivated this entry — `diagnose-error` → `debug` —
 * persisted on the Rust smoke even after `debug` was added to the
 * canonical enum and surfaced in both Stage 1 and Stage 11 prompts.
 * The model has a strong naming prior that the prompt schema alone
 * does not override.
 *
 * Keep this table narrow: only add a mapping if you have seen the
 * exact wrong value in a real run AND there is one obvious correct
 * target. When in doubt, let the schema retry handle it.
 */
export const INTENT_LENIENT_REMAP: Readonly<Record<string, IntentKind>> = {
  "diagnose-error": "debug",
  diagnose: "debug",
  troubleshoot: "debug",
  troubleshooting: "debug",
};

/**
 * Best-effort normalization of raw Stage 11 LLM output BEFORE schema
 * validation. Walks `set.positive[i].intent` and remaps via
 * `INTENT_LENIENT_REMAP`. Other malformed shapes still surface as
 * schema errors so the runner can retry.
 *
 * Non-object input is returned unchanged so the schema parse can
 * produce its normal error.
 */
export function normalizeStage11Output(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const r = raw as Record<string, unknown>;
  const set = r.set;
  if (typeof set !== "object" || set === null || Array.isArray(set)) {
    return raw;
  }
  const setObj = set as Record<string, unknown>;
  if (!Array.isArray(setObj.positive)) return raw;
  const positive = setObj.positive.map((p) => {
    if (typeof p !== "object" || p === null) return p;
    const fixture = { ...(p as Record<string, unknown>) };
    if (typeof fixture.intent === "string") {
      const remapped = INTENT_LENIENT_REMAP[fixture.intent.toLowerCase()];
      if (remapped !== undefined) {
        fixture.intent = remapped;
      }
    }
    return fixture;
  });
  return { ...r, set: { ...setObj, positive } };
}

export function parseStage11Output(raw: unknown): Stage11Output {
  return Stage11OutputSchema.parse(normalizeStage11Output(raw));
}

// ── Stage 12 — run results ───────────────────────────────────────────────────

export const BenchmarkResultStatusSchema = z.enum([
  "pass",
  "fail",
  "errored", // tool dispatch threw or returned malformed result
]);
export type BenchmarkResultStatus = z.infer<typeof BenchmarkResultStatusSchema>;

export const BenchmarkResultSchema = z
  .object({
    fixtureId: z
      .string()
      .max(48)
      .regex(FIXTURE_ID_RE, "must match fixture id format"),
    kind: z.enum(["positive", "negative"]),
    status: BenchmarkResultStatusSchema,
    /** What the runtime returned, summarized for the report. */
    observed: z.object({
      ok: z.boolean(),
      citationsCount: z.number().int().nonnegative(),
      staleness: StalenessSchema.nullable(),
      errorCode: z.string().max(64).nullable(),
    }),
    /** Why the fixture passed or failed (human-readable). */
    reason: z.string().min(1).max(500),
    /** Wall-clock duration of the runtime invocation in milliseconds. */
    durationMs: z.number().int().nonnegative(),
  })
  .superRefine((r, ctx) => {
    // Negative fixtures cannot have citations and pass simultaneously
    if (r.kind === "negative" && r.status === "pass" && r.observed.citationsCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message:
          "negative fixture cannot pass with citations > 0; the maxCitations expectation should have failed it",
      });
    }
  });
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;

export const BenchmarkSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  /** Fraction of positive fixtures whose answer carried ≥1 citation. */
  citationRate: z.number().min(0).max(1),
});
export type BenchmarkSummary = z.infer<typeof BenchmarkSummarySchema>;

export const BenchmarkReportSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    ranAt: z.string().regex(ISO_8601),
    /** The exact set this report was produced from. */
    set: BenchmarkSetSchema,
    results: z.array(BenchmarkResultSchema),
    summary: BenchmarkSummarySchema,
  })
  .superRefine((r, ctx) => {
    // Counts must match
    let passed = 0;
    let failed = 0;
    let errored = 0;
    let positiveCount = 0;
    let positiveCited = 0;
    for (const res of r.results) {
      if (res.status === "pass") passed += 1;
      else if (res.status === "fail") failed += 1;
      else errored += 1;
      if (res.kind === "positive") {
        positiveCount += 1;
        if (res.observed.citationsCount > 0) positiveCited += 1;
      }
    }
    const total = r.results.length;
    const checks: Array<[keyof BenchmarkSummary, number]> = [
      ["total", total],
      ["passed", passed],
      ["failed", failed],
      ["errored", errored],
    ];
    for (const [field, actual] of checks) {
      if (r.summary[field] !== actual) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["summary", field],
          message: `summary.${field} (${r.summary[field]}) !== actual (${actual})`,
        });
      }
    }
    const expectedRate = positiveCount === 0 ? 0 : positiveCited / positiveCount;
    if (Math.abs(r.summary.citationRate - expectedRate) > 1e-6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "citationRate"],
        message: `summary.citationRate (${r.summary.citationRate}) !== expected (${expectedRate})`,
      });
    }
  });
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;

/**
 * Aggregate per-fixture results into a `BenchmarkReport`. Pure helper; the
 * runner uses this to pack its output and tests use it without the runtime.
 */
export function buildBenchmarkReport(input: {
  almanacId: string;
  ranAt: Date;
  set: BenchmarkSet;
  results: BenchmarkResult[];
}): BenchmarkReport {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let positiveCount = 0;
  let positiveCited = 0;
  for (const r of input.results) {
    if (r.status === "pass") passed += 1;
    else if (r.status === "fail") failed += 1;
    else errored += 1;
    if (r.kind === "positive") {
      positiveCount += 1;
      if (r.observed.citationsCount > 0) positiveCited += 1;
    }
  }
  return BenchmarkReportSchema.parse({
    schemaVersion: "0.1.0" as const,
    almanacId: input.almanacId,
    ranAt: input.ranAt.toISOString(),
    set: input.set,
    results: input.results,
    summary: {
      total: input.results.length,
      passed,
      failed,
      errored,
      citationRate: positiveCount === 0 ? 0 : positiveCited / positiveCount,
    },
  });
}

// ── ToolResult — the wire-format every tool returns ──────────────────────────

/**
 * Single citation entry. `fetchedAt` is REQUIRED so the host LLM can reason
 * about staleness; `sourceTimestamp` is the upstream-provided per-record
 * timestamp (when available) and is preferred for "data-as-of" claims.
 */
export const CitationSchema = z.object({
  sourceId: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "must match SourcesFile source id format"),
  url: z.string().url(),
  fetchedAt: z.string().regex(ISO_8601),
  sourceTimestamp: z.string().regex(ISO_8601).optional(),
  excerpt: z.string().min(1).max(500).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

// (StalenessSchema is declared at the top of the file, next to VolatilityClassSchema.)

/** Per-result freshness annotation. */
export const ToolResultFreshnessSchema = z
  .object({
    class: VolatilityClassSchema,
    /** Max age in seconds before staleness=stale. `null` for static. */
    maxAge: z.number().int().nonnegative().nullable(),
    staleness: StalenessSchema,
  })
  .superRefine((f, ctx) => {
    if (f.class === "static") {
      if (f.maxAge !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxAge"],
          message: 'maxAge must be null when class is "static"',
        });
      }
      if (f.staleness !== "fresh") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["staleness"],
          message: 'staleness must be "fresh" when class is "static"',
        });
      }
    }
    if ((f.class === "slow" || f.class === "fast") && f.maxAge === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxAge"],
        message: `maxAge is required when class is "${f.class}"`,
      });
    }
  });
export type ToolResultFreshness = z.infer<typeof ToolResultFreshnessSchema>;

/** Error envelope used in the `ok: false` branch. */
export const ToolErrorSchema = z.object({
  code: z
    .string()
    .max(64)
    .regex(ERROR_CODE, "must be lowercase kebab/snake-case"),
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

/**
 * Build a `ToolResult` zod schema parameterized by the `data` schema.
 * Per-tool tests in Stage 7 use this against their own `Output` schema; the
 * runtime uses `ToolResultSchema` (with `data: z.unknown()`) for cross-tool
 * dispatch validation.
 */
export function toolResultSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data,
      citations: z.array(CitationSchema).min(1).max(20),
      freshness: ToolResultFreshnessSchema,
    }),
    z.object({
      ok: z.literal(false),
      error: ToolErrorSchema,
    }),
  ]);
}

/** Generic `ToolResult` — any `data` shape. */
export const ToolResultSchema = toolResultSchema(z.unknown());

export type ToolResult<T = unknown> =
  | {
      ok: true;
      data: T;
      citations: Citation[];
      freshness: ToolResultFreshness;
    }
  | { ok: false; error: ToolError };

// ── RunToolArtifact — local audit trail for `almanac run --tool` ─────────────

export const RunToolStatusSchema = z.enum([
  "ok",
  "bad-input",
  "tool-not-found",
  "tool-error",
]);
export type RunToolStatus = z.infer<typeof RunToolStatusSchema>;

export const RunToolExitCodeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);
export type RunToolExitCode = z.infer<typeof RunToolExitCodeSchema>;

export const RunToolRunIdSchema = z
  .string()
  .max(80)
  .regex(
    /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/,
    "must be run-<ISO timestamp with - separators>-<8 hex chars>",
  );

export const RunToolArtifactRelPathSchema = z
  .string()
  .max(120)
  .regex(/^\.runs\/run-[A-Za-z0-9-]+\.json$/);

export const RefreshRunIdSchema = z
  .string()
  .max(84)
  .regex(
    /^refresh-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/,
    "must be refresh-<ISO timestamp with - separators>-<8 hex chars>",
  );

export const RefreshArtifactRelPathSchema = z
  .string()
  .max(124)
  .regex(/^\.runs\/refresh-[A-Za-z0-9-]+\.json$/);

export const AnswerRunIdSchema = z
  .string()
  .max(83)
  .regex(
    /^answer-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/,
    "must be answer-<ISO timestamp with - separators>-<8 hex chars>",
  );

export const AnswerArtifactRelPathSchema = z
  .string()
  .max(123)
  .regex(/^\.runs\/answer-[A-Za-z0-9-]+\.json$/);

export const RunArtifactIdSchema = z.union([
  RunToolRunIdSchema,
  RefreshRunIdSchema,
  AnswerRunIdSchema,
]);

export const RunArtifactKindSchema = z.enum(["tool", "refresh", "answer"]);
export type RunArtifactKind = z.infer<typeof RunArtifactKindSchema>;

export const RunToolArtifactLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80);

export const RunToolArtifactNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000);

export const RunToolArtifactSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  kind: z.literal("tool").default("tool"),
  artifactRelPath: RunToolArtifactRelPathSchema,
  runId: RunToolRunIdSchema,
  invokedAt: z.string().regex(ISO_8601),
  almanacId: z
    .string()
    .max(32)
    .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
  version: z.string().regex(SEMVER_RE, "must be semver"),
  toolName: ToolNameSchema,
  input: z.record(z.unknown()).nullable(),
  label: RunToolArtifactLabelSchema.optional(),
  note: RunToolArtifactNoteSchema.optional(),
  status: RunToolStatusSchema,
  exitCode: RunToolExitCodeSchema,
  result: ToolResultSchema,
  durationMs: z.number().int().nonnegative(),
  citationsCount: z.number().int().nonnegative(),
  availableTools: z.array(ToolNameSchema).optional(),
});
export type RunToolArtifact = z.infer<typeof RunToolArtifactSchema>;

export const RefreshArtifactStatusSchema = z.enum([
  "ok",
  "failed",
  "not-due",
  "locked",
]);
export type RefreshArtifactStatus = z.infer<typeof RefreshArtifactStatusSchema>;

export const AnswerArtifactStatusSchema = z.enum([
  "ok",
  "abstained",
  "tool-error",
  "tool-not-found",
  "bad-tool-input",
  "budget-exhausted",
  "model-error",
]);
export type AnswerArtifactStatus = z.infer<typeof AnswerArtifactStatusSchema>;

export const RunArtifactStatusSchema = z.union([
  RunToolStatusSchema,
  RefreshArtifactStatusSchema,
  AnswerArtifactStatusSchema,
]);
export type RunArtifactStatus = z.infer<typeof RunArtifactStatusSchema>;

export const RefreshArtifactSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    kind: z.literal("refresh"),
    artifactRelPath: RefreshArtifactRelPathSchema,
    refreshId: RefreshRunIdSchema,
    startedAt: z.string().regex(ISO_8601),
    finishedAt: z.string().regex(ISO_8601),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    version: z.string().regex(SEMVER_RE, "must be semver"),
    label: RunToolArtifactLabelSchema.optional(),
    note: RunToolArtifactNoteSchema.optional(),
    status: RefreshArtifactStatusSchema,
    exitCode: RunToolExitCodeSchema,
    requestedFromStage: StageIdSchema,
    effectiveFromStage: StageIdSchema,
    dueDecision: z
      .object({
        due: z.boolean(),
        recommendedFromStage: StageIdSchema,
        reasonCodes: z.array(z.string().min(1).max(80)).max(40),
      })
      .passthrough(),
    stageSummary: z
      .object({
        succeeded: z.array(StageIdSchema),
        skipped: z.array(StageIdSchema),
        failed: z.array(StageIdSchema),
      })
      .optional(),
    benchmark: z
      .object({
        status: z.enum(["missing", "passed", "failed"]),
        total: z.number().int().nonnegative().optional(),
        passed: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        errored: z.number().int().nonnegative().optional(),
        citationRate: z.number().min(0).max(1).optional(),
      })
      .optional(),
    durationMs: z.number().int().nonnegative(),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(2000),
      })
      .optional(),
  })
  .superRefine((artifact, ctx) => {
    if (Date.parse(artifact.finishedAt) < Date.parse(artifact.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt must be >= startedAt",
      });
    }
  });
export type RefreshArtifact = z.infer<typeof RefreshArtifactSchema>;

export const AnswerToolCallStatusSchema = z.enum([
  "ok",
  "tool-error",
  "tool-not-found",
  "bad-tool-input",
]);
export type AnswerToolCallStatus = z.infer<typeof AnswerToolCallStatusSchema>;

export const AnswerToolCallSummarySchema = z.object({
  toolName: ToolNameSchema,
  input: z.record(z.unknown()).nullable(),
  status: AnswerToolCallStatusSchema,
  durationMs: z.number().int().nonnegative(),
  citationsCount: z.number().int().nonnegative(),
  error: ToolErrorSchema.optional(),
});
export type AnswerToolCallSummary = z.infer<
  typeof AnswerToolCallSummarySchema
>;

export const AnswerTracePlannerStepSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  plannerCall: z.number().int().nonnegative(),
  action: z.enum(["call_tool", "stop", "error"]),
  outcome: z.enum([
    "executed",
    "failed",
    "stopped",
    "budget-exhausted",
    "model-error",
  ]),
  toolName: ToolNameSchema.optional(),
  input: z.record(z.unknown()).nullable().optional(),
  stopReason: z.string().min(1).max(500).optional(),
  error: ToolErrorSchema.optional(),
});
export type AnswerTracePlannerStep = z.infer<
  typeof AnswerTracePlannerStepSchema
>;

export const AnswerTraceToolObservationSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  toolName: ToolNameSchema,
  input: z.record(z.unknown()).nullable(),
  status: AnswerToolCallStatusSchema,
  durationMs: z.number().int().nonnegative(),
  citationsCount: z.number().int().nonnegative(),
  freshness: ToolResultFreshnessSchema.optional(),
  errorCode: z.string().min(1).max(80).optional(),
});
export type AnswerTraceToolObservation = z.infer<
  typeof AnswerTraceToolObservationSchema
>;

export const AnswerTraceCitationLedgerEntrySchema = z.object({
  citationKey: z.string().min(1).max(2048),
  sourceId: z
    .string()
    .max(64)
    .regex(SOURCE_ID, "must match SourcesFile source id format"),
  url: z.string().url(),
  fetchedAt: z.string().regex(ISO_8601),
  sourceTimestamp: z.string().regex(ISO_8601).optional(),
  observedInCallIndexes: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(20),
  usedInAnswer: z.boolean(),
  stale: z.boolean(),
  freshness: ToolResultFreshnessSchema.optional(),
});
export type AnswerTraceCitationLedgerEntry = z.infer<
  typeof AnswerTraceCitationLedgerEntrySchema
>;

export const AnswerTraceQualitySchema = z.object({
  status: z.enum(["pass", "fail"]),
  citationRate: z.number().min(0).max(1),
  unsupportedClaimCount: z.number().int().nonnegative(),
  staleCitationCount: z.number().int().nonnegative(),
  abstention: z.object({
    expected: z.boolean(),
    actual: z.boolean(),
    matches: z.boolean(),
    expectedReason: z.string().min(1).max(2000).optional(),
    actualReason: z.string().min(1).max(2000).optional(),
  }),
  reasons: z.array(z.string().min(1).max(500)).max(20),
});
export type AnswerTraceQuality = z.infer<typeof AnswerTraceQualitySchema>;

export const AnswerTraceSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  planner: z.object({
    promptVersion: z.string().min(1).max(80),
    model: z.string().min(1).max(120),
    calls: z.number().int().nonnegative(),
    stopReason: z
      .enum(["planner-stop", "max-tool-calls", "max-duration", "model-error"]),
    maxToolCalls: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    steps: z.array(AnswerTracePlannerStepSchema).max(40),
  }),
  tools: z.object({
    observations: z.array(AnswerTraceToolObservationSchema).max(20),
  }),
  citations: z.object({
    observed: z.array(AnswerTraceCitationLedgerEntrySchema).max(100),
    usedCount: z.number().int().nonnegative(),
    staleCount: z.number().int().nonnegative(),
  }),
  synthesis: z.object({
    promptVersion: z.string().min(1).max(80),
    model: z.string().min(1).max(120),
    calls: z.number().int().nonnegative(),
    status: AnswerArtifactStatusSchema,
  }),
  abstain: z
    .object({
      status: AnswerArtifactStatusSchema,
      reason: z.string().min(1).max(2000),
      stage: z.enum(["planner", "tool", "evidence", "synthesis", "citation-gate"]),
    })
    .optional(),
  quality: AnswerTraceQualitySchema.optional(),
});
export type AnswerTrace = z.infer<typeof AnswerTraceSchema>;

export const AnswerArtifactSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    kind: z.literal("answer"),
    artifactRelPath: AnswerArtifactRelPathSchema,
    answerId: AnswerRunIdSchema,
    startedAt: z.string().regex(ISO_8601),
    finishedAt: z.string().regex(ISO_8601),
    almanacId: z
      .string()
      .max(32)
      .regex(CANONICAL_SLUG, "must be lowercase kebab-case"),
    version: z.string().regex(SEMVER_RE, "must be semver"),
    forgerVersion: z.string().min(1).max(40),
    question: z.string().trim().min(1).max(4000),
    label: RunToolArtifactLabelSchema.optional(),
    note: RunToolArtifactNoteSchema.optional(),
    status: AnswerArtifactStatusSchema,
    exitCode: RunToolExitCodeSchema,
    model: z.string().min(1).max(120).optional(),
    promptVersions: z
      .object({
        planner: z.string().min(1).max(80).optional(),
        synthesis: z.string().min(1).max(80).optional(),
      })
      .optional(),
    answer: z.string().min(1).max(12000).optional(),
    abstentionReason: z.string().min(1).max(2000).optional(),
    toolCalls: z.array(AnswerToolCallSummarySchema).max(20),
    citations: z.array(CitationSchema).max(20),
    freshness: ToolResultFreshnessSchema.optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    trace: AnswerTraceSchema.optional(),
    durationMs: z.number().int().nonnegative(),
    error: ToolErrorSchema.optional(),
  })
  .superRefine((artifact, ctx) => {
    if (Date.parse(artifact.finishedAt) < Date.parse(artifact.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt must be >= startedAt",
      });
    }
    if (artifact.status === "ok") {
      if (artifact.answer === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answer"],
          message: "answer is required when status is ok",
        });
      }
      if (artifact.citations.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations"],
          message: "at least one citation is required when status is ok",
        });
      }
    }
    if (
      artifact.status === "abstained" &&
      artifact.abstentionReason === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abstentionReason"],
        message: "abstentionReason is required when status is abstained",
      });
    }
    if (
      artifact.status !== "ok" &&
      artifact.status !== "abstained" &&
      artifact.error === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "error is required for failed answer artifacts",
      });
    }
  });
export type AnswerArtifact = z.infer<typeof AnswerArtifactSchema>;

export const RunArtifactEnvelopeSchema = z.union([
  RunToolArtifactSchema,
  RefreshArtifactSchema,
  AnswerArtifactSchema,
]);
export type RunArtifactEnvelope = z.infer<typeof RunArtifactEnvelopeSchema>;

// ── ResourceDescriptor — MCP resources/list, resources/read ──────────────────

/**
 * URI scheme: `almanac://<almanacId>/<path>`. The runtime resolves these to
 * files inside the compiled almanac directory.
 */
export const ResourceUriSchema = z
  .string()
  .regex(
    /^almanac:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[A-Za-z0-9._/-]+$/,
    "must be 'almanac://<almanacId>/<path>'",
  );

export const ResourceDescriptorSchema = z.object({
  uri: ResourceUriSchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500).optional(),
  mimeType: z.string().min(3).max(120),
  /** Size in bytes when known. */
  size: z.number().int().nonnegative().optional(),
});
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;
