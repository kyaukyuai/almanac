/**
 * Tests for `almanac export` — package a compiled almanac as tar.gz.
 *
 * Unit tests pin the spawn argv shape (with/without --include-compile,
 * default output filename). The integration test runs the real `tar`
 * binary against a tmp almanac dir and asserts the resulting archive
 * unpacks back to the expected file tree.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultExportPath, runExport, ExportFailedError } from "./export.ts";
import type { Spawner, SpawnResult } from "../compile/stages/s07/tsc-runner.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// defaultExportPath
// ──────────────────────────────────────────────────────────────────────────────

describe("defaultExportPath", () => {
  test("produces almanac-<id>-<version>.tar.gz under cwd", () => {
    const p = defaultExportPath({
      almanacId: "sqlite",
      version: "0.2.0",
      cwd: "/tmp/cwd",
    });
    expect(p).toBe("/tmp/cwd/almanac-sqlite-0.2.0.tar.gz");
  });

  test("defaults to process.cwd() when cwd not supplied", () => {
    const p = defaultExportPath({ almanacId: "x", version: "1.0.0" });
    expect(p.endsWith("/almanac-x-1.0.0.tar.gz")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runExport argv shape (stub spawner)
// ──────────────────────────────────────────────────────────────────────────────

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

function makeTmpAlmanac(): string {
  const root = mkdtempSync(join(tmpdir(), "almanac-export-"));
  cleanup.push(root);
  const dir = join(root, "tinytool");
  // We need the dir to exist for the existsSync guard in runExport.
  // Use bun's mkdir via fs/promises so we don't get a race.
  // We're not actually invoking tar; the spawner is stubbed.
  writeFileSync(join(root, ".keep"), "");
  // Make the almanac dir + a manifest stub so stat() works in tests
  // (the spawner is stubbed but runExport stats the OUTPUT, not input).
  return dir;
}

describe("runExport — argv construction", () => {
  test("default: tar -czf <out> -C <parent> --exclude=<base>/.compile <base>", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-export-argv-"));
    cleanup.push(root);
    const almanacDir = join(root, "myalmanac");
    await mkdir(almanacDir, { recursive: true });
    const outputPath = join(root, "out.tar.gz");

    const capture: { args?: readonly string[]; cwd?: string } = {};
    const spawner = stubSpawner(
      { exitCode: 0, stdout: "", stderr: "" },
      capture,
    );
    // Pre-create the output file so stat() succeeds — the stub doesn't
    // actually write anything.
    writeFileSync(outputPath, "fake");

    await runExport({ almanacDir, outputPath, spawner });
    expect(capture.cwd).toBe(root);
    expect(capture.args).toEqual([
      "tar",
      "-czf",
      outputPath,
      "-C",
      root,
      "--exclude=myalmanac/.compile",
      "myalmanac",
    ]);
  });

  test("--include-compile: omits the exclude flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-export-inc-"));
    cleanup.push(root);
    const almanacDir = join(root, "myalmanac");
    await mkdir(almanacDir, { recursive: true });
    const outputPath = join(root, "out.tar.gz");

    const capture: { args?: readonly string[]; cwd?: string } = {};
    const spawner = stubSpawner(
      { exitCode: 0, stdout: "", stderr: "" },
      capture,
    );
    writeFileSync(outputPath, "fake");

    await runExport({
      almanacDir,
      outputPath,
      includeCompile: true,
      spawner,
    });
    expect(capture.args).toEqual([
      "tar",
      "-czf",
      outputPath,
      "-C",
      root,
      "myalmanac",
    ]);
  });

  test("non-zero tar exit → ExportFailedError with stderr in message", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-export-fail-"));
    cleanup.push(root);
    const almanacDir = join(root, "broken");
    await mkdir(almanacDir, { recursive: true });
    const outputPath = join(root, "out.tar.gz");
    const spawner = stubSpawner({
      exitCode: 1,
      stdout: "",
      stderr: "tar: archive sucks: Permission denied",
    });
    await expect(
      runExport({ almanacDir, outputPath, spawner }),
    ).rejects.toBeInstanceOf(ExportFailedError);
  });

  test("missing almanac dir → throws synchronously", async () => {
    await expect(
      runExport({
        almanacDir: "/nowhere/almanac-doesnt-exist",
        outputPath: "/tmp/x.tar.gz",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  test("relative almanacDir → throws", async () => {
    await expect(
      runExport({ almanacDir: "relative/path", outputPath: "/tmp/x.tar.gz" }),
    ).rejects.toThrow(/almanacDir must be absolute/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: actually run system `tar` against a real tmp almanac dir
// ──────────────────────────────────────────────────────────────────────────────

describe("runExport — real tar integration", () => {
  async function buildTmpAlmanac(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "almanac-export-real-"));
    cleanup.push(root);
    const dir = join(root, "tinytool");
    await mkdir(dir, { recursive: true });
    // Some surface files:
    writeFileSync(join(dir, "manifest.json"), `{"almanacId":"tinytool"}`);
    writeFileSync(join(dir, "DOMAIN.md"), "# Tinytool\n");
    await mkdir(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "query_facts.json"), `{"name":"query_facts"}`);
    writeFileSync(
      join(dir, "tools", "query_facts.ts"),
      "export default async () => ({ ok: false, error: { code: 'stub', message: 'x', retryable: false } });",
    );
    await mkdir(join(dir, "extracted"), { recursive: true });
    writeFileSync(join(dir, "extracted", "facts.jsonl"), `{"id":"x"}\n`);
    // Stage scratch we expect to be excluded by default:
    await mkdir(join(dir, ".compile"), { recursive: true });
    writeFileSync(join(dir, ".compile", "domain-spec.json"), `{"sensitive":"yes"}`);
    return dir;
  }

  test("default excludes .compile/; unpack reproduces tree", async () => {
    const dir = await buildTmpAlmanac();
    const outDir = mkdtempSync(join(tmpdir(), "almanac-export-out-"));
    cleanup.push(outDir);
    const outputPath = join(outDir, "tinytool.tar.gz");

    const result = await runExport({ almanacDir: dir, outputPath });
    expect(result.outputPath).toBe(outputPath);
    expect(result.byteLength).toBeGreaterThan(0);
    expect(existsSync(outputPath)).toBe(true);

    // Unpack and confirm structure.
    const unpackDir = mkdtempSync(join(tmpdir(), "almanac-export-unpack-"));
    cleanup.push(unpackDir);
    await runTar(["-xzf", outputPath, "-C", unpackDir]);

    expect(existsSync(join(unpackDir, "tinytool", "manifest.json"))).toBe(true);
    expect(existsSync(join(unpackDir, "tinytool", "DOMAIN.md"))).toBe(true);
    expect(existsSync(join(unpackDir, "tinytool", "tools", "query_facts.json"))).toBe(true);
    expect(existsSync(join(unpackDir, "tinytool", "tools", "query_facts.ts"))).toBe(true);
    expect(existsSync(join(unpackDir, "tinytool", "extracted", "facts.jsonl"))).toBe(true);
    // .compile must be absent in the default export.
    expect(existsSync(join(unpackDir, "tinytool", ".compile"))).toBe(false);
  }, { timeout: 15_000 });

  test("--include-compile keeps .compile/", async () => {
    const dir = await buildTmpAlmanac();
    const outDir = mkdtempSync(join(tmpdir(), "almanac-export-incout-"));
    cleanup.push(outDir);
    const outputPath = join(outDir, "tinytool-with-compile.tar.gz");

    await runExport({
      almanacDir: dir,
      outputPath,
      includeCompile: true,
    });
    const unpackDir = mkdtempSync(join(tmpdir(), "almanac-export-incunpack-"));
    cleanup.push(unpackDir);
    await runTar(["-xzf", outputPath, "-C", unpackDir]);
    expect(
      existsSync(join(unpackDir, "tinytool", ".compile", "domain-spec.json")),
    ).toBe(true);
  }, { timeout: 15_000 });

  test("byteLength matches the on-disk size", async () => {
    const dir = await buildTmpAlmanac();
    const outDir = mkdtempSync(join(tmpdir(), "almanac-export-size-"));
    cleanup.push(outDir);
    const outputPath = join(outDir, "size.tar.gz");

    const result = await runExport({ almanacDir: dir, outputPath });
    const { statSync } = await import("node:fs");
    expect(result.byteLength).toBe(statSync(outputPath).size);
  }, { timeout: 15_000 });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function runTar(args: readonly string[]): Promise<void> {
  const [cmd, ...rest] = ["tar", ...args];
  if (!cmd) throw new Error("runTar: empty argv");
  const proc = Bun.spawn([cmd, ...rest], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar exited ${exit}: ${stderr}`);
  }
}
