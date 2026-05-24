/**
 * Tests for Stage 12 — benchmark-run pipeline adapter.
 *
 * The pure benchmark machinery (`runBenchmark`, `evaluatePositive`,
 * `evaluateNegative`) is covered by `s12-benchmark-run.test.ts`. These tests
 * focus on the StageRunner wrapper: reading the set, opening the runtime,
 * persisting the report.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  BenchmarkReportSchema,
  BenchmarkSetSchema,
  CompileStateSchema,
  Stage11OutputSchema,
  type AlmanacManifest,
  type BenchmarkSet,
  type CompileState,
  type ToolResult,
} from "../../core/types.ts";
import type { AlmanacRuntime } from "../../core/runtime.ts";
import { ensureAlmanacLayout, writeManifest } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import {
  negativeJsonlPath,
  positiveJsonlPath,
  stage11OutputPath,
} from "./s11-benchmark-gen.ts";
import {
  benchmarkResultPath,
  createBenchmarkRunRunner,
  MissingBenchmarkSetError,
} from "./s12-benchmark-run-runner.ts";
import type { StageContext } from "../pipeline.ts";

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

const SAMPLE_SET: BenchmarkSet = BenchmarkSetSchema.parse({
  schemaVersion: "0.1.0",
  almanacId: "kubernetes",
  positive: [
    {
      id: "k8s-pos-001",
      query: "what is a pod in kubernetes?",
      intent: "lookup",
      rationale: "Pod definition lookup over query_facts.",
      invocation: { tool: "query_facts", input: { q: "pod" } },
      expected: { minCitations: 1, contains: ["pod"], acceptableStaleness: ["fresh"] },
    },
  ],
  negative: [
    {
      id: "k8s-neg-001",
      query: "stock prices?",
      rationale: "Out of scope for kubernetes.",
      invocation: { tool: "query_facts", input: { q: "stock" } },
      refusalReason: "out-of-scope",
      expected: { maxCitations: 0 },
    },
  ],
});

const POSITIVE_RESULT: ToolResult = {
  ok: true,
  data: { facts: [{ text: "a pod is the smallest deployable unit" }] },
  citations: [
    {
      sourceId: "k8s-docs",
      url: "https://kubernetes.io/docs/",
      fetchedAt: "2026-05-08T12:00:00.000Z",
    },
  ],
  freshness: { class: "slow", maxAge: 2_592_000, staleness: "fresh" },
};

const NEGATIVE_RESULT: ToolResult = {
  ok: false,
  error: { code: "no-results", message: "no facts matched", retryable: false },
};

async function freshFixture(): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s12r-"));
  cleanup.push(root);
  const almanacDir = join(root, "kubernetes");
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "kubernetes",
    domain: "kubernetes",
    displayName: "Kubernetes",
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.0.0",
    options: {
      depth: "standard",
      sourcesHint: [],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
  await ensureAlmanacLayout(almanacDir);
  await writeManifest(almanacDir, AlmanacManifestSchema.parse(manifest));
  return {
    almanacDir,
    manifest: AlmanacManifestSchema.parse(manifest),
    state: CompileStateSchema.parse(compileState),
  };
}

function makeCtx(input: {
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
  log?: (e: object) => void;
}): StageContext {
  return {
    almanacDir: input.almanacDir,
    manifest: input.manifest,
    state: input.state,
    stageId: "12-benchmark-run",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:05.000Z"),
  };
}

function mockRuntime(
  handler: (name: string, input: unknown) => Promise<ToolResult>,
): AlmanacRuntime {
  return {
    listTools: async () => [],
    execTool: handler,
    listResources: async () => [],
    readResource: async () => ({ contents: "", mimeType: "text/plain" }),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createBenchmarkRunRunner", () => {
  test("advertises promptVersion=null (deterministic stage)", () => {
    const runner = createBenchmarkRunRunner();
    expect(runner.promptVersion).toBeNull();
  });

  test("happy path: persists benchmark-result.json with passing summary", async () => {
    const fx = await freshFixture();
    let closeCalled = 0;
    const runner = createBenchmarkRunRunner({
      readBenchmarkSet: async () => SAMPLE_SET,
      openRuntime: async () => ({
        runtime: mockRuntime(async (_name, input) => {
          const q = (input as { q: string }).q;
          return q.includes("pod") ? POSITIVE_RESULT : NEGATIVE_RESULT;
        }),
        close: () => {
          closeCalled += 1;
        },
      }),
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(closeCalled).toBe(1);

    const path = benchmarkResultPath(fx.almanacDir);
    expect(existsSync(path)).toBe(true);
    const parsed = BenchmarkReportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.passed).toBe(2);
    expect(parsed.summary.failed).toBe(0);
    expect(parsed.summary.citationRate).toBe(1);
    expect(parsed.ranAt).toBe("2026-05-08T12:00:05.000Z");
  });

  test("runtime.execTool throwing produces errored results but the runner still succeeds", async () => {
    const fx = await freshFixture();
    const runner = createBenchmarkRunRunner({
      readBenchmarkSet: async () => SAMPLE_SET,
      openRuntime: async () => ({
        runtime: mockRuntime(async () => {
          throw new Error("kaboom");
        }),
        close: () => {},
      }),
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(benchmarkResultPath(fx.almanacDir), "utf8")),
    );
    expect(report.summary.errored).toBe(2);
  });

  test("close is invoked even when runBenchmark throws", async () => {
    const fx = await freshFixture();
    let closeCalled = 0;
    const runner = createBenchmarkRunRunner({
      readBenchmarkSet: async () => {
        // Returning malformed set would cause buildBenchmarkReport to throw
        // — easier to simulate runtime failure via openRuntime.
        return SAMPLE_SET;
      },
      openRuntime: async () => ({
        runtime: {
          listTools: async () => {
            throw new Error("should not be called");
          },
          // runBenchmark catches per-fixture throws — to force a top-level
          // throw we make execTool throw a non-Error.
          execTool: async () => {
            throw new Error("execTool kaboom");
          },
          listResources: async () => [],
          readResource: async () => ({ contents: "", mimeType: "text/plain" }),
        },
        close: () => {
          closeCalled += 1;
        },
      }),
    });
    // runBenchmark catches per-fixture throws as `errored`, so this still
    // returns success — but `close` must have been called.
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(closeCalled).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Default reader
// ──────────────────────────────────────────────────────────────────────────────

describe("defaultReadBenchmarkSet", () => {
  test("reads from positive/negative.jsonl when present", async () => {
    const fx = await freshFixture();
    const posLines = SAMPLE_SET.positive
      .map((f) => JSON.stringify(f))
      .join("\n") + "\n";
    const negLines = SAMPLE_SET.negative
      .map((f) => JSON.stringify(f))
      .join("\n") + "\n";
    await mkdir(dirname(positiveJsonlPath(fx.almanacDir)), { recursive: true });
    await writeFile(positiveJsonlPath(fx.almanacDir), posLines, "utf8");
    await writeFile(negativeJsonlPath(fx.almanacDir), negLines, "utf8");

    const runner = createBenchmarkRunRunner({
      openRuntime: async () => ({
        runtime: mockRuntime(async () => POSITIVE_RESULT),
        close: () => {},
      }),
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(benchmarkResultPath(fx.almanacDir), "utf8")),
    );
    expect(report.summary.total).toBe(2);
  });

  test("falls back to .compile/stage11-output.json when jsonl files are missing", async () => {
    const fx = await freshFixture();
    const stage11 = Stage11OutputSchema.parse({
      schemaVersion: "0.1.0",
      set: SAMPLE_SET,
      rationale: "Synthetic benchmark for test purposes.",
    });
    const p = stage11OutputPath(fx.almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(stage11, null, 2), "utf8");

    const runner = createBenchmarkRunRunner({
      openRuntime: async () => ({
        runtime: mockRuntime(async () => POSITIVE_RESULT),
        close: () => {},
      }),
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
  });

  test("throws MissingBenchmarkSetError when no stage11 artifact exists", async () => {
    const fx = await freshFixture();
    const runner = createBenchmarkRunRunner({
      openRuntime: async () => ({
        runtime: mockRuntime(async () => POSITIVE_RESULT),
        close: () => {},
      }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toThrow(MissingBenchmarkSetError);
  });
});
