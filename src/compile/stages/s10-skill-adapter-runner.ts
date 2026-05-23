/**
 * Stage 10 — pipeline adapter for SKILL.md generation.
 *
 *   1. Reads `.compile/domain-spec.json`     (Stage 1)
 *   2. Reads `.compile/stage07-output.json`  (Stage 7) → manifests
 *   3. Reads `.compile/stage09-output.json`  (Stage 9) → contract files
 *   4. Reads `knowledge/index-manifest.json` (Stage 8) → fact count
 *   5. Calls `runSkillAdapter` with a deterministic `skillDescription`
 *      synthesized from the DomainSpec (the user can override via opts).
 *   6. Writes `adapters/skill/SKILL.md` to disk.
 *
 * `outputHash` = sha256 of the canonical `Stage10Output` JSON.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  KnowledgeIndexManifestSchema,
  Stage07OutputSchema,
  Stage09OutputSchema,
  type DomainSpec,
  type Stage09Output,
  type Stage10Output,
  type ToolManifest,
} from "../../core/types.ts";
import { knowledgeIndexManifestPath } from "../storage.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { stage07OutputPath } from "./s07-tool-impl-runner.ts";
import { runSkillAdapter } from "./s10-skill-adapter.ts";
import { stage09OutputPath } from "./s09-contract-runner.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────────

export const SKILL_MD_REL_PATH = "adapters/skill/SKILL.md";
export const STAGE10_OUTPUT_REL_PATH = ".compile/stage10-output.json";

export function skillMdPath(almanacDir: string): string {
  return join(almanacDir, SKILL_MD_REL_PATH);
}

export function stage10OutputPath(almanacDir: string): string {
  return join(almanacDir, STAGE10_OUTPUT_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingDomainSpecError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 10 requires the Stage 1 DomainSpec at ${path}; ` +
        "run Stage 1 first or restore the file",
    );
    this.name = "MissingDomainSpecError";
  }
}

export class MissingStage07OutputError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 10 requires the Stage 7 output at ${path}; ` +
        "run Stage 7 first or restore the file",
    );
    this.name = "MissingStage07OutputError";
  }
}

export class MissingStage09OutputError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 10 requires the Stage 9 output at ${path}; ` +
        "run Stage 9 first or restore the file",
    );
    this.name = "MissingStage09OutputError";
  }
}

export class MissingKnowledgeIndexError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 10 requires the Stage 8 knowledge index manifest at ${path}; ` +
        "run Stage 8 first or restore the file",
    );
    this.name = "MissingKnowledgeIndexError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateSkillAdapterRunnerOptions {
  /** Override the synthesized skill description. */
  skillDescription?: string;
  /** Override the skill version. Defaults to `"0.1.0"`. */
  skillVersion?: string;

  /** Test seam: read DomainSpec from a custom location. */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
  /** Test seam: read manifests (returns post-Stage-7 finalManifests). */
  readManifests?: (almanacDir: string) => Promise<ToolManifest[]>;
  /** Test seam: read the Stage 9 contract files aggregate. */
  readContractFiles?: (almanacDir: string) => Promise<Stage09Output>;
  /** Test seam: read the indexed fact count from Stage 8's manifest. */
  readFactCount?: (almanacDir: string) => Promise<number>;
}

/**
 * Build the Stage 10 `StageRunner`. Deterministic stage: `promptVersion = null`.
 */
export function createSkillAdapterRunner(
  opts: CreateSkillAdapterRunnerOptions = {},
): StageRunner {
  const readDomainSpec = opts.readDomainSpec ?? defaultReadDomainSpec;
  const readManifests = opts.readManifests ?? defaultReadManifests;
  const readContractFiles =
    opts.readContractFiles ?? defaultReadContractFiles;
  const readFactCount = opts.readFactCount ?? defaultReadFactCount;

  return {
    promptVersion: null,
    async run(ctx) {
      const [domainSpec, manifests, contractFiles, factCount] =
        await Promise.all([
          readDomainSpec(ctx.almanacDir),
          readManifests(ctx.almanacDir),
          readContractFiles(ctx.almanacDir),
          readFactCount(ctx.almanacDir),
        ]);

      const skillDescription =
        opts.skillDescription ?? synthesizeSkillDescription(domainSpec);

      const output: Stage10Output = runSkillAdapter({
        domainSpec,
        manifests,
        contractFiles,
        factCount,
        compiledAt: ctx.now(),
        skillDescription,
        ...(opts.skillVersion !== undefined
          ? { skillVersion: opts.skillVersion }
          : {}),
      });

      const skillPath = skillMdPath(ctx.almanacDir);
      await mkdir(dirname(skillPath), { recursive: true });
      await writeFile(skillPath, output.contents, "utf8");

      const canonicalText = JSON.stringify(output, null, 2);
      const aggPath = stage10OutputPath(ctx.almanacDir);
      await mkdir(dirname(aggPath), { recursive: true });
      await writeFile(aggPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage10:done",
        outputHash,
        bytes: output.byteLength,
        allowedTools: output.frontmatter.allowedTools.length,
      });

      return { kind: "success", outputHash };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a 1–3 sentence skill description from the DomainSpec. The output is
 * deterministic and clamped to the 20–500 char range required by
 * `SkillFrontmatter.description`.
 */
export function synthesizeSkillDescription(
  domainSpec: DomainSpec,
): string {
  const summary = domainSpec.summary.trim();
  const guidance = `Use this almanac for ${domainSpec.displayName} questions; it ships with offline facts and live retrieval tools tailored to ${domainSpec.freshnessProfile.profileId} freshness.`;
  const candidate = `${summary} ${guidance}`;
  if (candidate.length > 500) return candidate.slice(0, 500);
  if (candidate.length >= 20) return candidate;
  return (candidate + " " + " ".repeat(20)).slice(0, 20);
}

// ──────────────────────────────────────────────────────────────────────────────
// Default readers
// ──────────────────────────────────────────────────────────────────────────────

async function defaultReadDomainSpec(
  almanacDir: string,
): Promise<DomainSpec> {
  const path = domainSpecPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingDomainSpecError(path, cause);
    }
    throw cause;
  }
  return DomainSpecSchema.parse(JSON.parse(body));
}

async function defaultReadManifests(
  almanacDir: string,
): Promise<ToolManifest[]> {
  const path = stage07OutputPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingStage07OutputError(path, cause);
    }
    throw cause;
  }
  const parsed = Stage07OutputSchema.parse(JSON.parse(body));
  return parsed.results.map((r) => r.finalManifest);
}

async function defaultReadContractFiles(
  almanacDir: string,
): Promise<Stage09Output> {
  const path = stage09OutputPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingStage09OutputError(path, cause);
    }
    throw cause;
  }
  return Stage09OutputSchema.parse(JSON.parse(body));
}

async function defaultReadFactCount(almanacDir: string): Promise<number> {
  const path = knowledgeIndexManifestPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingKnowledgeIndexError(path, cause);
    }
    throw cause;
  }
  return KnowledgeIndexManifestSchema.parse(JSON.parse(body)).factCount;
}

// Re-export for tests.
export type { Stage10Output };
