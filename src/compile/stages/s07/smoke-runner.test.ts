/**
 * Tests for the Stage 7 `createBunSmokeRunner` — argv construction + exit-code
 * to ok/diagnostics mapping. Subprocess is stubbed; we don't want to invoke
 * `bun test` recursively from inside our own test runner.
 */
import { describe, expect, test } from "bun:test";

import { createBunSmokeRunner } from "./smoke-runner.ts";
import type { Spawner, SpawnResult } from "./tsc-runner.ts";

function stubSpawner(
  result: SpawnResult,
  capture?: { args?: readonly string[]; cwd?: string },
): Spawner {
  return {
    async spawn(args, opts) {
      if (capture) {
        (capture as { args?: readonly string[]; cwd?: string }).args = args;
        (capture as { args?: readonly string[]; cwd?: string }).cwd = opts.cwd;
      }
      return result;
    },
  };
}

describe("createBunSmokeRunner", () => {
  test("returns ok:true on exit 0", async () => {
    const spawner = stubSpawner({ exitCode: 0, stdout: "", stderr: "" });
    const runner = createBunSmokeRunner({ spawner, cwd: "/proj" });
    expect(await runner.test("/almanac/tools/x.test.ts")).toEqual({ ok: true });
  });

  test("returns ok:false with stderr-preferred diagnostics on non-zero exit", async () => {
    const spawner = stubSpawner({
      exitCode: 1,
      stdout: "noise on stdout",
      stderr: "1 fail | 0 expect() calls",
    });
    const runner = createBunSmokeRunner({ spawner, cwd: "/proj" });
    const r = await runner.test("/x.test.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("1 fail");
      expect(r.diagnostics).not.toContain("noise on stdout");
    }
  });

  test("falls back to stdout when stderr is empty", async () => {
    const spawner = stubSpawner({
      exitCode: 2,
      stdout: "stdout-side-only",
      stderr: "",
    });
    const runner = createBunSmokeRunner({ spawner, cwd: "/x" });
    const r = await runner.test("/x.test.ts");
    if (!r.ok) {
      expect(r.diagnostics).toContain("stdout-side-only");
    }
  });

  test("uses launcher + timeout + file argv shape by default", async () => {
    const capture: { args?: readonly string[]; cwd?: string } = {};
    const spawner = stubSpawner({ exitCode: 0, stdout: "", stderr: "" }, capture);
    const runner = createBunSmokeRunner({
      spawner,
      cwd: "/proj",
      timeoutMs: 5_000,
    });
    await runner.test("/x.test.ts");
    expect(capture.cwd).toBe("/proj");
    expect(capture.args).toEqual([
      "bun",
      "test",
      "--timeout",
      "5000",
      "/x.test.ts",
    ]);
  });

  test("honors custom launcher + extraArgs", async () => {
    const capture: { args?: readonly string[]; cwd?: string } = {};
    const spawner = stubSpawner({ exitCode: 0, stdout: "", stderr: "" }, capture);
    const runner = createBunSmokeRunner({
      spawner,
      cwd: "/x",
      launcher: ["custom-bun", "custom-test"],
      extraArgs: ["--reporter=junit"],
    });
    await runner.test("/test.ts");
    expect(capture.args).toEqual([
      "custom-bun",
      "custom-test",
      "--reporter=junit",
      "/test.ts",
    ]);
  });
});
