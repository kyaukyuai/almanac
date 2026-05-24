/**
 * Tests for `LlmImplementer` — verifies the per-tool retry loop and the
 * status / attempts / finalManifest the orchestrator receives.
 *
 * Strategy: drive the implementer with fully-stubbed `LlmCodeWriter`,
 * `TscRunner`, `SmokeTestRunner`, and `writeToolFiles`. No fs, no subprocess,
 * no real LLM.
 */
import { describe, expect, test } from "bun:test";

import {
  ToolImplementationResultSchema,
  ToolManifestSchema,
  type ToolManifest,
} from "../../../core/types.ts";
import { ImplementerMisroutedError } from "../s07-tool-impl.ts";
import type {
  ImplementationContext,
  LlmCodeWriter,
  SmokeTestRunner,
  TscRunner,
} from "../s07-tool-impl.ts";
import { LlmImplementer } from "./llm-implementer.ts";
import { LlmCodeWriterError } from "./code-writer.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

function manifest(name = "ingredient_substitute"): ToolManifest {
  return ToolManifestSchema.parse({
    name,
    version: "0.1.0",
    description: "Suggest substitutes for an ingredient.",
    whenToUse: "When the user asks for an alternative to an ingredient.",
    returnsSummary: "Ranked list of substitutes.",
    inputSchema: {
      type: "object",
      properties: { ingredient: { type: "string" } },
      required: ["ingredient"],
    },
    outputSchema: {
      type: "object",
      properties: { substitutes: { type: "array" } },
      required: ["substitutes"],
    },
    capabilities: { network: [], fs: "read", subprocess: [], secrets: [] },
    volatilityClass: "static",
    freshness: {
      cachePolicy: "manual-refresh",
      ttlSeconds: null,
      sourceTimestamp: false,
    },
    knowledgeUsage: { facts: true, ftsQuery: "{q}", embeddings: false },
    examples: [
      {
        description: "smoke",
        input: { ingredient: "buttermilk" },
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
    disabled: false,
  });
}

interface StubBag {
  llm: LlmCodeWriter;
  tsc: TscRunner;
  smoke: SmokeTestRunner;
  ctx: ImplementationContext;
  /** Records of what the implementer called. */
  log: object[];
  writes: Array<{ toolName: string; code: string; testCode: string }>;
}

interface MakeCtxOptions {
  generate?: LlmCodeWriter["generate"];
  tscCheck?: TscRunner["check"];
  smokeTest?: SmokeTestRunner["test"];
  writeToolFiles?: ImplementationContext["writeToolFiles"];
  llmModel?: string;
  llmPromptVersion?: string;
}

function makeCtx(opts: MakeCtxOptions = {}): StubBag {
  const log: object[] = [];
  const writes: Array<{ toolName: string; code: string; testCode: string }> = [];
  let n = 0;
  const llm: LlmCodeWriter = {
    model: opts.llmModel ?? "claude-sonnet-4-5",
    promptVersion: opts.llmPromptVersion ?? "07-tool-impl/v1",
    generate:
      opts.generate ??
      (async () => ({ code: "ok-code", testCode: "ok-test" })),
  };
  const tsc: TscRunner = {
    check: opts.tscCheck ?? (async () => ({ ok: true })),
  };
  const smoke: SmokeTestRunner = {
    test: opts.smokeTest ?? (async () => ({ ok: true })),
  };
  const writeToolFiles =
    opts.writeToolFiles ??
    (async (input: { toolName: string; code: string; testCode: string }) => {
      writes.push(input);
      return {
        implPath: `/tmp/almanac/tools/${input.toolName}.ts`,
        testPath: `/tmp/almanac/tools/${input.toolName}.test.ts`,
      };
    });
  const ctx: ImplementationContext = {
    almanacDir: "/tmp/almanac",
    llm,
    tsc,
    smoke,
    writeToolFiles,
    now: () => {
      n += 1;
      // Each call advances 1 second so finishedAt >= startedAt without ties.
      return new Date(2026, 4, 8, 12, 0, n);
    },
    log: (e) => log.push(e),
  };
  return { llm, tsc, smoke, ctx, log, writes };
}

// ──────────────────────────────────────────────────────────────────────────────
// canHandle
// ──────────────────────────────────────────────────────────────────────────────

describe("LlmImplementer.canHandle", () => {
  test("accepts custom tool names", () => {
    const impl = new LlmImplementer();
    expect(impl.canHandle(manifest("ingredient_substitute"))).toBe(true);
  });

  test("refuses the four default tool names", () => {
    const impl = new LlmImplementer();
    for (const n of [
      "query_facts",
      "fetch_official_docs",
      "web_search_recent",
      "latest_releases",
    ]) {
      expect(impl.canHandle(manifest(n))).toBe(false);
    }
  });

  test("respects custom refuseNames override", () => {
    const impl = new LlmImplementer({ refuseNames: new Set(["x_tool"]) });
    expect(impl.canHandle(manifest("x_tool"))).toBe(false);
    expect(impl.canHandle(manifest("query_facts"))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// implement — success path
// ──────────────────────────────────────────────────────────────────────────────

describe("LlmImplementer.implement (success)", () => {
  test("succeeds on first attempt; result schema-valid", async () => {
    const bag = makeCtx();
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 3,
    });
    expect(r.status).toBe("implemented");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.outcome).toBe("success");
    expect(r.finalManifest.disabled).toBe(false);
    expect(r.finalManifest.implementedBy?.attempts).toBe(1);
    expect(r.finalManifest.implementedBy?.tscPassed).toBe(true);
    expect(r.finalManifest.implementedBy?.smokePassed).toBe(true);
    expect(() => ToolImplementationResultSchema.parse(r)).not.toThrow();
    expect(bag.writes).toHaveLength(1);
  });

  test("recovers from tsc-failed → tsc-ok in 2 attempts", async () => {
    let calls = 0;
    const bag = makeCtx({
      tscCheck: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, diagnostics: "TS2304: Cannot find name 'foo'" }
          : { ok: true };
      },
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 3,
    });
    expect(r.status).toBe("implemented");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.outcome).toBe("tsc-failed");
    expect(r.attempts[0]!.diagnostics).toContain("TS2304");
    expect(r.attempts[1]!.outcome).toBe("success");
    expect(() => ToolImplementationResultSchema.parse(r)).not.toThrow();
  });

  test("recovers from smoke-failed in 2 attempts", async () => {
    let calls = 0;
    const bag = makeCtx({
      smokeTest: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, diagnostics: "FAIL tools/x.test.ts: expected 1 to be 2" }
          : { ok: true };
      },
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 3,
    });
    expect(r.status).toBe("implemented");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.outcome).toBe("smoke-failed");
    expect(r.attempts[1]!.outcome).toBe("success");
  });

  test("feeds previousAttempt diagnostics back into the next generate call", async () => {
    const seen: Array<unknown> = [];
    let calls = 0;
    const bag = makeCtx({
      generate: async (input) => {
        seen.push(input.previousAttempt ?? null);
        calls += 1;
        return { code: `code-${calls}`, testCode: `test-${calls}` };
      },
      tscCheck: async () => {
        return calls === 1
          ? { ok: false, diagnostics: "diag-from-tsc" }
          : { ok: true };
      },
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 3,
    });
    expect(r.status).toBe("implemented");
    expect(seen[0]).toBeNull();
    expect(seen[1]).toMatchObject({
      outcome: "tsc-failed",
      diagnostics: "diag-from-tsc",
      code: "code-1",
      testCode: "test-1",
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// implement — failure paths
// ──────────────────────────────────────────────────────────────────────────────

describe("LlmImplementer.implement (failure)", () => {
  test("llm throw → llm-failed attempt; rawText carried into previousAttempt", async () => {
    let firstAttempt = true;
    const seenPrev: unknown[] = [];
    const bag = makeCtx({
      generate: async (input) => {
        seenPrev.push(input.previousAttempt ?? null);
        if (firstAttempt) {
          firstAttempt = false;
          throw new LlmCodeWriterError(
            "bad json",
            "raw model output that was not valid JSON",
          );
        }
        return { code: "ok-code", testCode: "ok-test" };
      },
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 2,
    });
    expect(r.status).toBe("implemented");
    expect(r.attempts[0]!.outcome).toBe("llm-failed");
    expect(seenPrev[1]).toMatchObject({
      outcome: "llm-failed",
      code: "raw model output that was not valid JSON",
    });
  });

  test("write-failed → recorded and retried", async () => {
    let writeCalls = 0;
    const bag = makeCtx({
      writeToolFiles: async (input) => {
        writeCalls += 1;
        if (writeCalls === 1) throw new Error("EACCES: permission denied");
        return {
          implPath: `/tmp/${input.toolName}.ts`,
          testPath: `/tmp/${input.toolName}.test.ts`,
        };
      },
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 2,
    });
    expect(r.status).toBe("implemented");
    expect(r.attempts[0]!.outcome).toBe("write-failed");
    expect(r.attempts[0]!.diagnostics).toContain("EACCES");
  });

  test("exhausts attempts → disabled with finalManifest.disabled=true", async () => {
    const bag = makeCtx({
      tscCheck: async () => ({ ok: false, diagnostics: "persistent ts error" }),
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 2,
    });
    expect(r.status).toBe("disabled");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts.every((a) => a.outcome === "tsc-failed")).toBe(true);
    expect(r.finalManifest.disabled).toBe(true);
    expect(r.finalManifest.disabledReason).toContain("tsc-failed");
    expect(r.finalManifest.implementedBy).toBeUndefined();
    expect(() => ToolImplementationResultSchema.parse(r)).not.toThrow();
  });

  test("throws ImplementerMisroutedError if given a default tool name", async () => {
    const bag = makeCtx();
    await expect(
      new LlmImplementer().implement(manifest("query_facts"), bag.ctx, {
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(ImplementerMisroutedError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// implement — attempt numbering + ISO timestamps
// ──────────────────────────────────────────────────────────────────────────────

describe("attempt records", () => {
  test("attemptNumber is sequential starting at 1", async () => {
    const bag = makeCtx({
      tscCheck: async () => ({ ok: false, diagnostics: "x" }),
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 3,
    });
    expect(r.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
  });

  test("model + promptVersion come from ctx.llm", async () => {
    const bag = makeCtx({
      llmModel: "custom-model",
      llmPromptVersion: "custom/v9",
    });
    const r = await new LlmImplementer().implement(manifest(), bag.ctx, {
      maxAttempts: 1,
    });
    expect(r.attempts[0]!.model).toBe("custom-model");
    expect(r.attempts[0]!.promptVersion).toBe("custom/v9");
    expect(r.finalManifest.implementedBy?.model).toBe("custom-model");
    expect(r.finalManifest.implementedBy?.promptVersion).toBe("custom/v9");
  });
});
