/**
 * Stage 0 — bootstrap.
 *
 * Pure builder that produces the two seed artifacts every almanac starts with:
 *
 *   - `<almanacDir>/manifest.json`              (`AlmanacManifest`)
 *   - `<almanacDir>/.compile/compile-state.json` (`CompileState`)
 *
 * Persistence (creating directories and writing files) is the CLI's
 * responsibility — this stage returns the validated artifacts.
 */

import {
  AlmanacManifestSchema,
  initCompileState,
  type AlmanacManifest,
  type CompileOptions,
  type CompileState,
  type FreshnessProfileId,
} from "../../core/types.ts";

export interface BootstrapInput {
  /** Almanac canonical slug (also the directory name). */
  almanacId: string;
  /** Original domain string as the user typed it. */
  domain: string;
  /** Title-case display name. */
  displayName: string;
  /** Initial freshness profile (refined by Stage 1, but seeded here). */
  freshnessProfileId: FreshnessProfileId;
  /** Identity of this run. Same shape as `CompileState.runId`. */
  runId: string;
  /** Version of the `almanac` CLI driving this run. */
  forgerVersion: string;
  /** Compile-time options passed to `almanac new`. */
  options: CompileOptions;
  /** Wall-clock; defaulted to `new Date()` for production. */
  now?: Date;
}

export interface BootstrapResult {
  manifest: AlmanacManifest;
  compileState: CompileState;
}

/**
 * Build the seed `AlmanacManifest` and `CompileState`. Pure: returns new
 * objects, never touches the filesystem. The CLI is expected to:
 *   1. mkdir -p the almanac directory layout (sources/, extracted/, …)
 *   2. write `manifest.json` and `.compile/compile-state.json`
 *   3. invoke Stage 1 (`s01-domain-analysis`)
 */
export function bootstrapAlmanac(input: BootstrapInput): BootstrapResult {
  const at = (input.now ?? new Date()).toISOString();

  const manifest = AlmanacManifestSchema.parse({
    schemaVersion: "0.1.0" as const,
    almanacId: input.almanacId,
    version: "0.1.0",
    domain: input.domain,
    displayName: input.displayName,
    freshnessProfileId: input.freshnessProfileId,
    toolCount: 0,
    factCount: 0,
    bootstrappedAt: at,
    compiledAt: at,
    forgerVersion: input.forgerVersion,
  });

  const compileState = initCompileState({
    runId: input.runId,
    almanacId: input.almanacId,
    domain: input.domain,
    forgerVersion: input.forgerVersion,
    options: input.options,
    now: input.now,
  });

  return { manifest, compileState };
}

/**
 * The standard subdirectory layout Stage 0 expects the CLI to create. Exported
 * so tests and `almanac inspect` can verify the layout without redefining it.
 */
export const ALMANAC_SUBDIRECTORIES: readonly string[] = [
  "sources",
  "sources/raw",
  "extracted",
  "knowledge",
  "tools",
  "adapters",
  "adapters/skill",
  "tests",
  ".compile",
];
