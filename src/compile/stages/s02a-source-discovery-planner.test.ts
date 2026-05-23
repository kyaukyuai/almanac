/**
 * Tests for Stage 2a — source-discovery planner runner.
 *
 *   - happy path: mock provider returns a valid plan → runner persists
 *     `.compile/source-discovery-plan.json` and reports a deterministic hash
 *   - missing Stage 1 output → MissingDomainSpecError
 *   - schema mismatch → LlmSchemaValidationError
 *   - identity mismatch (canonicalSlug/displayName) → LlmSchemaValidationError
 *   - non-JSON output → LlmJsonParseError
 *   - vars binding: depth + domainSpecJson flow into the user prompt
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
  type AlmanacManifest,
  type CompileState,
  type DomainSpec,
  type SourceDiscoveryPlan,
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
  MissingDomainSpecError,
  STAGE2A_PROMPT_VERSION,
  createSourceDiscoveryPlannerRunner,
  indentBlock,
  sourceDiscoveryPlanPath,
} from "./s02a-source-discovery-planner.ts";
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
  summary:
    "Container orchestration platform for automating deployment, scaling, and management of containerized workloads.",
  subareas: [
    "core api and controllers",
    "scheduling and resource management",
    "networking",
  ],
  intents: [
    { kind: "howto", example: "how do I write a controller for a custom resource?" },
    { kind: "lookup", example: "what are the default kubelet eviction thresholds?" },
  ],
  verbs: ["explain", "diagnose", "lookup-spec"],
  entityTypes: ["resource", "controller", "version"],
  freshnessProfile: {
    profileId: "mixed",
    defaultClass: "fast",
    classes: {
      static: { examples: ["controller pattern"] },
      slow: { examples: ["RBAC design patterns"], maxAgeDays: 30 },
      fast: { examples: ["latest minor release features"], maxAgeHours: 24 },
      live: { examples: [] },
    },
  },
  suggestedSources: [
    { hint: "https://kubernetes.io/docs/", kind: "docs" },
    { hint: "https://kubernetes.io/blog/", kind: "news" },
    { hint: "https://github.com/kubernetes/kubernetes/releases", kind: "repo" },
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
    maxCandidatesPerKind: 8,
    targetAcceptedSources: 8,
  },
  directProbes: [
    { hint: "https://kubernetes.io/docs/", kind: "docs", rationale: "Primary docs." },
    { hint: "https://kubernetes.io/blog/", kind: "news", rationale: "Release blog." },
  ],
  webSearchQueries: [
    {
      query: "kubernetes operator best practices 2026",
      targetKind: "community",
      rationale: "Practitioner guidance.",
      recencyDays: 90,
    },
  ],
  githubQueries: [
    {
      query: "kubernetes-sigs topic:sig stars:>200",
      type: "repos",
      rationale: "SIG repos.",
    },
  ],
  coverageGoals: {
    docs: { min: 2, max: 3 },
    repo: { min: 1, max: 3 },
    news: { min: 1, max: 2 },
    community: { min: 1, max: 2 },
    academic: { min: 0, max: 1 },
    data: { min: 0, max: 2 },
    file: { min: 0, max: 0 },
    essay: { min: 0, max: 0 },
    book: { min: 0, max: 0 },
    talk: { min: 0, max: 0 },
  },
});

async function freshFixture(opts?: {
  /** When false, skip writing `.compile/domain-spec.json`. */
  withDomainSpec?: boolean;
  spec?: DomainSpec;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s02a-"));
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
    const specPath = domainSpecPath(almanacDir);
    await mkdir(dirname(specPath), { recursive: true });
    writeFileSync(
      specPath,
      JSON.stringify(opts?.spec ?? VALID_DOMAIN_SPEC, null, 2),
      "utf8",
    );
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
    stageId: "02a-source-discovery-planner",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:01.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// indentBlock
// ──────────────────────────────────────────────────────────────────────────────

describe("indentBlock", () => {
  test("indents every non-empty line", () => {
    expect(indentBlock("a\nb\n\nc", 2)).toBe("  a\n  b\n\n  c");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runner: happy path
// ──────────────────────────────────────────────────────────────────────────────

describe("createSourceDiscoveryPlannerRunner", () => {
  test("advertises promptVersion=planner-v1", () => {
    const runner = createSourceDiscoveryPlannerRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    expect(runner.promptVersion).toBe(STAGE2A_PROMPT_VERSION);
  });

  test("happy path: persists plan and returns deterministic hash", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@planner-v1": JSON.stringify(VALID_PLAN),
      },
    });
    const runner = createSourceDiscoveryPlannerRunner({ provider });

    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") {
      throw new Error(`expected success, got ${outcome.kind}`);
    }
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.llmCalls).toBe(1);

    const body = readFileSync(sourceDiscoveryPlanPath(fx.almanacDir), "utf8");
    const persisted = SourceDiscoveryPlanSchema.parse(JSON.parse(body));
    expect(persisted.domain.canonicalSlug).toBe("kubernetes");
    expect(persisted.directProbes.length).toBe(2);

    // Determinism: same plan → same hash
    const fx2 = await freshFixture();
    const provider2 = createMockProvider({
      responses: {
        "02-source-discovery@planner-v1": JSON.stringify(VALID_PLAN),
      },
    });
    const outcome2 = await createSourceDiscoveryPlannerRunner({
      provider: provider2,
    }).run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("forwards depth and an indented domainSpec block into the user message", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "02-source-discovery@planner-v1": JSON.stringify(VALID_PLAN),
      },
    });
    const runner = createSourceDiscoveryPlannerRunner({ provider });
    await runner.run(makeCtx(fx));
    const req = provider.callLog[0]!.request;
    const userMsg = req.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("depth: standard");
    // The DomainSpec block is YAML-indented under `domainSpec: |`
    expect(userMsg.content).toContain("domainSpec: |");
    expect(userMsg.content).toMatch(/^\s+"canonicalSlug": "kubernetes"/m);
    expect(req.callName).toBe("02-source-discovery@planner-v1");
  });

  test("strips a markdown code fence around the JSON", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: "```json\n" + JSON.stringify(VALID_PLAN) + "\n```",
    });
    const runner = createSourceDiscoveryPlannerRunner({ provider });
    const outcome = await runner.run(makeCtx(fx));
    expect(outcome.kind).toBe("success");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runner: failure modes
// ──────────────────────────────────────────────────────────────────────────────

describe("createSourceDiscoveryPlannerRunner — failures", () => {
  test("missing domain-spec.json → MissingDomainSpecError", async () => {
    const fx = await freshFixture({ withDomainSpec: false });
    const runner = createSourceDiscoveryPlannerRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingDomainSpecError,
    );
  });

  test("non-JSON output → LlmJsonParseError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({ defaultResponse: "not json" });
    const runner = createSourceDiscoveryPlannerRunner({ provider });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
  });

  test("schema mismatch → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: '{"schemaVersion":"0.1.0"}',
    });
    const runner = createSourceDiscoveryPlannerRunner({ provider });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });

  test("accepts an abstract-domain plan that weights essay/book/talk", async () => {
    // Build a leadership-shaped DomainSpec so canonicalSlug/displayName
    // match the planner's identity check.
    const leadershipSpec: DomainSpec = DomainSpecSchema.parse({
      domain: "leadership",
      canonicalSlug: "leadership",
      displayName: "Leadership",
      summary:
        "Durable principles, frameworks, and heuristics for leading engineering organizations and individuals.",
      subareas: [
        "decision making",
        "delegation",
        "feedback",
        "strategy",
        "managing managers",
      ],
      intents: [
        { kind: "explain", example: "what is the difference between Type 1 and Type 2 decisions?" },
        { kind: "howto", example: "how do I run a productive one-on-one?" },
      ],
      verbs: ["explain", "compare", "advise"],
      entityTypes: ["principle", "framework", "heuristic", "tradeoff"],
      freshnessProfile: {
        profileId: "static-heavy",
        defaultClass: "slow",
        classes: {
          static: { examples: ["Drucker's principles of effective executives"] },
          slow: { examples: ["modern remote-work patterns"], maxAgeDays: 365 },
          fast: { examples: [] },
          live: { examples: [] },
        },
      },
      suggestedSources: [
        { hint: "https://lethain.com/", kind: "essay" },
        { hint: "https://staffeng.com/", kind: "essay" },
        { hint: "Drucker The Effective Executive", kind: "book" },
        { hint: "https://www.ted.com/topics/leadership", kind: "talk" },
        { hint: "https://hbr.org/topic/leadership", kind: "community" },
      ],
      suggestedTools: [],
      cautions: [],
    });
    const leadershipPlan: SourceDiscoveryPlan = SourceDiscoveryPlanSchema.parse({
      schemaVersion: "0.1.0",
      domain: { canonicalSlug: "leadership", displayName: "Leadership" },
      budgets: {
        maxWebSearchQueries: 6,
        maxGithubQueries: 0,
        maxUrlProbes: 12,
        maxCandidatesPerKind: 8,
        targetAcceptedSources: 8,
      },
      directProbes: [
        { hint: "https://lethain.com/", kind: "essay", rationale: "Authority essays." },
        { hint: "https://staffeng.com/", kind: "essay", rationale: "Practitioner essays." },
        { hint: "Drucker The Effective Executive", kind: "book", rationale: "Canonical book." },
        { hint: "https://www.ted.com/topics/leadership", kind: "talk", rationale: "Talks." },
      ],
      webSearchQueries: [
        {
          query: "site:substack.com engineering leadership principles",
          targetKind: "essay",
          rationale: "Surface long-form essays from named authors.",
          recencyDays: null,
        },
        {
          query: "leadership podcast transcript site:transcripts.simplecast.com",
          targetKind: "talk",
          rationale: "Surface talk transcripts.",
          recencyDays: null,
        },
      ],
      githubQueries: [],
      coverageGoals: {
        docs: { min: 0, max: 1 },
        repo: { min: 0, max: 0 },
        news: { min: 0, max: 1 },
        community: { min: 1, max: 2 },
        academic: { min: 0, max: 1 },
        data: { min: 0, max: 0 },
        file: { min: 0, max: 0 },
        essay: { min: 2, max: 5 },
        book: { min: 1, max: 3 },
        talk: { min: 1, max: 3 },
      },
    });

    // Manually build a fixture for the leadership almanac (freshFixture is
    // hardcoded to kubernetes).
    const root = mkdtempSync(join(tmpdir(), "almanac-s02a-abstract-"));
    cleanup.push(root);
    const almanacDir = join(root, "leadership");
    const { manifest, compileState } = bootstrapAlmanac({
      almanacId: "leadership",
      domain: "leadership",
      displayName: "Leadership",
      freshnessProfileId: "static-heavy",
      runId: "run-abstract",
      forgerVersion: "0.0.0",
      options: {
        depth: "standard",
        sourcesHint: [],
        scopeHint: "for senior engineering managers",
        target: "both",
        autoApprove: true,
        language: "ts",
      },
      now: new Date("2026-05-08T12:00:00.000Z"),
    });
    await ensureAlmanacLayout(almanacDir);
    const specPath = domainSpecPath(almanacDir);
    await mkdir(dirname(specPath), { recursive: true });
    writeFileSync(specPath, JSON.stringify(leadershipSpec, null, 2), "utf8");

    const provider = createMockProvider({
      responses: {
        "02-source-discovery@planner-v1": JSON.stringify(leadershipPlan),
      },
    });
    const outcome = await createSourceDiscoveryPlannerRunner({
      provider,
    }).run({
      almanacDir,
      manifest: AlmanacManifestSchema.parse(manifest),
      state: CompileStateSchema.parse(compileState),
      stageId: "02a-source-discovery-planner",
      log: () => {},
      now: () => new Date("2026-05-08T12:00:01.000Z"),
    });
    if (outcome.kind !== "success") {
      throw new Error(`expected success, got ${outcome.kind}`);
    }

    const persisted = SourceDiscoveryPlanSchema.parse(
      JSON.parse(readFileSync(sourceDiscoveryPlanPath(almanacDir), "utf8")),
    );
    expect(persisted.coverageGoals.essay.min).toBeGreaterThanOrEqual(2);
    expect(persisted.coverageGoals.book.min).toBeGreaterThanOrEqual(1);
    expect(persisted.coverageGoals.talk.min).toBeGreaterThanOrEqual(1);
    expect(persisted.coverageGoals.repo.max).toBe(0);
    const abstractProbes = persisted.directProbes.filter((p) =>
      ["essay", "book", "talk"].includes(p.kind),
    );
    expect(abstractProbes.length).toBeGreaterThanOrEqual(3);
  });

  test("plan.domain identity mismatch → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    const wrong: SourceDiscoveryPlan = {
      ...VALID_PLAN,
      domain: { canonicalSlug: "k8s", displayName: "Wrong" },
    };
    const provider = createMockProvider({
      defaultResponse: JSON.stringify(wrong),
    });
    const runner = createSourceDiscoveryPlannerRunner({ provider });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });
});
