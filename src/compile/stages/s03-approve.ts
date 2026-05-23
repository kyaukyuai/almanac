/**
 * Stage 3 — source approval gate.
 *
 * Flips a draft `SourcesFile` (the output of Stage 2b) to `status: "approved"`
 * by recording `approvedAt` and `approvedBy`. This is the only mutation Stage 3
 * performs; downstream stages (4 fetch, 5 extract, ...) refuse to run on a
 * draft file.
 *
 * The CLI invokes this function:
 *   - automatically (`by: "auto"`) when `almanac new` runs with default flags
 *     (UX-first: --auto-approve is the default).
 *   - after an interactive confirmation (`by: "human"`) when the user passes
 *     `--require-approval`.
 *
 * The function is pure: it returns a new object and never mutates input. It
 * re-parses the result through `SourcesFileSchema` so any drift between the
 * draft contents and the approved-state invariants is caught immediately
 * (e.g., the schema enforces that `approvedAt`/`approvedBy` exist iff
 * `status === "approved"`).
 */

import { SourcesFileSchema, type SourcesFile } from "../../core/types.ts";

export interface ApprovalOptions {
  /** Who/what approved. `"auto"` for `--auto-approve`, `"human"` for confirmed. */
  by: "auto" | "human";
  /** Timestamp to record. Defaults to `new Date()`. Injectable for tests. */
  at?: Date;
}

export class AlreadyApprovedError extends Error {
  constructor(public readonly file: SourcesFile) {
    super(
      `cannot approve: SourcesFile is already approved ` +
        `(approvedAt=${file.approvedAt ?? "?"}, approvedBy=${file.approvedBy ?? "?"})`,
    );
    this.name = "AlreadyApprovedError";
  }
}

/**
 * Returns a new `SourcesFile` with `status: "approved"`, recording when and
 * by whom. Throws `AlreadyApprovedError` if the input is already approved.
 */
export function approveSources(
  file: SourcesFile,
  opts: ApprovalOptions,
): SourcesFile {
  if (file.status === "approved") {
    throw new AlreadyApprovedError(file);
  }
  const at = (opts.at ?? new Date()).toISOString();
  const next: SourcesFile = {
    ...file,
    status: "approved",
    approvedAt: at,
    approvedBy: opts.by,
  };
  // Re-validate through the schema. This catches any future drift between the
  // draft contents and the approved-state invariants.
  return SourcesFileSchema.parse(next);
}
