/**
 * Tests for `src/compile/stages/s07-tool-impl.ts`:
 *   - `isDefaultToolName` lookup
 *   - `selectImplementer` priority + miss
 *   - `runToolImplementation` aggregates per-tool results, records
 *     "no implementer matched" tools as `disabled`, and rejects empty input
 */

import { describe, expect, test } from "bun:test";

import {
  ToolManifestSchema,
  type ToolImplementationResult,
  type ToolManifest,
} from "../../core/types.ts";
import {
  NoImplementerForToolError,
  isDefaultToolName,
  runToolImplementation,
  selectImplementer,
  type ImplementationContext,
  type ToolImplementer,
} from "./s07-tool-impl.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const customManifest = (name: string): ToolManifest =>
  ToolManifestSchema.parse({
    name,
    version: "0.1.0",
    description: "A domain-specific custom tool.",
    whenToUse: "When the user asks something only this tool can answer.",
    returnsSummary: "Tool-specific output payload.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    capabilities: { network: ["api.example.com"], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: "live",
    freshness: { cachePolicy: "no-cache", ttlSeconds: null, sourceTimestamp: false },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    examples: [
      {
        description: "smoke",
        input: {},
        expectedShape: "match-outputSchema",
      },
    ],
    designedBy: { model: "claude-sonnet-4", promptVersion: "06-tool-design/v1" },
    disabled: false,
  });

const stubImplementer = (
  name: string,
  predicate: (m: ToolManifest) => boolean,
): ToolImplementer => ({
  name,
  canHandle: predicate,
  implement: async (m): Promise<ToolImplementationResult> => ({
    toolName: m.name,
    status: "implemented",
    attempts: [
      {
        attemptNumber: 1,
        model: "claude-sonnet-4",
        promptVersion: "07-tool-impl/v1",
        startedAt: "2026-05-08T12:00:00.000Z",
        finishedAt: "2026-05-08T12:00:30.000Z",
        outcome: "success",
        diagnostics: null,
      },
    ],
    finalManifest: {
      ...m,
      implementedBy: {
        model: "claude-sonnet-4",
        promptVersion: "07-tool-impl/v1",
        tscPassed: true,
        smokePassed: true,
        attempts: 1,
      },
    },
  }),
});

const stubCtx = (): ImplementationContext => ({
  almanacDir: "/tmp/almanac",
  llm: {
    model: "claude-sonnet-4",
    promptVersion: "07-tool-impl/v1",
    generate: async () => ({ code: "", testCode: "" }),
  },
  tsc: { check: async () => ({ ok: true }) },
  smoke: { test: async () => ({ ok: true }) },
  writeToolFiles: async ({ toolName }) => ({
    implPath: `/tmp/almanac/tools/${toolName}.ts`,
    testPath: `/tmp/almanac/tools/${toolName}.test.ts`,
  }),
  now: () => new Date("2026-05-08T12:00:00.000Z"),
  log: () => undefined,
});

// ──────────────────────────────────────────────────────────────────────────────
// isDefaultToolName
// ──────────────────────────────────────────────────────────────────────────────

describe("isDefaultToolName", () => {
  test("recognizes the 4 canonical defaults", () => {
    for (const n of [
      "query_facts",
      "fetch_official_docs",
      "web_search_recent",
      "latest_releases",
    ]) {
      expect(isDefaultToolName(n)).toBe(true);
    }
  });

  test("rejects custom names", () => {
    expect(isDefaultToolName("price_now")).toBe(false);
    expect(isDefaultToolName("ingredient_substitute")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// selectImplementer
// ──────────────────────────────────────────────────────────────────────────────

describe("selectImplementer", () => {
  const template = stubImplementer("template", (m) => isDefaultToolName(m.name));
  const llm = stubImplementer("llm", (m) => !isDefaultToolName(m.name));

  test("template-implementer claims defaults", () => {
    expect(
      selectImplementer(customManifest("query_facts"), [template, llm]).name,
    ).toBe("template");
  });

  test("llm-implementer claims custom tools", () => {
    expect(
      selectImplementer(customManifest("price_now"), [template, llm]).name,
    ).toBe("llm");
  });

  test("priority is registration order (specific before generic)", () => {
    const generic = stubImplementer("generic", () => true);
    expect(
      selectImplementer(customManifest("price_now"), [llm, generic]).name,
    ).toBe("llm");
    expect(
      selectImplementer(customManifest("query_facts"), [generic, template])
        .name,
    ).toBe("generic");
  });

  test("throws NoImplementerForToolError when none match", () => {
    expect(() =>
      selectImplementer(customManifest("price_now"), [
        stubImplementer("only-defaults", (m) => isDefaultToolName(m.name)),
      ]),
    ).toThrow(NoImplementerForToolError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runToolImplementation
// ──────────────────────────────────────────────────────────────────────────────

describe("runToolImplementation", () => {
  test("rejects empty manifests array", async () => {
    await expect(
      runToolImplementation({
        manifests: [],
        almanacDir: "/tmp/almanac",
        ctx: stubCtx(),
        implementers: [stubImplementer("any", () => true)],
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("delegates each manifest to the first matching implementer and aggregates", async () => {
    const out = await runToolImplementation({
      manifests: [customManifest("price_now"), customManifest("alpha_tool")],
      almanacDir: "/tmp/almanac",
      ctx: stubCtx(),
      implementers: [stubImplementer("any", () => true)],
    });
    expect(out.summary.total).toBe(2);
    expect(out.summary.implemented).toBe(2);
    expect(out.summary.disabled).toBe(0);
    expect(out.results.map((r) => r.toolName)).toEqual([
      "price_now",
      "alpha_tool",
    ]);
  });

  test("records tools with no matching implementer as disabled", async () => {
    const out = await runToolImplementation({
      manifests: [customManifest("price_now")],
      almanacDir: "/tmp/almanac",
      ctx: stubCtx(),
      // Predicate never matches → NoImplementerForToolError caught by orchestrator
      implementers: [stubImplementer("never", () => false)],
    });
    expect(out.summary.total).toBe(1);
    expect(out.summary.implemented).toBe(0);
    expect(out.summary.disabled).toBe(1);
    const r = out.results[0]!;
    expect(r.status).toBe("disabled");
    expect(r.finalManifest.disabled).toBe(true);
    expect(r.finalManifest.disabledReason).toContain("no implementer matched");
    expect(r.attempts[0]!.outcome).toBe("llm-failed");
  });
});
