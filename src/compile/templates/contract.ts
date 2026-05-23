/**
 * Stage 9 — DOMAIN.md / AGENTS.md / SKILLS.md renderers.
 *
 * Pure functions: input → string. No fs, no network, no LLM.
 *
 * - `renderDomainMd`  : DOMAIN.md (uses Stage09Narrative for marked slots)
 * - `renderAgentsMd`  : AGENTS.md (deterministic + Stage09Narrative.toolSelectionGuidance)
 * - `renderSkillsMd`  : SKILLS.md (100% deterministic from ToolManifest[])
 *
 * The renderers do not validate inputs; the caller (s09 orchestrator) supplies
 * pre-validated artifacts and an enabled-tools-only manifest list.
 */

import type {
  DomainSpec,
  Stage09Narrative,
  ToolManifest,
  VolatilityClass,
} from "../../core/types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────────

const VOLATILITY_LABEL: Record<VolatilityClass, string> = {
  static: "static (timeless)",
  slow: "slow (refresh every ~30 days)",
  fast: "fast (refresh every ~24 hours)",
  live: "live (never cached)",
};

const VOLATILITY_BADGE: Record<VolatilityClass, string> = {
  static: "🟢 static",
  slow: "🟡 slow",
  fast: "🟠 fast",
  live: "🔴 live",
};

/** Render a YAML-style frontmatter block. Values are rendered as-is. */
function frontmatter(entries: Array<[string, string | number | boolean]>): string {
  const body = entries.map(([k, v]) => `${k}: ${formatYamlValue(v)}`).join("\n");
  return `---\n${body}\n---\n`;
}

function formatYamlValue(v: string | number | boolean): string {
  if (typeof v === "string") {
    // Always quote strings — avoids YAML auto-parsing values like ISO
    // timestamps (contain `:`) as datetimes, slugs as numbers, etc.
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return String(v);
}

function bullets(items: readonly string[]): string {
  return items.map((s) => `- ${s}`).join("\n");
}

function fenced(lang: string, body: string): string {
  return "```" + lang + "\n" + body + "\n```";
}

// ──────────────────────────────────────────────────────────────────────────────
// SKILLS.md
// ──────────────────────────────────────────────────────────────────────────────

export interface RenderSkillsMdInput {
  almanacId: string;
  displayName: string;
  /** All tool manifests in the order they should appear. Caller filters out disabled. */
  manifests: ToolManifest[];
}

/** Render the deterministic tools catalog. */
export function renderSkillsMd(input: RenderSkillsMdInput): string {
  const head =
    `# ${input.displayName} — Tools Catalog\n\n` +
    `This catalog is auto-generated from \`tools/*.json\`. ` +
    `Do not edit by hand; re-compile with \`almanac update ${input.almanacId}\` instead.\n`;

  if (input.manifests.length === 0) {
    return head + "\n_No enabled tools in this almanac._\n";
  }

  const sections = input.manifests.map((m) => renderToolSection(m));
  return head + "\n" + sections.join("\n---\n\n") + "\n";
}

function renderToolSection(m: ToolManifest): string {
  const lines: string[] = [];
  lines.push(`## \`${m.name}\` ${VOLATILITY_BADGE[m.volatilityClass]}`);
  lines.push("");
  lines.push(m.description);
  lines.push("");
  lines.push("**When to use:** " + m.whenToUse);
  lines.push("");
  lines.push("**Returns:** " + m.returnsSummary);
  lines.push("");
  lines.push("**Input schema:**");
  lines.push(fenced("json", JSON.stringify(m.inputSchema, null, 2)));
  lines.push("");
  lines.push("**Capabilities:**");
  lines.push(
    bullets([
      `network: ${m.capabilities.network.length === 0 ? "_none_" : m.capabilities.network.map((h) => `\`${h}\``).join(", ")}`,
      `fs: \`${m.capabilities.fs}\``,
      `subprocess: ${m.capabilities.subprocess.length === 0 ? "_none_" : m.capabilities.subprocess.map((s) => `\`${s}\``).join(", ")}`,
      `secrets: ${m.capabilities.secrets.length === 0 ? "_none_" : m.capabilities.secrets.map((s) => `\`${s}\``).join(", ")}`,
    ]),
  );
  lines.push("");
  lines.push("**Freshness:**");
  lines.push(
    bullets([
      `class: \`${m.volatilityClass}\``,
      `cachePolicy: \`${m.freshness.cachePolicy}\``,
      `ttlSeconds: ${m.freshness.ttlSeconds === null ? "_n/a_" : `\`${m.freshness.ttlSeconds}\``}`,
      `sourceTimestamp: \`${m.freshness.sourceTimestamp}\``,
    ]),
  );
  lines.push("");
  if (m.examples.length > 0) {
    lines.push("**Example:**");
    const ex = m.examples[0]!;
    lines.push(`> ${ex.description}`);
    lines.push(fenced("json", JSON.stringify(ex.input, null, 2)));
  }
  lines.push("");
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// DOMAIN.md
// ──────────────────────────────────────────────────────────────────────────────

export interface RenderDomainMdInput {
  domainSpec: DomainSpec;
  narrative: Stage09Narrative;
  manifests: ToolManifest[];
  compiledAt: Date;
}

export function renderDomainMd(input: RenderDomainMdInput): string {
  const { domainSpec: ds, narrative: nx, manifests, compiledAt } = input;

  const fm = frontmatter([
    ["schemaVersion", "0.1.0"],
    ["almanacId", ds.canonicalSlug],
    ["domain", ds.domain],
    ["displayName", ds.displayName],
    ["freshnessProfile", ds.freshnessProfile.profileId],
    ["defaultVolatilityClass", ds.freshnessProfile.defaultClass],
    ["toolCount", manifests.length],
    ["compiledAt", compiledAt.toISOString()],
  ]);

  const parts: string[] = [];
  parts.push(fm);
  parts.push(`# ${ds.displayName} Almanac`);
  parts.push("");
  parts.push(nx.domainOneLiner);
  parts.push("");
  parts.push("## Scope");
  parts.push("");
  parts.push("**Covers:**");
  parts.push(bullets(nx.scope.covers));
  parts.push("");
  parts.push("**Out of scope:**");
  parts.push(bullets(nx.scope.outOfScope));
  parts.push("");
  parts.push("## Freshness Policy");
  parts.push("");
  parts.push(renderFreshnessTable(ds));
  parts.push("");
  parts.push("## Source Citation Rule");
  parts.push("");
  parts.push(
    "Every answer derived from this almanac MUST cite at least one source. " +
      "Tools return a `citations[]` array with `sourceId`, `url`, and " +
      "`fetchedAt` for each fact. If no source can be cited, refuse to answer.",
  );
  parts.push("");
  parts.push("## Tools");
  parts.push("");
  parts.push(
    `${manifests.length} tool${manifests.length === 1 ? "" : "s"} are exposed via MCP. ` +
      `See [SKILLS.md](./SKILLS.md) for the full catalog.`,
  );
  parts.push("");
  parts.push(renderToolsSummary(manifests));
  parts.push("");
  parts.push("## Cautions");
  parts.push("");
  if (ds.cautions.length === 0) {
    parts.push("_No domain-specific cautions._");
  } else {
    parts.push(
      bullets(ds.cautions.map((c) => `**${c.area}**: ${c.rationale}`)),
    );
  }
  parts.push("");
  return parts.join("\n");
}

function renderFreshnessTable(ds: DomainSpec): string {
  const rows: string[] = [
    "| Class | Policy | Examples |",
    "|-------|--------|----------|",
  ];
  const fp = ds.freshnessProfile;
  const orderedClasses: VolatilityClass[] = ["static", "slow", "fast", "live"];
  for (const klass of orderedClasses) {
    const cls = fp.classes[klass];
    const examples =
      cls.examples.length === 0
        ? "_n/a for this domain_"
        : cls.examples.map((e) => `\`${e}\``).join(", ");
    rows.push(`| ${klass} | ${VOLATILITY_LABEL[klass]} | ${examples} |`);
  }
  rows.push("");
  rows.push(`**Default class for this domain:** \`${fp.defaultClass}\``);
  return rows.join("\n");
}

function renderToolsSummary(manifests: readonly ToolManifest[]): string {
  if (manifests.length === 0) return "_No enabled tools._";
  const rows: string[] = [
    "| Tool | Class | Description |",
    "|------|-------|-------------|",
  ];
  for (const m of manifests) {
    rows.push(
      `| \`${m.name}\` | ${VOLATILITY_BADGE[m.volatilityClass]} | ${m.description} |`,
    );
  }
  return rows.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// AGENTS.md
// ──────────────────────────────────────────────────────────────────────────────

export interface RenderAgentsMdInput {
  domainSpec: DomainSpec;
  narrative: Stage09Narrative;
  manifests: ToolManifest[];
}

export function renderAgentsMd(input: RenderAgentsMdInput): string {
  const { domainSpec: ds, narrative: nx, manifests } = input;

  const parts: string[] = [];
  parts.push(`# AGENTS.md — ${ds.displayName} Almanac`);
  parts.push("");
  parts.push(
    "Operating contract for host LLMs (Claude, Cursor, …) consuming this " +
      "almanac. Loaded automatically when the almanac is registered.",
  );
  parts.push("");
  parts.push("## Mission");
  parts.push("");
  parts.push(
    `Serve as a freshness-aware retrieval and tools layer for the **${ds.displayName}** ` +
      `domain (${ds.domain}). ${ds.summary}`,
  );
  parts.push("");
  parts.push("## Non-Negotiables");
  parts.push("");
  parts.push(
    bullets([
      "**Cite or abstain.** Every claim derived from this almanac must include at least one citation. If no source can be cited, refuse the answer rather than fabricate.",
      "**Respect freshness class.** Treat `static` as durable, `slow` as 30-day-fresh, `fast` as 24-hour-fresh, `live` as point-in-time. Never present `stale` data without flagging it.",
      "**Surface staleness.** When a tool returns `freshness.staleness === \"stale\"`, prepend the answer with a one-line warning naming the source's `fetchedAt`.",
      "**Refuse outdated answers.** If the user asks for current data and the only available source is `stale`, refuse and suggest re-running `almanac update`.",
      `**Stay in scope.** This almanac covers \`${ds.canonicalSlug}\` only. For unrelated domains, decline and direct the user to the appropriate almanac.`,
    ]),
  );
  parts.push("");
  parts.push("## Tool Selection Guidance");
  parts.push("");
  parts.push(nx.toolSelectionGuidance);
  parts.push("");
  parts.push("## Retrieval Discipline");
  parts.push("");
  parts.push(
    bullets([
      "**Classify volatility first.** Determine whether the user's question is `static`/`slow` (cached facts) or `fast`/`live` (live retrieval) before picking a tool.",
      "**Route accordingly.** Use `query_facts` for cached static/slow; use the live tools (`fetch_official_docs`, `web_search_recent`, `latest_releases`, and any custom live tools) for fast/live.",
      "**Combine when needed.** A complete answer may require both: e.g., a static definition (`query_facts`) plus a current example (live tool).",
    ]),
  );
  parts.push("");
  parts.push("## Output Discipline");
  parts.push("");
  parts.push(
    bullets([
      "Do not invent `##` section headers; the user asked a question — answer it.",
      "Cite inline using the `url` field of each citation; group multiple citations for the same fact when natural.",
      "Be focused and brief; the host LLM provides reasoning, not narration.",
    ]),
  );
  parts.push("");
  parts.push("## When to Refuse");
  parts.push("");
  parts.push(
    bullets([
      "The question is out of scope for this almanac.",
      "No tool returns a citable result and the user requires a sourced answer.",
      "All available sources are stale and the user asked for current data.",
    ]),
  );
  parts.push("");
  parts.push("## Failure Modes to Surface");
  parts.push("");
  parts.push(
    bullets([
      "A live tool returned `ok: false` (e.g., `upstream-timeout`) — name the failure, do not silently fall back to stale cached facts.",
      "A `slow` fact's `validUntil` has passed but no fresh fact exists — present the stale answer with the staleness warning, OR refuse if the user requires currency.",
      "A `static` fact contradicts a `live` tool result — surface the conflict explicitly; do not silently prefer one.",
    ]),
  );
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(
    `_${manifests.length} tool${manifests.length === 1 ? "" : "s"} available._ ` +
      "See [SKILLS.md](./SKILLS.md) for the catalog and [DOMAIN.md](./DOMAIN.md) for the domain definition.",
  );
  parts.push("");
  return parts.join("\n");
}
