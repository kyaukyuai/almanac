/**
 * Tests for `almanac import` — inspect and install exported archives safely.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManifest, writeManifest } from "../compile/storage.ts";
import type { Spawner } from "../compile/stages/s07/tsc-runner.ts";
import { runExport } from "./export.ts";
import {
  ImportValidationError,
  inspectImportArchive,
  runImport,
} from "./import.ts";

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

describe("runImport — real tar integration", () => {
  test("dry-run validates without writing; --apply installs into a fresh root", async () => {
    const { archivePath } = await buildArchive();
    const parent = mkdtempSync(join(tmpdir(), "almanac-import-root-"));
    cleanup.push(parent);
    const importRoot = join(parent, "fresh-root");

    const dryRun = await runImport({ archivePath, root: importRoot });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.targetId).toBe("tinytool");
    expect(dryRun.collision).toBe(false);
    expect(existsSync(join(importRoot, "tinytool"))).toBe(false);

    const applied = await runImport({
      archivePath,
      root: importRoot,
      apply: true,
    });
    expect(applied.mode).toBe("applied");
    expect(applied.replaced).toBe(false);
    expect(existsSync(join(importRoot, "tinytool", "manifest.json"))).toBe(true);
    expect((await readManifest(join(importRoot, "tinytool"))).almanacId).toBe(
      "tinytool",
    );
  }, { timeout: 45_000 });

  test("collision requires --replace and replacement is explicit", async () => {
    const { archivePath } = await buildArchive();
    const importRoot = mkdtempSync(join(tmpdir(), "almanac-import-collision-"));
    cleanup.push(importRoot);

    await runImport({ archivePath, root: importRoot, apply: true });

    await expect(
      runImport({ archivePath, root: importRoot, apply: true }),
    ).rejects.toBeInstanceOf(ImportValidationError);

    const dryReplace = await runImport({
      archivePath,
      root: importRoot,
      replace: true,
    });
    expect(dryReplace.mode).toBe("dry-run");
    expect(dryReplace.collision).toBe(true);

    const replaced = await runImport({
      archivePath,
      root: importRoot,
      apply: true,
      replace: true,
    });
    expect(replaced.mode).toBe("applied");
    expect(replaced.replaced).toBe(true);
  }, { timeout: 45_000 });

  test("--as imports under a new id and rewrites manifest identity", async () => {
    const { archivePath } = await buildArchive();
    const importRoot = mkdtempSync(join(tmpdir(), "almanac-import-as-"));
    cleanup.push(importRoot);

    const result = await runImport({
      archivePath,
      root: importRoot,
      apply: true,
      targetId: "tiny-copy",
    });

    expect(result.targetId).toBe("tiny-copy");
    expect(existsSync(join(importRoot, "tiny-copy", "manifest.json"))).toBe(true);
    expect((await readManifest(join(importRoot, "tiny-copy"))).almanacId).toBe(
      "tiny-copy",
    );
    expect(existsSync(join(importRoot, "tinytool"))).toBe(false);
  }, { timeout: 45_000 });
});

describe("inspectImportArchive — validation", () => {
  test("rejects path traversal entries before extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-import-bad-"));
    cleanup.push(root);
    const archivePath = join(root, "bad.tar.gz");
    await writeFile(archivePath, "fake", "utf8");

    const spawner: Spawner = {
      async spawn(args) {
        if (args.includes("-tzf")) {
          return { exitCode: 0, stdout: "../evil\n", stderr: "" };
        }
        if (args.includes("-tvzf")) {
          return {
            exitCode: 0,
            stdout: "-rw-r--r--  0 user group 1 Jan 1 00:00 ../evil\n",
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected spawn" };
      },
    };

    await expect(
      inspectImportArchive({ archivePath, spawner }),
    ).rejects.toThrow(/unsafe archive entry/);
  });

  test("rejects symlink entries before extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-import-link-"));
    cleanup.push(root);
    const archivePath = join(root, "bad-link.tar.gz");
    await writeFile(archivePath, "fake", "utf8");

    const spawner: Spawner = {
      async spawn(args) {
        if (args.includes("-tzf")) {
          return {
            exitCode: 0,
            stdout: "tinytool/\ntinytool/manifest.json\ntinytool/link\n",
            stderr: "",
          };
        }
        if (args.includes("-tvzf")) {
          return {
            exitCode: 0,
            stdout:
              "drwxr-xr-x  0 user group 0 Jan 1 00:00 tinytool/\n" +
              "-rw-r--r--  0 user group 1 Jan 1 00:00 tinytool/manifest.json\n" +
              "lrwxr-xr-x  0 user group 0 Jan 1 00:00 tinytool/link -> /tmp/out\n",
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
        };
      },
    };

    await expect(
      inspectImportArchive({ archivePath, spawner }),
    ).rejects.toThrow(/unsupported entry type "l"/);
  });
});

async function buildArchive(): Promise<{ archivePath: string }> {
  const root = mkdtempSync(join(tmpdir(), "almanac-import-src-"));
  cleanup.push(root);
  const almanacDir = join(root, "tinytool");
  await mkdir(almanacDir, { recursive: true });
  await writeManifest(almanacDir, {
    schemaVersion: "0.1.0",
    almanacId: "tinytool",
    version: "0.1.0",
    domain: "Tiny Tool",
    displayName: "Tiny Tool",
    freshnessProfileId: "mixed",
    toolCount: 1,
    factCount: 1,
    bootstrappedAt: "2026-01-01T00:00:00.000Z",
    compiledAt: "2026-01-01T00:00:00.000Z",
    forgerVersion: "test",
  });
  await mkdir(join(almanacDir, "tools"), { recursive: true });
  await writeFile(join(almanacDir, "tools", "query_facts.json"), "{}\n", "utf8");
  await mkdir(join(almanacDir, "extracted"), { recursive: true });
  await writeFile(join(almanacDir, "extracted", "facts.jsonl"), "{}\n", "utf8");

  const archivePath = join(root, "tinytool.tar.gz");
  await runExport({ almanacDir, outputPath: archivePath });
  return { archivePath };
}
