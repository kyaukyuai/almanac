/**
 * Concrete `SmokeTestRunner` for Stage 7 — runs `bun test <file>` for a
 * single tool's smoke test and reports stderr on failure.
 *
 * Mirrors `tsc-runner.ts`'s split (Spawner abstraction + Bun.spawn impl) so
 * the same test harness can stub both runners.
 *
 * Failure modes:
 *   - exit 0           → `{ ok: true }`
 *   - non-zero exit    → `{ ok: false, diagnostics }`
 *
 * `bun test` writes its result table to stderr, so we prioritize stderr in
 * the diagnostics payload but fall back to stdout if stderr is empty.
 */

import {
  createBunSpawner,
  defaultTscCwd,
  type Spawner,
} from "./tsc-runner.ts";
import type { SmokeTestRunner } from "../s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateBunSmokeRunnerOptions {
  /** Spawner; defaults to `createBunSpawner()`. Tests inject stubs here. */
  spawner?: Spawner;
  /**
   * cwd for the subprocess. Defaults to the same project-root detection used
   * by `createBunxTscRunner` so `bun test` resolves `bun:test` consistently.
   */
  cwd?: string;
  /** Override the launcher prefix. Defaults to `["bun", "test"]`. */
  launcher?: readonly string[];
  /**
   * Extra flags appended after the launcher but before the file argument.
   * Defaults to `["--no-coverage"]` to keep the run lean.
   */
  extraArgs?: readonly string[];
  /**
   * Per-call timeout in milliseconds, enforced via `bun test --timeout`.
   * Defaults to 10_000 (10s) — a generated smoke test that doesn't finish
   * in that time is almost certainly stuck on a real network call.
   */
  timeoutMs?: number;
}

/**
 * Build a Stage 7 `SmokeTestRunner` that runs `bun test <file>`. The factory
 * captures the spawner + cwd so the orchestrator can reuse a single runner
 * across multiple tools in one Stage 7 invocation.
 */
export function createBunSmokeRunner(
  opts: CreateBunSmokeRunnerOptions = {},
): SmokeTestRunner {
  const spawner = opts.spawner ?? createBunSpawner();
  const cwd = opts.cwd ?? defaultTscCwd();
  const launcher = opts.launcher ?? ["bun", "test"];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // `--no-coverage` is the default-off path in bun, so it costs nothing to be
  // explicit and keeps the run free of "coverage temp files" surprises.
  const extraArgs = opts.extraArgs ?? ["--timeout", String(timeoutMs)];

  return {
    async test(testFile: string) {
      const args = [...launcher, ...extraArgs, testFile];
      const result = await spawner.spawn(args, { cwd });
      if (result.exitCode === 0) return { ok: true } as const;
      const diagnostics =
        (result.stderr.trim() || result.stdout.trim()) ||
        `bun test exited ${result.exitCode} with no output`;
      return { ok: false, diagnostics } as const;
    },
  };
}

// Re-export so callers can construct their own spawner without dipping into
// `./tsc-runner.ts` (a slight coupling smell, but keeps the public surface
// of stage-7 implementer plumbing in one place).
export { createBunSpawner, type Spawner } from "./tsc-runner.ts";
