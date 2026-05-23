/**
 * Stage 9 — contract files orchestrator.
 *
 * Renders DOMAIN.md / AGENTS.md / SKILLS.md from:
 *   - the validated `DomainSpec`             (Stage 1)
 *   - the LLM-authored `Stage09Narrative`    (small marked sections)
 *   - the post-Stage-7 `ToolManifest[]`      (filtered to enabled tools)
 *
 * Pure: returns a `Stage09Output` carrying the three rendered file contents.
 * Persisting to disk is the CLI's job, not this stage's. The same orchestrator
 * is used by `almanac inspect` to preview the contract files without writing.
 */

import {
  buildStage09Output,
  type DomainSpec,
  type Stage09Narrative,
  type Stage09Output,
  type ToolManifest,
} from "../../core/types.ts";
import {
  renderAgentsMd,
  renderDomainMd,
  renderSkillsMd,
} from "../templates/contract.ts";

export interface RunContractFilesInput {
  domainSpec: DomainSpec;
  narrative: Stage09Narrative;
  /** All manifests after Stage 7 (enabled + disabled). The orchestrator filters. */
  manifests: ToolManifest[];
  /** Wall-clock used for `compiledAt` in DOMAIN.md frontmatter. */
  compiledAt: Date;
}

/**
 * Pure rendering pass. Filters disabled tools, drives the three template
 * functions, packs the result into a validated `Stage09Output`.
 */
export function runContractFiles(input: RunContractFilesInput): Stage09Output {
  const enabled = input.manifests.filter((m) => !m.disabled);

  const domainMd = renderDomainMd({
    domainSpec: input.domainSpec,
    narrative: input.narrative,
    manifests: enabled,
    compiledAt: input.compiledAt,
  });
  const agentsMd = renderAgentsMd({
    domainSpec: input.domainSpec,
    narrative: input.narrative,
    manifests: enabled,
  });
  const skillsMd = renderSkillsMd({
    almanacId: input.domainSpec.canonicalSlug,
    displayName: input.domainSpec.displayName,
    manifests: enabled,
  });

  return buildStage09Output({
    almanacId: input.domainSpec.canonicalSlug,
    generatedAt: input.compiledAt,
    domainMd,
    agentsMd,
    skillsMd,
  });
}
