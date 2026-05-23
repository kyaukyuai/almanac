/**
 * Tests for the Stage 3 runner adapter (auto vs require-approval, IO).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  SourcesFileSchema,
  type AlmanacManifest,
  type CompileState,
  type CompileOptions,
  type SourcesFile,
} from "../../core/types.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { sourcesDraftPath } from "./s02b-source-discovery-evaluator.ts";
import {
  MissingDraftSourcesError,
  approvedSourcesPath,
  createApproveRunner,
} from "./s03-approve-runner.ts";
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

function buildDraft(): SourcesFile {
  return SourcesFileSchema.parse({
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
  });
}

async function freshFixture(opts?: {
  withDraft?: boolean;
  autoApprove?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s03-"));
  cleanup.push(root);
  const almanacDir = join(root, "kubernetes");
  const options: CompileOptions = {
    depth: "standard",
    sourcesHint: [],
    target: "both",
    autoApprove: opts?.autoApprove ?? true,
    language: "ts",
  };
  const { manifest, compileState } = bootstrapAlmanac({
    almanacId: "kubernetes",
    domain: "kubernetes",
    displayName: "Kubernetes",
    freshnessProfileId: "mixed",
    runId: "run-test",
    forgerVersion: "0.0.0",
    options,
    now: new Date("2026-05-08T12:00:00.000Z"),
  });
  await ensureAlmanacLayout(almanacDir);
  if (opts?.withDraft !== false) {
    const p = sourcesDraftPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(buildDraft(), null, 2), "utf8");
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
}): StageContext {
  return {
    almanacDir: input.almanacDir,
    manifest: input.manifest,
    state: input.state,
    stageId: "03-source-approve",
    log: () => {},
    now: () => new Date("2026-05-08T12:00:01.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createApproveRunner", () => {
  test("promptVersion is null", () => {
    expect(createApproveRunner().promptVersion).toBeNull();
  });

  test("auto-approve: writes sources/sources.json with status=approved", async () => {
    const fx = await freshFixture({ autoApprove: true });
    const outcome = await createApproveRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    const body = readFileSync(approvedSourcesPath(fx.almanacDir), "utf8");
    const persisted = SourcesFileSchema.parse(JSON.parse(body));
    expect(persisted.status).toBe("approved");
    expect(persisted.approvedBy).toBe("auto");
    expect(persisted.approvedAt).toBe("2026-05-08T12:00:01.000Z");
    expect(persisted.sources.length).toBe(1);
  });

  test("require-approval: returns skipped with reason", async () => {
    const fx = await freshFixture({ autoApprove: false });
    const outcome = await createApproveRunner().run(makeCtx(fx));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("human-approval-required");
    }
  });

  test("missing draft → MissingDraftSourcesError", async () => {
    const fx = await freshFixture({ withDraft: false });
    await expect(createApproveRunner().run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingDraftSourcesError,
    );
  });

  test("deterministic outputHash for the same draft + same now()", async () => {
    const fx1 = await freshFixture();
    const fx2 = await freshFixture();
    const out1 = await createApproveRunner().run(makeCtx(fx1));
    const out2 = await createApproveRunner().run(makeCtx(fx2));
    if (out1.kind !== "success" || out2.kind !== "success") {
      throw new Error("expected success");
    }
    expect(out1.outputHash).toBe(out2.outputHash);
  });
});
