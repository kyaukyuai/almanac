/**
 * Tests for the Stage 4 runner adapter.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  SourceFetchManifestSchema,
  SourcesFileSchema,
  type AlmanacManifest,
  type ApprovedSource,
  type CompileState,
  type SourceFetchEntry,
  type SourcesFile,
} from "../../core/types.ts";
import type { FetchContext, Fetcher } from "../fetchers/types.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { approvedSourcesPath } from "./s03-approve-runner.ts";
import {
  MissingApprovedSourcesError,
  createSourceFetchRunner,
  defaultFetchers,
  sourceFetchManifestPath,
} from "./s04-source-fetch-runner.ts";
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

function buildApproved(): SourcesFile {
  return SourcesFileSchema.parse({
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
}

async function freshFixture(opts?: {
  withApproved?: boolean;
  draftInsteadOfApproved?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s04-"));
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
  if (opts?.withApproved !== false) {
    const approved = opts?.draftInsteadOfApproved
      ? { ...buildApproved(), status: "draft" as const, approvedAt: undefined, approvedBy: undefined }
      : buildApproved();
    const p = approvedSourcesPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(approved, null, 2), "utf8");
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
    stageId: "04-source-fetch",
    log: () => {},
    now: () => new Date("2026-05-08T12:00:01.000Z"),
  };
}

// A simple stub fetcher that always succeeds with a tiny canned document.
function stubFetcher(): Fetcher {
  return {
    name: "stub",
    canHandle(_source: ApprovedSource): boolean {
      return true;
    },
    async fetch(
      source: ApprovedSource,
      ctx: FetchContext,
    ): Promise<SourceFetchEntry> {
      const bytes = new TextEncoder().encode(`fake content for ${source.id}`);
      const meta = await ctx.writeRaw({
        bytes,
        mediaType: "text/html",
      });
      return {
        sourceId: source.id,
        status: "fetched",
        fetchedAt: ctx.now().toISOString(),
        finalUrl: source.url,
        fetcher: "stub",
        documents: [
          {
            url: source.url,
            fetchedAt: ctx.now().toISOString(),
            mediaType: "text/html",
            byteLength: meta.byteLength,
            contentHash: meta.contentHash,
            relPath: meta.relPath,
          },
        ],
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createSourceFetchRunner", () => {
  test("promptVersion is null", () => {
    expect(createSourceFetchRunner().promptVersion).toBeNull();
  });

  test("happy path: writes manifest.summary.json + outputHash", async () => {
    const fx = await freshFixture();
    const runner = createSourceFetchRunner({
      fetchers: [stubFetcher()],
    });
    const outcome = await runner.run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    const body = readFileSync(sourceFetchManifestPath(fx.almanacDir), "utf8");
    const persisted = SourceFetchManifestSchema.parse(JSON.parse(body));
    expect(persisted.summary.fetched).toBe(1);
    expect(persisted.summary.failed).toBe(0);
    expect(persisted.entries.length).toBe(1);
    expect(persisted.entries[0]!.status).toBe("fetched");
  });

  test("missing approved sources → MissingApprovedSourcesError", async () => {
    const fx = await freshFixture({ withApproved: false });
    const runner = createSourceFetchRunner({ fetchers: [stubFetcher()] });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingApprovedSourcesError,
    );
  });

  test("draft instead of approved → throws (status guard)", async () => {
    const fx = await freshFixture({ draftInsteadOfApproved: true });
    const runner = createSourceFetchRunner({ fetchers: [stubFetcher()] });
    await expect(runner.run(makeCtx(fx))).rejects.toBeInstanceOf(Error);
  });

  test("defaultFetchers returns github-repo, local-file, http-index-only, generic-http in priority order", () => {
    const fs = defaultFetchers();
    expect(fs.map((f) => f.name)).toEqual([
      "github-repo",
      "local-file",
      "http-index-only",
      "generic-http",
    ]);
  });
});
