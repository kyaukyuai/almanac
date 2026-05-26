/**
 * Tests for Stage 6 — tool-design runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  DomainSpecSchema,
  SourcesFileSchema,
  ToolDesignResultSchema,
  type AlmanacManifest,
  type CompileState,
  type DomainSpec,
  type SourcesFile,
  type ToolDesignResult,
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
import { approvedSourcesPath } from "./s03-approve-runner.ts";
import { factsJsonlPath } from "./s05-fact-extraction.ts";
import {
  MissingApprovedSourcesError,
  MissingDomainSpecError,
  MissingFactsError,
  STAGE6_PROMPT_VERSION,
  buildSourceModeSummary,
  createToolDesignRunner,
  defaultReadFactCoverage,
  toolDesignPath,
} from "./s06-tool-design.ts";
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
  subareas: ["core api", "scheduling", "networking"],
  intents: [
    { kind: "howto", example: "how do I write a controller?" },
    { kind: "lookup", example: "what is the kubelet?" },
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
});

const APPROVED_SOURCES: SourcesFile = SourcesFileSchema.parse({
  schemaVersion: "0.1.0",
  status: "approved",
  generatedAt: "2026-05-08T12:00:00.000Z",
  approvedAt: "2026-05-08T12:00:00.500Z",
  approvedBy: "auto",
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
});

function buildCustomTool(name: string): ToolManifest {
  return {
    name,
    version: "0.1.0",
    description:
      "Look up the OpenAPI schema fragment for a Kubernetes resource at a specific minor version.",
    whenToUse:
      "When the user asks about the fields or validation of a Kubernetes resource at a specific version.",
    returnsSummary:
      "JSON schema fragment for the requested resource with field descriptions.",
    inputSchema: {
      type: "object",
      properties: { resource: { type: "string" } },
      required: ["resource"],
    },
    outputSchema: {
      type: "object",
      properties: { schema: { type: "object" } },
      required: ["schema"],
    },
    capabilities: {
      network: ["raw.githubusercontent.com"],
      fs: "none",
      subprocess: [],
      secrets: [],
    },
    volatilityClass: "fast",
    freshness: {
      cachePolicy: "ttl",
      ttlSeconds: 86400,
      sourceTimestamp: false,
    },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    sourceDependencies: [],
    examples: [
      {
        description: "Pod returns a schema",
        input: { resource: "Pod" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v2" },
    disabled: false,
  };
}

function buildToolDesignResult(): ToolDesignResult {
  return ToolDesignResultSchema.parse({
    schemaVersion: "0.1.0",
    customTools: [buildCustomTool("lookup_resource_spec")],
    rationale:
      "Kubernetes users frequently need version-aware spec lookups that the four defaults cannot perform.",
  });
}

const FACTS_JSONL_BODY = [
  JSON.stringify({
    id: "01H8Q5Z2QJK4VXNTRWP3M7XYZ0",
    text: "A Pod is the smallest deployable unit in Kubernetes.",
    type: "definition",
    entities: ["pod"],
    source: {
      sourceId: "k8s-docs",
      contentHash:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      url: "https://kubernetes.io/docs/",
      excerpt: "A Pod is the smallest deployable unit in Kubernetes.",
    },
    freshnessClass: "static",
    validUntil: null,
    confidence: 0.95,
    extractedAt: "2026-05-08T12:00:01.000Z",
    extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
  }),
  JSON.stringify({
    id: "01H8Q5Z2QJK4VXNTRWP3M7XYZ1",
    text: "To create a Pod, apply a YAML manifest to the API server.",
    type: "procedure",
    entities: ["pod", "kubectl"],
    source: {
      sourceId: "k8s-docs",
      contentHash:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      url: "https://kubernetes.io/docs/",
      excerpt: "To create a Pod, apply a YAML manifest to the API server.",
    },
    freshnessClass: "slow",
    validUntil: "2027-05-08T12:00:01.000Z",
    confidence: 0.92,
    extractedAt: "2026-05-08T12:00:01.000Z",
    extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
  }),
].join("\n") + "\n";

async function freshFixture(opts?: {
  withDomainSpec?: boolean;
  withApproved?: boolean;
  withFacts?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s06-"));
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
  if (opts?.withDomainSpec !== false) {
    const p = domainSpecPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(VALID_DOMAIN_SPEC, null, 2), "utf8");
  }
  if (opts?.withApproved !== false) {
    const p = approvedSourcesPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(APPROVED_SOURCES, null, 2), "utf8");
  }
  if (opts?.withFacts !== false) {
    const p = factsJsonlPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, FACTS_JSONL_BODY, "utf8");
  }
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
    stageId: "06-tool-design",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:02.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createToolDesignRunner", () => {
  test("advertises promptVersion=v3", () => {
    const runner = createToolDesignRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    expect(runner.promptVersion).toBe(STAGE6_PROMPT_VERSION);
    expect(STAGE6_PROMPT_VERSION).toBe("v3");
  });

  test("happy path: persists tool-design.json with deterministic outputHash", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "06-tool-design@v3": JSON.stringify(buildToolDesignResult()),
      },
    });
    const outcome = await createToolDesignRunner({ provider }).run(
      makeCtx(fx),
    );
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.llmCalls).toBe(1);

    const body = readFileSync(toolDesignPath(fx.almanacDir), "utf8");
    const parsed = ToolDesignResultSchema.parse(JSON.parse(body));
    expect(parsed.customTools.length).toBe(1);
    expect(parsed.customTools[0]!.name).toBe("lookup_resource_spec");

    const fx2 = await freshFixture();
    const provider2 = createMockProvider({
      responses: {
        "06-tool-design@v3": JSON.stringify(buildToolDesignResult()),
      },
    });
    const outcome2 = await createToolDesignRunner({ provider: provider2 }).run(
      makeCtx(fx2),
    );
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("forwards domainSpec/sourcesFile/factCoverage + sourceModeSummary into the user message", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "06-tool-design@v3": JSON.stringify(buildToolDesignResult()),
      },
    });
    await createToolDesignRunner({ provider }).run(makeCtx(fx));
    const userMsg = provider.callLog[0]!.request.messages.find(
      (m) => m.role === "user",
    )!;
    expect(userMsg.content).toContain("domainSpec:");
    expect(userMsg.content).toContain("sourcesFile:");
    expect(userMsg.content).toContain("factCoverage:");
    expect(userMsg.content).toContain("sourceModeSummary:");
    expect(userMsg.content).toContain("kubernetes");
    expect(userMsg.content).toContain("k8s-docs");
    expect(userMsg.content).toContain("factsExtracted");
    expect(userMsg.content).toContain("snapshotIds");
  });

  test("empty customTools is a valid happy path", async () => {
    const fx = await freshFixture();
    const empty: ToolDesignResult = ToolDesignResultSchema.parse({
      schemaVersion: "0.1.0",
      customTools: [],
      rationale:
        "The four default tools fully cover this domain's expected workflows.",
    });
    const provider = createMockProvider({
      responses: { "06-tool-design@v3": JSON.stringify(empty) },
    });
    const outcome = await createToolDesignRunner({ provider }).run(
      makeCtx(fx),
    );
    if (outcome.kind !== "success") throw new Error("expected success");
    const body = readFileSync(toolDesignPath(fx.almanacDir), "utf8");
    const parsed = ToolDesignResultSchema.parse(JSON.parse(body));
    expect(parsed.customTools.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Failure modes
// ──────────────────────────────────────────────────────────────────────────────

describe("createToolDesignRunner — failures", () => {
  test("missing domain spec → MissingDomainSpecError", async () => {
    const fx = await freshFixture({ withDomainSpec: false });
    const runner = createToolDesignRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingDomainSpecError,
    );
  });

  test("missing approved sources → MissingApprovedSourcesError", async () => {
    const fx = await freshFixture({ withApproved: false });
    const runner = createToolDesignRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingApprovedSourcesError,
    );
  });

  test("missing facts.jsonl → MissingFactsError", async () => {
    const fx = await freshFixture({ withFacts: false });
    const runner = createToolDesignRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingFactsError,
    );
  });

  test("non-JSON output → LlmJsonParseError", async () => {
    const fx = await freshFixture();
    const runner = createToolDesignRunner({
      provider: createMockProvider({ defaultResponse: "not json" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
  });

  test("schema mismatch → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    // Missing rationale + customTools → fails ToolDesignResultSchema.
    const runner = createToolDesignRunner({
      provider: createMockProvider({
        defaultResponse: '{"schemaVersion":"0.1.0"}',
      }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });

  test("default-name collision in customTools → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    // A custom tool whose name collides with `query_facts` — should be
    // rejected by ToolDesignResultSchema's superRefine.
    const collide = {
      schemaVersion: "0.1.0",
      customTools: [{ ...buildCustomTool("query_facts") }],
      rationale:
        "This should fail because query_facts collides with a default name.",
    };
    const runner = createToolDesignRunner({
      provider: createMockProvider({
        defaultResponse: JSON.stringify(collide),
      }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Retry on validation failure
// ──────────────────────────────────────────────────────────────────────────────

describe("createToolDesignRunner — retry on validation failure", () => {
  test("schema-violation on first attempt + valid on second → success, llmCalls=2", async () => {
    const fx = await freshFixture();
    let call = 0;
    const provider = createMockProvider({
      responses: {
        "06-tool-design@v3": () => {
          call += 1;
          if (call === 1) {
            // First attempt: missing required `rationale` field.
            return JSON.stringify({ schemaVersion: "0.1.0", customTools: [] });
          }
          // Second attempt: corrected.
          return JSON.stringify({
            schemaVersion: "0.1.0",
            customTools: [],
            rationale: "Defaults are sufficient after retry feedback.",
          });
        },
      },
    });
    const events: object[] = [];
    const outcome = await createToolDesignRunner({ provider }).run(
      makeCtx({ ...fx, log: (e) => events.push(e) }),
    );
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.llmCalls).toBe(2);
    expect(provider.callLog.length).toBe(2);
    // Retry call must echo the prior bad output back to the model.
    const secondCall = provider.callLog[1]!.request.messages;
    expect(secondCall.length).toBeGreaterThanOrEqual(4); // sys, user, asst, user
    expect(secondCall.some((m) => m.role === "assistant")).toBe(true);
    expect(
      secondCall.find((m) => m.role === "assistant")!.content,
    ).toContain('"schemaVersion":"0.1.0"');
    // A retry event was emitted with the schema-validation reason.
    const retryEvent = events.find(
      (e) => (e as { event?: string }).event === "stage6:llm:retry",
    ) as { reason?: string } | undefined;
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.reason).toBe("schema-validation");
  });

  test("json-parse fail on first attempt + valid on second → success, llmCalls=2", async () => {
    const fx = await freshFixture();
    let call = 0;
    const provider = createMockProvider({
      responses: {
        "06-tool-design@v3": () => {
          call += 1;
          if (call === 1) return "this is not json at all";
          return JSON.stringify({
            schemaVersion: "0.1.0",
            customTools: [],
            rationale: "Defaults cover this domain.",
          });
        },
      },
    });
    const events: object[] = [];
    const outcome = await createToolDesignRunner({ provider }).run(
      makeCtx({ ...fx, log: (e) => events.push(e) }),
    );
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.llmCalls).toBe(2);
    const retryEvent = events.find(
      (e) => (e as { event?: string }).event === "stage6:llm:retry",
    ) as { reason?: string } | undefined;
    expect(retryEvent!.reason).toBe("json-parse");
  });

  test("both attempts fail → throws LlmSchemaValidationError after maxAttempts", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: '{"schemaVersion":"0.1.0"}', // always schema-invalid
    });
    await expect(
      createToolDesignRunner({ provider }).run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(LlmSchemaValidationError);
    // Default maxAttempts=2 means exactly 2 calls before giving up.
    expect(provider.callLog.length).toBe(2);
  });

  test("maxAttempts=1 disables retry (legacy behavior)", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: '{"schemaVersion":"0.1.0"}',
    });
    await expect(
      createToolDesignRunner({ provider, maxAttempts: 1 }).run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(LlmSchemaValidationError);
    expect(provider.callLog.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// defaultReadFactCoverage
// ──────────────────────────────────────────────────────────────────────────────

describe("defaultReadFactCoverage", () => {
  test("counts records by freshnessClass", async () => {
    const fx = await freshFixture();
    const cov = await defaultReadFactCoverage(fx.almanacDir);
    expect(cov.factsExtracted).toBe(2);
    expect(cov.byFreshnessClass.static).toBe(1);
    expect(cov.byFreshnessClass.slow).toBe(1);
  });

  test("skips blank lines and malformed records", async () => {
    const fx = await freshFixture({ withFacts: false });
    const p = factsJsonlPath(fx.almanacDir);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      [
        "",
        "not json",
        '{"id":"not-a-ulid"}',
        FACTS_JSONL_BODY.split("\n")[0]!,
        "",
      ].join("\n"),
      "utf8",
    );
    const cov = await defaultReadFactCoverage(fx.almanacDir);
    expect(cov.factsExtracted).toBe(1);
    expect(cov.byFreshnessClass.static).toBe(1);
    expect(cov.byFreshnessClass.slow).toBe(0);
  });

  test("missing facts.jsonl → MissingFactsError", async () => {
    const fx = await freshFixture({ withFacts: false });
    await expect(defaultReadFactCoverage(fx.almanacDir)).rejects.toBeInstanceOf(
      MissingFactsError,
    );
  });
});

describe("buildSourceModeSummary", () => {
  test("groups source ids by ingestion.mode and counts each bucket", () => {
    const summary = buildSourceModeSummary(
      SourcesFileSchema.parse({
        ...APPROVED_SOURCES,
        coverage: { ...APPROVED_SOURCES.coverage, docs: 1, repo: 2, news: 1 },
        generatedBy: {
          ...APPROVED_SOURCES.generatedBy,
          candidateCount: 4,
          acceptedCount: 4,
        },
        sources: [
          APPROVED_SOURCES.sources[0]!, // k8s-docs, snapshot
          {
            id: "k8s-repo",
            url: "https://github.com/kubernetes/kubernetes",
            kind: "repo",
            trust: 0.95,
            volatility: "fast",
            rationale: "Upstream.",
            ingestion: {
              mode: "index-only",
              scope: ["/"],
              refreshIntervalHours: 168,
            },
            notes: null,
          },
          {
            id: "k8s-blog",
            url: "https://kubernetes.io/blog/",
            kind: "news",
            trust: 0.9,
            volatility: "fast",
            rationale: "Official blog.",
            ingestion: {
              mode: "feed",
              scope: ["/feed/"],
              refreshIntervalHours: 24,
            },
            notes: null,
          },
          {
            id: "k8s-rfcs",
            url: "https://github.com/kubernetes/enhancements",
            kind: "repo",
            trust: 0.92,
            volatility: "slow",
            rationale: "Enhancement proposals.",
            ingestion: {
              mode: "snapshot",
              scope: ["/keps/"],
              refreshIntervalHours: 168,
            },
            notes: null,
          },
        ],
      }),
    );
    expect(summary.counts).toEqual({ snapshot: 2, indexOnly: 1, feed: 1 });
    expect(summary.snapshotIds).toEqual(["k8s-docs", "k8s-rfcs"]);
    expect(summary.indexOnlyIds).toEqual(["k8s-repo"]);
    expect(summary.feedIds).toEqual(["k8s-blog"]);
  });

  test("returns empty arrays for an empty sources list", () => {
    const summary = buildSourceModeSummary(
      SourcesFileSchema.parse({
        ...APPROVED_SOURCES,
        coverage: {
          docs: 0, repo: 0, news: 0, community: 0, academic: 0,
          data: 0, file: 0, essay: 0, book: 0, talk: 0,
        },
        generatedBy: {
          ...APPROVED_SOURCES.generatedBy,
          candidateCount: 0,
          acceptedCount: 0,
        },
        sources: [],
      }),
    );
    expect(summary.counts).toEqual({ snapshot: 0, indexOnly: 0, feed: 0 });
    expect(summary.snapshotIds).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// v0.3 — source-mode awareness
//
// Reproduces the v0.2.6 failure mode where Stage 6 designed fact-store-reading
// tools on top of index-only sources, and Stage 7 implemented them faithfully
// but uselessly (runtime calls returned empty).
// ──────────────────────────────────────────────────────────────────────────────

async function freshIndexOnlyFixture(): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s06-idx-"));
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

  const sources: SourcesFile = SourcesFileSchema.parse({
    ...APPROVED_SOURCES,
    coverage: { ...APPROVED_SOURCES.coverage, docs: 1, repo: 1 },
    generatedBy: {
      ...APPROVED_SOURCES.generatedBy,
      candidateCount: 2,
      acceptedCount: 2,
    },
    sources: [
      APPROVED_SOURCES.sources[0]!,
      {
        id: "k8s-repo",
        url: "https://github.com/kubernetes/kubernetes",
        kind: "repo",
        trust: 0.95,
        volatility: "fast",
        rationale: "Upstream source repository.",
        ingestion: {
          mode: "index-only",
          scope: ["/"],
          refreshIntervalHours: 168,
        },
        notes: null,
      },
    ],
  });

  const p = domainSpecPath(almanacDir);
  await mkdir(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(VALID_DOMAIN_SPEC, null, 2), "utf8");
  const sp = approvedSourcesPath(almanacDir);
  await mkdir(dirname(sp), { recursive: true });
  writeFileSync(sp, JSON.stringify(sources, null, 2), "utf8");
  const fp = factsJsonlPath(almanacDir);
  await mkdir(dirname(fp), { recursive: true });
  await writeFile(fp, FACTS_JSONL_BODY, "utf8");

  return {
    almanacDir,
    manifest: AlmanacManifestSchema.parse(manifest),
    state: CompileStateSchema.parse(compileState),
  };
}

function makeFactsTool(
  name: string,
  sourceDependencies: string[],
): ToolManifest {
  return {
    ...buildCustomTool(name),
    volatilityClass: "static",
    freshness: {
      cachePolicy: "manual-refresh",
      ttlSeconds: null,
      sourceTimestamp: false,
    },
    knowledgeUsage: { facts: true, ftsQuery: "{q}", embeddings: false },
    sourceDependencies,
  };
}

describe("createToolDesignRunner — v0.3 source-mode awareness", () => {
  test("rejects facts:true tool that depends only on index-only sources", async () => {
    const fx = await freshIndexOnlyFixture();
    const badDesign = {
      schemaVersion: "0.1.0",
      customTools: [makeFactsTool("lookup_std_item", ["k8s-repo"])],
      rationale:
        "This should fail because k8s-repo is index-only; the fact store will be empty for it.",
    };
    const provider = createMockProvider({
      defaultResponse: JSON.stringify(badDesign),
    });
    await expect(
      createToolDesignRunner({ provider, maxAttempts: 1 }).run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(LlmSchemaValidationError);
  });

  test("accepts facts:true tool that includes at least one snapshot source", async () => {
    const fx = await freshIndexOnlyFixture();
    const goodDesign = {
      schemaVersion: "0.1.0",
      customTools: [makeFactsTool("lookup_std_item", ["k8s-docs", "k8s-repo"])],
      rationale:
        "k8s-docs is snapshot, so the fact store contains its body — facts retrieval works.",
    };
    const provider = createMockProvider({
      responses: {
        "06-tool-design@v3": JSON.stringify(goodDesign),
      },
    });
    const outcome = await createToolDesignRunner({ provider }).run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    const body = readFileSync(toolDesignPath(fx.almanacDir), "utf8");
    const parsed = ToolDesignResultSchema.parse(JSON.parse(body));
    expect(parsed.customTools[0]!.sourceDependencies).toEqual([
      "k8s-docs",
      "k8s-repo",
    ]);
  });

  test("accepts live tool (facts:false) with empty sourceDependencies", async () => {
    const fx = await freshIndexOnlyFixture();
    const liveDesign = {
      schemaVersion: "0.1.0",
      customTools: [buildCustomTool("price_now")], // facts:false, sourceDependencies:[]
      rationale: "Live API tool that does not touch the fact store.",
    };
    const provider = createMockProvider({
      responses: { "06-tool-design@v3": JSON.stringify(liveDesign) },
    });
    const outcome = await createToolDesignRunner({ provider }).run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
  });

  test("rejects tool that references an unknown source id", async () => {
    const fx = await freshIndexOnlyFixture();
    const badDesign = {
      schemaVersion: "0.1.0",
      customTools: [makeFactsTool("lookup_std_item", ["k8s-docs", "ghost"])],
      rationale: "Ghost id is not in approved sources.",
    };
    const provider = createMockProvider({
      defaultResponse: JSON.stringify(badDesign),
    });
    await expect(
      createToolDesignRunner({ provider, maxAttempts: 1 }).run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(LlmSchemaValidationError);
  });

  test("source-mode failure emits stage6:llm:retry with source-mode-validation reason", async () => {
    const fx = await freshIndexOnlyFixture();
    let call = 0;
    const provider = createMockProvider({
      responses: {
        "06-tool-design@v3": () => {
          call += 1;
          if (call === 1) {
            // index-only-only tool → source-mode violation
            return JSON.stringify({
              schemaVersion: "0.1.0",
              customTools: [makeFactsTool("lookup_std_item", ["k8s-repo"])],
              rationale:
                "First attempt depends only on index-only; should retry.",
            });
          }
          // Second attempt: redesigned as live-fetch wrapper.
          return JSON.stringify({
            schemaVersion: "0.1.0",
            customTools: [
              {
                ...buildCustomTool("lookup_std_item"),
                sourceDependencies: ["k8s-repo"],
              },
            ],
            rationale:
              "Redesigned to live-fetch from the index-only source via fetch_official_docs pattern.",
          });
        },
      },
    });
    const events: object[] = [];
    const outcome = await createToolDesignRunner({ provider }).run(
      makeCtx({ ...fx, log: (e) => events.push(e) }),
    );
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.llmCalls).toBe(2);
    const retryEvent = events.find(
      (e) => (e as { event?: string }).event === "stage6:llm:retry",
    ) as { reason?: string } | undefined;
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.reason).toBe("source-mode-validation");
  });
});
