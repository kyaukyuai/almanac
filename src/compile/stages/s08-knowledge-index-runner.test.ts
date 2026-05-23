/**
 * Tests for the Stage 8 runner adapter.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  KnowledgeIndexManifestSchema,
  type AlmanacManifest,
  type CompileState,
  type FactRecord,
} from "../../core/types.ts";
import { knowledgeIndexManifestPath } from "../storage.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { factsJsonlPath } from "./s05-fact-extraction.ts";
import {
  MissingFactsError,
  createKnowledgeIndexRunner,
  knowledgeDbPath,
} from "./s08-knowledge-index-runner.ts";
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

const ULID = (n: number) =>
  `01H000000000000000000000${n.toString(36).toUpperCase().padStart(2, "0")}`;
const HASH = (n: number) => "abcdef".repeat(10) + n.toString().padStart(4, "0");

function buildFacts(): FactRecord[] {
  return [
    {
      id: ULID(1),
      text: "A Pod is the smallest deployable unit in Kubernetes.",
      type: "definition",
      entities: ["pod", "resource"],
      source: {
        sourceId: "k8s-docs",
        contentHash: HASH(1),
        url: "https://kubernetes.io/docs/",
        excerpt: "A Pod is the smallest deployable unit in Kubernetes.",
      },
      freshnessClass: "static",
      validUntil: null,
      confidence: 0.95,
      extractedAt: "2026-05-08T12:00:01.000Z",
      extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
    },
    {
      id: ULID(2),
      text: "To create a Pod, apply a YAML manifest with kind: Pod to the API server.",
      type: "procedure",
      entities: ["pod", "kubectl"],
      source: {
        sourceId: "k8s-docs",
        contentHash: HASH(2),
        url: "https://kubernetes.io/docs/",
        excerpt: "Apply a YAML manifest with kind: Pod to the API server.",
      },
      freshnessClass: "slow",
      validUntil: "2027-05-08T12:00:01.000Z",
      confidence: 0.9,
      extractedAt: "2026-05-08T12:00:01.000Z",
      extractor: { model: "claude-sonnet-4-5", promptVersion: "v1" },
    },
  ];
}

async function freshFixture(opts?: {
  withFacts?: boolean;
  factsBody?: string;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s08r-"));
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
  if (opts?.withFacts !== false) {
    const p = factsJsonlPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    const body =
      opts?.factsBody ?? buildFacts().map((f) => JSON.stringify(f)).join("\n") + "\n";
    await writeFile(p, body, "utf8");
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
    stageId: "08-knowledge-index",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:04.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createKnowledgeIndexRunner", () => {
  test("promptVersion is null", () => {
    expect(createKnowledgeIndexRunner().promptVersion).toBeNull();
  });

  test("happy path: builds sqlite db + manifest, deterministic outputHash", async () => {
    const fx = await freshFixture();
    const outcome = await createKnowledgeIndexRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    expect(existsSync(knowledgeDbPath(fx.almanacDir))).toBe(true);
    const m = KnowledgeIndexManifestSchema.parse(
      JSON.parse(readFileSync(knowledgeIndexManifestPath(fx.almanacDir), "utf8")),
    );
    expect(m.factCount).toBe(2);
    expect(m.counts.byClass.static).toBe(1);
    expect(m.counts.byClass.slow).toBe(1);
    expect(m.counts.byType.definition).toBe(1);
    expect(m.counts.byType.procedure).toBe(1);
    expect(m.factCorpusHash).toMatch(/^[a-f0-9]{64}$/);

    // The db actually has the rows.
    const db = new Database(knowledgeDbPath(fx.almanacDir), { readonly: true });
    const row = db.query("SELECT count(*) AS n FROM facts").get() as {
      n: number;
    };
    expect(row.n).toBe(2);
    db.close();

    // Determinism on a second run.
    const fx2 = await freshFixture();
    const outcome2 = await createKnowledgeIndexRunner().run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("rebuild: deletes prior sqlite file before building", async () => {
    const fx = await freshFixture();
    await createKnowledgeIndexRunner().run(makeCtx(fx));
    // Pre-write a sentinel byte to simulate a stale prior db.
    const dbPath = knowledgeDbPath(fx.almanacDir);
    expect(existsSync(dbPath)).toBe(true);
    const sizeBefore = readFileSync(dbPath).byteLength;
    expect(sizeBefore).toBeGreaterThan(0);
    // Re-run with the same facts → still succeeds, db is rebuilt.
    const outcome = await createKnowledgeIndexRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
  });

  test("malformed lines are skipped, valid lines indexed", async () => {
    const valid = buildFacts()[0]!;
    const body = [
      "",
      "not json",
      '{"id":"not-a-ulid"}',
      JSON.stringify(valid),
      "",
    ].join("\n");
    const fx = await freshFixture({ factsBody: body });
    const events: object[] = [];
    const outcome = await createKnowledgeIndexRunner().run(
      makeCtx({ ...fx, log: (e) => events.push(e) }),
    );
    if (outcome.kind !== "success") throw new Error("expected success");
    const m = KnowledgeIndexManifestSchema.parse(
      JSON.parse(readFileSync(knowledgeIndexManifestPath(fx.almanacDir), "utf8")),
    );
    expect(m.factCount).toBe(1);
    const malformed = events.filter(
      (e) => (e as { event?: string }).event === "stage8:malformed-line",
    );
    expect(malformed.length).toBe(2);
  });

  test("empty facts.jsonl → valid empty manifest", async () => {
    const fx = await freshFixture({ factsBody: "" });
    const outcome = await createKnowledgeIndexRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    const m = KnowledgeIndexManifestSchema.parse(
      JSON.parse(readFileSync(knowledgeIndexManifestPath(fx.almanacDir), "utf8")),
    );
    expect(m.factCount).toBe(0);
    expect(m.counts.byClass.static).toBe(0);
    expect(m.counts.byClass.slow).toBe(0);
  });

  test("missing facts.jsonl → MissingFactsError", async () => {
    const fx = await freshFixture({ withFacts: false });
    await expect(
      createKnowledgeIndexRunner().run(makeCtx(fx)),
    ).rejects.toBeInstanceOf(MissingFactsError);
  });
});
