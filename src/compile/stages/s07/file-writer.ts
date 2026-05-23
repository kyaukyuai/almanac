/**
 * Concrete fs writer + manifest persister for Stage 7.
 *
 * The pipeline injects this as `ctx.writeToolFiles` so the implementer
 * (template- or LLM-driven) doesn't need to know about disk paths. Test
 * implementers can pass a mock that records calls instead.
 *
 * The manifest writer (`writeFinalManifest`) is separate because Stage 7
 * needs to persist the final, augmented `ToolManifest` (with
 * `implementedBy` or `disabled: true`) AFTER the implementation succeeds —
 * not while writing the source files.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ToolManifestSchema,
  type ToolManifest,
} from "../../../core/types.ts";

export interface ToolFilePaths {
  implPath: string;
  testPath: string;
}

/**
 * Write `<almanacDir>/tools/<name>.ts` and `<almanacDir>/tools/<name>.test.ts`.
 *
 * Returns the absolute paths so the orchestrator can pass them straight to
 * `tsc.check` / `smoke.test`.
 */
export async function writeToolFiles(input: {
  almanacDir: string;
  toolName: string;
  code: string;
  testCode: string;
}): Promise<ToolFilePaths> {
  const dir = join(input.almanacDir, "tools");
  await mkdir(dir, { recursive: true });
  const implPath = join(dir, `${input.toolName}.ts`);
  const testPath = join(dir, `${input.toolName}.test.ts`);
  await writeFile(implPath, input.code, "utf8");
  await writeFile(testPath, input.testCode, "utf8");
  return { implPath, testPath };
}

/** Persist a tool's final manifest as `<almanacDir>/tools/<name>.json`. */
export async function writeFinalManifest(input: {
  almanacDir: string;
  manifest: ToolManifest;
}): Promise<string> {
  const validated = ToolManifestSchema.parse(input.manifest);
  const dir = join(input.almanacDir, "tools");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${validated.name}.json`);
  const body = JSON.stringify(validated, null, 2) + "\n";
  await writeFile(path, body, "utf8");
  return path;
}
