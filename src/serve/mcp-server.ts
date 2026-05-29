/**
 * MCP server adapter for `almanac serve`.
 *
 * Wraps an `AlmanacRuntime` (the 4-operation contract from `core/runtime.ts`)
 * in an `@modelcontextprotocol/sdk` low-level `Server`. The mapping is
 * intentionally trivial:
 *
 *   AlmanacRuntime          | MCP request
 *   ────────────────────────┼─────────────────────────
 *   listTools()             | tools/list
 *   execTool(name, input)   | tools/call
 *   listResources()         | resources/list
 *   readResource(uri)       | resources/read
 *
 * The low-level `Server` is preferred over `McpServer` because:
 *   - tool schemas are JSON Schema (not zod), and `McpServer.registerTool`
 *     wants a zod raw shape;
 *   - we have a single generic dispatcher (`execTool`) and no per-tool
 *     handler functions to register;
 *   - the runtime already validates `ToolResult` envelopes.
 *
 * Errors:
 *   - `ToolNotFoundError` from `execTool` is converted to an MCP error
 *     response (`isError: true`) so the host LLM sees a clean failure.
 *   - `ResourceNotFoundError` from `readResource` is converted to a JSON-RPC
 *     error via `McpError` (the SDK's typed error class).
 *
 * Lifetime:
 *   - One server instance per almanac. `createMcpServerForAlmanac` builds the
 *     `AlmanacRuntime` lazily inside, so callers only deal with `Server`.
 *   - `serveAlmanacOverStdio` is a one-call helper for the CLI.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  ResourceNotFoundError,
  ToolNotFoundError,
  type AlmanacRuntime,
  type AlmanacRuntimeOptions,
  type ToolLogger,
} from "../core/runtime.ts";
import type { ToolManifest } from "../core/types.ts";

import { createAlmanacRuntimeAsync } from "./runtime.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Public factories
// ──────────────────────────────────────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface CreateMcpServerInput {
  runtime: AlmanacRuntime;
  serverInfo: McpServerInfo;
  log?: ToolLogger;
}

/**
 * Build an MCP `Server` over an existing `AlmanacRuntime`. The caller is
 * responsible for connecting it to a transport (stdio, in-memory, …).
 *
 * Used by `serveAlmanacOverStdio` for the production path and by tests for
 * in-memory transports.
 */
export function createMcpServer(input: CreateMcpServerInput): Server {
  const log: ToolLogger = input.log ?? (() => {});

  const server = new Server(
    {
      name: input.serverInfo.name,
      version: input.serverInfo.version,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // ── tools/list ──────────────────────────────────────────────────────────
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      const manifests = await input.runtime.listTools();
      const tools: Tool[] = manifests.map(manifestToMcpTool);
      log({ event: "mcp:tools/list", count: tools.length });
      return { tools };
    },
  );

  // ── tools/call ──────────────────────────────────────────────────────────
  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> => {
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      log({ event: "mcp:tools/call", name });
      try {
        const envelope = await input.runtime.execTool(name, args);
        return toolResultToCallToolResult(envelope);
      } catch (e) {
        if (e instanceof ToolNotFoundError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: {
                    code: "tool-not-found",
                    message: e.message,
                    retryable: false,
                  },
                }),
              },
            ],
          };
        }
        // Unexpected — let the SDK convert to a JSON-RPC internal error.
        throw e;
      }
    },
  );

  // ── resources/list ──────────────────────────────────────────────────────
  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (): Promise<ListResourcesResult> => {
      const list = await input.runtime.listResources();
      log({ event: "mcp:resources/list", count: list.length });
      return {
        resources: list.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description !== undefined ? { description: r.description } : {}),
          mimeType: r.mimeType,
          ...(r.size !== undefined ? { size: r.size } : {}),
        })),
      };
    },
  );

  // ── resources/read ──────────────────────────────────────────────────────
  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (req): Promise<ReadResourceResult> => {
      const uri = req.params.uri;
      log({ event: "mcp:resources/read", uri });
      try {
        const r = await input.runtime.readResource(uri);
        return {
          contents: [
            {
              uri,
              mimeType: r.mimeType,
              text: r.contents,
            },
          ],
        };
      } catch (e) {
        if (e instanceof ResourceNotFoundError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `resource not found: ${uri}`,
          );
        }
        throw e;
      }
    },
  );

  return server;
}

export interface ServeAlmanacOverStdioInput extends AlmanacRuntimeOptions {
  serverInfo: McpServerInfo;
}

/**
 * One-call helper used by `almanac serve <id>`:
 *
 *   1. Open the almanac (load tools, knowledge index).
 *   2. Build the MCP server.
 *   3. Connect over stdio and resolve when the client disconnects.
 *
 * Logs go through `options.log` (defaults to a no-op so stdio stays clean).
 */
export async function serveAlmanacOverStdio(
  input: ServeAlmanacOverStdioInput,
): Promise<void> {
  const runtime = await createAlmanacRuntimeAsync(input);
  const server = createMcpServer({
    runtime,
    serverInfo: input.serverInfo,
    log: input.log,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The promise stays unresolved until the transport closes (client exits).
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}

export interface ServeMcpOverHttpInput {
  runtime: AlmanacRuntime;
  serverInfo: McpServerInfo;
  hostname?: string;
  port?: number;
  path?: string;
  log?: ToolLogger;
}

export interface ServeAlmanacOverHttpInput extends AlmanacRuntimeOptions {
  serverInfo: McpServerInfo;
  hostname?: string;
  port?: number;
  path?: string;
}

export interface McpHttpServerHandle {
  url: string;
  hostname: string;
  port: number;
  path: string;
  close: () => Promise<void>;
}

interface HttpMcpSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

/**
 * Start a Streamable HTTP MCP endpoint over an existing runtime.
 *
 * Streamable HTTP uses POST for JSON-RPC messages and SSE streams for
 * long-lived responses / notifications. This helper keeps MCP sessions in
 * memory, matching the SDK's stateful transport mode.
 */
export async function serveMcpOverHttp(
  input: ServeMcpOverHttpInput,
): Promise<McpHttpServerHandle> {
  const hostname = input.hostname ?? "127.0.0.1";
  const port = input.port ?? 7331;
  const path = normalizeHttpPath(input.path ?? "/mcp");
  const log: ToolLogger = input.log ?? (() => {});
  const sessions = new Map<string, HttpMcpSession>();

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);
  };

  const createSession = async (): Promise<HttpMcpSession> => {
    let session: HttpMcpSession | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (session) sessions.set(sessionId, session);
        log({ event: "mcp:http:session:start", sessionId });
      },
      onsessionclosed: async (sessionId) => {
        if (sessionId) {
          log({ event: "mcp:http:session:close", sessionId });
          await closeSession(sessionId);
        }
      },
    });
    transport.onerror = (error) => {
      log({ event: "mcp:http:transport-error", message: error.message });
    };
    const server = createMcpServer({
      runtime: input.runtime,
      serverInfo: input.serverInfo,
      log,
    });
    session = { server, transport };
    await server.connect(transport);
    return session;
  };

  const bunServer = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          transport: "streamable-http",
          endpoint: path,
          sessions: sessions.size,
        });
      }
      if (url.pathname !== path) {
        return jsonResponse(
          { ok: false, error: { code: "not-found", message: "not found" } },
          { status: 404 },
        );
      }

      const sessionId = request.headers.get("mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : await createSession();
      if (!session) {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          },
          { status: 404 },
        );
      }

      try {
        const response = await session.transport.handleRequest(request);
        const currentSessionId = session.transport.sessionId;
        if (request.method === "DELETE" && currentSessionId) {
          await closeSession(currentSessionId);
        }
        if (!currentSessionId) {
          await Promise.allSettled([
            session.transport.close(),
            session.server.close(),
          ]);
        }
        return withCors(response);
      } catch (cause) {
        log({
          event: "mcp:http:request-error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        const currentSessionId = session.transport.sessionId;
        if (!currentSessionId) {
          await Promise.allSettled([
            session.transport.close(),
            session.server.close(),
          ]);
        }
        return jsonResponse(
          {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          },
          { status: 500 },
        );
      }
    },
  });

  const endpoint = new URL(path, bunServer.url).toString();
  const actualPort = Number.parseInt(bunServer.url.port, 10);
  log({ event: "mcp:http:start", url: endpoint });
  return {
    url: endpoint,
    hostname,
    port: actualPort,
    path,
    close: async () => {
      for (const sessionId of [...sessions.keys()]) {
        await closeSession(sessionId);
      }
      bunServer.stop(true);
      log({ event: "mcp:http:stop" });
    },
  };
}

export async function serveAlmanacOverHttp(
  input: ServeAlmanacOverHttpInput,
): Promise<McpHttpServerHandle> {
  const runtime = await createAlmanacRuntimeAsync(input);
  return serveMcpOverHttp({
    runtime,
    serverInfo: input.serverInfo,
    hostname: input.hostname,
    port: input.port,
    path: input.path,
    log: input.log,
  });
}

function normalizeHttpPath(path: string): string {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")) {
    return withLeadingSlash.slice(0, -1);
  }
  return withLeadingSlash;
}

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "content-type, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders()) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(
  body: unknown,
  options: { status?: number } = {},
): Response {
  const headers = corsHeaders();
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Mapping helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert an almanac `ToolManifest` to an MCP `Tool` descriptor. We pack the
 * almanac-specific metadata (volatility class, freshness policy, knowledge
 * usage) into the description so the host LLM sees it in `tools/list`.
 */
export function manifestToMcpTool(m: ToolManifest): Tool {
  const description = renderToolDescription(m);
  const inputSchema = coerceObjectSchema(m.inputSchema);
  const outputSchema = coerceObjectSchema(m.outputSchema);
  return {
    name: m.name,
    description,
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  };
}

function renderToolDescription(m: ToolManifest): string {
  const parts: string[] = [m.description.trim()];
  if (m.whenToUse) parts.push(`\n\nWhen to use: ${m.whenToUse.trim()}`);
  if (m.returnsSummary) parts.push(`\n\nReturns: ${m.returnsSummary.trim()}`);
  parts.push(
    `\n\nVolatility: ${m.volatilityClass}` +
      (m.freshness.cachePolicy === "ttl" && m.freshness.ttlSeconds
        ? ` (cached up to ${m.freshness.ttlSeconds}s)`
        : m.freshness.cachePolicy === "no-cache"
          ? " (every call refetches)"
          : " (refreshed by `almanac update`)"),
  );
  return parts.join("");
}

/**
 * Coerce a loose `JsonSchemaObject` into the MCP `Tool.inputSchema` shape
 * (which requires `type: "object"`). Most almanac tools already store an
 * object schema; if not, we wrap with one so the SDK accepts it.
 */
function coerceObjectSchema(
  schema: Record<string, unknown> | undefined,
): { type: "object"; [k: string]: unknown } {
  if (
    schema &&
    typeof schema === "object" &&
    (schema as { type?: unknown }).type === "object"
  ) {
    return schema as { type: "object"; [k: string]: unknown };
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

/**
 * Convert an almanac `ToolResult` envelope to MCP's `CallToolResult`. The
 * envelope is serialized as a single text block (JSON.stringify) so host
 * LLMs see the structured `data | error`, `citations`, and `freshness` in
 * one place. `isError: true` is set on `ok: false` envelopes to match MCP
 * semantics.
 */
export function toolResultToCallToolResult(
  envelope: import("../core/types.ts").ToolResult,
): CallToolResult {
  const text = JSON.stringify(envelope);
  if (envelope.ok) {
    return {
      content: [{ type: "text", text }],
      structuredContent: { ok: true, data: envelope.data },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}
