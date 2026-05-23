/**
 * Stage 11 — benchmark generation (LLM-driven).
 *
 * Generates a `BenchmarkSet` for the compiled almanac:
 *   - `positive` fixtures exercise in-scope queries that should return
 *     citable answers via specific tools.
 *   - `negative` fixtures exercise out-of-scope or unsupported queries that
 *     should NOT return citations.
 *
 * **Skeleton.** The signature is committed; the body throws "not implemented"
 * until the LLM call lands. The LLM output is parsed via
 * `parseStage11Output` from `core/types.ts`, which validates cross-fixture
 * uniqueness and per-fixture invariants.
 */

import {
  parseStage11Output,
  type DomainSpec,
  type Stage11Output,
  type ToolManifest,
} from "../../core/types.ts";

export interface BenchmarkGenerator {
  readonly model: string;
  readonly promptVersion: string;
  /** Returns the raw JSON the LLM emitted; it will be parsed by Stage 11. */
  generate(input: {
    domainSpec: DomainSpec;
    /** Enabled tool manifests to bias the LLM's invocation choices. */
    manifests: ToolManifest[];
  }): Promise<unknown>;
}

export interface RunBenchmarkGenInput {
  domainSpec: DomainSpec;
  manifests: ToolManifest[];
  generator: BenchmarkGenerator;
}

/**
 * **Skeleton.** When implemented, this should:
 *   1. call `input.generator.generate({ domainSpec, manifests })`
 *   2. validate the raw output via `parseStage11Output`
 *   3. enforce that every fixture's `invocation.tool` references an enabled tool
 *   4. return the validated `Stage11Output`
 */
export async function runBenchmarkGen(
  input: RunBenchmarkGenInput,
): Promise<Stage11Output> {
  void input;
  void parseStage11Output;
  throw new Error(
    "runBenchmarkGen: not implemented. " +
      "Wire `BenchmarkGenerator.generate` (Stage 11 LLM call) and remove this throw.",
  );
}
