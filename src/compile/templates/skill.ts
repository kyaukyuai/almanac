/**
 * Stage 10 — SKILL.md renderer.
 *
 * Pure: input → string. Builds the YAML frontmatter and concatenates the
 * three contract files (DOMAIN.md / AGENTS.md / SKILLS.md) into one document
 * that Claude Code reads at skill registration time.
 *
 * Frontmatter modeled on `last30days-skill`:
 *
 *   ---
 *   name: almanac-cooking
 *   version: "0.1.0"
 *   description: "Cooking domain almanac. ..."
 *   allowed-tools:
 *     - mcp__almanac-cooking__query_facts
 *     - mcp__almanac-cooking__ingredient_substitute
 *   metadata:
 *     almanac:
 *       domain: cooking
 *       freshnessProfile: static-heavy
 *       toolCount: 2
 *       factCount: 1234
 *       compiledAt: "2026-05-08T12:00:00.000Z"
 *   ---
 *
 *   # almanac-cooking
 *
 *   <DOMAIN.md body>
 *
 *   ---
 *
 *   <AGENTS.md body>
 *
 *   ---
 *
 *   <SKILLS.md body>
 */

import type { SkillFrontmatter } from "../../core/types.ts";

export interface RenderSkillMdInput {
  frontmatter: SkillFrontmatter;
  /** The DOMAIN.md contents (already rendered by Stage 9). */
  domainMd: string;
  agentsMd: string;
  skillsMd: string;
}

export function renderSkillMd(input: RenderSkillMdInput): string {
  const fm = renderFrontmatter(input.frontmatter);
  const body = [
    `# ${input.frontmatter.name}`,
    "",
    input.frontmatter.description,
    "",
    "---",
    "",
    stripFirstFrontmatter(input.domainMd).trim(),
    "",
    "---",
    "",
    input.agentsMd.trim(),
    "",
    "---",
    "",
    input.skillsMd.trim(),
    "",
  ].join("\n");
  return fm + "\n" + body;
}

/**
 * Build the qualified MCP tool name expected in `allowed-tools`:
 * `mcp__almanac-<almanacId>__<toolName>`.
 */
export function toMcpQualifiedToolName(
  almanacId: string,
  toolName: string,
): string {
  return `mcp__almanac-${almanacId}__${toolName}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal — frontmatter rendering
// ──────────────────────────────────────────────────────────────────────────────

function renderFrontmatter(fm: SkillFrontmatter): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${quote(fm.name)}`);
  lines.push(`version: ${quote(fm.version)}`);
  lines.push(`description: ${quote(fm.description)}`);
  if (fm.allowedTools.length === 0) {
    lines.push("allowed-tools: []");
  } else {
    lines.push("allowed-tools:");
    for (const t of fm.allowedTools) lines.push(`  - ${t}`);
  }
  lines.push("metadata:");
  lines.push("  almanac:");
  lines.push(`    domain: ${quote(fm.metadata.almanac.domain)}`);
  lines.push(`    freshnessProfile: ${quote(fm.metadata.almanac.freshnessProfileId)}`);
  lines.push(`    toolCount: ${fm.metadata.almanac.toolCount}`);
  lines.push(`    factCount: ${fm.metadata.almanac.factCount}`);
  lines.push(`    compiledAt: ${quote(fm.metadata.almanac.compiledAt)}`);
  lines.push("---");
  return lines.join("\n");
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * DOMAIN.md begins with its own `---` frontmatter; strip it so SKILL.md only
 * has one frontmatter block at the top. AGENTS.md and SKILLS.md have no
 * frontmatter, so they are inlined verbatim.
 */
function stripFirstFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---\n", 4);
  if (end === -1) return md;
  return md.slice(end + "\n---\n".length);
}
