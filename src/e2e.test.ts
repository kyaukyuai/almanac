/**
 * End-to-end integration test.
 *
 * Walks the entire compile pipeline (Stages 0–10) in-process using a mocked
 * LLM, stub discovery, and stub fetcher. Then opens an `AlmanacRuntime` over
 * the resulting on-disk artifacts and exercises the `query_facts` default
 * tool to prove that real facts flow all the way from the extractor through
 * the SQLite + FTS5 index into the runtime.
 *
 * No network, no real LLM: every external surface is stubbed. Cost = 0.
 *
 * If this test breaks, e2e is broken.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AlmanacManifest,
  type ApprovedSource,
  type CompileState,
  type DomainSpec,
  type ExtractionResult,
  type SourceDiscoveryPlan,
  type SourceFetchEntry,
  type SourcesFile,
  type Stage11Output,
  type StageId,
  type ToolDesignResult,
  type ToolManifest,
} from "./core/types.ts";
import {
  AlmanacManifestSchema,
  BenchmarkReportSchema,
  CompileStateSchema,
} from "./core/types.ts";
import type {
  FetchContext,
  Fetcher,
} from "./compile/fetchers/types.ts";
import { createMockProvider } from "./llm/mock.ts";
import { runPipeline } from "./compile/pipeline.ts";
import {
  ensureAlmanacLayout,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";
import { createDomainAnalysisRunner } from "./compile/stages/s01-domain-analysis.ts";
import { createSourceDiscoveryPlannerRunner } from "./compile/stages/s02a-source-discovery-planner.ts";
import { createSourceDiscoveryExecutorRunner } from "./compile/stages/s02x-source-discovery-executor.ts";
import { createSourceDiscoveryEvaluatorRunner } from "./compile/stages/s02b-source-discovery-evaluator.ts";
import { createApproveRunner } from "./compile/stages/s03-approve-runner.ts";
import { createSourceFetchRunner } from "./compile/stages/s04-source-fetch-runner.ts";
import { createFactExtractionRunner } from "./compile/stages/s05-fact-extraction.ts";
import { createToolDesignRunner } from "./compile/stages/s06-tool-design.ts";
import { createToolImplRunner } from "./compile/stages/s07-tool-impl-runner.ts";
import { createLlmCodeWriter } from "./compile/stages/s07/code-writer.ts";
import { createBunxTscRunner } from "./compile/stages/s07/tsc-runner.ts";
import { createBunSmokeRunner } from "./compile/stages/s07/smoke-runner.ts";
import { LlmImplementer } from "./compile/stages/s07/llm-implementer.ts";
import { createKnowledgeIndexRunner } from "./compile/stages/s08-knowledge-index-runner.ts";
import { createContractFilesRunner } from "./compile/stages/s09-contract-runner.ts";
import { createSkillAdapterRunner } from "./compile/stages/s10-skill-adapter-runner.ts";
import { createBenchmarkGenRunner } from "./compile/stages/s11-benchmark-gen.ts";
import { createBenchmarkRunRunner } from "./compile/stages/s12-benchmark-run-runner.ts";
import { markStageCompleted, sha256Hex } from "./compile/pipeline.ts";
import type {
  GithubSearcher,
  UrlProber,
  WebSearcher,
} from "./compile/discovery/types.ts";
import { createAlmanacRuntimeAsync } from "./serve/runtime.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Cleanup
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

// ──────────────────────────────────────────────────────────────────────────────
// Canned LLM outputs
// ──────────────────────────────────────────────────────────────────────────────

const DOMAIN_SPEC: DomainSpec = {
  domain: "kubernetes",
  canonicalSlug: "kubernetes",
  displayName: "Kubernetes",
  summary: "Container orchestration platform for declaratively running workloads.",
  subareas: ["core api", "scheduling", "networking"],
  intents: [
    { kind: "howto", example: "how do I write a controller?" },
    { kind: "lookup", example: "what is a pod?" },
  ],
  verbs: ["explain", "diagnose", "lookup-spec"],
  entityTypes: ["resource", "controller", "version"],
  freshnessProfile: {
    profileId: "mixed",
    defaultClass: "fast",
    classes: {
      static: { examples: ["controller pattern"] },
      slow: { examples: ["RBAC patterns"], maxAgeDays: 30 },
      fast: { examples: ["latest features"], maxAgeHours: 24 },
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
};

const DISCOVERY_PLAN: SourceDiscoveryPlan = {
  schemaVersion: "0.1.0",
  domain: { canonicalSlug: "kubernetes", displayName: "Kubernetes" },
  budgets: {
    maxWebSearchQueries: 0,
    maxGithubQueries: 0,
    maxUrlProbes: 4,
    maxCandidatesPerKind: 4,
    targetAcceptedSources: 1,
  },
  directProbes: [
    {
      hint: "https://kubernetes.io/docs/",
      kind: "docs",
      rationale: "Authoritative documentation home.",
    },
  ],
  webSearchQueries: [],
  githubQueries: [],
  coverageGoals: {
    docs: { min: 1, max: 3 },
    repo: { min: 0, max: 0 },
    news: { min: 0, max: 0 },
    community: { min: 0, max: 0 },
    academic: { min: 0, max: 0 },
    data: { min: 0, max: 0 },
    file: { min: 0, max: 0 },
    essay: { min: 0, max: 0 },
    book: { min: 0, max: 0 },
    talk: { min: 0, max: 0 },
  },
};

const DRAFT_SOURCES: SourcesFile = {
  schemaVersion: "0.1.0",
  status: "draft",
  generatedAt: "2026-05-08T12:00:00.000Z",
  generatedBy: {
    stage: "02-source-discovery",
    evaluatorPromptVersion: "evaluator-v1",
    candidateCount: 1,
    acceptedCount: 1,
  },
  coverage: {
    docs: 1,
    repo: 0,
    news: 0,
    community: 0,
    academic: 0,
    data: 0,
    file: 0,
    essay: 0,
    book: 0,
    talk: 0,
  },
  warnings: [],
  sources: [
    {
      id: "k8s-docs",
      url: "https://kubernetes.io/docs/",
      kind: "docs",
      trust: 0.95,
      volatility: "fast",
      rationale: "Authoritative documentation.",
      ingestion: {
        mode: "snapshot",
        scope: ["/"],
        refreshIntervalHours: 168,
      },
      notes: null,
    },
  ],
  rejected: [],
};

const EXTRACTION_RESULT: ExtractionResult = {
  schemaVersion: "0.1.0",
  status: "extracted",
  skipReason: null,
  coverage: {
    extractable: "Pod definition.",
    nonExtractable: "n/a",
  },
  facts: [
    {
      text: "A Pod is the smallest deployable unit in Kubernetes.",
      type: "definition",
      entities: ["pod", "resource"],
      excerpt: "A Pod is the smallest deployable unit in Kubernetes.",
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.95,
    },
    {
      text: "A Pod represents one or more containers that share storage and network.",
      type: "fact",
      entities: ["pod", "container"],
      excerpt:
        "A Pod represents one or more containers that share storage and network.",
      freshnessClass: "static",
      validUntilRelative: null,
      confidence: 0.92,
    },
  ],
};

// One synthetic custom tool exercised through LlmImplementer. The impl + test
// source below are hand-written (not LLM-emitted) but injected via the mock
// provider as if the LLM had produced them. This proves the entire LLM
// pipeline — code-writer → write-files → real `bun x tsc` → real `bun test`
// — wires together end-to-end.
const KUBERNETES_SAFETY_NOTE_MANIFEST: ToolManifest = {
  name: "kubernetes_safety_note",
  version: "0.1.0",
  description:
    "Return a canned safety/compatibility note for a Kubernetes operation, drawn from the official docs.",
  whenToUse:
    "When the user asks about a security or compatibility consideration for a specific Kubernetes feature.",
  returnsSummary: "{ topic, note } with one citation to the official docs.",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", description: "Kebab-case topic, e.g., rbac" } },
    required: ["topic"],
  },
  outputSchema: {
    type: "object",
    properties: { topic: { type: "string" }, note: { type: "string" } },
    required: ["topic", "note"],
  },
  capabilities: { network: [], fs: "none", subprocess: [], secrets: [] },
  volatilityClass: "static",
  freshness: {
    cachePolicy: "manual-refresh",
    ttlSeconds: null,
    sourceTimestamp: false,
  },
  knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
  examples: [
    {
      description: "rbac topic returns a non-empty note",
      input: { topic: "rbac" },
      expectedShape: "match-outputSchema",
    },
  ],
  designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
  disabled: false,
};

const SAFETY_NOTE_IMPL = `// AUTO-GENERATED by almanac Stage 7 (LlmImplementer). Do not edit by hand.
// kubernetes_safety_note — static lookup of canned safety advice.

export default async function kubernetes_safety_note(
  input: any,
  ctx: any,
): Promise<any> {
  const topic =
    typeof input?.topic === "string" ? input.topic.trim().toLowerCase() : "";
  if (topic.length === 0) {
    return {
      ok: false,
      error: { code: "bad-input", message: "\`topic\` is required", retryable: false },
    };
  }
  const NOTES: Record<string, string> = {
    rbac: "Always start with namespace-scoped roles before granting cluster-wide permissions.",
    "pod-security": "Run containers as non-root and drop all linux capabilities by default.",
  };
  const note =
    NOTES[topic] ??
    "No specific safety note recorded for this topic; consult the official documentation.";
  ctx?.log?.({ event: "kubernetes_safety_note", topic });
  return {
    ok: true,
    data: { topic, note },
    citations: [
      {
        sourceId: "k8s-docs",
        url: "https://kubernetes.io/docs/concepts/security/",
        fetchedAt: "2026-05-01T00:00:00.000Z",
        excerpt: "Security best practices in Kubernetes.",
      },
    ],
    freshness: { class: "static", maxAge: null, staleness: "fresh" },
  };
}
`;

const SAFETY_NOTE_TEST = `// AUTO-GENERATED by almanac Stage 7 (LlmImplementer). Do not edit by hand.
import { describe, expect, test } from "bun:test";
import safetyNote from "./kubernetes_safety_note.ts";

const ctx: any = { secrets: {}, log: () => {} };

describe("kubernetes_safety_note", () => {
  test("smoke: known topic returns ok envelope with citation", async () => {
    const r: any = await safetyNote({ topic: "rbac" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.citations.length).toBeGreaterThanOrEqual(1);
    expect(r.freshness.class).toBe("static");
    expect(r.data.topic).toBe("rbac");
  });
  test("bad input: returns ok:false with bad-input code", async () => {
    const r: any = await safetyNote({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("bad-input");
  });
});
`;

const TOOL_DESIGN: ToolDesignResult = {
  schemaVersion: "0.1.0",
  customTools: [KUBERNETES_SAFETY_NOTE_MANIFEST],
  rationale:
    "Adds one static safety-note lookup beyond the four defaults, exercising the LlmImplementer path end-to-end.",
};

const BENCHMARK_SET: Stage11Output = {
  schemaVersion: "0.1.0",
  set: {
    schemaVersion: "0.1.0",
    almanacId: "kubernetes",
    positive: [
      {
        id: "k8s-pos-pod-definition",
        query: "what is a Pod in Kubernetes?",
        intent: "lookup",
        rationale:
          "Stable Pod definition lookup over query_facts; should return ≥1 citation.",
        invocation: { tool: "query_facts", input: { q: "Pod" } },
        expected: {
          minCitations: 1,
          contains: ["Pod"],
          acceptableStaleness: ["fresh"],
        },
      },
    ],
    negative: [
      {
        id: "k8s-neg-stock-price",
        query: "what is today's apple stock price?",
        rationale:
          "Out of scope: stock prices are not in the Kubernetes almanac.",
        invocation: { tool: "query_facts", input: { q: "apple stock price" } },
        refusalReason: "out-of-scope",
        expected: { maxCitations: 0 },
      },
    ],
  },
  rationale:
    "Tiny e2e benchmark: one positive (Pod definition over query_facts) and one negative (out-of-scope query) to prove Stages 11 + 12 wire together end-to-end.",
};

const DOC_BODY =
  "A Pod is the smallest deployable unit in Kubernetes. " +
  "A Pod represents one or more containers that share storage and network.";

// ──────────────────────────────────────────────────────────────────────────────
// Stubs
// ──────────────────────────────────────────────────────────────────────────────

function stubProber(): UrlProber {
  return {
    name: "stub-prober",
    async probe(url: string) {
      return {
        url,
        fetchStatus: "ok",
        title: "Kubernetes Documentation",
        snippet: "Production-ready container orchestration",
        preview: "Kubernetes is an open-source container orchestrator…",
        meta: { httpStatusCode: 200, contentType: "text/html" },
      };
    },
  };
}

function nullWebSearcher(): WebSearcher {
  return {
    name: "null-web",
    async search() {
      return [];
    },
  };
}

function nullGithubSearcher(): GithubSearcher {
  return {
    name: "null-github",
    async search() {
      return [];
    },
  };
}

function stubFetcher(): Fetcher {
  return {
    name: "stub-fetcher",
    canHandle(_source: ApprovedSource): boolean {
      return true;
    },
    async fetch(
      source: ApprovedSource,
      ctx: FetchContext,
    ): Promise<SourceFetchEntry> {
      const bytes = new TextEncoder().encode(DOC_BODY);
      const meta = await ctx.writeRaw({
        bytes,
        mediaType: "text/html",
        extension: "html",
      });
      return {
        sourceId: source.id,
        status: "fetched",
        fetchedAt: ctx.now().toISOString(),
        finalUrl: source.url,
        fetcher: "stub-fetcher",
        documents: [
          {
            url: source.url,
            fetchedAt: ctx.now().toISOString(),
            mediaType: "text/html",
            byteLength: meta.byteLength,
            contentHash: meta.contentHash,
            relPath: meta.relPath,
            title: "Kubernetes Documentation",
          },
        ],
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────────────

async function freshAlmanac(): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-e2e-"));
  cleanup.push(root);
  const almanacDir = join(root, "kubernetes");
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "kubernetes",
    domain: "kubernetes",
    displayName: "Kubernetes",
    freshnessProfileId: "mixed",
    runId: "run-e2e",
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
  await writeManifest(almanacDir, manifest);

  const stage0Hash = sha256Hex(
    JSON.stringify(manifest) + "\n" + JSON.stringify(compileState),
  );
  const stage0Done = markStageCompleted(
    compileState,
    "00-bootstrap",
    new Date("2026-05-08T12:00:00.500Z"),
    { outputHash: stage0Hash },
  );
  await writeCompileState(almanacDir, stage0Done);

  return {
    almanacDir,
    manifest: AlmanacManifestSchema.parse(manifest),
    state: CompileStateSchema.parse(stage0Done),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// The test
// ──────────────────────────────────────────────────────────────────────────────

describe("end-to-end pipeline (in-process, all stubs, zero LLM cost)", () => {
  test(
    "compiles 0–12 then serves query_facts against real facts",
    async () => {
      const fx = await freshAlmanac();

      const provider = createMockProvider({
        responses: {
          "01-domain-analysis@v2": JSON.stringify(DOMAIN_SPEC),
          "02-source-discovery@planner-v1": JSON.stringify(DISCOVERY_PLAN),
          "02-source-discovery@evaluator-v1": JSON.stringify(DRAFT_SOURCES),
          "05-fact-extraction@v1": JSON.stringify(EXTRACTION_RESULT),
          "06-tool-design@v1": JSON.stringify(TOOL_DESIGN),
          "07-tool-impl@v1": JSON.stringify({
            implCode: SAFETY_NOTE_IMPL,
            testCode: SAFETY_NOTE_TEST,
          }),
          "11-benchmark-gen@v3": JSON.stringify(BENCHMARK_SET),
        },
      });

      const runners = {
        "01-domain-analysis": createDomainAnalysisRunner({ provider }),
        "02a-source-discovery-planner": createSourceDiscoveryPlannerRunner({
          provider,
        }),
        "02x-source-discovery-executor": createSourceDiscoveryExecutorRunner({
          prober: stubProber(),
          webSearcher: nullWebSearcher(),
          githubSearcher: nullGithubSearcher(),
        }),
        "02b-source-discovery-evaluator": createSourceDiscoveryEvaluatorRunner({
          provider,
        }),
        "03-source-approve": createApproveRunner(),
        "04-source-fetch": createSourceFetchRunner({
          fetchers: [stubFetcher()],
        }),
        "05-fact-extraction": createFactExtractionRunner({ provider }),
        "06-tool-design": createToolDesignRunner({ provider }),
        "07-tool-impl": createToolImplRunner({
          customToolImplementer: new LlmImplementer(),
          llm: createLlmCodeWriter({ provider }),
          tsc: createBunxTscRunner(),
          smoke: createBunSmokeRunner(),
        }),
        "08-knowledge-index": createKnowledgeIndexRunner(),
        "09-contract-files": createContractFilesRunner(),
        "10-adapter-generation": createSkillAdapterRunner(),
        "11-benchmark-gen": createBenchmarkGenRunner({ provider }),
        "12-benchmark-run": createBenchmarkRunRunner(),
      };

      const events: object[] = [];
      const result = await runPipeline({
        almanacDir: fx.almanacDir,
        state: fx.state,
        manifest: fx.manifest,
        runners,
        persistState: (s) => writeCompileState(fx.almanacDir, s),
        persistManifest: (m) => writeManifest(fx.almanacDir, m),
        log: (e) => events.push(e),
        now: () => new Date("2026-05-08T12:00:01.000Z"),
      });

      // Every stage 0–12 must succeed (or be already-completed for 00).
      const expected: StageId[] = [
        "00-bootstrap",
        "01-domain-analysis",
        "02a-source-discovery-planner",
        "02x-source-discovery-executor",
        "02b-source-discovery-evaluator",
        "03-source-approve",
        "04-source-fetch",
        "05-fact-extraction",
        "06-tool-design",
        "07-tool-impl",
        "08-knowledge-index",
        "09-contract-files",
        "10-adapter-generation",
        "11-benchmark-gen",
        "12-benchmark-run",
      ];
      for (const id of expected) {
        if (!result.succeeded.includes(id)) {
          throw new Error(
            `stage ${id} did not succeed; failed=${result.failed.join(",")} skipped=${result.skipped.join(",")} notReached=${result.notReached.join(",")}`,
          );
        }
      }

      // Key on-disk artifacts must exist.
      const must = [
        ".compile/domain-spec.json",
        ".compile/source-discovery-plan.json",
        ".compile/candidates.json",
        ".compile/sources.draft.json",
        "sources/sources.json",
        "sources/manifest.summary.json",
        "extracted/facts.jsonl",
        ".compile/tool-design.json",
        ".compile/stage07-output.json",
        "tools/query_facts.json",
        "tools/query_facts.ts",
        "tools/kubernetes_safety_note.json",
        "tools/kubernetes_safety_note.ts",
        "tools/kubernetes_safety_note.test.ts",
        "knowledge/almanac.sqlite",
        "knowledge/index-manifest.json",
        "DOMAIN.md",
        "AGENTS.md",
        "SKILLS.md",
        "adapters/skill/SKILL.md",
        ".compile/stage11-output.json",
        "tests/positive.jsonl",
        "tests/negative.jsonl",
        ".compile/benchmark-result.json",
      ];
      for (const rel of must) {
        if (!existsSync(join(fx.almanacDir, rel))) {
          throw new Error(`expected artifact missing: ${rel}`);
        }
      }

      // facts.jsonl actually has the two facts the LLM "extracted".
      const jsonl = readFileSync(
        join(fx.almanacDir, "extracted/facts.jsonl"),
        "utf8",
      );
      expect(jsonl.split("\n").filter((l) => l.length > 0).length).toBe(2);

      // Now spin up the runtime and prove the facts are reachable.
      const runtime = await createAlmanacRuntimeAsync({
        almanacDir: fx.almanacDir,
        log: () => {},
      });

      const tools = await runtime.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "fetch_official_docs",
        "kubernetes_safety_note",
        "latest_releases",
        "query_facts",
        "web_search_recent",
      ]);

      // The custom tool's manifest is marked implemented (not disabled) and
      // carries the LlmImplementer's provenance.
      const customManifest = tools.find(
        (t) => t.name === "kubernetes_safety_note",
      );
      expect(customManifest).toBeDefined();
      expect(customManifest!.disabled).toBe(false);
      expect(customManifest!.implementedBy?.tscPassed).toBe(true);
      expect(customManifest!.implementedBy?.smokePassed).toBe(true);

      // The runtime can actually dispatch the custom tool and validates its
      // ToolResult envelope.
      const safetyOut = await runtime.execTool("kubernetes_safety_note", {
        topic: "rbac",
      });
      if (!safetyOut.ok) {
        throw new Error(
          `kubernetes_safety_note returned an error: ${JSON.stringify(safetyOut.error)}`,
        );
      }
      expect(safetyOut.citations.length).toBeGreaterThanOrEqual(1);
      expect(safetyOut.freshness.class).toBe("static");

      const out = await runtime.execTool("query_facts", { q: "Pod" });
      if (!out.ok) {
        throw new Error(
          `query_facts returned an error: ${JSON.stringify(out.error)}`,
        );
      }
      const data = out.data as { hits?: Array<{ text: string }> };
      expect(Array.isArray(data.hits)).toBe(true);
      expect(data.hits!.length).toBeGreaterThanOrEqual(1);
      expect(data.hits![0]!.text.toLowerCase()).toContain("pod");

      // Stage 12 benchmark report: both fixtures must have passed against the
      // real runtime.
      const reportBody = readFileSync(
        join(fx.almanacDir, ".compile/benchmark-result.json"),
        "utf8",
      );
      const report = BenchmarkReportSchema.parse(JSON.parse(reportBody));
      expect(report.summary.total).toBe(2);
      expect(report.summary.passed).toBe(2);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.errored).toBe(0);
      expect(report.summary.citationRate).toBe(1);
    },
    // 60s budget. The bulk of the wall time is the Stage 7 LLM implementer
    // path spawning `bun x tsc` + `bun test` subprocesses for the synthetic
    // custom tool; on cold caches that can take 10–15 s.
    60_000,
  );
});

// Ensure mkdir import is used somewhere (silences unused-import lints in
// strict configs); also gives a single place to add per-suite setup later.
void mkdir;
