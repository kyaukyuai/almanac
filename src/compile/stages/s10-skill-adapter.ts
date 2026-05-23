/**
 * Stage 10 — SKILL.md adapter orchestrator.
 *
 * Takes the Stage 9 contract files + manifests + counts and produces a
 * validated `Stage10Output` carrying the rendered SKILL.md plus its parsed
 * frontmatter.
 *
 * Pure: no fs, no network. The CLI persists `contents` to
 * `<almanacDir>/adapters/skill/SKILL.md`.
 */

import {
  Stage10OutputSchema,
  type DomainSpec,
  type Stage09Output,
  type Stage10Output,
  type ToolManifest,
} from "../../core/types.ts";
import { renderSkillMd, toMcpQualifiedToolName } from "../templates/skill.ts";

export interface RunSkillAdapterInput {
  domainSpec: DomainSpec;
  /** All manifests (incl. disabled). The orchestrator filters. */
  manifests: ToolManifest[];
  /** The three rendered contract files from Stage 9. */
  contractFiles: Stage09Output;
  /** Number of facts in `extracted/facts.jsonl` at this point. */
  factCount: number;
  /** Wall-clock for `metadata.almanac.compiledAt`. */
  compiledAt: Date;
  /** Description text for the skill (1–3 sentences for Claude Code's UI). */
  skillDescription: string;
  /** Skill semver. Defaults to "0.1.0". */
  skillVersion?: string;
}

export function runSkillAdapter(input: RunSkillAdapterInput): Stage10Output {
  const enabled = input.manifests.filter((m) => !m.disabled);
  const allowedTools = enabled.map((m) =>
    toMcpQualifiedToolName(input.domainSpec.canonicalSlug, m.name),
  );

  const byName = new Map(input.contractFiles.files.map((f) => [f.name, f.contents]));
  const domainMd = byName.get("DOMAIN.md")!;
  const agentsMd = byName.get("AGENTS.md")!;
  const skillsMd = byName.get("SKILLS.md")!;

  const frontmatter = {
    name: `almanac-${input.domainSpec.canonicalSlug}`,
    version: input.skillVersion ?? "0.1.0",
    description: input.skillDescription,
    allowedTools,
    metadata: {
      almanac: {
        domain: input.domainSpec.domain,
        freshnessProfileId: input.domainSpec.freshnessProfile.profileId,
        toolCount: enabled.length,
        factCount: input.factCount,
        compiledAt: input.compiledAt.toISOString(),
      },
    },
  };

  const contents = renderSkillMd({
    frontmatter,
    domainMd,
    agentsMd,
    skillsMd,
  });

  return Stage10OutputSchema.parse({
    schemaVersion: "0.1.0" as const,
    almanacId: input.domainSpec.canonicalSlug,
    relPath: "adapters/skill/SKILL.md" as const,
    contents,
    byteLength: new TextEncoder().encode(contents).length,
    frontmatter,
  });
}
