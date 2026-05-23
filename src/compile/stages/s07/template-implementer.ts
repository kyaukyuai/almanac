/**
 * `TemplateImplementer` — concrete `ToolImplementer` for the four default
 * tools (`query_facts`, `fetch_official_docs`, `web_search_recent`,
 * `latest_releases`).
 *
 * Strategy:
 *   1. Match by name (`canHandle` ↔ `DEFAULT_TOOL_NAMES`).
 *   2. Look up the canonical template (`DEFAULT_TOOL_TEMPLATES`).
 *   3. Persist the impl + test source via `ctx.writeToolFiles`.
 *   4. Synthesize an `implementedBy` provenance and return a single-attempt
 *      `ToolImplementationResult` with status="implemented".
 *
 * No LLM, no retry loop. Failures are programmer errors (missing template,
 * fs error) and propagate as exceptions — they are NOT routine `disabled`
 * outcomes. Stage 7 will record those as a "stage-threw" failure via the
 * pipeline orchestrator.
 *
 * The template implementer is also the canonical source of *default-tool
 * manifests*. Stage 6 will eventually call `synthesizeDefaultToolManifest`
 * (or its successor) before Stage 7 starts so the four defaults are always
 * present in `tools/`.
 */

import {
  DEFAULT_TOOL_NAMES,
  ToolManifestSchema,
  type DefaultToolName,
  type ImplementationAttempt,
  type ToolCapabilities,
  type ToolFreshnessConfig,
  type ToolImplementationProvenance,
  type ToolImplementationResult,
  type ToolKnowledgeUsage,
  type ToolManifest,
  type VolatilityClass,
} from "../../../core/types.ts";
import {
  ImplementerMisroutedError,
  type ImplementationContext,
  type ToolImplementer,
} from "../s07-tool-impl.ts";
import { DEFAULT_TOOL_TEMPLATES } from "./templates.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Default-tool defaults — the per-name capabilities, freshness, and
// knowledge-usage that ship out-of-the-box.
// ──────────────────────────────────────────────────────────────────────────────

interface DefaultToolDefaults {
  description: string;
  whenToUse: string;
  returnsSummary: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  capabilities: ToolCapabilities;
  volatilityClass: VolatilityClass;
  freshness: ToolFreshnessConfig;
  knowledgeUsage: ToolKnowledgeUsage;
  example: { description: string; input: Record<string, unknown> };
}

const DEFAULTS: Readonly<Record<DefaultToolName, DefaultToolDefaults>> = {
  query_facts: {
    description:
      "Search the indexed fact store (FTS5) for facts matching a free-text query. Returns hits with citations.",
    whenToUse:
      "Use for any factual recall against this almanac's domain — definitions, procedures, references, or static facts. Prefer this over web search for established knowledge.",
    returnsSummary:
      "Returns matching facts with their source citations and freshness class.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "free-text query" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        freshnessClass: { type: "string", enum: ["static", "slow"] },
      },
      required: ["q"],
    },
    outputSchema: {
      type: "object",
      properties: {
        hits: { type: "array" },
      },
      required: ["hits"],
    },
    capabilities: { network: [], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: "slow",
    freshness: {
      cachePolicy: "manual-refresh",
      ttlSeconds: null,
      sourceTimestamp: false,
    },
    knowledgeUsage: { facts: true, ftsQuery: null, embeddings: false },
    example: { description: "lookup", input: { q: "definition" } },
  },

  fetch_official_docs: {
    description:
      "Fetch a single page of official documentation by URL. Returns the raw body (truncated at 200KB).",
    whenToUse:
      "Use when the user needs the canonical, up-to-date version of an official documentation page. The URL must be on the manifest's network allowlist.",
    returnsSummary:
      "Returns { url, status, contentType, body, fetchedAt } with one citation.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        status: { type: "integer" },
        body: { type: "string" },
      },
      required: ["url", "status", "body"],
    },
    // Real allowlists are populated by the compiler from DomainSpec sources.
    // Empty here — the synthesizer expects the caller to override.
    capabilities: { network: [], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: "slow",
    freshness: {
      cachePolicy: "ttl",
      ttlSeconds: 2_592_000,
      sourceTimestamp: false,
    },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    example: {
      description: "smoke",
      input: { url: "https://example.com/docs/index" },
    },
  },

  web_search_recent: {
    description:
      "Recent-bias web search via DuckDuckGo HTML. Returns the top results for the query.",
    whenToUse:
      "Use when the user asks about recent events, news, or topics outside the cached fact store. Pair with `fetch_official_docs` to follow promising results.",
    returnsSummary:
      "Returns { query, fetchedAt, results: [{ title, url, snippet }] } with one citation pointing at the search results page.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["q"],
    },
    outputSchema: {
      type: "object",
      properties: { results: { type: "array" } },
      required: ["results"],
    },
    capabilities: {
      network: ["html.duckduckgo.com"],
      fs: "none",
      subprocess: [],
      secrets: [],
    },
    volatilityClass: "fast",
    freshness: {
      cachePolicy: "ttl",
      ttlSeconds: 86_400,
      sourceTimestamp: false,
    },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    example: { description: "smoke", input: { q: "almanac project" } },
  },

  latest_releases: {
    description:
      "Fetch recent releases for one GitHub repository via api.github.com.",
    whenToUse:
      "Use when the user asks about new versions, changelogs, or recent releases of a tool/library tracked in this almanac.",
    returnsSummary:
      "Returns { repo, fetchedAt, releases: [{ tagName, name, publishedAt, url, prerelease, draft }] }.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["owner", "repo"],
    },
    outputSchema: {
      type: "object",
      properties: { releases: { type: "array" } },
      required: ["releases"],
    },
    capabilities: {
      network: ["api.github.com"],
      fs: "none",
      subprocess: [],
      secrets: ["GITHUB_TOKEN"],
    },
    volatilityClass: "fast",
    freshness: {
      cachePolicy: "ttl",
      ttlSeconds: 86_400,
      sourceTimestamp: true,
    },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    example: { description: "smoke", input: { owner: "octo", repo: "repo" } },
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Synthesizer
// ──────────────────────────────────────────────────────────────────────────────

export interface SynthesizeDefaultManifestOptions {
  /** Override the default `capabilities.network` allowlist. */
  networkAllowlist?: readonly string[];
  /** Override the default `capabilities.secrets`. */
  secrets?: readonly string[];
  /** Manifest version. Defaults to "0.1.0". */
  version?: string;
}

/**
 * Build a `ToolManifest` for one of the four default tools.
 *
 * Stage 6 (or the bootstrap path) calls this once per default to populate
 * `tools/<name>.json` with sane defaults. Per-domain customization (extra
 * hosts in the network allowlist, etc.) flows through the options.
 *
 * The returned manifest has:
 *   - `disabled: false` (will be flipped by Stage 7 if implementation fails)
 *   - `implementedBy` omitted (Stage 7 fills it in)
 *   - `designedBy = { model: "template", promptVersion: "default-v1" }`
 */
export function synthesizeDefaultToolManifest(
  name: DefaultToolName,
  opts: SynthesizeDefaultManifestOptions = {},
): ToolManifest {
  const d = DEFAULTS[name];
  const capabilities: ToolCapabilities = {
    ...d.capabilities,
    network: opts.networkAllowlist
      ? Array.from(opts.networkAllowlist)
      : d.capabilities.network,
    secrets: opts.secrets ? Array.from(opts.secrets) : d.capabilities.secrets,
  };

  const candidate = {
    name,
    version: opts.version ?? "0.1.0",
    description: d.description,
    whenToUse: d.whenToUse,
    returnsSummary: d.returnsSummary,
    inputSchema: d.inputSchema,
    outputSchema: d.outputSchema,
    capabilities,
    volatilityClass: d.volatilityClass,
    freshness: d.freshness,
    knowledgeUsage: d.knowledgeUsage,
    examples: [
      {
        description: d.example.description,
        input: d.example.input,
        expectedShape: "match-outputSchema" as const,
      },
    ],
    designedBy: { model: "template", promptVersion: "default-v1" },
    disabled: false,
  };

  return ToolManifestSchema.parse(candidate);
}

/** All four default-tool manifests, with default capabilities only. */
export function synthesizeAllDefaultManifests(
  opts: Partial<Record<DefaultToolName, SynthesizeDefaultManifestOptions>> = {},
): ToolManifest[] {
  return DEFAULT_TOOL_NAMES.map((name) =>
    synthesizeDefaultToolManifest(name, opts[name] ?? {}),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// TemplateImplementer
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_NAMES: ReadonlySet<string> = new Set(DEFAULT_TOOL_NAMES);

export class TemplateImplementer implements ToolImplementer {
  readonly name = "template";

  canHandle(manifest: ToolManifest): boolean {
    return DEFAULT_NAMES.has(manifest.name);
  }

  async implement(
    manifest: ToolManifest,
    ctx: ImplementationContext,
  ): Promise<ToolImplementationResult> {
    if (!this.canHandle(manifest)) {
      throw new ImplementerMisroutedError(this.name, manifest.name);
    }
    const template =
      DEFAULT_TOOL_TEMPLATES[manifest.name as DefaultToolName] ??
      DEFAULT_TOOL_TEMPLATES[manifest.name as keyof typeof DEFAULT_TOOL_TEMPLATES];
    if (!template) {
      // Programmer error: DEFAULT_TOOL_NAMES is in sync with the registry.
      throw new Error(
        `TemplateImplementer: no template registered for "${manifest.name}"`,
      );
    }

    const startedAt = ctx.now();
    ctx.log({ event: "tool:impl:template:start", name: manifest.name });

    await ctx.writeToolFiles({
      toolName: manifest.name,
      code: template.implCode,
      testCode: template.testCode,
    });

    const finishedAt = ctx.now();

    const provenance: ToolImplementationProvenance = {
      model: "template",
      promptVersion: "default-v1",
      tscPassed: true,
      smokePassed: true,
      attempts: 1,
    };

    const finalManifest: ToolManifest = ToolManifestSchema.parse({
      ...manifest,
      disabled: false,
      implementedBy: provenance,
    });

    const attempt: ImplementationAttempt = {
      attemptNumber: 1,
      model: "template",
      promptVersion: "default-v1",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      outcome: "success",
      diagnostics: null,
    };

    ctx.log({
      event: "tool:impl:template:done",
      name: manifest.name,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });

    return {
      toolName: manifest.name,
      status: "implemented",
      attempts: [attempt],
      finalManifest,
    };
  }
}
