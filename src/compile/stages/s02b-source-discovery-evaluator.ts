/**
 * Stage 2b — source-discovery evaluator.
 *
 *   1. Reads the Stage 1 `DomainSpec`, the Stage 2a `SourceDiscoveryPlan`,
 *      and the Stage 02x `Candidate[]` from `.compile/`.
 *   2. Asks the LLM to evaluate the candidates against the spec/plan and
 *      emit a draft `SourcesFile`. Validates via `parseDraftSourcesFile`
 *      (which asserts `status: "draft"`).
 *
 * Persists the draft `SourcesFile` to `.compile/sources.draft.json`. Stage
 * 3 (approval) reads from there, flips status to "approved", and writes the
 * final `sources/sources.json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CandidatesSchema,
  DomainSpecSchema,
  SourceDiscoveryPlanSchema,
  SourcesFileSchema,
  parseDraftSourcesFile,
  type ApprovedSource,
  type Candidates,
  type DomainSpec,
  type SourceDiscoveryPlan,
  type SourcesFile,
} from "../../core/types.ts";
import {
  LlmJsonParseError,
  LlmSchemaValidationError,
  type LlmProvider,
} from "../../llm/provider.ts";
import { sha256Hex, type StageRunner } from "../pipeline.ts";
import { loadPromptTemplate } from "../prompt-loader.ts";
import { domainSpecPath } from "./s01-domain-analysis.ts";
import {
  MissingPlanError,
  sourceDiscoveryPlanPath,
} from "./s02a-source-discovery-planner.ts";
import { candidatesPath } from "./s02x-source-discovery-executor.ts";

// Re-export for tests + callers that already imported from this module.
export { MissingPlanError };

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

export const STAGE2B_PROMPT_VERSION = "evaluator-v1";
export const STAGE2B_PROMPT_STAGE_ID = "02-source-discovery";

/** Matches `recommendedModel` in `prompts/02-source-discovery/evaluator-v1.md`. */
export const STAGE2B_DEFAULT_MODEL = "claude-sonnet-4-5";
export const STAGE2B_DEFAULT_MAX_TOKENS = 6144;
export const STAGE2B_DEFAULT_TEMPERATURE = 0.1;

export const SOURCES_DRAFT_REL_PATH = ".compile/sources.draft.json";

export function sourcesDraftPath(almanacDir: string): string {
  return join(almanacDir, SOURCES_DRAFT_REL_PATH);
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class MissingCandidatesError extends Error {
  constructor(public readonly path: string, public readonly cause?: unknown) {
    super(
      `Stage 2b requires Stage 02x candidates at ${path}; ` +
        "run Stage 02x first or restore the file",
    );
    this.name = "MissingCandidatesError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateSourceDiscoveryEvaluatorRunnerOptions {
  provider: LlmProvider;
  /** Defaults to `STAGE2B_DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to `STAGE2B_DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** Defaults to `STAGE2B_DEFAULT_TEMPERATURE`. */
  temperature?: number;
  /** Override the prompts root (tests). */
  promptsDir?: string;

  /** Test seam for reading Stage 1 output. Defaults to `.compile/domain-spec.json`. */
  readDomainSpec?: (almanacDir: string) => Promise<DomainSpec>;
  /** Test seam for reading Stage 2a output. Defaults to `.compile/source-discovery-plan.json`. */
  readPlan?: (almanacDir: string) => Promise<SourceDiscoveryPlan>;
  /** Test seam for reading Stage 02x candidates. Defaults to `.compile/candidates.json`. */
  readCandidates?: (almanacDir: string) => Promise<Candidates>;
}

/**
 * Build the Stage 2b `StageRunner`. Records `promptVersion = "evaluator-v1"`.
 */
export function createSourceDiscoveryEvaluatorRunner(
  opts: CreateSourceDiscoveryEvaluatorRunnerOptions,
): StageRunner {
  const model = opts.model ?? STAGE2B_DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? STAGE2B_DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? STAGE2B_DEFAULT_TEMPERATURE;
  const readSpec = opts.readDomainSpec ?? defaultReadDomainSpec;
  const readPlan = opts.readPlan ?? defaultReadPlan;
  const readCandidates = opts.readCandidates ?? defaultReadCandidates;

  return {
    promptVersion: STAGE2B_PROMPT_VERSION,
    async run(ctx) {
      const [domainSpec, plan, candidates] = await Promise.all([
        readSpec(ctx.almanacDir),
        readPlan(ctx.almanacDir),
        readCandidates(ctx.almanacDir),
      ]);

      const prompt = loadPromptTemplate({
        stageId: STAGE2B_PROMPT_STAGE_ID,
        version: STAGE2B_PROMPT_VERSION,
        ...(opts.promptsDir !== undefined ? { promptsDir: opts.promptsDir } : {}),
        vars: {
          domainSpecJson: indentBlock(JSON.stringify(domainSpec, null, 2), 2),
          planJson: indentBlock(JSON.stringify(plan, null, 2), 2),
          candidatesJson: indentBlock(
            JSON.stringify(candidates, null, 2),
            2,
          ),
        },
      });

      const callName = `${STAGE2B_PROMPT_STAGE_ID}@${STAGE2B_PROMPT_VERSION}`;
      ctx.log({
        event: "stage2b:llm:start",
        callName,
        model,
        candidates: candidates.length,
      });

      const completion = await opts.provider.complete({
        model,
        maxTokens,
        temperature,
        callName,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      });

      const jsonText = stripFence(completion.text);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonText);
      } catch (cause) {
        throw new LlmJsonParseError(
          `Stage 2b: LLM output is not valid JSON: ${(cause as Error).message}`,
          completion.text,
          cause,
        );
      }

      let draft: SourcesFile;
      try {
        draft = parseDraftSourcesFile(parsedJson);
      } catch (e) {
        throw new LlmSchemaValidationError(
          `Stage 2b: LLM output does not match draft SourcesFile schema: ${
            e instanceof Error ? e.message : String(e)
          }`,
          completion.text,
          parsedJson,
          e,
        );
      }

      const normalized = applyKnownPermissiveDocsSnapshotPolicy(
        draft,
        candidates,
      );
      draft = normalized.file;
      for (const adjustment of normalized.adjustments) {
        ctx.log({
          event: "stage2b:source-mode-adjusted",
          sourceId: adjustment.sourceId,
          url: adjustment.url,
          from: adjustment.from,
          to: adjustment.to,
          reason: adjustment.reason,
          license: adjustment.license,
        });
      }

      const canonicalText = JSON.stringify(draft, null, 2);
      const outPath = sourcesDraftPath(ctx.almanacDir);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, canonicalText + "\n", "utf8");

      const outputHash = sha256Hex(canonicalText);
      ctx.log({
        event: "stage2b:llm:done",
        callName,
        outputHash,
        accepted: draft.sources.length,
        rejected: draft.rejected.length,
        durationMs: completion.durationMs,
        usage: completion.usage,
      });

      return {
        kind: "success",
        outputHash,
        llmCalls: 1,
        cost: {
          tokens: {
            input: completion.usage.inputTokens,
            output: completion.usage.outputTokens,
          },
          usd: 0,
        },
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Deterministic source-mode normalization
// ──────────────────────────────────────────────────────────────────────────────

interface PermissiveDocsSnapshotPolicy {
  readonly hostname: string;
  readonly pathPrefixes: readonly string[];
  readonly license: string;
  readonly reason: string;
}

export interface SourceModeAdjustment {
  sourceId: string;
  url: string;
  from: "index-only";
  to: "snapshot";
  reason: string;
  license: string;
}

const KNOWN_PERMISSIVE_DOCS_SNAPSHOT_POLICIES: readonly PermissiveDocsSnapshotPolicy[] =
  [
    {
      hostname: "kubernetes.io",
      pathPrefixes: ["/docs/"],
      license: "CC-BY-4.0",
      reason: "known-permissive-docs",
    },
    {
      hostname: "book.kubebuilder.io",
      pathPrefixes: ["/"],
      license: "Apache-2.0",
      reason: "known-permissive-docs",
    },
    {
      hostname: "kubebuilder.io",
      pathPrefixes: ["/"],
      license: "Apache-2.0",
      reason: "known-permissive-docs",
    },
    {
      hostname: "master.book.kubebuilder.io",
      pathPrefixes: ["/"],
      license: "Apache-2.0",
      reason: "known-permissive-docs",
    },
  ];

export function applyKnownPermissiveDocsSnapshotPolicy(
  file: SourcesFile,
  candidates: Candidates,
): { file: SourcesFile; adjustments: SourceModeAdjustment[] } {
  const probedDocsUrls = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "docs") continue;
    if (
      candidate.fetchStatus !== "ok" &&
      candidate.fetchStatus !== "redirect"
    ) {
      continue;
    }
    const primary = canonicalUrlKey(candidate.url);
    if (primary !== undefined) probedDocsUrls.add(primary);
    if (candidate.finalUrl !== undefined) {
      const finalUrl = canonicalUrlKey(candidate.finalUrl);
      if (finalUrl !== undefined) probedDocsUrls.add(finalUrl);
    }
  }

  const adjustments: SourceModeAdjustment[] = [];
  const sources = file.sources.map((source) => {
    const policy = findPermissiveDocsSnapshotPolicy(source);
    if (policy === undefined) return source;

    const sourceUrlKey = canonicalUrlKey(source.url);
    if (sourceUrlKey === undefined || !probedDocsUrls.has(sourceUrlKey)) {
      return source;
    }

    adjustments.push({
      sourceId: source.id,
      url: source.url,
      from: "index-only",
      to: "snapshot",
      reason: policy.reason,
      license: policy.license,
    });

    return {
      ...source,
      ingestion: {
        ...source.ingestion,
        mode: "snapshot" as const,
      },
      notes: appendNote(
        source.notes,
        `Snapshot promoted by ${policy.reason} policy (${policy.license}).`,
      ),
    };
  });

  if (adjustments.length === 0) return { file, adjustments };

  return {
    file: SourcesFileSchema.parse({ ...file, sources }),
    adjustments,
  };
}

function findPermissiveDocsSnapshotPolicy(
  source: ApprovedSource,
): PermissiveDocsSnapshotPolicy | undefined {
  if (source.kind !== "docs") return undefined;
  if (source.ingestion.mode !== "index-only") return undefined;

  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  return KNOWN_PERMISSIVE_DOCS_SNAPSHOT_POLICIES.find((policy) => {
    if (policy.hostname !== hostname) return false;
    return policy.pathPrefixes.some((prefix) =>
      pathnameStartsWithPrefix(url.pathname, prefix),
    );
  });
}

function canonicalUrlKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function pathnameStartsWithPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (pathname.startsWith(prefix)) return true;
  if (prefix.endsWith("/") && pathname === prefix.slice(0, -1)) return true;
  return false;
}

function appendNote(existing: string | null, note: string): string {
  if (existing === null || existing.trim().length === 0) return note;
  if (existing.includes(note)) return existing;
  return `${existing} ${note}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function defaultReadDomainSpec(almanacDir: string): Promise<DomainSpec> {
  const path = domainSpecPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      // Re-use the Stage 2a-style error so the CLI can guide the user
      // back to Stage 1 with a clear message.
      throw Object.assign(new Error(`missing DomainSpec: ${path}`), {
        name: "MissingDomainSpecError",
        path,
        cause,
      });
    }
    throw cause;
  }
  return DomainSpecSchema.parse(JSON.parse(body));
}

async function defaultReadPlan(
  almanacDir: string,
): Promise<SourceDiscoveryPlan> {
  const path = sourceDiscoveryPlanPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingPlanError(path, cause);
    }
    throw cause;
  }
  return SourceDiscoveryPlanSchema.parse(JSON.parse(body));
}

async function defaultReadCandidates(almanacDir: string): Promise<Candidates> {
  const path = candidatesPath(almanacDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingCandidatesError(path, cause);
    }
    throw cause;
  }
  return CandidatesSchema.parse(JSON.parse(body));
}

/** Indent every line by `n` spaces — re-used from Stage 2a's helper. */
export function indentBlock(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/,
  );
  return m ? m[1]!.trim() : trimmed;
}

// Re-export the Candidates type so callers can read the persisted file
// without importing from core directly.
export type { Candidates };
