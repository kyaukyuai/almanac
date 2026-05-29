/**
 * Tests for Stage 2b — source-discovery evaluator runner.
 *
 *   - happy path: discovery executor produces candidates → evaluator returns
 *     a draft SourcesFile → runner persists `.compile/sources.draft.json`
 *     and `.compile/candidates.json`, returns deterministic outputHash
 *   - missing plan → MissingPlanError
 *   - LLM emits status: "approved" → throws (parseDraftSourcesFile guard)
 *   - vars binding: domainSpecJson + planJson + candidatesJson all present
 *   - schema mismatch → LlmSchemaValidationError
 *   - non-JSON output → LlmJsonParseError
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  DomainSpecSchema,
  SourceDiscoveryPlanSchema,
  SourcesFileSchema,
  type AlmanacManifest,
  type CompileState,
  type DomainSpec,
  type SourceDiscoveryPlan,
  type SourcesFile,
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
  MissingPlanError,
  sourceDiscoveryPlanPath,
} from "./s02a-source-discovery-planner.ts";
import { candidatesPath } from "./s02x-source-discovery-executor.ts";
import {
  STAGE2B_PROMPT_VERSION,
  applyApprovedSourceReuse,
  applyKnownIndexOnlyLandingPageRejectionPolicy,
  applyKnownPermissiveDocsSnapshotPolicy,
  createSourceDiscoveryEvaluatorRunner,
  sourcesDraftPath,
} from "./s02b-source-discovery-evaluator.ts";
import type { StageContext } from "../pipeline.ts";
import type { Candidates } from "../../core/types.ts";

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

const VALID_PLAN: SourceDiscoveryPlan = SourceDiscoveryPlanSchema.parse({
  schemaVersion: "0.1.0",
  domain: { canonicalSlug: "kubernetes", displayName: "Kubernetes" },
  budgets: {
    maxWebSearchQueries: 4,
    maxGithubQueries: 4,
    maxUrlProbes: 12,
    maxCandidatesPerKind: 4,
    targetAcceptedSources: 8,
  },
  directProbes: [
    { hint: "https://kubernetes.io/docs/", kind: "docs", rationale: "primary" },
  ],
  webSearchQueries: [],
  githubQueries: [
    {
      query: "topic:kubernetes stars:>500",
      type: "repos",
      rationale: "official repos",
    },
  ],
  coverageGoals: {
    docs: { min: 1, max: 3 },
    repo: { min: 1, max: 3 },
    news: { min: 0, max: 2 },
    community: { min: 0, max: 2 },
    academic: { min: 0, max: 1 },
    data: { min: 0, max: 2 },
    file: { min: 0, max: 0 },
    essay: { min: 0, max: 0 },
    book: { min: 0, max: 0 },
    talk: { min: 0, max: 0 },
  },
});

function buildDraftSourcesFile(): SourcesFile {
  return SourcesFileSchema.parse({
    schemaVersion: "0.1.0",
    status: "draft",
    generatedAt: "2026-05-08T12:00:00.000Z",
    generatedBy: {
      stage: "02-source-discovery",
      evaluatorPromptVersion: "evaluator-v1",
      candidateCount: 2,
      acceptedCount: 2,
    },
    coverage: {
      docs: 1,
      repo: 1,
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
          scope: ["/concepts/", "/reference/"],
          refreshIntervalHours: 168,
        },
        notes: null,
      },
      {
        id: "k8s-repo",
        url: "https://github.com/kubernetes/kubernetes",
        kind: "repo",
        trust: 0.92,
        volatility: "fast",
        rationale: "Canonical source repo.",
        ingestion: {
          mode: "index-only",
          scope: ["releases", "CHANGELOG"],
          refreshIntervalHours: 24,
        },
        notes: null,
      },
    ],
    rejected: [],
  });
}

function approveSourcesFile(file: SourcesFile): SourcesFile {
  return SourcesFileSchema.parse({
    ...file,
    status: "approved",
    approvedAt: "2026-05-08T12:00:00.500Z",
    approvedBy: "human",
  });
}

const VALID_CANDIDATES: Candidates = [
  {
    url: "https://kubernetes.io/docs/",
    kind: "docs",
    title: "Kubernetes Documentation",
    snippet: "Production-ready container orchestration",
    preview: "Kubernetes is an open-source system for automating deployment...",
    fetchedAt: "2026-05-08T11:59:55.000Z",
    fetchStatus: "ok",
    origin: { type: "direct-probe", probeIndex: 0 },
    meta: { httpStatusCode: 200, contentType: "text/html" },
  },
  {
    url: "https://github.com/kubernetes/kubernetes",
    kind: "repo",
    title: "kubernetes/kubernetes",
    snippet: "Production-Grade Container Scheduling and Management",
    preview: null,
    fetchedAt: "2026-05-08T11:59:55.000Z",
    fetchStatus: "ok",
    origin: { type: "github", queryIndex: 0, rank: 0 },
    meta: {
      githubStars: 100000,
      githubLicense: "Apache-2.0",
      githubLastCommitAt: "2026-04-01T00:00:00Z",
    },
  },
];

async function freshFixture(opts?: {
  withDomainSpec?: boolean;
  withPlan?: boolean;
  withCandidates?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s02b-"));
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
  if (opts?.withPlan !== false) {
    const p = sourceDiscoveryPlanPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(VALID_PLAN, null, 2), "utf8");
  }
  if (opts?.withCandidates !== false) {
    const p = candidatesPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(VALID_CANDIDATES, null, 2), "utf8");
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
    stageId: "02b-source-discovery-evaluator",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:01.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createSourceDiscoveryEvaluatorRunner", () => {
  test("advertises promptVersion=evaluator-v1", () => {
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    expect(runner.promptVersion).toBe(STAGE2B_PROMPT_VERSION);
  });

  test("happy path: persists draft SourcesFile, deterministic hash", async () => {
    const fx = await freshFixture();
    const draft = buildDraftSourcesFile();
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@evaluator-v1": JSON.stringify(draft),
      },
    });
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider,
    });

    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.llmCalls).toBe(1);

    // Sources draft persisted
    const draftBody = readFileSync(sourcesDraftPath(fx.almanacDir), "utf8");
    const persisted = SourcesFileSchema.parse(JSON.parse(draftBody));
    expect(persisted.status).toBe("draft");
    expect(persisted.sources.length).toBe(2);

    // Candidates fixture left unchanged (Stage 2b only reads — Stage 02x
    // owns writes to .compile/candidates.json).
    const candBody = readFileSync(candidatesPath(fx.almanacDir), "utf8");
    const candidates = JSON.parse(candBody);
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBe(VALID_CANDIDATES.length);

    // Determinism on a second run
    const fx2 = await freshFixture();
    const provider2 = createMockProvider({
      responses: {
        "02-source-discovery@evaluator-v1": JSON.stringify(draft),
      },
    });
    const outcome2 = await createSourceDiscoveryEvaluatorRunner({
      provider: provider2,
    }).run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("forwards domainSpec/plan/candidates blocks into the user message", async () => {
    const fx = await freshFixture();
    const draft = buildDraftSourcesFile();
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@evaluator-v1": JSON.stringify(draft),
      },
    });
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider,
    });
    await runner.run(makeCtx(fx));
    const req = provider.callLog[0]!.request;
    const userMsg = req.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("domainSpec: |");
    expect(userMsg.content).toContain("plan: |");
    expect(userMsg.content).toContain("candidates: |");
    expect(userMsg.content).toContain("kubernetes");
  });

  test("promotes known permissive docs from index-only to snapshot", async () => {
    const fx = await freshFixture();
    const draft = buildDraftSourcesFile();
    draft.sources[0] = {
      ...draft.sources[0]!,
      ingestion: {
        ...draft.sources[0]!.ingestion,
        mode: "index-only",
      },
      notes: null,
    };
    const events: object[] = [];
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@evaluator-v1": JSON.stringify(draft),
      },
    });
    const runner = createSourceDiscoveryEvaluatorRunner({ provider });

    await runner.run(makeCtx({ ...fx, log: (e) => events.push(e) }));

    const draftBody = readFileSync(sourcesDraftPath(fx.almanacDir), "utf8");
    const persisted = SourcesFileSchema.parse(JSON.parse(draftBody));
    const docs = persisted.sources.find((s) => s.id === "k8s-docs")!;
    expect(docs.ingestion.mode).toBe("snapshot");
    expect(docs.notes).toContain("CC-BY-4.0");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "stage2b:source-mode-adjusted",
        sourceId: "k8s-docs",
        from: "index-only",
        to: "snapshot",
        license: "CC-BY-4.0",
      }),
    );
  });

  test("rejects known index-only docs landing pages that cannot produce facts", async () => {
    const fx = await freshFixture();
    const draft = buildDraftSourcesFile();
    draft.sources.push({
      id: "operatorframework-io",
      url: "https://operatorframework.io/",
      kind: "docs",
      trust: 0.95,
      volatility: "slow",
      rationale: "Canonical documentation landing page.",
      ingestion: {
        mode: "index-only",
        scope: ["**"],
        refreshIntervalHours: 168,
      },
      notes: null,
    });
    const events: object[] = [];
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@evaluator-v1": JSON.stringify(draft),
      },
    });
    const runner = createSourceDiscoveryEvaluatorRunner({ provider });

    await runner.run(makeCtx({ ...fx, log: (e) => events.push(e) }));

    const draftBody = readFileSync(sourcesDraftPath(fx.almanacDir), "utf8");
    const persisted = SourcesFileSchema.parse(JSON.parse(draftBody));
    expect(persisted.sources.some((s) => s.id === "operatorframework-io")).toBe(
      false,
    );
    expect(persisted.generatedBy.acceptedCount).toBe(persisted.sources.length);
    expect(persisted.coverage.docs).toBe(1);
    expect(persisted.rejected).toContainEqual({
      url: "https://operatorframework.io/",
      reason: "licensing-unclear",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "stage2b:source-rejected",
        sourceId: "operatorframework-io",
        reason: "licensing-unclear",
        policy: "known-index-only-landing-page",
      }),
    );
  });

  test("reuses prior approved source ids, notes, and ingestion mode", async () => {
    const fx = await freshFixture();
    const prior = approveSourcesFile(buildDraftSourcesFile());
    prior.sources[0] = {
      ...prior.sources[0]!,
      id: "kubernetes-io-docs",
      notes: "Reviewed by a human.",
      ingestion: {
        mode: "snapshot",
        scope: ["/docs/"],
        refreshIntervalHours: 168,
      },
    };
    const approvedPath = join(fx.almanacDir, "sources/sources.json");
    await mkdir(dirname(approvedPath), { recursive: true });
    writeFileSync(approvedPath, JSON.stringify(prior, null, 2), "utf8");

    const draft = buildDraftSourcesFile();
    draft.sources[0] = {
      ...draft.sources[0]!,
      id: "k8s-docs-new",
      notes: null,
      ingestion: {
        ...draft.sources[0]!.ingestion,
        mode: "index-only",
      },
    };
    const events: object[] = [];
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@evaluator-v1": JSON.stringify(draft),
      },
    });

    await createSourceDiscoveryEvaluatorRunner({ provider }).run(
      makeCtx({ ...fx, log: (e) => events.push(e) }),
    );

    const draftBody = readFileSync(sourcesDraftPath(fx.almanacDir), "utf8");
    const persisted = SourcesFileSchema.parse(JSON.parse(draftBody));
    const docs = persisted.sources.find((s) => s.url === prior.sources[0]!.url)!;
    expect(docs.id).toBe("kubernetes-io-docs");
    expect(docs.notes).toBe("Reviewed by a human.");
    expect(docs.ingestion).toEqual(prior.sources[0]!.ingestion);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "stage2b:source-reused",
        sourceId: "kubernetes-io-docs",
        action: "replaced",
        replacedSourceId: "k8s-docs-new",
      }),
    );
  });
});

describe("applyApprovedSourceReuse", () => {
  test("restores an omitted approved source when the current candidate is fetchable", () => {
    const prior = approveSourcesFile(buildDraftSourcesFile());
    const draft = buildDraftSourcesFile();
    draft.sources = [draft.sources[1]!];
    draft.generatedBy.acceptedCount = 1;
    draft.coverage.docs = 0;
    draft.coverage.repo = 1;

    const result = applyApprovedSourceReuse(draft, VALID_CANDIDATES, prior);

    expect(result.adjustments).toContainEqual({
      sourceId: "k8s-docs",
      url: "https://kubernetes.io/docs/",
      action: "restored",
    });
    expect(result.file.sources.map((source) => source.id)).toEqual([
      "k8s-docs",
      "k8s-repo",
    ]);
    expect(result.file.generatedBy.acceptedCount).toBe(2);
    expect(result.file.coverage.docs).toBe(1);
    expect(result.file.coverage.repo).toBe(1);
  });

  test("does not reuse a prior source explicitly rejected in the new draft", () => {
    const prior = approveSourcesFile(buildDraftSourcesFile());
    const draft = buildDraftSourcesFile();
    draft.sources = [draft.sources[1]!];
    draft.generatedBy.acceptedCount = 1;
    draft.coverage.docs = 0;
    draft.coverage.repo = 1;
    draft.rejected = [
      { url: "https://kubernetes.io/docs/", reason: "out-of-scope" },
    ];

    const result = applyApprovedSourceReuse(draft, VALID_CANDIDATES, prior);

    expect(result.adjustments.map((a) => a.sourceId)).not.toContain("k8s-docs");
    expect(result.file.sources.map((source) => source.id)).toEqual(["k8s-repo"]);
  });

  test("does not reuse a prior source when the current candidate failed", () => {
    const prior = approveSourcesFile(buildDraftSourcesFile());
    const draft = buildDraftSourcesFile();
    draft.sources = [draft.sources[1]!];
    draft.generatedBy.acceptedCount = 1;
    draft.coverage.docs = 0;
    draft.coverage.repo = 1;
    const candidates: Candidates = [
      {
        ...VALID_CANDIDATES[0]!,
        fetchStatus: "client-error",
        preview: null,
      },
      VALID_CANDIDATES[1]!,
    ];

    const result = applyApprovedSourceReuse(draft, candidates, prior);

    expect(result.adjustments.map((a) => a.sourceId)).not.toContain("k8s-docs");
    expect(result.file.sources.map((source) => source.id)).toEqual(["k8s-repo"]);
  });
});

describe("applyKnownPermissiveDocsSnapshotPolicy", () => {
  test("does not promote unknown external docs", () => {
    const draft = buildDraftSourcesFile();
    draft.sources[0] = {
      ...draft.sources[0]!,
      url: "https://example.com/docs/",
      ingestion: {
        ...draft.sources[0]!.ingestion,
        mode: "index-only",
      },
    };
    const candidates: Candidates = [
      {
        ...VALID_CANDIDATES[0]!,
        url: "https://example.com/docs/",
      },
    ];

    const result = applyKnownPermissiveDocsSnapshotPolicy(draft, candidates);

    expect(result.adjustments).toEqual([]);
    expect(result.file.sources[0]!.ingestion.mode).toBe("index-only");
  });

  test("requires an ok or redirected candidate for the same docs URL", () => {
    const draft = buildDraftSourcesFile();
    draft.sources[0] = {
      ...draft.sources[0]!,
      ingestion: {
        ...draft.sources[0]!.ingestion,
        mode: "index-only",
      },
    };
    const candidates: Candidates = [
      {
        ...VALID_CANDIDATES[0]!,
        fetchStatus: "client-error",
        preview: null,
      },
    ];

    const result = applyKnownPermissiveDocsSnapshotPolicy(draft, candidates);

    expect(result.adjustments).toEqual([]);
    expect(result.file.sources[0]!.ingestion.mode).toBe("index-only");
  });
});

describe("applyKnownIndexOnlyLandingPageRejectionPolicy", () => {
  test("removes operatorframework.io index-only landing page from accepted sources", () => {
    const draft = buildDraftSourcesFile();
    draft.sources.push({
      id: "operatorframework-io",
      url: "https://operatorframework.io/",
      kind: "docs",
      trust: 0.95,
      volatility: "slow",
      rationale: "Canonical documentation landing page.",
      ingestion: {
        mode: "index-only",
        scope: ["**"],
        refreshIntervalHours: 168,
      },
      notes: null,
    });

    const result = applyKnownIndexOnlyLandingPageRejectionPolicy(draft);

    expect(result.adjustments).toEqual([
      {
        sourceId: "operatorframework-io",
        url: "https://operatorframework.io/",
        reason: "licensing-unclear",
        policy: "known-index-only-landing-page",
      },
    ]);
    expect(
      result.file.sources.some((source) => source.id === "operatorframework-io"),
    ).toBe(false);
    expect(result.file.generatedBy.acceptedCount).toBe(
      result.file.sources.length,
    );
    expect(result.file.coverage.docs).toBe(1);
    expect(result.file.rejected).toContainEqual({
      url: "https://operatorframework.io/",
      reason: "licensing-unclear",
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Failure modes
// ──────────────────────────────────────────────────────────────────────────────

describe("createSourceDiscoveryEvaluatorRunner — failures", () => {
  test("missing plan → MissingPlanError", async () => {
    const fx = await freshFixture({ withPlan: false });
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingPlanError,
    );
  });

  test("non-JSON output → LlmJsonParseError", async () => {
    const fx = await freshFixture();
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider: createMockProvider({ defaultResponse: "not json" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
  });

  test("schema mismatch → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider: createMockProvider({
        defaultResponse: '{"schemaVersion":"0.1.0","status":"draft"}',
      }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });

  test("status=approved from evaluator → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    // Build an otherwise-valid file but mark it approved — Stage 2b must
    // refuse it (parseDraftSourcesFile guards this).
    const approved = {
      ...buildDraftSourcesFile(),
      status: "approved" as const,
      approvedAt: "2026-05-08T12:00:00.000Z",
      approvedBy: "auto" as const,
    };
    const runner = createSourceDiscoveryEvaluatorRunner({
      provider: createMockProvider({
        defaultResponse: JSON.stringify(approved),
      }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });
});
