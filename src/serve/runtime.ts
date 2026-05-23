/**
 * Concrete `AlmanacRuntime` for `almanac serve` and `almanac inspect`.
 *
 * Responsibilities (per `docs/design.md` §2):
 *
 *   1. listTools     — return enabled `ToolManifest`s loaded from
 *                      `<almanacDir>/tools/`.
 *   2. execTool      — dispatch by name, build a capability-gated
 *                      `ToolContext` (knowledge / fetch / secrets / log),
 *                      validate the returned envelope against
 *                      `ToolResultSchema`, and stamp `freshness.staleness`
 *                      via `computeStaleness`.
 *   3. listResources — `DOMAIN.md`, `AGENTS.md`, `SKILLS.md`,
 *                      `manifest.json`, plus `tools/<name>.json` per loaded
 *                      tool.
 *   4. readResource  — file read with strict path-traversal protection.
 *
 * The runtime is constructed *eagerly*: tools and the knowledge index are
 * loaded once at `createAlmanacRuntime` time. This is appropriate for
 * `almanac serve` (long-lived process) and `almanac inspect` (one-shot CLI);
 * a hot-reload variant can land in v0.2 if needed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  ToolResultSchema,
  type ToolManifest,
  type ToolResult,
  type ToolResultFreshness,
  type VolatilityClass,
} from "../core/types.ts";
import {
  NetworkNotAllowedError,
  ToolNotFoundError,
  computeStaleness,
  type AlmanacRuntime,
  type AlmanacRuntimeOptions,
  type KnowledgeReader,
  type ToolContext,
  type ToolLogger,
} from "../core/runtime.ts";
import { readManifest } from "../compile/storage.ts";
import { openKnowledgeReader } from "../compile/stages/s08-knowledge-index.ts";
import {
  loadAllTools,
  type LoadedTool,
} from "./tool-loader.ts";
import {
  listResources as listResourcesImpl,
  readResource as readResourceImpl,
} from "./resource-loader.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Public factory
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Construct an `AlmanacRuntime` for a compiled almanac on disk.
 *
 * Validates that `<almanacDir>/manifest.json` exists and parses; loads every
 * tool under `<almanacDir>/tools/`; opens `knowledge/almanac.sqlite` if
 * present (read-only). Throws on first failure.
 */
export async function createAlmanacRuntimeAsync(
  options: AlmanacRuntimeOptions,
): Promise<AlmanacRuntime> {
  const almanacDir = options.almanacDir;
  if (!existsSync(almanacDir)) {
    throw new Error(`almanac directory does not exist: ${almanacDir}`);
  }

  const almanacManifest = await readManifest(almanacDir);
  const almanacId = almanacManifest.almanacId;

  const tools = await loadAllTools(almanacDir);
  const toolsByName = new Map<string, LoadedTool>();
  for (const t of tools) {
    toolsByName.set(t.manifest.name, t);
  }

  // Knowledge index — present only once Stage 8 has run.
  const dbPath = join(almanacDir, "knowledge", "almanac.sqlite");
  let db: Database | null = null;
  let knowledge: KnowledgeReader | null = null;
  if (existsSync(dbPath)) {
    db = new Database(dbPath, { readonly: true });
    knowledge = openKnowledgeReader(db);
  }

  const log: ToolLogger = options.log ?? (() => {});
  const resolveSecret =
    options.resolveSecret ?? ((name: string) => process.env[name]);
  const fetchImpl = options.fetchImpl;

  return new ConcreteAlmanacRuntime({
    almanacDir,
    almanacId,
    toolsByName,
    knowledge,
    db,
    log,
    resolveSecret,
    fetchImpl,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────────

interface RuntimeState {
  almanacDir: string;
  almanacId: string;
  toolsByName: Map<string, LoadedTool>;
  knowledge: KnowledgeReader | null;
  db: Database | null;
  log: ToolLogger;
  resolveSecret: (name: string) => string | undefined;
  fetchImpl?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
}

class ConcreteAlmanacRuntime implements AlmanacRuntime {
  constructor(private readonly s: RuntimeState) {}

  async listTools(): Promise<ToolManifest[]> {
    const out: ToolManifest[] = [];
    for (const t of this.s.toolsByName.values()) {
      if (!t.manifest.disabled) out.push(t.manifest);
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  async execTool(name: string, input: unknown): Promise<ToolResult> {
    const loaded = this.s.toolsByName.get(name);
    if (!loaded) throw new ToolNotFoundError(name);

    const m = loaded.manifest;

    if (m.disabled) {
      return {
        ok: false,
        error: {
          code: "tool-disabled",
          message: `tool "${name}" is disabled${m.disabledReason ? `: ${m.disabledReason}` : ""}`,
          retryable: false,
        },
      };
    }

    const startedAt = Date.now();
    this.s.log({
      event: "tool:exec:start",
      name,
      almanacId: this.s.almanacId,
    });

    let result: unknown;
    try {
      const ctx = this.buildToolContext(m);
      result = await loaded.implementation(input, ctx);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : `non-Error thrown: ${String(cause)}`;
      this.s.log({
        event: "tool:exec:threw",
        name,
        message,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        error: {
          code: "tool-threw",
          message: message.slice(0, 2000),
          retryable: false,
        },
      };
    }

    const validated = ToolResultSchema.safeParse(result);
    if (!validated.success) {
      this.s.log({
        event: "tool:exec:bad-envelope",
        name,
        issues: validated.error.issues,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        error: {
          code: "tool-bad-envelope",
          message: `tool "${name}" returned a value that does not match ToolResultSchema: ${validated.error.message}`.slice(
            0,
            2000,
          ),
          retryable: false,
        },
      };
    }

    let envelope = validated.data as ToolResult;

    // Stamp staleness from the returned freshness + the oldest citation age.
    if (envelope.ok) {
      envelope = {
        ...envelope,
        freshness: stampStaleness(envelope.freshness, envelope.citations, m.volatilityClass),
      };
    }

    this.s.log({
      event: "tool:exec:done",
      name,
      ok: envelope.ok,
      durationMs: Date.now() - startedAt,
    });

    return envelope;
  }

  async listResources() {
    return listResourcesImpl({
      almanacDir: this.s.almanacDir,
      almanacId: this.s.almanacId,
    });
  }

  async readResource(uri: string) {
    return readResourceImpl({
      almanacDir: this.s.almanacDir,
      almanacId: this.s.almanacId,
      uri,
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private buildToolContext(m: ToolManifest): ToolContext {
    const ctx: ToolContext = {
      secrets: this.collectSecrets(m),
      log: this.s.log,
    };

    if (m.knowledgeUsage.facts) {
      if (this.s.knowledge === null) {
        // Knowledge requested but not built; surface a typed log entry. The
        // tool itself will see `ctx.knowledge === undefined` (matching the
        // interface) and should fail with a `knowledge-missing` error.
        this.s.log({
          event: "tool:knowledge:missing",
          tool: m.name,
          almanacDir: this.s.almanacDir,
        });
      } else {
        ctx.knowledge = this.s.knowledge;
      }
    }

    if (m.capabilities.network.length > 0) {
      ctx.fetch = makeAllowlistedFetch(m.capabilities.network, this.s.fetchImpl);
    }

    return ctx;
  }

  private collectSecrets(m: ToolManifest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of m.capabilities.secrets) {
      const v = this.s.resolveSecret(name);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }

  /** Close any open resources (currently only the sqlite db). */
  close(): void {
    if (this.s.db) {
      this.s.db.close();
      this.s.db = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Capability-gated fetch
// ──────────────────────────────────────────────────────────────────────────────

function makeAllowlistedFetch(
  allowedHosts: readonly string[],
  fetchImpl?: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  const allowed = new Set(allowedHosts);
  const underlying =
    fetchImpl ??
    ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      globalThis.fetch(input as Parameters<typeof fetch>[0], init));
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const urlString =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);
    let host: string;
    try {
      host = new URL(urlString).hostname.toLowerCase();
    } catch {
      throw new NetworkNotAllowedError("<malformed-url>", allowedHosts);
    }
    if (!allowed.has(host)) {
      throw new NetworkNotAllowedError(host, allowedHosts);
    }
    return underlying(input, init);
  };
  // Bun's `typeof fetch` includes a `preconnect` method; forward it to the
  // global `fetch` so the type checker is satisfied. Tools should not use it.
  (guarded as unknown as { preconnect: typeof fetch.preconnect }).preconnect =
    fetch.preconnect.bind(fetch);
  return guarded as unknown as typeof fetch;
}

// ──────────────────────────────────────────────────────────────────────────────
// Staleness stamping
// ──────────────────────────────────────────────────────────────────────────────

import type { Citation } from "../core/types.ts";

/**
 * Recompute `freshness.staleness` from the oldest citation `fetchedAt` and
 * the envelope's declared `class` + `maxAge`. The runtime trusts what the
 * tool reports for *this* call (the manifest's `volatilityClass` is the
 * upper bound, but a slow-classified tool legitimately returns static facts
 * sometimes — `query_facts` is the canonical example).
 *
 * Whatever `staleness` the tool emitted is overwritten so callers can rely
 * on a deterministic bucket.
 *
 * `manifestClass` is accepted for future use (e.g., to log a warning when
 * the envelope class is more volatile than the manifest declares); it is
 * not used to gate the computation today.
 */
function stampStaleness(
  freshness: ToolResultFreshness,
  citations: readonly Citation[],
  manifestClass: VolatilityClass,
): ToolResultFreshness {
  void manifestClass;
  const klass = freshness.class;
  const maxAge = freshness.maxAge;

  if (klass === "static" || klass === "live") {
    return { class: klass, maxAge: null, staleness: "fresh" };
  }

  // Age = now - oldest citation fetchedAt.
  let oldestMs = Date.now();
  for (const c of citations) {
    const t = Date.parse(c.fetchedAt);
    if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - oldestMs) / 1000));

  // slow/fast require a positive maxAge per ToolResultFreshnessSchema; if a
  // tool ships a buggy envelope (maxAge null/0), fall back to "fresh" rather
  // than throwing — the validation already accepted the envelope.
  if (maxAge === null || maxAge <= 0) {
    return { class: klass, maxAge, staleness: "fresh" };
  }
  return {
    class: klass,
    maxAge,
    staleness: computeStaleness(klass, ageSeconds, maxAge),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Re-export the sync factory from `core/runtime.ts` would throw; we provide
// an async one. Code paths that need sync construction can be added later.
// ──────────────────────────────────────────────────────────────────────────────
