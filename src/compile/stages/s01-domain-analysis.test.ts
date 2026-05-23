/**
 * Tests for Stage 1 — domain analysis runner.
 *
 *   - happy path: mock provider returns a valid DomainSpec → runner persists
 *     `.compile/domain-spec.json` and reports a deterministic outputHash
 *   - schema enforcement: malformed mock output → LlmSchemaValidationError
 *   - INSUFFICIENT_DOMAIN sentinel → InsufficientDomainError surfaces
 *   - vars binding: depth + sourcesHint flow into the user prompt
 *   - hash determinism: same DomainSpec ⇒ same outputHash across runs
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  DomainSpecSchema,
  InsufficientDomainError,
  type AlmanacManifest,
  type CompileState,
  type DomainSpec,
} from "../../core/types.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
} from "../../llm/provider.ts";
import { createMockProvider } from "../../llm/mock.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import {
  createDomainAnalysisRunner,
  domainSpecPath,
  renderSourcesHint,
  STAGE1_PROMPT_VERSION,
} from "./s01-domain-analysis.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
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

async function freshFixture(): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s01-"));
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
      sourcesHint: ["https://kubernetes.io/docs/"],
      target: "both",
      autoApprove: true,
      language: "ts",
    },
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
  await ensureAlmanacLayout(almanacDir);
  return {
    almanacDir,
    manifest: AlmanacManifestSchema.parse(manifest),
    state: CompileStateSchema.parse(compileState),
  };
}

const VALID_SPEC: DomainSpec = DomainSpecSchema.parse({
  domain: "kubernetes",
  canonicalSlug: "kubernetes",
  displayName: "Kubernetes",
  summary:
    "Container orchestration platform for automating deployment, scaling, and management of containerized workloads.",
  subareas: [
    "core api and controllers",
    "scheduling and resource management",
    "networking",
    "storage",
    "security and policy",
  ],
  intents: [
    { kind: "howto", example: "how do I write a controller for a custom resource?" },
    { kind: "lookup", example: "what are the default kubelet eviction thresholds?" },
    { kind: "explain", example: "why does my pod stay in CrashLoopBackOff?" },
    { kind: "compare", example: "what changed between Kubernetes 1.29 and 1.30?" },
  ],
  verbs: ["explain", "diagnose", "compare-versions", "lookup-spec", "design"],
  entityTypes: ["resource", "controller", "version", "feature-gate", "api-group"],
  freshnessProfile: {
    profileId: "mixed",
    defaultClass: "fast",
    classes: {
      static: { examples: ["controller pattern", "container runtime concepts"] },
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
    stageId: "01-domain-analysis",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:01.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// renderSourcesHint
// ──────────────────────────────────────────────────────────────────────────────

describe("renderSourcesHint", () => {
  test("renders [] for empty hints", () => {
    expect(renderSourcesHint([])).toBe("[]");
  });
  test("renders JSON array for non-empty hints", () => {
    expect(renderSourcesHint(["a", "b"])).toBe('["a","b"]');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runner: happy path
// ──────────────────────────────────────────────────────────────────────────────

describe("createDomainAnalysisRunner", () => {
  test("advertises promptVersion=v1", () => {
    const runner = createDomainAnalysisRunner({
      provider: createMockProvider({ defaultResponse: "{}" }),
    });
    expect(runner.promptVersion).toBe(STAGE1_PROMPT_VERSION);
  });

  test("happy path: persists DomainSpec and returns deterministic outputHash", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "01-domain-analysis@v2": JSON.stringify(VALID_SPEC),
      },
    });
    const runner = createDomainAnalysisRunner({ provider });

    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") {
      throw new Error(`expected success, got ${outcome.kind}`);
    }
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.llmCalls).toBe(1);
    expect(outcome.cost?.tokens.output).toBeGreaterThan(0);

    const onDisk = readFileSync(domainSpecPath(fx.almanacDir), "utf8");
    const parsed = DomainSpecSchema.parse(JSON.parse(onDisk));
    expect(parsed.canonicalSlug).toBe("kubernetes");
    expect(parsed.freshnessProfile.defaultClass).toBe("fast");

    // Determinism: same input → same hash on a second run.
    const fx2 = await freshFixture();
    const provider2 = createMockProvider({
      responses: { "01-domain-analysis@v2": JSON.stringify(VALID_SPEC) },
    });
    const outcome2 = await createDomainAnalysisRunner({
      provider: provider2,
    }).run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("strips a markdown code fence around the JSON", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "01-domain-analysis@v2":
          "```json\n" + JSON.stringify(VALID_SPEC) + "\n```",
      },
    });
    const runner = createDomainAnalysisRunner({ provider });
    const outcome = await runner.run(makeCtx(fx));
    expect(outcome.kind).toBe("success");
  });

  test("forwards depth and sourcesHint into the user message", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: {
        "01-domain-analysis@v2": JSON.stringify(VALID_SPEC),
      },
    });
    const runner = createDomainAnalysisRunner({ provider });
    await runner.run(makeCtx(fx));
    expect(provider.callLog.length).toBe(1);
    const req = provider.callLog[0]!.request;
    const userMsg = req.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("domain: kubernetes");
    expect(userMsg.content).toContain("depth: standard");
    expect(userMsg.content).toContain('sourcesHint: ["https://kubernetes.io/docs/"]');
    expect(req.callName).toBe("01-domain-analysis@v2");
  });

  test("scopeHint defaults to (none provided) when CompileOptions omits it", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      responses: { "01-domain-analysis@v2": JSON.stringify(VALID_SPEC) },
    });
    await createDomainAnalysisRunner({ provider }).run(makeCtx(fx));
    const userMsg = provider.callLog[0]!.request.messages.find(
      (m) => m.role === "user",
    )!;
    expect(userMsg.content).toContain("scopeHint: (none provided)");
  });

  test("scopeHint flows verbatim into the user message when supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-s01-scope-"));
    cleanup.push(root);
    const almanacDir = join(root, "leadership");
    const { manifest, compileState } = bootstrapAlmanac({
      almanacId: "leadership",
      domain: "leadership",
      displayName: "Leadership",
      freshnessProfileId: "static-heavy",
      runId: "run-scope",
      forgerVersion: "0.0.0",
      options: {
        depth: "standard",
        sourcesHint: [],
        scopeHint: "for senior engineering leaders at series B+ startups",
        target: "both",
        autoApprove: true,
        language: "ts",
      },
      now: new Date("2026-05-08T12:00:00.000Z"),
    });
    await ensureAlmanacLayout(almanacDir);

    const provider = createMockProvider({
      responses: { "01-domain-analysis@v2": JSON.stringify(VALID_SPEC) },
    });
    await createDomainAnalysisRunner({ provider }).run({
      almanacDir,
      manifest: AlmanacManifestSchema.parse(manifest),
      state: CompileStateSchema.parse(compileState),
      stageId: "01-domain-analysis",
      log: () => {},
      now: () => new Date("2026-05-08T12:00:01.000Z"),
    });
    const userMsg = provider.callLog[0]!.request.messages.find(
      (m) => m.role === "user",
    )!;
    expect(userMsg.content).toContain(
      "scopeHint: for senior engineering leaders at series B+ startups",
    );
    // The literal variable line must NOT fall back to the default sentinel.
    expect(userMsg.content).not.toContain("scopeHint: (none provided)");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Runner: failure modes
// ──────────────────────────────────────────────────────────────────────────────

describe("createDomainAnalysisRunner — failures", () => {
  test("non-JSON output → LlmJsonParseError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({ defaultResponse: "not json at all" });
    const runner = createDomainAnalysisRunner({ provider });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
  });

  test("schema mismatch → LlmSchemaValidationError", async () => {
    const fx = await freshFixture();
    // Valid JSON but missing required fields.
    const provider = createMockProvider({ defaultResponse: '{"domain":"k8s"}' });
    const runner = createDomainAnalysisRunner({ provider });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      LlmSchemaValidationError,
    );
  });

  test("INSUFFICIENT_DOMAIN sentinel → InsufficientDomainError", async () => {
    const fx = await freshFixture();
    const provider = createMockProvider({
      defaultResponse: JSON.stringify({
        summary: "INSUFFICIENT_DOMAIN: gibberish input",
      }),
    });
    const runner = createDomainAnalysisRunner({ provider });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      InsufficientDomainError,
    );
  });
});
