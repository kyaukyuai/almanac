/**
 * Filesystem layer for compiled almanac directories.
 *
 * The on-disk layout (per ALMANAC_SUBDIRECTORIES):
 *
 *   <almanacDir>/
 *     manifest.json                       AlmanacManifest
 *     sources/                            (Stage 4)
 *       raw/                              binary blobs by sha256
 *       manifest.summary.json             SourceFetchManifest
 *     extracted/                          facts.jsonl (Stage 5)
 *     knowledge/
 *       almanac.sqlite                    Stage 8 build
 *       index-manifest.json               KnowledgeIndexManifest
 *       vectors.jsonl                     Optional Stage 8 embedding vectors
 *       vector-index.json                 Optional vector artifact manifest
 *     tools/                              <name>.ts + <name>.test.ts (Stage 7)
 *     adapters/
 *       skill/SKILL.md                    Stage 10
 *     tests/                              Stage 11 fixtures
 *     .runs/                              saved `almanac run` audit records
 *     .compile/
 *       compile-state.json                CompileState
 *
 * This module is intentionally I/O-only — it does not enforce business rules
 * beyond the schemas in `core/types.ts`. Stage 0 (`s00-bootstrap`) and the
 * pipeline orchestrator (`pipeline.ts`) are the rule-enforcing layers above.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  KnowledgeIndexManifestSchema,
  type AlmanacManifest,
  type CompileState,
  type KnowledgeIndexManifest,
} from "../core/types.ts";
import { ALMANAC_SUBDIRECTORIES } from "./stages/s00-bootstrap.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The default root where compiled almanacs live. Honors `$ALMANAC_ROOT`,
 * otherwise falls back to `~/.almanac/almanacs`.
 */
export function defaultAlmanacRoot(): string {
  const env = process.env.ALMANAC_ROOT;
  if (env && env.length > 0) {
    return isAbsolute(env) ? env : resolve(env);
  }
  return join(homedir(), ".almanac", "almanacs");
}

/** Absolute path to a single almanac under `root`. */
export function almanacDirPath(root: string, almanacId: string): string {
  return join(root, almanacId);
}

export function manifestPath(almanacDir: string): string {
  return join(almanacDir, "manifest.json");
}

export function compileStatePath(almanacDir: string): string {
  return join(almanacDir, ".compile", "compile-state.json");
}

export function knowledgeIndexManifestPath(almanacDir: string): string {
  return join(almanacDir, "knowledge", "index-manifest.json");
}

export function toolsDirPath(almanacDir: string): string {
  return join(almanacDir, "tools");
}

// ──────────────────────────────────────────────────────────────────────────────
// Directory layout
// ──────────────────────────────────────────────────────────────────────────────

/** Create `almanacDir` and every entry in `ALMANAC_SUBDIRECTORIES`. */
export async function ensureAlmanacLayout(almanacDir: string): Promise<void> {
  await mkdir(almanacDir, { recursive: true });
  for (const sub of ALMANAC_SUBDIRECTORIES) {
    await mkdir(join(almanacDir, sub), { recursive: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// JSON read/write — schema-validated
// ──────────────────────────────────────────────────────────────────────────────

async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, body, "utf8");
}

async function readJsonOrThrow<T>(path: string): Promise<T> {
  const body = await readFile(path, "utf8");
  return JSON.parse(body) as T;
}

export async function writeManifest(
  almanacDir: string,
  manifest: AlmanacManifest,
): Promise<void> {
  // Re-validate so a buggy caller can't persist a malformed manifest.
  const validated = AlmanacManifestSchema.parse(manifest);
  await writeJsonAtomic(manifestPath(almanacDir), validated);
}

export async function readManifest(
  almanacDir: string,
): Promise<AlmanacManifest> {
  const raw = await readJsonOrThrow<unknown>(manifestPath(almanacDir));
  return AlmanacManifestSchema.parse(raw);
}

export async function writeCompileState(
  almanacDir: string,
  state: CompileState,
): Promise<void> {
  const validated = CompileStateSchema.parse(state);
  await writeJsonAtomic(compileStatePath(almanacDir), validated);
}

export async function readCompileState(
  almanacDir: string,
): Promise<CompileState> {
  const raw = await readJsonOrThrow<unknown>(compileStatePath(almanacDir));
  return CompileStateSchema.parse(raw);
}

export async function readKnowledgeIndexManifest(
  almanacDir: string,
): Promise<KnowledgeIndexManifest | null> {
  const path = knowledgeIndexManifestPath(almanacDir);
  if (!existsSync(path)) return null;
  const raw = await readJsonOrThrow<unknown>(path);
  return KnowledgeIndexManifestSchema.parse(normalizeKnowledgeIndexManifest(raw));
}

function normalizeKnowledgeIndexManifest(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const manifest = raw as Record<string, unknown>;
  const counts = manifest["counts"];
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    return raw;
  }
  const countsObj = counts as Record<string, unknown>;
  const byType = countsObj["byType"];
  if (byType === null || typeof byType !== "object" || Array.isArray(byType)) {
    return raw;
  }

  return {
    ...manifest,
    counts: {
      ...countsObj,
      byType: {
        fact: 0,
        definition: 0,
        procedure: 0,
        opinion: 0,
        reference: 0,
        principle: 0,
        heuristic: 0,
        tradeoff: 0,
        framework: 0,
        ...(byType as Record<string, unknown>),
      },
    },
  };
}

export async function readImplementedToolCount(
  almanacDir: string,
): Promise<number> {
  const dir = toolsDirPath(almanacDir);
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir);
  const jsonNames = new Set<string>();
  const implNames = new Set<string>();

  for (const e of entries) {
    if (e.endsWith(".test.ts") || e.endsWith(".test.js")) continue;
    if (e.endsWith(".json")) {
      jsonNames.add(e.slice(0, -".json".length));
    } else if (e.endsWith(".ts")) {
      implNames.add(e.slice(0, -".ts".length));
    } else if (e.endsWith(".js")) {
      implNames.add(e.slice(0, -".js".length));
    }
  }

  let count = 0;
  for (const name of jsonNames) {
    if (!implNames.has(name)) continue;
    const raw = await readJsonOrThrow<unknown>(join(dir, `${name}.json`));
    const disabled =
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>)["disabled"] === true;
    if (!disabled) count += 1;
  }
  return count;
}

// ──────────────────────────────────────────────────────────────────────────────
// Discovery — `almanac list`
// ──────────────────────────────────────────────────────────────────────────────

export interface ListedAlmanac {
  almanacId: string;
  almanacDir: string;
  manifest: AlmanacManifest;
}

/**
 * Enumerate every subdirectory under `root` that contains a valid
 * `manifest.json`. Directories without a manifest, or whose manifest fails
 * schema validation, are silently skipped.
 */
export async function listAlmanacs(root: string): Promise<ListedAlmanac[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: ListedAlmanac[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    if (!existsSync(manifestPath(dir))) continue;
    try {
      const manifest = await readManifest(dir);
      out.push({ almanacId: manifest.almanacId, almanacDir: dir, manifest });
    } catch {
      // Skip malformed entries; surfaced via `almanac inspect <id>` if user asks.
    }
  }
  // Sort by almanacId for stable output.
  out.sort((a, b) => (a.almanacId < b.almanacId ? -1 : 1));
  return out;
}
