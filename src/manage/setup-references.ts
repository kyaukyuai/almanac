/**
 * Staged setup references for the next almanac in a root.
 *
 * Studio reference intake and `start` planning share this state: references
 * submitted in Studio are persisted here and surface in the same source
 * checklist that `almanac start "<goal>"` renders. Intake only stages
 * URLs/paths — nothing is fetched or snapshotted until a provider-backed
 * compile consumes them through the existing pipeline.
 *
 * The state is a single JSON file at the root level (not inside an almanac
 * directory) because it describes an almanac that does not exist yet.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SetupReference {
  url: string;
  addedAt: string;
  via: "studio" | "cli";
}

export interface SetupReferencesFile {
  schemaVersion: "0.1.0";
  references: SetupReference[];
}

export type SetupReferenceAddResult =
  | { status: "accepted"; reference: SetupReference }
  | { status: "duplicate"; reference: SetupReference }
  | { status: "rejected"; url: string; reason: string };

export function setupReferencesPath(root: string): string {
  return join(root, "setup-references.json");
}

export async function readSetupReferences(
  root: string,
): Promise<SetupReferencesFile> {
  let raw: string;
  try {
    raw = await readFile(setupReferencesPath(root), "utf8");
  } catch {
    return { schemaVersion: "0.1.0", references: [] };
  }
  try {
    const parsed = JSON.parse(raw) as SetupReferencesFile;
    if (!Array.isArray(parsed.references)) {
      return { schemaVersion: "0.1.0", references: [] };
    }
    return {
      schemaVersion: "0.1.0",
      references: parsed.references.filter(
        (reference): reference is SetupReference =>
          typeof reference === "object" &&
          reference !== null &&
          typeof reference.url === "string" &&
          reference.url.length > 0,
      ),
    };
  } catch {
    return { schemaVersion: "0.1.0", references: [] };
  }
}

/**
 * Validate a candidate reference without mutating anything. Mirrors the
 * shapes `start --source` accepts: http(s) URLs, local file paths, and
 * file: URLs. Returns a user-facing rejection reason, or null when valid.
 */
export function setupReferenceRejectionReason(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) {
    return "reference is empty";
  }
  if (/\s/.test(value)) {
    return "reference must be a single URL or file path without spaces";
  }
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("file:")
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "reference is not a recognizable URL or local file path";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `unsupported URL scheme: ${parsed.protocol.replace(/:$/, "")}`;
  }
  if (parsed.hostname.length === 0) {
    return "URL has no hostname";
  }
  return null;
}

export async function addSetupReference(args: {
  root: string;
  url: string;
  via: SetupReference["via"];
  now?: Date;
}): Promise<SetupReferenceAddResult> {
  const url = args.url.trim();
  const reason = setupReferenceRejectionReason(url);
  if (reason !== null) {
    return { status: "rejected", url, reason };
  }
  const file = await readSetupReferences(args.root);
  const existing = file.references.find(
    (reference) => reference.url === url,
  );
  if (existing !== undefined) {
    return { status: "duplicate", reference: existing };
  }
  const reference: SetupReference = {
    url,
    addedAt: (args.now ?? new Date()).toISOString(),
    via: args.via,
  };
  const next: SetupReferencesFile = {
    schemaVersion: "0.1.0",
    references: [...file.references, reference],
  };
  await mkdir(args.root, { recursive: true });
  await writeFile(
    setupReferencesPath(args.root),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
  return { status: "accepted", reference };
}
