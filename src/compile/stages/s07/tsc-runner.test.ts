/**
 * Tests for the Stage 7 `createBunxTscRunner` — verifies command construction
 * and exit-code → ok/diagnostics mapping. Subprocess execution itself is
 * stubbed (we don't want to spend wall clock on `bun x tsc` in a unit test).
 */
import { describe, expect, test } from "bun:test";

import {
  STAGE7_TSC_OPTIONS,
  createBunxTscRunner,
  findTypescriptProjectRoot,
  type Spawner,
  type SpawnResult,
} from "./tsc-runner.ts";

function stubSpawner(result: SpawnResult, capture?: { args?: readonly string[]; cwd?: string }): Spawner {
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

describe("createBunxTscRunner", () => {
  test("returns ok:true when subprocess exits 0", async () => {
    const spawner = stubSpawner({ exitCode: 0, stdout: "", stderr: "" });
    const runner = createBunxTscRunner({ spawner, cwd: "/proj" });
    const r = await runner.check(["/almanac/tools/x.ts"]);
    expect(r).toEqual({ ok: true });
  });

  test("returns ok:false with diagnostics on non-zero exit", async () => {
    const spawner = stubSpawner({
      exitCode: 1,
      stdout: "/almanac/tools/x.ts(1,1): error TS2304: Cannot find 'foo'.",
      stderr: "",
    });
    const runner = createBunxTscRunner({ spawner, cwd: "/proj" });
    const r = await runner.check(["/almanac/tools/x.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("TS2304");
    }
  });

  test("constructs the expected argv: launcher + options + files", async () => {
    const capture: { args?: readonly string[]; cwd?: string } = {};
    const spawner = stubSpawner({ exitCode: 0, stdout: "", stderr: "" }, capture);
    const runner = createBunxTscRunner({
      spawner,
      cwd: "/proj-root",
      launcher: ["bun", "x", "tsc"],
    });
    await runner.check(["/a.ts", "/b.ts"]);
    expect(capture.cwd).toBe("/proj-root");
    expect(capture.args).toEqual([
      "bun",
      "x",
      "tsc",
      ...STAGE7_TSC_OPTIONS,
      "/a.ts",
      "/b.ts",
    ]);
  });

  test("with empty file list, returns ok without spawning", async () => {
    let calls = 0;
    const spawner: Spawner = {
      async spawn() {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const runner = createBunxTscRunner({ spawner, cwd: "/x" });
    const r = await runner.check([]);
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(0);
  });

  test("falls back to a stub diagnostics string if subprocess had no output", async () => {
    const spawner = stubSpawner({ exitCode: 2, stdout: "", stderr: "" });
    const runner = createBunxTscRunner({ spawner, cwd: "/x" });
    const r = await runner.check(["/a.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toContain("exited 2");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Project-root detection
// ──────────────────────────────────────────────────────────────────────────────

describe("findTypescriptProjectRoot", () => {
  test("walks up from this file and finds the project's own node_modules/typescript", () => {
    // This test file lives inside the savant-forge repo which has typescript
    // installed as a devDependency.
    const here = import.meta.dirname;
    const found = findTypescriptProjectRoot(here);
    expect(found).not.toBeNull();
    expect(typeof found).toBe("string");
  });

  test("returns null when no ancestor has node_modules/typescript", () => {
    // The macOS / Linux fs root will never contain node_modules/typescript
    // (and certainly not at `/` itself). This relies on the test runner not
    // installing a global package there.
    const found = findTypescriptProjectRoot("/");
    expect(found).toBeNull();
  });
});
