/**
 * Stage 9 — pipeline adapter for contract files.
 *
 *   1. Reads the Stage 1 `DomainSpec`        (`.compile/domain-spec.json`)
 *   2. Reads the Stage 7 aggregate output    (`.compile/stage07-output.json`)
 *      and extracts the per-tool `finalManifest`s.
 *   3. Synthesizes a deterministic `Stage09Narrative` from the DomainSpec
 *      (the LLM-driven narrative prompt is deferred — v0.1 ships with a
 *      template so the contract files can be produced offline).
 *   4. Calls `runContractFiles` → `Stage09Output`.
 *   5. Persists the three rendered files to `<almanacDir>/DOMAIN.md`,
 *      `AGENTS.md`, `SKILLS.md` and the aggregate to
 *      `.compile/stage09-output.json`.
 *
 * `outputHash` = sha256 of the canonical Stage 9 output JSON.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DomainSpecSchema,
  Stage07OutputSchema,
  Stage09NarrativeSchema,
  type DomainSpec,
  type Stage09Narrative,
  type Stage09Output,
  type ToolManifest,
} from "../../core/types.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { runContractFiles } from "./s09-contract.ts";
import { stage07OutputPath } from "./s07-tool-impl-runner.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE09_OUTPUT_REL_PATH = ".compile/stage09-output.json";

export function stage09OutputPath(almanacDir: string): string {
  return join(almanacDir, STAGE09_OUTPUT_REL_PATH);
}

export function domainMdPath(almanacDir: string): string {
  return join(almanacDir, "DOMAIN.md");
}
export function agentsMdPath(almanacDir: string): string {
  return join(almanacDir, "AGENTS.md");
}
export function skillsMdPath(almanacDir: string): string {
  return join(almanacDir, "SKILLS.md");
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingDomainSpecError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 9 requires the Stage 1 DomainSpec at ${path}; ` +
        "run Stage 1 first or restore the file",
    );
    this.name = "MissingDomainSpecError";
  }
}

export class MissingStage07OutputError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 9 requires the Stage 7 output at ${path}; ` +
        "run Stage 7 first or restore the file",
    );
    this.name = "MissingStage07OutputError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateContractFilesRunnerOptions {
  /** Test seam: read the Stage 1 DomainSpec from a custom location. */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
  /** Test seam: read the Stage 7 output (returns the post-Stage-7 manifests). */
  readManifests?: (almanacDir: string) => Promise<ToolManifest[]>;
  /**
   * Optionally override the narrative synthesizer. Default:
   * `synthesizeNarrative(domainSpec)` — fully deterministic.
   */
  buildNarrative?: (domainSpec: DomainSpec) => Stage09Narrative;
}

/**
 * Build the Stage 9 `StageRunner`. Deterministic stage: `promptVersion = null`.
 */
export function createContractFilesRunner(
  opts: CreateContractFilesRunnerOptions = {},
): StageRunner {
  const readDomainSpec = opts.readDomainSpec ?? defaultReadDomainSpec;
  const readManifests = opts.readManifests ?? defaultReadManifests;
  const buildNarrative = opts.buildNarrative ?? synthesizeNarrative;

  return {
    promptVersion: null,
    async run(ctx) {
      const [domainSpec, manifests] = await Promise.all([
        readDomainSpec(ctx.almanacDir),
        readManifests(ctx.almanacDir),
      ]);

      const narrative = buildNarrative(domainSpec);

      const output = runContractFiles({
        domainSpec,
        narrative,
        manifests,
        compiledAt: ctx.now(),
      });

      await Promise.all([
        writeFile(domainMdPath(ctx.almanacDir), output.files[0]!.contents, "utf8"),
        writeFile(agentsMdPath(ctx.almanacDir), output.files[1]!.contents, "utf8"),
        writeFile(skillsMdPath(ctx.almanacDir), output.files[2]!.contents, "utf8"),
      ]);

      const canonicalText = JSON.stringify(output, null, 2);
      const outPath = stage09OutputPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage9:done",
        outputHash,
        files: output.files.map((f) => ({ name: f.name, bytes: f.byteLength })),
      });

      return {
        kind: "success",
        outputHash,
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Narrative synthesizer (deterministic v0.1)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a `Stage09Narrative` from the DomainSpec alone. v0.1 ships without
 * the LLM narrative call so the pipeline can complete end-to-end offline.
 *
 * - `domainOneLiner` ← DomainSpec.summary (truncated to 300)
 * - `scope.covers`   ← DomainSpec.subareas (2..8)
 * - `scope.outOfScope` ← cautions, falling back to a generic placeholder
 * - `toolSelectionGuidance` ← formulaic paragraph derived from intents/verbs
 */
export function synthesizeNarrative(domainSpec: DomainSpec): Stage09Narrative {
  const domainOneLiner = clamp(domainSpec.summary, 10, 300);

  const covers = clampList(domainSpec.subareas, 2, 8, 3, 200, [
    "core concepts",
    "common workflows",
  ]);

  const outOfScope = clampList(
    domainSpec.cautions.map((c) => `${c.area}: ${c.rationale}`),
    1,
    6,
    3,
    200,
    [
      `topics outside ${domainSpec.displayName} (consult a domain expert for those)`,
    ],
  );

  const intents = domainSpec.intents
    .map((i) => `${i.kind} ("${i.example}")`)
    .slice(0, 4)
    .join(", ");

  const verbs = domainSpec.verbs.slice(0, 6).join(", ");

  const guidance = clamp(
    [
      `Use \`query_facts\` first for any \`static\` or \`slow\` question about ${domainSpec.displayName} — it searches the offline fact corpus and returns citations.`,
      `Reach for \`fetch_official_docs\` when the user asks for the canonical specification, reference page, or live documentation snippet.`,
      `Use \`web_search_recent\` and \`latest_releases\` for \`fast\` and \`live\` topics (recent changes, current versions, news).`,
      intents.length > 0
        ? `Typical intents this almanac handles: ${intents}.`
        : `This almanac targets ${domainSpec.displayName} workflows.`,
      verbs.length > 0
        ? `Common verbs the host LLM should map to tools: ${verbs}.`
        : "",
      `Prefer the most specific tool when multiple match, and cite the returned \`source.url\` in answers.`,
    ]
      .filter((s) => s.length > 0)
      .join("\n\n"),
    40,
    3000,
  );

  return Stage09NarrativeSchema.parse({
    schemaVersion: "0.1.0",
    domainOneLiner,
    scope: { covers, outOfScope },
    toolSelectionGuidance: guidance,
  });
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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function clamp(s: string, min: number, max: number): string {
  if (s.length > max) return s.slice(0, max);
  if (s.length < min) return (s + " ".repeat(min)).slice(0, min);
  return s;
}

function clampList(
  items: readonly string[],
  minLen: number,
  maxLen: number,
  itemMin: number,
  itemMax: number,
  fallback: readonly string[],
): string[] {
  const cleaned = items
    .map((s) => clamp(s.trim(), itemMin, itemMax))
    .filter((s) => s.length >= itemMin);
  const padded = cleaned.length < minLen ? [...cleaned, ...fallback] : cleaned;
  return padded.slice(0, maxLen);
}

// Re-export for tests.
export type { Stage09Narrative, Stage09Output };
