/**
 * Tests for the Stage 10 runner adapter.
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
  KnowledgeIndexManifestSchema,
  Stage07OutputSchema,
  Stage09OutputSchema,
  Stage10OutputSchema,
  ToolManifestSchema,
  buildStage09Output,
  type AlmanacManifest,
  type CompileState,
  type DomainSpec,
  type ToolManifest,
} from "../../core/types.ts";
import { knowledgeIndexManifestPath, ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { synthesizeAllDefaultManifests } from "./s07/template-implementer.ts";
import { stage07OutputPath } from "./s07-tool-impl-runner.ts";
import {
  stage09OutputPath,
  synthesizeNarrative,
} from "./s09-contract-runner.ts";
import { runContractFiles } from "./s09-contract.ts";
import {
  MissingDomainSpecError,
  MissingKnowledgeIndexError,
  MissingStage07OutputError,
  MissingStage09OutputError,
  createSkillAdapterRunner,
  skillMdPath,
  stage10OutputPath,
  synthesizeSkillDescription,
} from "./s10-skill-adapter-runner.ts";
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
  summary: "Container orchestration platform for declaratively running workloads.",
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

function buildStage07OutputJson() {
  const defaults = synthesizeAllDefaultManifests();
  const ts = "2026-05-08T12:00:03.000Z";
  return Stage07OutputSchema.parse({
    schemaVersion: "0.1.0",
    startedAt: ts,
    finishedAt: ts,
    summary: {
      total: defaults.length,
      implemented: defaults.length,
      disabled: 0,
      totalAttempts: defaults.length,
    },
    results: defaults.map((m) => {
      const finalManifest: ToolManifest = ToolManifestSchema.parse({
        ...m,
        implementedBy: {
          model: "template",
          promptVersion: "default-v1",
          tscPassed: true,
          smokePassed: true,
          attempts: 1,
        },
      });
      return {
        toolName: m.name,
        status: "implemented" as const,
        attempts: [
          {
            attemptNumber: 1,
            model: "template",
            promptVersion: "default-v1",
            startedAt: ts,
            finishedAt: ts,
            outcome: "success" as const,
            diagnostics: null,
          },
        ],
        finalManifest,
      };
    }),
  });
}

function buildStage09OutputJson() {
  const manifests = synthesizeAllDefaultManifests();
  return runContractFiles({
    domainSpec: VALID_DOMAIN_SPEC,
    narrative: synthesizeNarrative(VALID_DOMAIN_SPEC),
    manifests,
    compiledAt: new Date("2026-05-08T12:00:05.000Z"),
  });
}

function buildKnowledgeIndexManifestJson() {
  return KnowledgeIndexManifestSchema.parse({
    schemaVersion: "0.1.0",
    almanacId: "kubernetes",
    dbRelPath: "knowledge/almanac.sqlite",
    factCount: 2,
    counts: {
      byClass: { static: 1, slow: 1 },
      byType: {
        fact: 0,
        definition: 1,
        procedure: 1,
        opinion: 0,
        reference: 0,
        principle: 0,
        heuristic: 0,
        tradeoff: 0,
        framework: 0,
      },
    },
    builtAt: "2026-05-08T12:00:04.000Z",
    sqliteVersion: "3.45.1",
    factCorpusHash:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  });
}

// Sanity-check: buildStage09Output is exported and works. (used for compile-time check)
void buildStage09Output;

async function freshFixture(opts?: {
  withDomainSpec?: boolean;
  withStage07?: boolean;
  withStage09?: boolean;
  withKnowledgeIndex?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s10r-"));
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
  if (opts?.withStage07 !== false) {
    const p = stage07OutputPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(buildStage07OutputJson(), null, 2), "utf8");
  }
  if (opts?.withStage09 !== false) {
    const p = stage09OutputPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(buildStage09OutputJson(), null, 2), "utf8");
  }
  if (opts?.withKnowledgeIndex !== false) {
    const p = knowledgeIndexManifestPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(buildKnowledgeIndexManifestJson(), null, 2),
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
    stageId: "10-adapter-generation",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:06.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createSkillAdapterRunner", () => {
  test("promptVersion is null", () => {
    expect(createSkillAdapterRunner().promptVersion).toBeNull();
  });

  test("happy path: writes SKILL.md + aggregate, deterministic outputHash", async () => {
    const fx = await freshFixture();
    const outcome = await createSkillAdapterRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    expect(existsSync(skillMdPath(fx.almanacDir))).toBe(true);
    const skillBody = readFileSync(skillMdPath(fx.almanacDir), "utf8");
    expect(skillBody).toContain('name: "almanac-kubernetes"');
    expect(skillBody).toContain("mcp__almanac-kubernetes__query_facts");

    const agg = Stage10OutputSchema.parse(
      JSON.parse(readFileSync(stage10OutputPath(fx.almanacDir), "utf8")),
    );
    expect(agg.frontmatter.name).toBe("almanac-kubernetes");
    expect(agg.frontmatter.metadata.almanac.factCount).toBe(2);
    expect(agg.frontmatter.metadata.almanac.toolCount).toBe(4);
    expect(agg.frontmatter.allowedTools.length).toBe(4);

    const fx2 = await freshFixture();
    const outcome2 = await createSkillAdapterRunner().run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("missing domain spec → MissingDomainSpecError", async () => {
    const fx = await freshFixture({ withDomainSpec: false });
    await expect(
      createSkillAdapterRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingDomainSpecError);
  });

  test("missing Stage 7 output → MissingStage07OutputError", async () => {
    const fx = await freshFixture({ withStage07: false });
    await expect(
      createSkillAdapterRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingStage07OutputError);
  });

  test("missing Stage 9 output → MissingStage09OutputError", async () => {
    const fx = await freshFixture({ withStage09: false });
    await expect(
      createSkillAdapterRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingStage09OutputError);
  });

  test("missing knowledge index manifest → MissingKnowledgeIndexError", async () => {
    const fx = await freshFixture({ withKnowledgeIndex: false });
    await expect(
      createSkillAdapterRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingKnowledgeIndexError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// synthesizeSkillDescription
// ──────────────────────────────────────────────────────────────────────────────

describe("synthesizeSkillDescription", () => {
  test("produces a 20–500 char string mentioning the displayName", () => {
    const d = synthesizeSkillDescription(VALID_DOMAIN_SPEC);
    expect(d.length).toBeGreaterThanOrEqual(20);
    expect(d.length).toBeLessThanOrEqual(500);
    expect(d).toContain("Kubernetes");
  });
});
