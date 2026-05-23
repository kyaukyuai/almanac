/**
 * Tool loader for `almanac serve`.
 *
 * Walks `<almanacDir>/tools/` and loads each `(name).json` + `(name).ts`
 * pair as a `ToolModule`. The `.json` file is the *canonical* manifest
 * (Stage 6/7 source-of-truth); the `.ts` file provides the implementation
 * via a default export plus an optional `manifest` named export.
 *
 * Discovery rules:
 *
 *   - A tool exists iff both `<name>.json` and `<name>.ts` are present.
 *   - `<name>.test.ts`, `<name>.test.js`, etc. are ignored.
 *   - Manifests that fail `ToolManifestSchema` validation cause a
 *     `ToolLoadError` (loader never silently drops a real tool — a malformed
 *     manifest indicates a broken compilation that should surface).
 *   - Disabled tools (`manifest.disabled === true`) are loaded but flagged;
 *     `listTools()` filters them out, but `execTool()` still returns a typed
 *     error so callers can distinguish "unknown tool" from "disabled tool".
 *   - The `.ts` file is loaded via dynamic `import()`; bun resolves `.ts`
 *     natively. The default export must be a function (the implementation).
 *
 * The loader does NOT execute any tool — that is the runtime's job.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ToolManifestSchema,
  type ToolManifest,
} from "../core/types.ts";
import type { ToolImplementation } from "../core/runtime.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class ToolLoadError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly path: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`tool "${toolName}" at ${path}: ${message}`);
    this.name = "ToolLoadError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Loaded tool record
// ──────────────────────────────────────────────────────────────────────────────

export interface LoadedTool {
  manifest: ToolManifest;
  implementation: ToolImplementation;
  /** Absolute path to the `<name>.ts` implementation file. */
  implPath: string;
  /** Absolute path to the `<name>.json` manifest file. */
  manifestPath: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────────

/** Absolute path to the tools directory for an almanac. */
export function toolsDirPath(almanacDir: string): string {
  return join(almanacDir, "tools");
}

/**
 * Enumerate `<name>` for every `<name>.json` in `<almanacDir>/tools/` that has
 * a sibling `<name>.ts`. Returns names sorted lexicographically. Test files
 * (`<name>.test.ts`) are ignored.
 */
export async function discoverToolNames(almanacDir: string): Promise<string[]> {
  const dir = toolsDirPath(almanacDir);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const jsonNames = new Set<string>();
  const tsNames = new Set<string>();
  for (const e of entries) {
    if (e.endsWith(".test.ts") || e.endsWith(".test.js")) continue;
    if (e.endsWith(".json")) {
      jsonNames.add(e.slice(0, -".json".length));
    } else if (e.endsWith(".ts")) {
      tsNames.add(e.slice(0, -".ts".length));
    } else if (e.endsWith(".js")) {
      tsNames.add(e.slice(0, -".js".length));
    }
  }
  const both: string[] = [];
  for (const n of jsonNames) {
    if (tsNames.has(n)) both.push(n);
  }
  both.sort();
  return both;
}

// ──────────────────────────────────────────────────────────────────────────────
// Load
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Load a single tool by name from `<almanacDir>/tools/<name>.{json,ts}`.
 * Throws `ToolLoadError` if either file is missing, the manifest is invalid,
 * or the `.ts` module's default export is not a function.
 */
export async function loadTool(
  almanacDir: string,
  name: string,
): Promise<LoadedTool> {
  const dir = toolsDirPath(almanacDir);
  const manifestPath = join(dir, `${name}.json`);
  const implPath = join(dir, `${name}.ts`);

  if (!existsSync(manifestPath)) {
    throw new ToolLoadError(name, manifestPath, "manifest file not found");
  }
  if (!existsSync(implPath)) {
    throw new ToolLoadError(name, implPath, "implementation file not found");
  }

  // Manifest
  let raw: unknown;
  try {
    const body = await readFile(manifestPath, "utf8");
    raw = JSON.parse(body);
  } catch (cause) {
    throw new ToolLoadError(
      name,
      manifestPath,
      `failed to parse manifest JSON: ${(cause as Error).message}`,
      cause,
    );
  }

  const validated = ToolManifestSchema.safeParse(raw);
  if (!validated.success) {
    throw new ToolLoadError(
      name,
      manifestPath,
      `manifest does not match ToolManifestSchema: ${validated.error.message}`,
      validated.error,
    );
  }
  const manifest = validated.data;

  if (manifest.name !== name) {
    throw new ToolLoadError(
      name,
      manifestPath,
      `manifest.name "${manifest.name}" does not match filename "${name}"`,
    );
  }

  // Implementation — dynamic import via file URL so bun's loader handles `.ts`.
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(resolve(implPath)).href)) as {
      default?: unknown;
    };
  } catch (cause) {
    throw new ToolLoadError(
      name,
      implPath,
      `failed to import implementation: ${(cause as Error).message}`,
      cause,
    );
  }

  if (typeof mod.default !== "function") {
    throw new ToolLoadError(
      name,
      implPath,
      `default export must be a function (the tool implementation), got ${typeof mod.default}`,
    );
  }
  const implementation = mod.default as ToolImplementation;

  return { manifest, implementation, implPath, manifestPath };
}

/**
 * Load every tool discovered under `<almanacDir>/tools/`. Throws on the first
 * load failure (callers wanting partial loading should iterate
 * `discoverToolNames` and `loadTool` themselves).
 */
export async function loadAllTools(almanacDir: string): Promise<LoadedTool[]> {
  const names = await discoverToolNames(almanacDir);
  const out: LoadedTool[] = [];
  for (const name of names) {
    out.push(await loadTool(almanacDir, name));
  }
  return out;
}
