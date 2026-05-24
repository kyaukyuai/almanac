/**
 * Concrete `TscRunner` for Stage 7 — runs `bun x tsc --noEmit` on the
 * generated tool files and reports diagnostics on failure.
 *
 * The generated tools live under `~/.almanac/almanacs/<id>/tools/`, which is
 * outside the project's own `tsconfig.json` include. We therefore pass an
 * inline set of compiler options (no `-p`) and set `cwd` to a directory that
 * has `typescript` resolvable so `bun x` can find the binary cheaply.
 *
 * Failure modes the orchestrator cares about:
 *   - exit 0           → `{ ok: true }`
 *   - non-zero exit    → `{ ok: false, diagnostics: stderr || stdout }`
 *   - spawn error      → propagated as an exception (programmer error)
 *
 * The runner is intentionally split into a pure `Spawner` interface + a
 * default `Bun.spawn`-backed impl. Unit tests inject a stub spawner so they
 * don't need a real TypeScript install on the test path.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TscRunner } from "../s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Spawner abstraction
// ──────────────────────────────────────────────────────────────────────────────

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Spawner {
  spawn(args: readonly string[], opts: { cwd: string }): Promise<SpawnResult>;
}

/**
 * Default spawner backed by `Bun.spawn`. Captures both streams and resolves
 * once the child exits.
 */
export function createBunSpawner(): Spawner {
  return {
    async spawn(args, opts) {
      const [cmd, ...rest] = args;
      if (!cmd) throw new RangeError("spawn: args must not be empty");
      const proc = Bun.spawn([cmd, ...rest], {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Project-root detection
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Walk up from `start` until a directory containing `node_modules/typescript`
 * is found. Returns `null` if no such directory exists between `start` and
 * the filesystem root. The caller falls back to `process.cwd()` in that case.
 *
 * Exported so tests can pin behavior without changing fs.
 */
export function findTypescriptProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(`${dir}/node_modules/typescript/package.json`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Best-effort detection of the cli's own project root (the dir that has
 * `typescript` installed). Falls back to `process.cwd()` so commands invoked
 * from inside that project still work even when the cli source has moved.
 */
export function defaultTscCwd(): string {
  return findTypescriptProjectRoot(HERE) ?? process.cwd();
}

// ──────────────────────────────────────────────────────────────────────────────
// Inline compiler options
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compiler flags applied to every tool file pair. Kept as a literal array so
 * the exact invocation is greppable and the test assertion stays terse.
 *
 * Notes:
 *   - `--module ESNext` + `--moduleResolution Bundler` lets `bun:test` and
 *     `bun:sqlite` resolve without a tsconfig.
 *   - `--types bun` brings in `Bun.spawn`, the `bun:test` matchers, and the
 *     `bun:sqlite` `Database` type.
 *   - `--skipLibCheck` keeps the wall-clock budget reasonable; the tool's
 *     own code is what we're checking.
 *   - `--allowImportingTsExtensions` lets the generated test import
 *     `"./<name>.ts"` directly (matching the runtime's loader).
 *   - We deliberately omit `--noUncheckedIndexedAccess` and
 *     `--exactOptionalPropertyTypes`: the project tsconfig is strict in
 *     those, but the generated tool files use plenty of `any` and untyped
 *     index access that would not survive those flags.
 */
export const STAGE7_TSC_OPTIONS: readonly string[] = [
  "--noEmit",
  "--strict",
  "--skipLibCheck",
  "--target",
  "ES2022",
  "--module",
  "ESNext",
  "--moduleResolution",
  "Bundler",
  "--esModuleInterop",
  "--resolveJsonModule",
  "--allowImportingTsExtensions",
  "--types",
  "bun",
];

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateBunxTscRunnerOptions {
  /** Spawner; defaults to `createBunSpawner()`. Tests inject stubs here. */
  spawner?: Spawner;
  /** cwd for the subprocess. Defaults to `defaultTscCwd()`. */
  cwd?: string;
  /** Override the inline option set (rarely needed). */
  options?: readonly string[];
  /** Override the launcher prefix. Defaults to `["bun", "x", "tsc"]`. */
  launcher?: readonly string[];
}

/**
 * Build a Stage 7 `TscRunner` that runs `bun x tsc` over the supplied files.
 * The factory captures the spawner + cwd so the orchestrator can reuse a
 * single runner across multiple tools in one Stage 7 invocation.
 */
export function createBunxTscRunner(
  opts: CreateBunxTscRunnerOptions = {},
): TscRunner {
  const spawner = opts.spawner ?? createBunSpawner();
  const cwd = opts.cwd ?? defaultTscCwd();
  const options = opts.options ?? STAGE7_TSC_OPTIONS;
  const launcher = opts.launcher ?? ["bun", "x", "tsc"];

  return {
    async check(files: string[]) {
      if (files.length === 0) {
        return { ok: true } as const;
      }
      const args = [...launcher, ...options, ...files];
      const result = await spawner.spawn(args, { cwd });
      if (result.exitCode === 0) return { ok: true } as const;
      const diagnostics =
        (result.stderr.trim() + "\n" + result.stdout.trim()).trim() ||
        `tsc exited ${result.exitCode} with no output`;
      return { ok: false, diagnostics } as const;
    },
  };
}
