/**
 * Resource loader for `almanac serve` (MCP `resources/list`, `resources/read`).
 *
 * Resources are exposed under URIs of the form `almanac://<almanacId>/<path>`
 * where `<path>` is a forward-slash relative path inside the almanac
 * directory. The loader is responsible for:
 *
 *   - Enumerating the canonical contract files (DOMAIN.md, AGENTS.md,
 *     SKILLS.md, manifest.json) plus per-tool manifests.
 *   - Reading a resource by URI with strict path-traversal protection.
 *
 * The runtime never reveals files outside `<almanacDir>` and refuses any
 * URI that contains `..`, leading slashes, or backslashes.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ResourceDescriptorSchema,
  type ResourceDescriptor,
} from "../core/types.ts";
import { ResourceNotFoundError } from "../core/runtime.ts";
import { discoverToolNames } from "./tool-loader.ts";

// ──────────────────────────────────────────────────────────────────────────────
// MIME types
// ──────────────────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".txt": "text/plain",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

function mimeForPath(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = p.slice(idx).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// ──────────────────────────────────────────────────────────────────────────────
// URI parsing
// ──────────────────────────────────────────────────────────────────────────────

const URI_RE = /^almanac:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/(.+)$/;

export interface ParsedResourceUri {
  almanacId: string;
  /** Forward-slash relative path inside the almanac directory. */
  path: string;
}

export function parseResourceUri(uri: string): ParsedResourceUri | null {
  const m = URI_RE.exec(uri);
  if (!m) return null;
  const almanacId = m[1]!;
  const path = m[2]!;
  // Disallow path traversal & absolute paths.
  if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
    return null;
  }
  return { almanacId, path };
}

export function resourceUri(almanacId: string, relPath: string): string {
  // Normalize: strip leading "./" and any backslashes.
  const norm = relPath.replace(/^\.\//, "").replace(/\\/g, "/");
  return `almanac://${almanacId}/${norm}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Canonical resource set
// ──────────────────────────────────────────────────────────────────────────────

interface CanonicalEntry {
  relPath: string;
  name: string;
  description: string;
}

const CANONICAL_FILES: CanonicalEntry[] = [
  {
    relPath: "DOMAIN.md",
    name: "DOMAIN.md",
    description:
      "Domain definition + freshness model. The host LLM should consult this first.",
  },
  {
    relPath: "AGENTS.md",
    name: "AGENTS.md",
    description: "Operating contract for host LLMs (when to use which tool).",
  },
  {
    relPath: "SKILLS.md",
    name: "SKILLS.md",
    description: "Catalog of available tools with examples.",
  },
  {
    relPath: "manifest.json",
    name: "manifest.json",
    description: "Almanac identity, version, and counts.",
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// listResources / readResource
// ──────────────────────────────────────────────────────────────────────────────

export interface ListResourcesInput {
  almanacDir: string;
  almanacId: string;
}

export async function listResources(
  input: ListResourcesInput,
): Promise<ResourceDescriptor[]> {
  const out: ResourceDescriptor[] = [];

  for (const entry of CANONICAL_FILES) {
    const abs = join(input.almanacDir, entry.relPath);
    if (!existsSync(abs)) continue;
    const size = statSync(abs).size;
    out.push(
      ResourceDescriptorSchema.parse({
        uri: resourceUri(input.almanacId, entry.relPath),
        name: entry.name,
        description: entry.description,
        mimeType: mimeForPath(entry.relPath),
        size,
      }),
    );
  }

  // Per-tool JSON manifests (one resource per tool). Only the .json — the .ts
  // implementation is internal to the runtime.
  const toolNames = await discoverToolNames(input.almanacDir);
  for (const name of toolNames) {
    const rel = `tools/${name}.json`;
    const abs = join(input.almanacDir, rel);
    if (!existsSync(abs)) continue;
    const size = statSync(abs).size;
    out.push(
      ResourceDescriptorSchema.parse({
        uri: resourceUri(input.almanacId, rel),
        name: `${name}.json`,
        description: `Manifest for the "${name}" tool.`,
        mimeType: "application/json",
        size,
      }),
    );
  }

  return out;
}

export interface ReadResourceInput {
  almanacDir: string;
  almanacId: string;
  uri: string;
}

export interface ReadResourceResult {
  contents: string;
  mimeType: string;
}

/**
 * Read a resource by URI. Throws `ResourceNotFoundError` for:
 *   - malformed URIs
 *   - URIs whose almanacId does not match this runtime's
 *   - paths that fall outside `<almanacDir>` (defense-in-depth against
 *     parseResourceUri bugs)
 *   - missing files
 */
export async function readResource(
  input: ReadResourceInput,
): Promise<ReadResourceResult> {
  const parsed = parseResourceUri(input.uri);
  if (!parsed) throw new ResourceNotFoundError(input.uri);
  if (parsed.almanacId !== input.almanacId) {
    throw new ResourceNotFoundError(input.uri);
  }

  const abs = join(input.almanacDir, parsed.path);
  // Defense-in-depth: ensure the resolved path is inside almanacDir.
  const dirResolved = resolve(input.almanacDir);
  const absResolved = resolve(abs);
  if (
    absResolved !== dirResolved &&
    !absResolved.startsWith(dirResolved + "/") &&
    !absResolved.startsWith(dirResolved + "\\")
  ) {
    throw new ResourceNotFoundError(input.uri);
  }

  if (!existsSync(absResolved)) {
    throw new ResourceNotFoundError(input.uri);
  }

  const contents = await readFile(absResolved, "utf8");
  return { contents, mimeType: mimeForPath(parsed.path) };
}
