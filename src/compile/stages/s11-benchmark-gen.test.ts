/**
 * Tests for Stage 11 — benchmark generation runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  DomainSpecSchema,
  INTENT_LENIENT_REMAP,
  PositiveFixtureSchema,
  NegativeFixtureSchema,
  Stage11OutputSchema,
  buildBenchmarkReport,
  normalizeStage11Output,
  parseStage11Output,
  type AlmanacManifest,
  type BenchmarkResult,
  type BenchmarkSet,
  type CompileState,
  type DomainSpec,
  type Stage11Output,
  type ToolManifest,
} from "../../core/types.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
} from "../../llm/provider.ts";
import { createMockProvider } from "../../llm/mock.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import {
  BenchmarkPreflightCoverageError,
  BenchmarkPreflightValidationError,
  InvalidFixtureInvocationError,
  NoEnabledToolsError,
  STAGE11_PROMPT_VERSION,
  buildPreflightBenchmarkSet,
  buildTradeoffBenchmarkGuidance,
  createBenchmarkGenRunner,
  defaultReadFactSample,
  isPreflightSafeToolManifest,
  normalizePositiveContainsForFactsTools,
  negativeJsonlPath,
  positiveJsonlPath,
  stage11OutputPath,
  validateInvocations,
} from "./s11-benchmark-gen.ts";
import { factsJsonlPath } from "./s05-fact-extraction.ts";
import type { StageContext } from "../pipeline.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

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

const VALID_DOMAIN_SPEC: DomainSpec = DomainSpecSchema.parse({
  domain: "kubernetes",
  canonicalSlug: "kubernetes",
  displayName: "Kubernetes",
  summary: "Container orchestration platform.",
  subareas: ["core api", "scheduling"],
  intents: [
    { kind: "lookup", example: "what is a pod?" },
    { kind: "explain", example: "what is the controller pattern?" },
  ],
  verbs: ["explain", "lookup"],
  entityTypes: ["resource", "controller"],
  freshnessProfile: {
    profileId: "mixed",
    defaultClass: "fast",
    classes: {
      static: { examples: ["controller pattern"] },
      slow: { examples: ["RBAC"], maxAgeDays: 30 },
      fast: { examples: ["releases"], maxAgeHours: 24 },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://kubernetes.io/docs/", kind: "docs" },
    { hint: "https://kubernetes.io/blog/", kind: "news" },
    { hint: "https://github.com/kubernetes/kubernetes", kind: "repo" },
  ],
  suggestedTools: [],
  cautions: [],
});

function buildManifest(name: string, vol: "static" | "slow" | "fast" = "slow"): ToolManifest {
  return {
    name,
    version: "0.1.0",
    description: `Test tool ${name} for benchmark generation unit tests.`,
    whenToUse: `Use ${name} when running stage 11 tests; this is a synthetic manifest.`,
    returnsSummary: "Returns a synthetic result shape for test purposes.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    outputSchema: {
      type: "object",
      properties: { facts: { type: "array" } },
      required: ["facts"],
    },
    capabilities: { network: [], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: vol,
    freshness:
      vol === "fast"
        ? { cachePolicy: "ttl", ttlSeconds: 3600, sourceTimestamp: false }
        : { cachePolicy: "manual-refresh", ttlSeconds: null, sourceTimestamp: false },
    knowledgeUsage: {
      facts: vol !== "fast",
      ftsQuery: vol !== "fast" ? "{q}" : null,
      embeddings: false,
    },
    sourceDependencies: [],
    sampleUrls: [],
    examples: [
      {
        description: `${name} smoke`,
        input: { q: "test" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
    disabled: false,
  };
}

function buildNetworkManifest(name: string): ToolManifest {
  const manifest = buildManifest(name, "fast");
  manifest.capabilities = {
    ...manifest.capabilities,
    network: ["api.example.com"],
  };
  manifest.knowledgeUsage = {
    facts: false,
    ftsQuery: null,
    embeddings: false,
  };
  manifest.sampleUrls = ["https://api.example.com/example"];
  return manifest;
}

function buildStage11Output(toolName: string): Stage11Output {
  return Stage11OutputSchema.parse({
    schemaVersion: "0.1.0",
    set: {
      schemaVersion: "0.1.0",
      almanacId: "kubernetes",
      positive: [
        {
          id: "k8s-pos-001",
          query: "what is a pod in kubernetes?",
          intent: "lookup",
          rationale: "Stable lookup over query_facts; should cite the docs source.",
          invocation: { tool: toolName, input: { q: "pod" } },
          expected: {
            minCitations: 1,
            contains: ["pod"],
            acceptableStaleness: ["fresh", "warm"],
          },
        },
      ],
      negative: [
        {
          id: "k8s-neg-001",
          query: "what is today's apple stock price?",
          rationale: "Out of scope for a kubernetes almanac; expect no citations.",
          invocation: { tool: toolName, input: { q: "apple stock" } },
          refusalReason: "out-of-scope",
          expected: { maxCitations: 0 },
        },
      ],
    },
    rationale:
      "Tiny synthetic benchmark covering one positive and one negative fixture against query_facts.",
  });
}

function addDeterministicCoverage(
  output: Stage11Output,
  toolName: string,
  positives: number,
  negatives: number,
): void {
  const positiveBase = output.set.positive[0]!;
  for (let i = output.set.positive.length + 1; i <= positives; i++) {
    output.set.positive.push({
      ...positiveBase,
      id: `k8s-pos-${String(i).padStart(3, "0")}`,
      query: `what is controller topic ${i}?`,
      invocation: { tool: toolName, input: { q: `controller ${i}` } },
      expected: {
        ...positiveBase.expected,
        contains: [],
      },
    });
  }

  const negativeBase = output.set.negative[0]!;
  for (let i = output.set.negative.length + 1; i <= negatives; i++) {
    output.set.negative.push({
      ...negativeBase,
      id: `k8s-neg-${String(i).padStart(3, "0")}`,
      query: `out of scope benchmark query ${i}`,
      invocation: { tool: toolName, input: { q: `out-of-scope ${i}` } },
    });
  }
}

function benchmarkReportFor(
  set: BenchmarkSet,
  failedFixtureIds: readonly string[] = [],
) {
  const failed = new Set(failedFixtureIds);
  const results: BenchmarkResult[] = [
    ...set.positive.map((f) => ({
      fixtureId: f.id,
      kind: "positive" as const,
      status: failed.has(f.id) ? "fail" as const : "pass" as const,
      observed: failed.has(f.id)
        ? { ok: false, citationsCount: 0, staleness: null, errorCode: "no-results" }
        : { ok: true, citationsCount: 1, staleness: "fresh" as const, errorCode: null },
      durationMs: 0,
      reason: failed.has(f.id) ? "preflight fixture failed" : "preflight passed",
    })),
    ...set.negative.map((f) => ({
      fixtureId: f.id,
      kind: "negative" as const,
      status: failed.has(f.id) ? "fail" as const : "pass" as const,
      observed: failed.has(f.id)
        ? { ok: true, citationsCount: 1, staleness: "fresh" as const, errorCode: null }
        : { ok: false, citationsCount: 0, staleness: null, errorCode: "no-results" },
      durationMs: 0,
      reason: failed.has(f.id) ? "preflight fixture failed" : "preflight passed",
    })),
  ];
  return buildBenchmarkReport({
    almanacId: set.almanacId,
    ranAt: new Date("2026-05-08T12:00:03.000Z"),
    set,
    results,
  });
}

async function freshFixture(): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s11-"));
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
  const p = domainSpecPath(almanacDir);
  await mkdir(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(VALID_DOMAIN_SPEC, null, 2), "utf8");
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
    stageId: "11-benchmark-gen",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:02.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure helper
// ──────────────────────────────────────────────────────────────────────────────

describe("validateInvocations", () => {
  test("accepts fixtures whose tool name is enabled", () => {
    const out = buildStage11Output("query_facts");
    expect(() =>
      validateInvocations(out.set, new Set(["query_facts"])),
    ).not.toThrow();
  });

  test("rejects fixtures whose tool name is not enabled", () => {
    const out = buildStage11Output("nonexistent_tool");
    expect(() =>
      validateInvocations(out.set, new Set(["query_facts"])),
    ).toThrow(InvalidFixtureInvocationError);
  });
});

describe("normalizePositiveContainsForFactsTools", () => {
  test("clears brittle contains checks for facts-backed positive fixtures", () => {
    const out = buildStage11Output("query_facts");
    const normalized = normalizePositiveContainsForFactsTools(out, [
      buildManifest("query_facts", "slow"),
    ]);

    expect(normalized.changedFixtureIds).toEqual(["k8s-pos-001"]);
    expect(normalized.output.set.positive[0]!.expected.contains).toEqual([]);
  });

  test("leaves live-fetch positive fixtures unchanged", () => {
    const out = buildStage11Output("fetch_docs");
    const manifest = buildManifest("fetch_docs", "fast");
    manifest.capabilities = {
      ...manifest.capabilities,
      network: ["docs.example.com"],
    };
    const normalized = normalizePositiveContainsForFactsTools(out, [manifest]);

    expect(normalized.changedFixtureIds).toEqual([]);
    expect(normalized.output.set.positive[0]!.expected.contains).toEqual(["pod"]);
  });
});

describe("buildPreflightBenchmarkSet", () => {
  test("keeps only deterministic facts-backed fixtures", () => {
    const out = buildStage11Output("query_facts");
    out.set.positive.push({
      ...out.set.positive[0]!,
      id: "k8s-pos-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    out.set.negative.push({
      ...out.set.negative[0]!,
      id: "k8s-neg-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });

    const plan = buildPreflightBenchmarkSet(out.set, [
      buildManifest("query_facts", "slow"),
      buildNetworkManifest("latest_releases"),
    ]);

    expect(plan.set?.positive.map((f) => f.id)).toEqual(["k8s-pos-001"]);
    expect(plan.set?.negative.map((f) => f.id)).toEqual(["k8s-neg-001"]);
    expect(plan.includedFixtureIds).toEqual(["k8s-pos-001", "k8s-neg-001"]);
    expect(plan.skippedFixtureIds.sort()).toEqual([
      "k8s-neg-live",
      "k8s-pos-live",
    ]);
  });

  test("returns null when no complete deterministic subset can run", () => {
    const out = buildStage11Output("latest_releases");
    const plan = buildPreflightBenchmarkSet(out.set, [
      buildNetworkManifest("latest_releases"),
    ]);

    expect(plan.set).toBeNull();
    expect(plan.includedFixtureIds).toEqual([]);
    expect(plan.skippedFixtureIds.sort()).toEqual(["k8s-neg-001", "k8s-pos-001"]);
  });

  test("classifies facts-backed no-network tools as preflight-safe only", () => {
    expect(isPreflightSafeToolManifest(buildManifest("query_facts", "slow"))).toBe(
      true,
    );
    expect(isPreflightSafeToolManifest(buildNetworkManifest("latest_releases"))).toBe(
      false,
    );
  });
});

describe("buildTradeoffBenchmarkGuidance", () => {
  test("surfaces co-occurring tradeoff entities and comparison-shaped tools", () => {
    const compareTool = buildManifest("compare_runtime", "slow");
    compareTool.whenToUse =
      "Compare A vs B runtime tradeoffs using indexed facts.";
    compareTool.inputSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a", "b"],
    };

    const guidance = buildTradeoffBenchmarkGuidance(
      [
        {
          text: "WAL mode trades write concurrency against checkpoint overhead.",
          type: "tradeoff",
          entities: ["wal", "checkpoint"],
          sourceId: "sqlite-docs",
        },
        {
          text: "A normal fact should not become a tradeoff opportunity.",
          type: "fact",
          entities: ["normal", "fact"],
          sourceId: "sqlite-docs",
        },
      ],
      [compareTool, buildManifest("query_facts", "slow")],
    );

    expect(guidance.required).toBe(true);
    expect(guidance.opportunities).toEqual([
      {
        text: "WAL mode trades write concurrency against checkpoint overhead.",
        entities: ["wal", "checkpoint"],
        sourceId: "sqlite-docs",
      },
    ]);
    expect(guidance.comparisonTools).toEqual([
      {
        name: "compare_runtime",
        reason: "input-pair",
        inputFields: ["a", "b"],
        factsBacked: true,
      },
    ]);
    expect(guidance.fallbackFactsTools).toEqual(["query_facts"]);
  });

  test("does not require comparison coverage without sampled tradeoff facts", () => {
    const guidance = buildTradeoffBenchmarkGuidance(
      [
        {
          text: "Controllers reconcile desired state.",
          type: "principle",
          entities: ["controller", "desired-state"],
          sourceId: "kubernetes-docs",
        },
      ],
      [buildManifest("query_facts", "slow")],
    );

    expect(guidance.required).toBe(false);
    expect(guidance.opportunities).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Pre-parse lenient intent remap
// ──────────────────────────────────────────────────────────────────────────────

describe("INTENT_LENIENT_REMAP / normalizeStage11Output", () => {
  test("table covers the known LLM intent typos and maps them to debug", () => {
    expect(Object.keys(INTENT_LENIENT_REMAP).sort()).toEqual([
      "diagnose",
      "diagnose-error",
      "troubleshoot",
      "troubleshooting",
    ]);
    expect(new Set(Object.values(INTENT_LENIENT_REMAP))).toEqual(
      new Set(["debug"]),
    );
  });

  test("remaps 'diagnose-error' to 'debug' (regression — Rust smoke)", () => {
    const raw = buildStage11Output("query_facts") as unknown as {
      set: { positive: Array<{ intent: string }> };
    };
    raw.set.positive[0]!.intent = "diagnose-error";
    const normalized = normalizeStage11Output(raw) as typeof raw;
    expect(normalized.set.positive[0]!.intent).toBe("debug");
  });

  test("parseStage11Output applies the remap before schema validation", () => {
    const raw = buildStage11Output("query_facts") as unknown as {
      set: { positive: Array<{ intent: string }> };
    };
    raw.set.positive[0]!.intent = "troubleshoot";
    const parsed = parseStage11Output(raw);
    expect(parsed.set.positive[0]!.intent).toBe("debug");
  });

  test("non-object input is returned unchanged (schema raises its own error)", () => {
    expect(normalizeStage11Output(null)).toBeNull();
    expect(normalizeStage11Output("not-an-object")).toBe("not-an-object");
    expect(normalizeStage11Output([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("leaves unknown intent values for the schema to reject (loud)", () => {
    const raw = buildStage11Output("query_facts") as unknown as {
      set: { positive: Array<{ intent: string }> };
    };
    raw.set.positive[0]!.intent = "totally-unknown-intent";
    const normalized = normalizeStage11Output(raw) as typeof raw;
    expect(normalized.set.positive[0]!.intent).toBe("totally-unknown-intent");
    expect(() => parseStage11Output(raw)).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createBenchmarkGenRunner", () => {
  test("advertises promptVersion=v1", () => {
    const runner = createBenchmarkGenRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    expect(runner.promptVersion).toBe(STAGE11_PROMPT_VERSION);
  });

  test("happy path: persists positive/negative jsonl + stage11-output.json", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(buildStage11Output("query_facts")),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.llmCalls).toBe(1);
    expect(outcome.cost?.tokens.output).toBeGreaterThan(0);

    // Stage 11 artifact + jsonl files all exist.
    expect(existsSync(stage11OutputPath(fx.almanacDir))).toBe(true);
    expect(existsSync(positiveJsonlPath(fx.almanacDir))).toBe(true);
    expect(existsSync(negativeJsonlPath(fx.almanacDir))).toBe(true);

    const posLines = readFileSync(positiveJsonlPath(fx.almanacDir), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const negLines = readFileSync(negativeJsonlPath(fx.almanacDir), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(posLines).toHaveLength(1);
    expect(negLines).toHaveLength(1);
    expect(() => PositiveFixtureSchema.parse(JSON.parse(posLines[0]!))).not.toThrow();
    expect(() => NegativeFixtureSchema.parse(JSON.parse(negLines[0]!))).not.toThrow();
  });

  test("passes runtime-relevant manifest fields to the prompt", async () => {
    const fx = await freshFixture();
    const manifest = buildManifest("fetch_docs", "fast");
    manifest.capabilities = {
      ...manifest.capabilities,
      network: ["docs.example.com"],
    };
    manifest.knowledgeUsage = {
      facts: false,
      ftsQuery: null,
      embeddings: false,
    };
    manifest.sourceDependencies = ["kubernetes-docs"];
    manifest.sampleUrls = ["https://docs.example.com/kubernetes/operator"];

    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(buildStage11Output("fetch_docs")),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      readEnabledManifests: async () => [manifest],
    });

    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");

    const prompt = provider.callLog[0]!.request.messages
      .map((m) => m.content)
      .join("\n");
    expect(prompt).toContain('"outputSchema"');
    expect(prompt).toContain('"capabilities"');
    expect(prompt).toContain('"knowledgeUsage"');
    expect(prompt).toContain('"sourceDependencies"');
    expect(prompt).toContain('"sampleUrls"');
    expect(prompt).toContain("https://docs.example.com/kubernetes/operator");
  });

  test("passes tradeoff fixture guidance to the prompt", async () => {
    const fx = await freshFixture();
    const compareTool = buildManifest("compare_runtime", "slow");
    compareTool.whenToUse =
      "Compare A vs B runtime tradeoffs using indexed facts.";
    compareTool.inputSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a", "b"],
    };

    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(buildStage11Output("query_facts")),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      readEnabledManifests: async () => [
        buildManifest("query_facts", "slow"),
        compareTool,
      ],
      readFactSample: async () => [
        {
          text: "WAL mode trades write concurrency against checkpoint overhead.",
          type: "tradeoff",
          entities: ["wal", "checkpoint"],
          sourceId: "sqlite-docs",
        },
      ],
    });

    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");

    const prompt = provider.callLog[0]!.request.messages
      .map((m) => m.content)
      .join("\n");
    expect(prompt).toContain("tradeoffGuidance:");
    expect(prompt).toContain('"required":true');
    expect(prompt).toContain('"wal"');
    expect(prompt).toContain('"checkpoint"');
    expect(prompt).toContain('"compare_runtime"');
  });

  test("preflights a normalized benchmark set before persisting", async () => {
    const fx = await freshFixture();
    const observedSets: BenchmarkSet[] = [];
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(buildStage11Output("query_facts")),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) => {
        observedSets.push(set);
        return benchmarkReportFor(set);
      },
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });

    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");

    expect(observedSets).toHaveLength(1);
    expect(observedSets[0]!.positive[0]!.expected.contains).toEqual([]);
    const persisted = Stage11OutputSchema.parse(
      JSON.parse(readFileSync(stage11OutputPath(fx.almanacDir), "utf8")),
    );
    expect(persisted.set.positive[0]!.expected.contains).toEqual([]);
  });

  test("does not execute live/network fixtures during Stage 11 preflight", async () => {
    const fx = await freshFixture();
    const out = buildStage11Output("query_facts");
    addDeterministicCoverage(out, "query_facts", 8, 4);
    out.set.positive.push({
      ...out.set.positive[0]!,
      id: "k8s-pos-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    out.set.negative.push({
      ...out.set.negative[0]!,
      id: "k8s-neg-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    const observedSets: BenchmarkSet[] = [];
    const logs: object[] = [];
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(out),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) => {
        observedSets.push(set);
        expect(set.positive.map((f) => f.id)).not.toContain("k8s-pos-live");
        expect(set.negative.map((f) => f.id)).not.toContain("k8s-neg-live");
        return benchmarkReportFor(set);
      },
      readEnabledManifests: async () => [
        buildManifest("query_facts", "slow"),
        buildNetworkManifest("latest_releases"),
      ],
    });

    const outcome = await runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) }));
    if (outcome.kind !== "success") throw new Error("expected success");

    expect(observedSets).toHaveLength(1);
    const persisted = Stage11OutputSchema.parse(
      JSON.parse(readFileSync(stage11OutputPath(fx.almanacDir), "utf8")),
    );
    expect(persisted.set.positive.map((f) => f.id)).not.toContain("k8s-pos-live");
    expect(persisted.set.negative.map((f) => f.id)).not.toContain("k8s-neg-live");
    expect(persisted.set.positive).toHaveLength(8);
    expect(persisted.set.negative).toHaveLength(4);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:preflight:filtered",
        skippedFixtureIds: ["k8s-pos-live", "k8s-neg-live"],
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:preflight:stabilized",
        reason: "unverified-fixtures",
        dropped: ["k8s-pos-live", "k8s-neg-live"],
      }),
    );
  });

  test("retries when unpreflighted fixtures would drop below minimum coverage", async () => {
    const fx = await freshFixture();
    const unstable = buildStage11Output("query_facts");
    unstable.set.positive.push({
      ...unstable.set.positive[0]!,
      id: "k8s-pos-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    unstable.set.negative.push({
      ...unstable.set.negative[0]!,
      id: "k8s-neg-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    const repaired = buildStage11Output("query_facts");
    addDeterministicCoverage(repaired, "query_facts", 8, 4);

    let call = 0;
    const logs: object[] = [];
    const provider = createMockProvider({
      defaultResponse: () => {
        call += 1;
        return JSON.stringify(call === 1 ? unstable : repaired);
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 2,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) => benchmarkReportFor(set),
      readEnabledManifests: async () => [
        buildManifest("query_facts", "slow"),
        buildNetworkManifest("latest_releases"),
      ],
    });

    const outcome = await runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) }));
    if (outcome.kind !== "success") throw new Error("expected success");

    expect(call).toBe(2);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:llm:retry",
        reason: "preflight-failed",
      }),
    );
    const persisted = Stage11OutputSchema.parse(
      JSON.parse(readFileSync(stage11OutputPath(fx.almanacDir), "utf8")),
    );
    expect(persisted.set.positive.map((f) => f.id)).not.toContain("k8s-pos-live");
    expect(persisted.set.negative.map((f) => f.id)).not.toContain("k8s-neg-live");
  });

  test("refuses final unpreflighted stabilization below minimum coverage", async () => {
    const fx = await freshFixture();
    const out = buildStage11Output("query_facts");
    out.set.positive.push({
      ...out.set.positive[0]!,
      id: "k8s-pos-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    out.set.negative.push({
      ...out.set.negative[0]!,
      id: "k8s-neg-live",
      invocation: { tool: "latest_releases", input: { owner: "x", repo: "y" } },
    });
    const logs: object[] = [];
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(out),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 1,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) => benchmarkReportFor(set),
      readEnabledManifests: async () => [
        buildManifest("query_facts", "slow"),
        buildNetworkManifest("latest_releases"),
      ],
    });

    await expect(
      runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) })),
    ).rejects.toBeInstanceOf(BenchmarkPreflightCoverageError);
    expect(existsSync(stage11OutputPath(fx.almanacDir))).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:preflight:stabilization-skipped",
        skippedFixtureIds: ["k8s-pos-live", "k8s-neg-live"],
      }),
    );
  });

  test("skips Stage 11 preflight when every fixture is live/network-backed", async () => {
    const fx = await freshFixture();
    const out = buildStage11Output("latest_releases");
    const logs: object[] = [];
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(out),
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async () => {
        throw new Error("preflight should not execute network-backed fixtures");
      },
      readEnabledManifests: async () => [buildNetworkManifest("latest_releases")],
    });

    const outcome = await runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) }));
    if (outcome.kind !== "success") throw new Error("expected success");

    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:preflight:skipped",
        reason: "no-deterministic-fixtures",
      }),
    );
  });

  test("retries when runtime preflight fails, then persists the repaired set", async () => {
    const fx = await freshFixture();
    let call = 0;
    const provider = createMockProvider({
      defaultResponse: () => {
        call += 1;
        return JSON.stringify(buildStage11Output("query_facts"));
      },
    });
    let preflightCall = 0;
    const logs: object[] = [];
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 2,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) => {
        preflightCall += 1;
        return benchmarkReportFor(
          set,
          preflightCall === 1 ? ["k8s-pos-001"] : [],
        );
      },
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });

    const outcome = await runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) }));
    if (outcome.kind !== "success") throw new Error("expected success");

    expect(call).toBe(2);
    expect(preflightCall).toBe(2);
    expect(outcome.llmCalls).toBe(2);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:llm:retry",
        reason: "preflight-failed",
      }),
    );
  });

  test("drops still-failing fixtures on the final preflight attempt", async () => {
    const fx = await freshFixture();
    const out = buildStage11Output("query_facts");
    for (let i = 2; i <= 9; i++) {
      out.set.positive.push({
        ...out.set.positive[0]!,
        id: `k8s-pos-00${i}`,
        query: `what is controller topic ${i}?`,
        invocation: { tool: "query_facts", input: { q: `controller ${i}` } },
      });
    }
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(out),
      },
    });
    const logs: object[] = [];
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 1,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) =>
        benchmarkReportFor(set, ["k8s-pos-001"]),
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });

    const outcome = await runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) }));
    if (outcome.kind !== "success") throw new Error("expected success");

    const persisted = Stage11OutputSchema.parse(
      JSON.parse(readFileSync(stage11OutputPath(fx.almanacDir), "utf8")),
    );
    expect(persisted.set.positive.map((f) => f.id)).toEqual([
      "k8s-pos-002",
      "k8s-pos-003",
      "k8s-pos-004",
      "k8s-pos-005",
      "k8s-pos-006",
      "k8s-pos-007",
      "k8s-pos-008",
      "k8s-pos-009",
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:preflight:stabilized",
        dropped: ["k8s-pos-001"],
      }),
    );
  });

  test("refuses final stabilization that would drop below minimum coverage", async () => {
    const fx = await freshFixture();
    const out = buildStage11Output("query_facts");
    for (let i = 2; i <= 9; i++) {
      out.set.positive.push({
        ...out.set.positive[0]!,
        id: `k8s-pos-00${i}`,
        query: `what is controller topic ${i}?`,
        invocation: { tool: "query_facts", input: { q: `controller ${i}` } },
      });
    }
    const provider = createMockProvider({
      responses: {
        "11-benchmark-gen@v3": JSON.stringify(out),
      },
    });
    const logs: object[] = [];
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 1,
      preflightGeneratedSet: true,
      preflightBenchmarkSet: async (_dir, set) =>
        benchmarkReportFor(set, ["k8s-pos-001", "k8s-pos-002"]),
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });

    await expect(
      runner.run(makeCtx({ ...fx, log: (e) => logs.push(e) })),
    ).rejects.toBeInstanceOf(BenchmarkPreflightValidationError);
    expect(existsSync(stage11OutputPath(fx.almanacDir))).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "stage11:preflight:stabilization-skipped",
      }),
    );
  });

  test("throws NoEnabledToolsError when zero manifests are enabled", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({ defaultResponse: "{}" });
    const runner = createBenchmarkGenRunner({
      provider,
      readEnabledManifests: async () => [],
    });
    await expect(runner.run(makeCtx(fx))).rejects.toThrow(NoEnabledToolsError);
  });

  test("retries on bad JSON then succeeds", async () => {
    const fx = await freshFixture();
    let call = 0;
    const provider = createMockProvider({
      defaultResponse: () => {
        call += 1;
        if (call === 1) return "not json at all";
        return JSON.stringify(buildStage11Output("query_facts"));
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 2,
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(call).toBe(2);
    expect(outcome.llmCalls).toBe(2);
  });

  test("retries on invalid invocation then succeeds", async () => {
    const fx = await freshFixture();
    let call = 0;
    const provider = createMockProvider({
      defaultResponse: () => {
        call += 1;
        if (call === 1) {
          // First attempt: references a tool that is not enabled.
          return JSON.stringify(buildStage11Output("ghost_tool"));
        }
        return JSON.stringify(buildStage11Output("query_facts"));
      },
    });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 2,
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(call).toBe(2);
  });

  test("after exhausting attempts on bad JSON, surfaces LlmJsonParseError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({ defaultResponse: "still not json" });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 2,
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
  });

  test("after exhausting attempts on schema failure, surfaces LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: JSON.stringify({ schemaVersion: "0.1.0" }),
    });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 1,
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });

  test("after exhausting attempts on invalid invocation, surfaces InvalidFixtureInvocationError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: JSON.stringify(buildStage11Output("ghost_tool")),
    });
    const runner = createBenchmarkGenRunner({
      provider,
      maxAttempts: 1,
      readEnabledManifests: async () => [buildManifest("query_facts", "slow")],
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      InvalidFixtureInvocationError,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// defaultReadFactSample
// ──────────────────────────────────────────────────────────────────────────────

describe("defaultReadFactSample", () => {
  async function seedFacts(
    almanacDir: string,
    factCount: number,
  ): Promise<void> {
    const fp = factsJsonlPath(almanacDir);
    await mkdir(dirname(fp), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < factCount; i++) {
      // ULID regex excludes I/L/O/U; use all-digit IDs to dodge those.
      // Must be exactly 26 chars.
      const ulid = String(1_000_000 + i).padStart(26, "0");
      lines.push(
        JSON.stringify({
          id: ulid,
          text: `Fact number ${i} about sqlite syntax.`,
          type: "fact",
          entities: [`entity-${i}`],
          source: {
            sourceId: `src-${i % 3}`,
            contentHash: "a".repeat(64),
            url: `https://example.com/${i}`,
            excerpt: `Fact number ${i} about sqlite syntax.`,
          },
          freshnessClass: "static",
          validUntil: null,
          confidence: 0.9,
          extractedAt: "2026-05-08T12:00:00.000Z",
          extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
        }),
      );
    }
    writeFileSync(fp, lines.join("\n") + "\n", "utf8");
  }

  test("missing facts.jsonl → empty array (no throw)", async () => {
    const fx = await freshFixture();
    const sample = await defaultReadFactSample(fx.almanacDir, 20);
    expect(sample).toEqual([]);
  });

  test("size=0 → empty array (no read)", async () => {
    const fx = await freshFixture();
    await seedFacts(fx.almanacDir, 50);
    expect(await defaultReadFactSample(fx.almanacDir, 0)).toEqual([]);
  });

  test("evenly spaces samples across the corpus", async () => {
    const fx = await freshFixture();
    await seedFacts(fx.almanacDir, 50);
    const sample = await defaultReadFactSample(fx.almanacDir, 10);
    expect(sample).toHaveLength(10);
    // step = 50 / 10 = 5; samples should be facts 0, 5, 10, 15, ...
    expect(sample[0]!.entities[0]).toBe("entity-0");
    expect(sample[1]!.entities[0]).toBe("entity-5");
    expect(sample[9]!.entities[0]).toBe("entity-45");
    // Compact shape: only the routing-relevant fields.
    expect(Object.keys(sample[0]!).sort()).toEqual([
      "entities",
      "sourceId",
      "text",
      "type",
    ]);
  });

  test("size > factCount → all facts returned", async () => {
    const fx = await freshFixture();
    await seedFacts(fx.almanacDir, 3);
    const sample = await defaultReadFactSample(fx.almanacDir, 20);
    expect(sample).toHaveLength(3);
  });

  test("malformed lines are skipped silently", async () => {
    const fx = await freshFixture();
    const fp = factsJsonlPath(fx.almanacDir);
    await mkdir(dirname(fp), { recursive: true });
    writeFileSync(
      fp,
      [
        "not-json",
        JSON.stringify({
          id: "01H8Q5Z2QJK4VXNTRWP3M7XYZ0",
          text: "Valid fact text long enough to satisfy schema.",
          type: "fact",
          entities: ["x"],
          source: {
            sourceId: "src-1",
            contentHash: "a".repeat(64),
            url: "https://example.com",
            excerpt: "Valid fact text long enough to satisfy schema.",
          },
          freshnessClass: "static",
          validUntil: null,
          confidence: 0.9,
          extractedAt: "2026-05-08T12:00:00.000Z",
          extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
        }),
        "{invalid-json:",
      ].join("\n") + "\n",
      "utf8",
    );
    const sample = await defaultReadFactSample(fx.almanacDir, 10);
    expect(sample).toHaveLength(1);
    expect(sample[0]!.text).toContain("Valid fact text");
  });
});
