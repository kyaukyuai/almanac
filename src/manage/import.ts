/**
 * `almanac import <archive>` — safely install an archive produced by
 * `almanac export`.
 *
 * Import is dry-run by default. The archive is inspected with `tar -tzf`,
 * its manifest is read with `tar -xOf`, and unsafe entries are rejected before
 * anything is extracted. `--apply` extracts into a temporary directory under
 * the target root and then moves the validated almanac into place.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Spawner } from "../compile/stages/s07/tsc-runner.ts";
import { createBunSpawner } from "../compile/stages/s07/tsc-runner.ts";
import {
  AlmanacManifestSchema,
  type AlmanacManifest,
} from "../core/types.ts";
import { readCompileState, writeCompileState, writeManifest } from "../compile/storage.ts";

export interface RunImportInput {
  /** Absolute path to the exported .tar.gz archive. */
  archivePath: string;
  /** Absolute almanac root directory to install into. */
  root: string;
  /** Import under a different almanac id. Rewrites manifest.almanacId. */
  targetId?: string;
  /** Actually extract the archive. Default false for dry-run. */
  apply?: boolean;
  /** Allow replacing an existing target directory. */
  replace?: boolean;
  /** Override the system `tar` binary path. Defaults to plain `tar`. */
  tarBinary?: string;
  /** Spawner; defaults to Bun.spawn. Tests inject stubs here. */
  spawner?: Spawner;
  /** Structured event log. Defaults to no-op. */
  log?: (event: object) => void;
}

export interface ImportArchiveInspection {
  archivePath: string;
  topLevelDir: string;
  manifestEntry: string;
  manifest: AlmanacManifest;
  entries: number;
}

export interface ImportResult extends ImportArchiveInspection {
  root: string;
  targetId: string;
  targetDir: string;
  mode: "dry-run" | "applied";
  collision: boolean;
  replaced: boolean;
}

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export class ImportFailedError extends Error {
  constructor(
    public readonly operation: "list" | "manifest" | "extract",
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly argv: readonly string[],
  ) {
    super(
      `tar ${operation} exited with code ${exitCode}: ${stderr.trim().slice(0, 500) || "(no stderr)"}`,
    );
    this.name = "ImportFailedError";
  }
}

interface ArchiveEntry {
  raw: string;
  normalized: string;
}

export async function inspectImportArchive(
  input: Pick<RunImportInput, "archivePath" | "tarBinary" | "spawner" | "log">,
): Promise<ImportArchiveInspection> {
  assertAbsolute("archivePath", input.archivePath);
  if (!existsSync(input.archivePath)) {
    throw new ImportValidationError(`archive does not exist: ${input.archivePath}`);
  }

  const log = input.log ?? (() => {});
  const spawner = input.spawner ?? createBunSpawner();
  const tarBinary = input.tarBinary ?? "tar";

  const listArgv = [tarBinary, "-tzf", input.archivePath];
  log({ event: "import:inspect:list:start", archivePath: input.archivePath });
  const listed = await spawner.spawn(listArgv, { cwd: dirname(input.archivePath) });
  if (listed.exitCode !== 0) {
    throw new ImportFailedError("list", listed.exitCode, listed.stderr, listArgv);
  }

  const verboseListArgv = [tarBinary, "-tvzf", input.archivePath];
  const verboseListed = await spawner.spawn(verboseListArgv, {
    cwd: dirname(input.archivePath),
  });
  if (verboseListed.exitCode !== 0) {
    throw new ImportFailedError(
      "list",
      verboseListed.exitCode,
      verboseListed.stderr,
      verboseListArgv,
    );
  }
  validateArchiveEntryTypes(verboseListed.stdout);

  const entries = parseArchiveEntries(listed.stdout);
  if (entries.length === 0) {
    throw new ImportValidationError("archive is empty");
  }

  const topLevels = new Set(entries.map((entry) => entry.normalized.split("/")[0]!));
  if (topLevels.size !== 1) {
    throw new ImportValidationError(
      `archive must contain exactly one top-level directory (found ${topLevels.size})`,
    );
  }
  const topLevelDir = [...topLevels][0]!;
  const manifestPath = `${topLevelDir}/manifest.json`;
  const manifestEntry = entries.find((entry) => entry.normalized === manifestPath);
  if (!manifestEntry) {
    throw new ImportValidationError(
      `archive is missing required manifest: ${manifestPath}`,
    );
  }

  const manifestArgv = [
    tarBinary,
    "-xOf",
    input.archivePath,
    manifestEntry.raw,
  ];
  log({
    event: "import:inspect:manifest:start",
    archivePath: input.archivePath,
    manifestEntry: manifestEntry.raw,
  });
  const manifestRead = await spawner.spawn(manifestArgv, {
    cwd: dirname(input.archivePath),
  });
  if (manifestRead.exitCode !== 0) {
    throw new ImportFailedError(
      "manifest",
      manifestRead.exitCode,
      manifestRead.stderr,
      manifestArgv,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRead.stdout);
  } catch (e) {
    throw new ImportValidationError(
      `manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let manifest: AlmanacManifest;
  try {
    manifest = AlmanacManifestSchema.parse(parsed);
  } catch (e) {
    throw new ImportValidationError(
      `manifest does not match AlmanacManifest schema: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  log({
    event: "import:inspect:done",
    archivePath: input.archivePath,
    topLevelDir,
    manifestId: manifest.almanacId,
    entries: entries.length,
  });

  return {
    archivePath: input.archivePath,
    topLevelDir,
    manifestEntry: manifestEntry.raw,
    manifest,
    entries: entries.length,
  };
}

export async function runImport(input: RunImportInput): Promise<ImportResult> {
  assertAbsolute("archivePath", input.archivePath);
  assertAbsolute("root", input.root);

  const log = input.log ?? (() => {});
  const spawner = input.spawner ?? createBunSpawner();
  const tarBinary = input.tarBinary ?? "tar";
  const inspection = await inspectImportArchive({
    archivePath: input.archivePath,
    tarBinary,
    spawner,
    log,
  });

  const targetId = input.targetId ?? inspection.manifest.almanacId;
  const targetDir = safeAlmanacDir(input.root, targetId);
  const targetManifest = AlmanacManifestSchema.parse({
    ...inspection.manifest,
    almanacId: targetId,
  });
  const collision = existsSync(targetDir);
  const replace = input.replace === true;
  if (collision && !replace) {
    throw new ImportValidationError(
      `target almanac already exists: ${targetDir}; pass --replace to allow replacement`,
    );
  }

  if (input.apply !== true) {
    return {
      ...inspection,
      manifest: targetManifest,
      root: input.root,
      targetId,
      targetDir,
      mode: "dry-run",
      collision,
      replaced: false,
    };
  }

  log({
    event: "import:apply:start",
    archivePath: input.archivePath,
    root: input.root,
    targetId,
    replace,
  });

  await mkdir(input.root, { recursive: true });
  const tempRoot = await mkdtemp(join(input.root, ".import-"));
  let moved = false;
  try {
    const extractArgv = [tarBinary, "-xzf", input.archivePath, "-C", tempRoot];
    const extracted = await spawner.spawn(extractArgv, { cwd: input.root });
    if (extracted.exitCode !== 0) {
      throw new ImportFailedError(
        "extract",
        extracted.exitCode,
        extracted.stderr,
        extractArgv,
      );
    }

    const extractedDir = join(tempRoot, inspection.topLevelDir);
    if (!existsSync(extractedDir)) {
      throw new ImportValidationError(
        `archive did not extract expected top-level directory: ${inspection.topLevelDir}`,
      );
    }

    await rewriteImportedIdentity(extractedDir, targetManifest);

    if (collision && replace) {
      await rm(targetDir, { recursive: true, force: true });
    }
    await rename(extractedDir, targetDir);
    moved = true;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  log({
    event: "import:apply:done",
    targetId,
    targetDir,
    replaced: collision && replace,
  });

  return {
    ...inspection,
    manifest: targetManifest,
    root: input.root,
    targetId,
    targetDir,
    mode: "applied",
    collision,
    replaced: moved && collision && replace,
  };
}

function parseArchiveEntries(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const normalized = normalizeArchiveEntry(line);
    validateArchiveEntry(line, normalized);
    entries.push({ raw: line, normalized });
  }
  return entries;
}

function normalizeArchiveEntry(raw: string): string {
  let entry = raw.trim().replace(/\\/g, "/");
  while (entry.startsWith("./")) {
    entry = entry.slice(2);
  }
  while (entry.endsWith("/") && entry.length > 1) {
    entry = entry.slice(0, -1);
  }
  return entry;
}

function validateArchiveEntry(raw: string, normalized: string): void {
  if (normalized.length === 0) {
    throw new ImportValidationError(`unsafe archive entry: ${JSON.stringify(raw)}`);
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new ImportValidationError(`unsafe archive entry: ${raw}`);
  }
  if (normalized.includes("\0")) {
    throw new ImportValidationError(`unsafe archive entry contains NUL: ${raw}`);
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new ImportValidationError(`unsafe archive entry: ${raw}`);
    }
  }
}

function validateArchiveEntryTypes(stdout: string): void {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entryType = line.trimStart()[0];
    if (entryType !== "-" && entryType !== "d") {
      throw new ImportValidationError(
        `archive contains unsupported entry type "${entryType}" (only regular files and directories are allowed)`,
      );
    }
  }
}

function safeAlmanacDir(root: string, almanacId: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(almanacId) || almanacId.length > 32) {
    throw new ImportValidationError(
      `target id must be lowercase kebab-case and at most 32 characters: ${almanacId}`,
    );
  }
  const resolvedRoot = resolve(root);
  const targetDir = resolve(resolvedRoot, almanacId);
  const rootWithSep = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  if (targetDir !== resolvedRoot && !targetDir.startsWith(rootWithSep)) {
    throw new ImportValidationError(`target id resolves outside root: ${almanacId}`);
  }
  return targetDir;
}

async function rewriteImportedIdentity(
  extractedDir: string,
  manifest: AlmanacManifest,
): Promise<void> {
  await writeManifest(extractedDir, manifest);

  try {
    const state = await readCompileState(extractedDir);
    await writeCompileState(extractedDir, {
      ...state,
      almanacId: manifest.almanacId,
    });
  } catch {
    // Default exports exclude .compile/. Including it is optional debug state,
    // so a missing or stale compile-state must not block a runtime import.
  }
}

function assertAbsolute(name: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`runImport: ${name} must be absolute (got "${path}")`);
  }
}
