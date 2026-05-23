/**
 * Tests for the Stage 9 runner adapter.
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
  Stage07OutputSchema,
  Stage09NarrativeSchema,
  Stage09OutputSchema,
  ToolManifestSchema,
  type AlmanacManifest,
  type CompileState,
  type DomainSpec,
  type ToolManifest,
} from "../../core/types.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import { synthesizeAllDefaultManifests } from "./s07/template-implementer.ts";
import { stage07OutputPath } from "./s07-tool-impl-runner.ts";
import {
  MissingDomainSpecError,
  MissingStage07OutputError,
  agentsMdPath,
  createContractFilesRunner,
  domainMdPath,
  skillsMdPath,
  stage09OutputPath,
  synthesizeNarrative,
} from "./s09-contract-runner.ts";
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

/** Build a minimal Stage 7 output with the four implemented default manifests. */
function buildStage07Output() {
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

async function freshFixture(opts?: {
  withDomainSpec?: boolean;
  withStage07?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s09r-"));
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
    writeFileSync(p, JSON.stringify(buildStage07Output(), null, 2), "utf8");
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
    stageId: "09-contract-files",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:05.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createContractFilesRunner", () => {
  test("promptVersion is null", () => {
    expect(createContractFilesRunner().promptVersion).toBeNull();
  });

  test("happy path: writes DOMAIN.md / AGENTS.md / SKILLS.md + aggregate", async () => {
    const fx = await freshFixture();
    const outcome = await createContractFilesRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    expect(existsSync(domainMdPath(fx.almanacDir))).toBe(true);
    expect(existsSync(agentsMdPath(fx.almanacDir))).toBe(true);
    expect(existsSync(skillsMdPath(fx.almanacDir))).toBe(true);

    const domainMd = readFileSync(domainMdPath(fx.almanacDir), "utf8");
    expect(domainMd).toContain("Kubernetes");
    const skillsMd = readFileSync(skillsMdPath(fx.almanacDir), "utf8");
    expect(skillsMd).toContain("query_facts");

    const agg = Stage09OutputSchema.parse(
      JSON.parse(readFileSync(stage09OutputPath(fx.almanacDir), "utf8")),
    );
    expect(agg.files.map((f) => f.name)).toEqual([
      "DOMAIN.md",
      "AGENTS.md",
      "SKILLS.md",
    ]);

    // Determinism on a second run.
    const fx2 = await freshFixture();
    const outcome2 = await createContractFilesRunner().run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("missing domain spec → MissingDomainSpecError", async () => {
    const fx = await freshFixture({ withDomainSpec: false });
    await expect(
      createContractFilesRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingDomainSpecError);
  });

  test("missing Stage 7 output → MissingStage07OutputError", async () => {
    const fx = await freshFixture({ withStage07: false });
    await expect(
      createContractFilesRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingStage07OutputError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// synthesizeNarrative
// ──────────────────────────────────────────────────────────────────────────────

describe("synthesizeNarrative", () => {
  test("produces a schema-valid narrative from a minimal DomainSpec", () => {
    const n = synthesizeNarrative(VALID_DOMAIN_SPEC);
    Stage09NarrativeSchema.parse(n);
    expect(n.scope.covers.length).toBeGreaterThanOrEqual(2);
    expect(n.scope.outOfScope.length).toBeGreaterThanOrEqual(1);
    expect(n.toolSelectionGuidance).toContain("query_facts");
  });

  test("falls back to placeholders when DomainSpec.cautions is empty", () => {
    const n = synthesizeNarrative(VALID_DOMAIN_SPEC);
    expect(n.scope.outOfScope[0]).toContain("Kubernetes");
  });
});
