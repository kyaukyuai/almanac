/**
 * In-process MCP integration tests.
 *
 * Wires a `Client` to a `createMcpServer` over an in-memory transport pair,
 * backed by a stub `AlmanacRuntime`. This validates that:
 *
 *   - tools/list returns the manifest list shaped as MCP `Tool[]`
 *   - tools/call routes through `runtime.execTool`
 *   - tools/call → `ToolNotFoundError` becomes an `isError: true` envelope
 *   - resources/list / resources/read pass through correctly
 *   - resources/read of an unknown URI surfaces an MCP error
 */

import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  type AlmanacRuntime,
  ResourceNotFoundError,
  ToolNotFoundError,
} from "../core/runtime.ts";
import type {
  ResourceDescriptor,
  ToolManifest,
  ToolResult,
} from "../core/types.ts";

import { createMcpServer, manifestToMcpTool } from "./mcp-server.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Stub runtime
// ──────────────────────────────────────────────────────────────────────────────

interface StubRuntimeInput {
  tools?: ToolManifest[];
  resources?: ResourceDescriptor[];
  exec?: (name: string, input: unknown) => Promise<ToolResult>;
  read?: (uri: string) => Promise<{ contents: string; mimeType: string }>;
}

function makeStubRuntime(input: StubRuntimeInput): AlmanacRuntime {
  const tools = input.tools ?? [];
  const toolNames = new Set(tools.map((t) => t.name));
  return {
    async listTools() {
      return tools;
    },
    async execTool(name, args) {
      if (input.exec) return input.exec(name, args);
      if (!toolNames.has(name)) throw new ToolNotFoundError(name);
      return {
        ok: true,
        data: { echoed: args },
        citations: [
          {
            sourceId: "src-test-001",
            url: "https://example.com",
            fetchedAt: new Date().toISOString(),
          },
        ],
        freshness: { class: "static", maxAge: null, staleness: "fresh" },
      };
    },
    async listResources() {
      return input.resources ?? [];
    },
    async readResource(uri) {
      if (input.read) return input.read(uri);
      throw new ResourceNotFoundError(uri);
    },
  };
}

function baseManifest(name: string, overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name,
    version: "0.1.0",
    description: `Stub tool ${name} for MCP integration tests.`,
    whenToUse: `Use when testing MCP routing for ${name}.`,
    returnsSummary: `Echoes the input as JSON.`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    outputSchema: { type: "object", properties: { echoed: { type: "object" } } },
    capabilities: { network: [], fs: "none", subprocess: [], secrets: [] },
    volatilityClass: "slow",
    freshness: { cachePolicy: "ttl", ttlSeconds: 3600, sourceTimestamp: false },
    knowledgeUsage: { facts: false, ftsQuery: null, embeddings: false },
    sourceDependencies: [],
    sampleUrls: [],
    examples: [
      { description: "smoke", input: { q: "x" }, expectedShape: "match-outputSchema" },
    ],
    designedBy: { model: "stub", promptVersion: "v1" },
    disabled: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Wiring
// ──────────────────────────────────────────────────────────────────────────────

async function connect(runtime: AlmanacRuntime): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({
    runtime,
    serverInfo: { name: "almanac-test", version: "0.0.0-test" },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("MCP server — tools/list", () => {
  test("maps each manifest to an MCP Tool with name + description + inputSchema", async () => {
    const tools = [baseManifest("alpha_tool"), baseManifest("beta_tool")];
    const { client, close } = await connect(makeStubRuntime({ tools }));
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).toEqual(["alpha_tool", "beta_tool"]);
      const a = result.tools.find((t) => t.name === "alpha_tool");
      expect(a?.inputSchema.type).toBe("object");
      expect(a?.description).toContain("Stub tool alpha_tool");
      expect(a?.description).toContain("Volatility: slow");
      expect(a?.description).toContain("cached up to 3600s");
    } finally {
      await close();
    }
  });
});

describe("MCP server — tools/call", () => {
  test("routes through execTool and returns the envelope as text content", async () => {
    const tools = [baseManifest("echo_tool")];
    const { client, close } = await connect(makeStubRuntime({ tools }));
    try {
      const result = await client.callTool({ name: "echo_tool", arguments: { q: "ping" } });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(typeof text).toBe("string");
      const envelope = JSON.parse(text!) as ToolResult;
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect((envelope.data as { echoed: unknown }).echoed).toEqual({ q: "ping" });
        expect(envelope.citations.length).toBeGreaterThan(0);
        expect(envelope.freshness.class).toBe("static");
      }
    } finally {
      await close();
    }
  });

  test("converts ToolNotFoundError to isError:true with tool-not-found", async () => {
    const { client, close } = await connect(makeStubRuntime({ tools: [] }));
    try {
      const result = await client.callTool({ name: "unknown_tool", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      const envelope = JSON.parse(text!) as ToolResult;
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.code).toBe("tool-not-found");
        expect(envelope.error.message).toContain("unknown_tool");
      }
    } finally {
      await close();
    }
  });

  test("ok:false envelopes from runtime are surfaced with isError:true", async () => {
    const tools = [baseManifest("err_tool")];
    const runtime = makeStubRuntime({
      tools,
      exec: async () => ({
        ok: false,
        error: { code: "blocked", message: "rate limited", retryable: true },
      }),
    });
    const { client, close } = await connect(runtime);
    try {
      const result = await client.callTool({ name: "err_tool", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      const envelope = JSON.parse(text!) as ToolResult;
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.code).toBe("blocked");
        expect(envelope.error.retryable).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

describe("MCP server — resources/list + resources/read", () => {
  test("listResources passes through with mimeType + size", async () => {
    const resources: ResourceDescriptor[] = [
      {
        uri: "almanac://test/DOMAIN.md",
        name: "DOMAIN.md",
        description: "Domain definition",
        mimeType: "text/markdown",
        size: 42,
      },
    ];
    const { client, close } = await connect(makeStubRuntime({ resources }));
    try {
      const result = await client.listResources();
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0]?.uri).toBe("almanac://test/DOMAIN.md");
      expect(result.resources[0]?.mimeType).toBe("text/markdown");
    } finally {
      await close();
    }
  });

  test("readResource returns text contents under the requested URI", async () => {
    const { client, close } = await connect(
      makeStubRuntime({
        read: async (uri) => {
          expect(uri).toBe("almanac://test/DOMAIN.md");
          return { contents: "# Domain\nhello\n", mimeType: "text/markdown" };
        },
      }),
    );
    try {
      const result = await client.readResource({ uri: "almanac://test/DOMAIN.md" });
      expect(result.contents).toHaveLength(1);
      const c = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(c.uri).toBe("almanac://test/DOMAIN.md");
      expect(c.mimeType).toBe("text/markdown");
      expect(c.text).toContain("# Domain");
    } finally {
      await close();
    }
  });

  test("readResource of an unknown URI surfaces an MCP error", async () => {
    const { client, close } = await connect(makeStubRuntime({}));
    try {
      await expect(
        client.readResource({ uri: "almanac://test/missing.md" }),
      ).rejects.toThrow(/resource not found/);
    } finally {
      await close();
    }
  });
});

describe("manifestToMcpTool", () => {
  test("preserves type:object inputSchema verbatim", () => {
    const m = baseManifest("a", {
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
      },
    });
    const tool = manifestToMcpTool(m);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toEqual(["x"]);
  });

  test("wraps non-object input schemas in a permissive object", () => {
    const m = baseManifest("a", { inputSchema: { type: "string" } });
    const tool = manifestToMcpTool(m);
    expect(tool.inputSchema.type).toBe("object");
  });

  test("describes a no-cache (live) tool correctly", () => {
    const m = baseManifest("live_tool", {
      volatilityClass: "live",
      freshness: { cachePolicy: "no-cache", ttlSeconds: null, sourceTimestamp: false },
    });
    const tool = manifestToMcpTool(m);
    expect(tool.description).toContain("Volatility: live");
    expect(tool.description).toContain("every call refetches");
  });

  test("describes a manual-refresh (static) tool correctly", () => {
    const m = baseManifest("static_tool", {
      volatilityClass: "static",
      freshness: { cachePolicy: "manual-refresh", ttlSeconds: null, sourceTimestamp: false },
    });
    const tool = manifestToMcpTool(m);
    expect(tool.description).toContain("Volatility: static");
    expect(tool.description).toContain("almanac update");
  });
});
