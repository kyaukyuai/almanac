/**
 * Stage 3 — pipeline adapter for source approval.
 *
 * Wraps the pure `approveSources` library function in a `StageRunner` so the
 * orchestrator can drive it. The runner:
 *
 *   1. Reads the draft `SourcesFile` produced by Stage 2b from
 *      `.compile/sources.draft.json`.
 *   2. If `state.options.autoApprove` is `true`, calls `approveSources`
 *      with `by: "auto"` and writes the approved file to
 *      `<almanacDir>/sources/sources.json` (the location Stage 4 reads).
 *   3. If `autoApprove` is `false`, returns `{ kind: "skipped" }` with reason
 *      `"human-approval-required"`. A future `almanac approve <id>` CLI
 *      command will perform the human-in-the-loop step.
 *
 * `outputHash` is the sha256 of the canonical approved-file JSON. Re-runs
 * with the same draft + same `at` produce the same hash; the orchestrator's
 * injected `now()` makes the timestamp deterministic in tests.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SourcesFileSchema,
  type SourcesFile,
} from "../../core/types.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { approveSources } from "./s03-approve.ts";
import { sourcesDraftPath } from "./s02b-source-discovery-evaluator.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────────

export const APPROVED_SOURCES_REL_PATH = "sources/sources.json";

/** Absolute path to the approved `SourcesFile` Stage 4 will read. */
export function approvedSourcesPath(almanacDir: string): string {
  return join(almanacDir, APPROVED_SOURCES_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingDraftSourcesError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 3 requires a Stage 2b draft SourcesFile at ${path}; ` +
        "run Stage 2b first or restore the file",
    );
    this.name = "MissingDraftSourcesError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateApproveRunnerOptions {
  /**
   * Test seam: read the upstream draft from a custom location instead of
   * `<almanacDir>/.compile/sources.draft.json`.
   */
  readDraft?: (almanacDir: string) => Promise<SourcesFile>;
}

/**
 * Build the Stage 3 `StageRunner`. Deterministic stage: `promptVersion = null`.
 */
export function createApproveRunner(
  opts: CreateApproveRunnerOptions = {},
): StageRunner {
  const readDraft = opts.readDraft ?? defaultReadDraft;
  return {
    promptVersion: null,
    async run(ctx) {
      const draft = await readDraft(ctx.almanacDir);

      if (!ctx.state.options.autoApprove) {
        ctx.log({
          event: "stage3:skipped",
          reason: "human-approval-required",
        });
        return {
          kind: "skipped",
          reason: "human-approval-required",
        };
      }

      const approved = approveSources(draft, { by: "auto", at: ctx.now() });
      const canonicalText = JSON.stringify(approved, null, 2);
      const outPath = approvedSourcesPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage3:approved",
        outputHash,
        sources: approved.sources.length,
        approvedAt: approved.approvedAt,
      });

      return {
        kind: "success",
        outputHash,
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function defaultReadDraft(almanacDir: string): Promise<SourcesFile> {
  const path = sourcesDraftPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingDraftSourcesError(path, cause);
    }
    throw cause;
  }
  return SourcesFileSchema.parse(JSON.parse(body));
}
