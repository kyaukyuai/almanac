/**
 * Concrete `writeRaw` implementation for Stage 4.
 *
 * Persists fetched bytes to `<almanacDir>/sources/raw/<sha256>.<ext>` and
 * returns the metadata that the fetchers embed in `FetchedDocument`.
 *
 * The default extension is derived from the supplied `mediaType` (so HTML
 * lands as `*.html`, JSON as `*.json`, …). Fetchers can override via the
 * `extension` argument.
 *
 * Idempotent: writing the same bytes twice produces the same path. Existing
 * files with the same hash are NOT overwritten — content addressing makes
 * that unnecessary, and skipping the second write avoids racing readers.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { FetchContext } from "./types.ts";
import type { FetchedDocument } from "../../core/types.ts";

const EXT_BY_MIME: Record<string, string> = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/rss+xml": "xml",
  "application/atom+xml": "xml",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/json": "json",
  "application/jsonl": "jsonl",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/pdf": "pdf",
  "text/yaml": "yaml",
};

function extensionFor(mediaType: string, override?: string): string {
  if (override) return override.replace(/^\./, "");
  return EXT_BY_MIME[mediaType] ?? "bin";
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a `writeRaw` closure bound to one `almanacDir`. The orchestrator
 * passes this into every `FetchContext`.
 */
export function createWriteRaw(almanacDir: string): FetchContext["writeRaw"] {
  const dir = join(almanacDir, "sources", "raw");
  return async ({ bytes, mediaType, extension }) => {
    await mkdir(dir, { recursive: true });
    const contentHash = sha256HexBytes(bytes);
    const ext = extensionFor(mediaType, extension);
    const fileName = ext.length > 0 ? `${contentHash}.${ext}` : contentHash;
    const path = join(dir, fileName);
    if (!existsSync(path)) {
      await writeFile(path, bytes);
    }
    const relPath = `sources/raw/${fileName}` as FetchedDocument["relPath"];
    return { contentHash, relPath, byteLength: bytes.byteLength };
  };
}
