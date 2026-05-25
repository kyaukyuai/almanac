/**
 * `almanac export <id>` — package a compiled almanac as a portable
 * `.tar.gz` archive that can be unpacked elsewhere and served via
 * `almanac serve` immediately.
 *
 * Pairs with `feed`: `feed` grows an almanac in place; `export` ships
 * the grown result.
 *
 * The archive includes the canonical surface of a compiled almanac:
 *
 *   manifest.json
 *   DOMAIN.md, AGENTS.md, SKILLS.md
 *   adapters/skill/SKILL.md
 *   tools/<name>.{json,ts,test.ts}
 *   extracted/facts.jsonl
 *   knowledge/almanac.sqlite + knowledge/index-manifest.json
 *   sources/sources.json + sources/manifest.summary.json + sources/raw/*
 *   tests/positive.jsonl + tests/negative.jsonl
 *
 * It EXCLUDES `.compile/` by default — that directory holds Stage 1–6
 * intermediates (LLM prompts, candidate lists, retry diagnostics) which
 * the recipient doesn't need to run the almanac. Pass `includeCompile`
 * to keep them, e.g. for debugging or auditing a generated almanac.
 *
 * Implementation uses the system `tar` binary via `Bun.spawn`. BSD tar
 * (macOS) and GNU tar (Linux) both support the same surface:
 *   tar -czf <out> -C <parent-of-almanac> --exclude=<base>/.compile <base>
 *
 * The unpacker just does `tar -xzf <archive>` in any directory; the
 * archive's top-level entry is `<almanac-id>/`, so the result lands
 * cleanly under that name. `almanac serve <id> --root .` then works.
 */

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { Spawner } from "../compile/stages/s07/tsc-runner.ts";
import { createBunSpawner } from "../compile/stages/s07/tsc-runner.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────────────

export interface RunExportInput {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Absolute path to write the .tar.gz to. */
  outputPath: string;
  /**
   * When true, the archive includes the `.compile/` directory (Stage 1–6
   * intermediates). Default false — those files aren't needed to run the
   * compiled almanac and bloat the archive.
   */
  includeCompile?: boolean;
  /** Override the system `tar` binary path. Defaults to plain `tar`. */
  tarBinary?: string;
  /** Spawner; defaults to Bun.spawn. Tests inject stubs here. */
  spawner?: Spawner;
  /** Structured event log. Defaults to no-op. */
  log?: (event: object) => void;
}

export interface ExportResult {
  outputPath: string;
  byteLength: number;
  /** Sha256 of the .tar.gz contents (computed by the caller; null when skipped). */
  contentHash: string | null;
  argv: readonly string[];
  cwd: string;
}

export class ExportFailedError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly argv: readonly string[],
  ) {
    super(
      `tar exited with code ${exitCode}: ${stderr.trim().slice(0, 500) || "(no stderr)"}`,
    );
    this.name = "ExportFailedError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Package an almanac directory as a tar.gz at `outputPath`. The output
 * file's parent directory is created if it doesn't exist; an existing
 * file at `outputPath` is overwritten (tar's default behavior).
 *
 * Throws `ExportFailedError` if the subprocess exits non-zero.
 */
export async function runExport(input: RunExportInput): Promise<ExportResult> {
  if (!isAbsolute(input.almanacDir)) {
    throw new Error(
      `runExport: almanacDir must be absolute (got "${input.almanacDir}")`,
    );
  }
  if (!isAbsolute(input.outputPath)) {
    throw new Error(
      `runExport: outputPath must be absolute (got "${input.outputPath}")`,
    );
  }
  if (!existsSync(input.almanacDir)) {
    throw new Error(`runExport: almanacDir does not exist: ${input.almanacDir}`);
  }

  const log = input.log ?? (() => {});
  const spawner = input.spawner ?? createBunSpawner();
  const tarBinary = input.tarBinary ?? "tar";

  // Ensure the output's parent directory exists.
  await mkdir(dirname(input.outputPath), { recursive: true });

  // tar invocation:
  //   tar -czf <out>
  //       -C <parent-of-almanac>
  //       [--exclude=<base>/.compile]
  //       <base>
  const parent = dirname(input.almanacDir);
  const base = basename(input.almanacDir);
  const argv: string[] = [
    tarBinary,
    "-czf",
    input.outputPath,
    "-C",
    parent,
  ];
  if (input.includeCompile !== true) {
    argv.push(`--exclude=${base}/.compile`);
  }
  argv.push(base);

  log({
    event: "export:start",
    almanacDir: input.almanacDir,
    outputPath: input.outputPath,
    includeCompile: input.includeCompile === true,
  });

  const result = await spawner.spawn(argv, { cwd: parent });
  if (result.exitCode !== 0) {
    throw new ExportFailedError(result.exitCode, result.stderr, argv);
  }

  // Resolve actual on-disk size + the tar command we ran.
  const stats = await stat(input.outputPath);

  log({
    event: "export:done",
    outputPath: input.outputPath,
    byteLength: stats.size,
  });

  return {
    outputPath: input.outputPath,
    byteLength: stats.size,
    contentHash: null, // Hash computation is opt-in by the caller.
    argv,
    cwd: parent,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Default output filename for an almanac of the given id + version:
 *
 *   almanac-<id>-<version>.tar.gz
 *
 * Placed in `process.cwd()` unless an absolute target is supplied.
 */
export function defaultExportPath(args: {
  almanacId: string;
  version: string;
  cwd?: string;
}): string {
  const cwd = args.cwd ?? process.cwd();
  return resolve(cwd, `almanac-${args.almanacId}-${args.version}.tar.gz`);
}
