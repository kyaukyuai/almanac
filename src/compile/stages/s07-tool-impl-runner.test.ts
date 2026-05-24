/**
 * Tests for the Stage 7 runner adapter.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AlmanacManifestSchema,
  CompileStateSchema,
  Stage07OutputSchema,
  ToolDesignResultSchema,
  ToolManifestSchema,
  type AlmanacManifest,
  type CompileState,
  type ToolDesignResult,
  type ToolManifest,
} from "../../core/types.ts";
import { ensureAlmanacLayout } from "../storage.ts";
import { bootstrapAlmanac } from "./s00-bootstrap.ts";
import { toolDesignPath } from "./s06-tool-design.ts";
import {
  MissingToolDesignError,
  createToolImplRunner,
  removeStaleToolFiles,
  stage07OutputPath,
} from "./s07-tool-impl-runner.ts";
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

function buildCustomTool(name: string): ToolManifest {
  return {
    name,
    version: "0.1.0",
    description:
      "Look up the OpenAPI schema fragment for a Kubernetes resource at a specific version.",
    whenToUse:
      "When the user asks about the fields or validation of a resource at a specific version.",
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
    freshness: { cachePolicy: "ttl", ttlSeconds: 86400, sourceTimestamp: false },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    examples: [
      {
        description: "Pod returns a schema",
        input: { resource: "Pod" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
    disabled: false,
  };
}

function buildToolDesign(opts?: { withCustom?: boolean }): ToolDesignResult {
  return ToolDesignResultSchema.parse({
    schemaVersion: "0.1.0",
    customTools: opts?.withCustom ? [buildCustomTool("lookup_resource_spec")] : [],
    rationale:
      opts?.withCustom
        ? "Domain needs a version-aware spec lookup beyond the four defaults."
        : "The four defaults fully cover this domain.",
  });
}

async function freshFixture(opts?: {
  withDesign?: boolean;
  customTools?: boolean;
}): Promise<{
  almanacDir: string;
  manifest: AlmanacManifest;
  state: CompileState;
}> {
  const root = mkdtempSync(join(tmpdir(), "almanac-s07r-"));
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
  if (opts?.withDesign !== false) {
    const p = toolDesignPath(almanacDir);
    await mkdir(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(buildToolDesign({ withCustom: opts?.customTools }), null, 2),
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
    stageId: "07-tool-impl",
    log: input.log ?? (() => {}),
    now: () => new Date("2026-05-08T12:00:03.000Z"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────────

describe("createToolImplRunner", () => {
  test("promptVersion is null", () => {
    expect(createToolImplRunner().promptVersion).toBeNull();
  });

  test("happy path: implements the four defaults, persists per-tool manifests + aggregate", async () => {
    const fx = await freshFixture();
    const outcome = await createToolImplRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    expect(outcome.outputHash).toMatch(/^[a-f0-9]{64}$/);

    const aggBody = readFileSync(stage07OutputPath(fx.almanacDir), "utf8");
    const agg = Stage07OutputSchema.parse(JSON.parse(aggBody));
    expect(agg.summary.total).toBe(4);
    expect(agg.summary.implemented).toBe(4);
    expect(agg.summary.disabled).toBe(0);
    expect(agg.results.map((r) => r.toolName).sort()).toEqual([
      "fetch_official_docs",
      "latest_releases",
      "query_facts",
      "web_search_recent",
    ]);

    // Each per-tool manifest landed at tools/<name>.json and is schema-valid.
    for (const r of agg.results) {
      const mp = join(fx.almanacDir, "tools", `${r.finalManifest.name}.json`);
      expect(existsSync(mp)).toBe(true);
      ToolManifestSchema.parse(JSON.parse(readFileSync(mp, "utf8")));
      // And the impl + test source files were written.
      expect(existsSync(join(fx.almanacDir, "tools", `${r.toolName}.ts`))).toBe(
        true,
      );
      expect(
        existsSync(join(fx.almanacDir, "tools", `${r.toolName}.test.ts`)),
      ).toBe(true);
    }

    // Determinism: same fixture + same now() → same outputHash.
    const fx2 = await freshFixture();
    const outcome2 = await createToolImplRunner().run(makeCtx(fx2));
    if (outcome2.kind !== "success") throw new Error("expected success");
    expect(outcome2.outputHash).toBe(outcome.outputHash);
  });

  test("custom tool without an implementer is recorded as disabled", async () => {
    const fx = await freshFixture({ customTools: true });
    const outcome = await createToolImplRunner().run(makeCtx(fx));
    if (outcome.kind !== "success") throw new Error("expected success");
    const agg = Stage07OutputSchema.parse(
      JSON.parse(readFileSync(stage07OutputPath(fx.almanacDir), "utf8")),
    );
    expect(agg.summary.total).toBe(5);
    expect(agg.summary.implemented).toBe(4);
    expect(agg.summary.disabled).toBe(1);
    const custom = agg.results.find((r) => r.toolName === "lookup_resource_spec")!;
    expect(custom.status).toBe("disabled");
    expect(custom.finalManifest.disabled).toBe(true);
    expect(custom.finalManifest.disabledReason).toContain(
      "no implementer matched",
    );
  });

  test("missing tool design → MissingToolDesignError", async () => {
    const fx = await freshFixture({ withDesign: false });
    await expect(createToolImplRunner().run(makeCtx(fx))).rejects.toBeInstanceOf(
      MissingToolDesignError,
    );
  });

  test("skipDefaults + no customs → skipped (no manifests)", async () => {
    const fx = await freshFixture();
    const events: object[] = [];
    const outcome = await createToolImplRunner({ skipDefaults: true }).run(
      makeCtx({ ...fx, log: (e) => events.push(e) }),
    );
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no-manifests");
    }
    const skip = events.find(
      (e) => (e as { event?: string }).event === "stage7:skipped",
    );
    expect(skip).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// removeStaleToolFiles
// ──────────────────────────────────────────────────────────────────────────────

describe("removeStaleToolFiles", () => {
  test("removes triplets for tools not in the expected set", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-stale-"));
    cleanup.push(root);
    const toolsDir = join(root, "tools");
    await mkdir(toolsDir, { recursive: true });
    for (const name of ["alive", "ghost"]) {
      writeFileSync(join(toolsDir, `${name}.json`), "{}", "utf8");
      writeFileSync(join(toolsDir, `${name}.ts`), "export default () => {}", "utf8");
      writeFileSync(join(toolsDir, `${name}.test.ts`), "// test", "utf8");
    }

    const removed = await removeStaleToolFiles(root, new Set(["alive"]));
    expect(removed).toEqual(["ghost"]);
    expect(existsSync(join(toolsDir, "alive.json"))).toBe(true);
    expect(existsSync(join(toolsDir, "alive.ts"))).toBe(true);
    expect(existsSync(join(toolsDir, "alive.test.ts"))).toBe(true);
    expect(existsSync(join(toolsDir, "ghost.json"))).toBe(false);
    expect(existsSync(join(toolsDir, "ghost.ts"))).toBe(false);
    expect(existsSync(join(toolsDir, "ghost.test.ts"))).toBe(false);
  });

  test("missing tools/ dir → returns empty (no throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-stale-nodir-"));
    cleanup.push(root);
    expect(await removeStaleToolFiles(root, new Set())).toEqual([]);
  });

  test("ignores files outside the .{json,ts,test.ts} triplet shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "almanac-stale-extra-"));
    cleanup.push(root);
    const toolsDir = join(root, "tools");
    await mkdir(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "alive.json"), "{}", "utf8");
    writeFileSync(join(toolsDir, "alive.ts"), "// noop", "utf8");
    // Files we should not touch:
    writeFileSync(join(toolsDir, "scratch.md"), "# notes", "utf8");
    writeFileSync(join(toolsDir, "tsconfig.toml"), "[x]", "utf8");

    const removed = await removeStaleToolFiles(root, new Set(["alive"]));
    expect(removed).toEqual([]);
    expect(existsSync(join(toolsDir, "scratch.md"))).toBe(true);
    expect(existsSync(join(toolsDir, "tsconfig.toml"))).toBe(true);
  });
});
