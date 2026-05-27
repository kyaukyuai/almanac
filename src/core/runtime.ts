/**
 * almanac-core runtime interface.
 *
 * The 4-operation contract that every adapter (MCP server, Claude Code Skill,
 * `almanac inspect`) implements against. A single `AlmanacRuntime` instance
 * backs one compiled almanac directory.
 *
 * Per `docs/design.md` §2 and §5:
 *
 *   interface AlmanacRuntime {
 *     listTools():    Promise<ToolManifest[]>;
 *     execTool(...):  Promise<ToolResult<unknown>>;
 *     listResources():Promise<ResourceDescriptor[]>;
 *     readResource(...):Promise<{ contents; mimeType }>;
 *   }
 *
 * Wire-format schemas for `ToolManifest`, `ToolResult`, and
 * `ResourceDescriptor` live in `./types.ts`. This file is the interface
 * layer; the concrete filesystem-backed implementation lives in
 * `src/serve/runtime.ts`.
 */

import type {
  CacheableVolatility,
  FactRecord,
  ResourceDescriptor,
  Staleness,
  ToolManifest,
  ToolResult,
  VolatilityClass,
} from "./types.ts";

// Re-export the contract types so adapters can `import "almanac-core/runtime"`
// without also reaching into `./types`.
export type {
  Citation,
  ResourceDescriptor,
  Staleness,
  ToolError,
  ToolManifest,
  ToolResult,
  ToolResultFreshness,
  VolatilityClass,
} from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// AlmanacRuntime
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The 4-operation contract. One instance per compiled almanac.
 *
 * All methods are async because the concrete implementation will read from
 * the filesystem (and, for `execTool`, from the network / sqlite). The
 * interface itself is intentionally minimal — health checks, search, and
 * citation are all implemented as *tools*, not as separate methods.
 */
export interface AlmanacRuntime {
  /** Discoverable tools. Returns enabled manifests only (disabled excluded). */
  listTools(): Promise<ToolManifest[]>;

  /**
   * Invoke a tool by `name` with raw input. The runtime is responsible for:
   *   - validating input against the manifest's `inputSchema`
   *   - constructing a capability-gated `ToolContext`
   *   - validating the returned `ToolResult` against `outputSchema`
   *   - stamping `freshness.staleness` (via {@link computeStaleness})
   *
   * Returns the structured `ToolResult` envelope. The runtime never throws
   * for tool-level failures; it returns `{ ok: false, error }`.
   */
  execTool(name: string, input: unknown): Promise<ToolResult>;

  /** Resources exposed via MCP `resources/list`. */
  listResources(): Promise<ResourceDescriptor[]>;

  /**
   * Read a resource. `uri` must be of the form `almanac://<almanacId>/<path>`
   * (see `ResourceUriSchema` in `./types.ts`). Throws `ResourceNotFoundError`
   * when the URI is unknown or refused.
   */
  readResource(uri: string): Promise<{ contents: string; mimeType: string }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// KnowledgeReader — read-only view over the indexed fact store
// ──────────────────────────────────────────────────────────────────────────────

export interface SearchFactsOptions {
  /** Default 10, max 50. */
  limit?: number;
  /** When set, restrict results to this freshness class. */
  freshnessClass?: CacheableVolatility;
  /**
   * When set (ISO-8601), exclude facts whose `validUntil` is non-null and
   * <= this timestamp. Use `new Date().toISOString()` to filter expired facts.
   */
  notExpiredAt?: string;
}

/**
 * Read-only view over `knowledge/almanac.sqlite`. Built in Stage 8; injected
 * into `ToolContext.knowledge` only when the calling tool's manifest declares
 * `knowledgeUsage.facts === true`.
 */
export interface KnowledgeReader {
  /** FTS5 search over fact text + entities. Results ordered by relevance. */
  searchFacts(query: string, opts?: SearchFactsOptions): Promise<FactRecord[]>;

  /** Look up a fact by ULID. Returns null when not found. */
  getFactById(id: string): Promise<FactRecord | null>;
}

// ──────────────────────────────────────────────────────────────────────────────
// ToolContext — per-call context built from a tool's capabilities
// ──────────────────────────────────────────────────────────────────────────────

export type ToolLogger = (event: object) => void;

/**
 * Per-call context constructed from a tool's manifest `capabilities`.
 *
 * Fields are present iff the manifest declares the corresponding capability:
 *   - `knowledge`: `knowledgeUsage.facts === true`
 *   - `fetch`:     `capabilities.network.length > 0` (host-allowlisted)
 *   - `secrets`:   only the env vars declared in `capabilities.secrets`
 *
 * The runtime constructs and audits this object; tools must not capture or
 * persist it across calls.
 */
export interface ToolContext {
  /** Read-only fact store. Present only when the tool declares facts usage. */
  knowledge?: KnowledgeReader;
  /** Selected env vars; empty object when no secrets are declared. */
  secrets: Record<string, string>;
  /**
   * Capability-gated `fetch` — restricted to the manifest's host allowlist.
   * Calls to other hosts throw `NetworkNotAllowedError`.
   */
  fetch?: typeof fetch;
  /** Structured event logger. Always present (defaults to no-op). */
  log: ToolLogger;
}

// ──────────────────────────────────────────────────────────────────────────────
// ToolModule — fixed shape of every `tools/<name>.ts`
// ──────────────────────────────────────────────────────────────────────────────

export type ToolImplementation<I = unknown, O = unknown> = (
  input: I,
  ctx: ToolContext,
) => Promise<ToolResult<O>>;

/**
 * Default-export shape that the dynamic loader (`serve/tool-loader.ts`)
 * expects from each `tools/<name>.ts`.
 */
export interface ToolModule<I = unknown, O = unknown> {
  manifest: ToolManifest;
  default: ToolImplementation<I, O>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class ToolNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`tool not found: "${name}"`);
    this.name = "ToolNotFoundError";
  }
}

export class ResourceNotFoundError extends Error {
  constructor(public readonly uri: string) {
    super(`resource not found: "${uri}"`);
    this.name = "ResourceNotFoundError";
  }
}

export class NetworkNotAllowedError extends Error {
  constructor(
    public readonly host: string,
    public readonly allowedHosts: readonly string[],
  ) {
    super(
      `network access denied: host "${host}" is not in allowlist [${allowedHosts.join(", ")}]`,
    );
    this.name = "NetworkNotAllowedError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// computeStaleness — single source of truth for the staleness bucket
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute `freshness.staleness` from age and `maxAge`.
 *
 * Rules:
 *   - `static`                 → always "fresh"
 *   - `live`                   → always "fresh" (each call is a fresh fetch)
 *   - `slow`/`fast` with maxAge:
 *       age <= maxAge          → "fresh"
 *       age <= 2 * maxAge      → "warm"
 *       else                   → "stale"
 *
 * `ageSeconds` must be a non-negative integer (seconds since `fetchedAt`).
 * `maxAge` is `null` for static / live and a positive integer otherwise.
 */
export function computeStaleness(
  klass: VolatilityClass,
  ageSeconds: number,
  maxAge: number | null,
): Staleness {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    throw new RangeError(`ageSeconds must be a non-negative finite number, got ${ageSeconds}`);
  }
  if (klass === "static" || klass === "live") return "fresh";
  if (maxAge === null || maxAge <= 0) {
    // Defensive: slow/fast schemas already require a positive maxAge.
    throw new RangeError(
      `maxAge must be a positive integer for class "${klass}", got ${maxAge}`,
    );
  }
  if (ageSeconds <= maxAge) return "fresh";
  if (ageSeconds <= 2 * maxAge) return "warm";
  return "stale";
}

// ──────────────────────────────────────────────────────────────────────────────
// Runtime factory
// ──────────────────────────────────────────────────────────────────────────────

export interface AlmanacRuntimeOptions {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Resolves a secret name (env var) to a value. Defaults to reading `process.env`. */
  resolveSecret?: (name: string) => string | undefined;
  /** Receives structured runtime events. Defaults to a no-op. */
  log?: ToolLogger;
  /**
   * Underlying fetch implementation used to satisfy capability-gated network
   * calls. Defaults to `globalThis.fetch`. Tests inject a stub here so they
   * don't depend on monkey-patching globals.
   */
  fetchImpl?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
}

/**
 * Construct an `AlmanacRuntime` for a compiled almanac on disk.
 *
 * This dynamically imports the concrete serve-layer implementation so callers
 * using the core entrypoint do not hit the old skeleton stub.
 */
export async function createAlmanacRuntime(
  options: AlmanacRuntimeOptions,
): Promise<AlmanacRuntime> {
  const { createAlmanacRuntimeAsync } = await import("../serve/runtime.ts");
  return createAlmanacRuntimeAsync(options);
}
