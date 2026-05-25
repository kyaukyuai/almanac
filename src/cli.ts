#!/usr/bin/env bun
/**
 * `almanac` — top-level CLI.
 *
 * v0.1 commands:
 *   almanac new <domain> [opts]            bootstrap and compile an almanac
 *                                          (supports --resume to continue an
 *                                          interrupted run)
 *   almanac update <id> [opts]             refresh an existing almanac
 *                                          (resets stages from --from-stage
 *                                          onwards and re-runs the pipeline)
 *   almanac list [opts]                    list compiled almanacs under the root
 *   almanac inspect <id> [opts]            print manifest + per-stage state
 *   almanac path <id> [opts]               print the absolute almanac dir path
 *   almanac serve <id> [opts]              start the MCP server (stdio transport)
 *   almanac register <id> [opts]           install SKILL.md + merge MCP entry
 *                                          into a downstream client config
 *                                          (--client=claude-code|claude-desktop|cursor)
 *   almanac remove <id> [opts]             delete an almanac dir + unregister
 *                                          it from any client configs (dry-run
 *                                          by default; --apply to commit)
 *
 * All twelve stages (0–12) are implemented and exercised by `src/e2e.test.ts`.
 * Stage 11 (benchmark generation) is LLM-driven and is skipped when no
 * `LlmProvider` is available; Stage 12 (benchmark run) is deterministic and
 * always registered. Together they emit `tests/{positive,negative}.jsonl`
 * and `.compile/benchmark-result.json`.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { Command, Option } from "commander";

import { bootstrapAlmanac } from "./compile/stages/s00-bootstrap.ts";
import {
  createDomainAnalysisRunner,
  domainSpecPath,
} from "./compile/stages/s01-domain-analysis.ts";
import { createSourceDiscoveryPlannerRunner } from "./compile/stages/s02a-source-discovery-planner.ts";
import { createSourceDiscoveryExecutorRunner } from "./compile/stages/s02x-source-discovery-executor.ts";
import { createSourceDiscoveryEvaluatorRunner } from "./compile/stages/s02b-source-discovery-evaluator.ts";
import { createApproveRunner } from "./compile/stages/s03-approve-runner.ts";
import { createSourceFetchRunner } from "./compile/stages/s04-source-fetch-runner.ts";
import { createFactExtractionRunner } from "./compile/stages/s05-fact-extraction.ts";
import { createToolDesignRunner } from "./compile/stages/s06-tool-design.ts";
import { createToolImplRunner } from "./compile/stages/s07-tool-impl-runner.ts";
import { createLlmCodeWriter } from "./compile/stages/s07/code-writer.ts";
import { createBunxTscRunner } from "./compile/stages/s07/tsc-runner.ts";
import { createBunSmokeRunner } from "./compile/stages/s07/smoke-runner.ts";
import { LlmImplementer } from "./compile/stages/s07/llm-implementer.ts";
import { createKnowledgeIndexRunner } from "./compile/stages/s08-knowledge-index-runner.ts";
import { createContractFilesRunner } from "./compile/stages/s09-contract-runner.ts";
import { createSkillAdapterRunner } from "./compile/stages/s10-skill-adapter-runner.ts";
import { createBenchmarkGenRunner } from "./compile/stages/s11-benchmark-gen.ts";
import { createBenchmarkRunRunner } from "./compile/stages/s12-benchmark-run-runner.ts";
import { createGithubSearcher } from "./compile/discovery/github-searcher.ts";
import { createHttpUrlProber } from "./compile/discovery/url-prober.ts";
import {
  createBraveWebSearcher,
  createNullWebSearcher,
} from "./compile/discovery/web-searcher.ts";
import {
  defaultAlmanacRoot,
  almanacDirPath,
  ensureAlmanacLayout,
  listAlmanacs,
  readCompileState,
  readKnowledgeIndexManifest,
  readManifest,
  writeCompileState,
  writeManifest,
} from "./compile/storage.ts";
import {
  bumpSemver,
  markStageCompleted,
  resetStagesForUpdate,
  runPipeline,
  sha256Hex,
  type StageRunners,
} from "./compile/pipeline.ts";
import {
  DomainSpecSchema,
  STAGE_IDS,
  type AlmanacManifest,
  type CompileOptions,
  type CompileState,
  type FreshnessProfileId,
  type StageId,
} from "./core/types.ts";
import { createAnthropicProvider } from "./llm/anthropic.ts";
import { createMockProvider } from "./llm/mock.ts";
import type { LlmProvider } from "./llm/provider.ts";
import { serveAlmanacOverStdio } from "./serve/mcp-server.ts";

const FORGER_VERSION = "0.0.0";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function titleCase(input: string): string {
  return input
    .split(/[\s\-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex");
  return `run-${ts}-${suffix}`;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/**
 * Pick an `LlmProvider` for the run. Real Anthropic when `ANTHROPIC_API_KEY`
 * is set; `null` otherwise (callers skip LLM stages instead of crashing).
 *
 * `ALMANAC_LLM=mock` forces the in-process MockProvider — useful for smoke
 * tests that want the runner exercised without spending tokens. The mock
 * returns the empty string, so Stage 1 will fail JSON parsing — which is
 * exactly the visible signal we want when no real responses are wired in.
 */
function resolveProvider(): LlmProvider | null {
  if (process.env["ALMANAC_LLM"] === "mock") {
    return createMockProvider({ defaultResponse: "" });
  }
  if (process.env["ANTHROPIC_API_KEY"]) {
    return createAnthropicProvider();
  }
  return null;
}

/**
 * Open `$EDITOR` (falls back to `vi`) on a temp file pre-filled with `content`.
 * Returns the user's saved contents. If the editor exits non-zero, throws.
 */
function editInExternalEditor(args: {
  content: string;
  filename: string;
}): string {
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  const tmpPath = join(tmpdir(), `${args.filename}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, args.content, "utf8");
  try {
    const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(
        `editor "${editor}" exited with status ${result.status}`,
      );
    }
    return readFileSync(tmpPath, "utf8");
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Interactive review loop for the Stage 1 `DomainSpec`. Prompts the user to
 * Accept / Edit / Quit. On Edit, opens `$EDITOR` on the spec, re-validates,
 * and re-prompts. Falls through to "accept" automatically when stdin is not
 * a TTY (CI / pipe-driven invocations).
 *
 * Returns `"accept"` or `"quit"`. Persists any user edits back to
 * `<almanacDir>/.compile/domain-spec.json`.
 */
async function reviewDomainSpec(almanacDir: string): Promise<"accept" | "quit"> {
  const specPath = domainSpecPath(almanacDir);

  if (!process.stdin.isTTY) {
    process.stdout.write(
      `\n--review: stdin is not a TTY; auto-accepting the DomainSpec at ${specPath}\n`,
    );
    return "accept";
  }

  // Loop so that after a successful edit we re-prompt for accept/edit/quit.
  for (;;) {
    const body = await readFile(specPath, "utf8");
    const spec = JSON.parse(body);
    process.stdout.write(
      "\n────────────────────────── DomainSpec (Stage 1 output) ──────────────────────────\n",
    );
    process.stdout.write(
      `  domain         ${spec.domain}\n` +
        `  displayName    ${spec.displayName}\n` +
        `  canonicalSlug  ${spec.canonicalSlug}\n` +
        `  summary        ${spec.summary}\n` +
        `  subareas       ${(spec.subareas as string[]).join(", ")}\n` +
        `  verbs          ${(spec.verbs as string[]).join(", ")}\n` +
        `  entityTypes    ${(spec.entityTypes as string[]).join(", ")}\n` +
        `  intents        ${(spec.intents as Array<{ kind: string; example: string }>)
          .map((i) => `${i.kind}: "${i.example}"`)
          .join("\n                 ")}\n` +
        `  profile        ${spec.freshnessProfile.profileId} (default=${spec.freshnessProfile.defaultClass})\n` +
        `  sources        ${spec.suggestedSources.length} suggested\n` +
        `  tools          ${spec.suggestedTools.length} suggested (in addition to 4 defaults)\n` +
        `  cautions       ${spec.cautions.length}\n` +
        `\n  full JSON at  ${specPath}\n`,
    );
    process.stdout.write(
      "────────────────────────────────────────────────────────────────────────────────\n",
    );

    const rl = createInterface({ input, output });
    const answer = (
      await rl.question(
        "\n[A]ccept and continue / [E]dit JSON in $EDITOR / [Q]uit (default: A): ",
      )
    )
      .trim()
      .toLowerCase();
    rl.close();

    if (answer === "" || answer === "a" || answer === "accept") {
      return "accept";
    }
    if (answer === "q" || answer === "quit") {
      return "quit";
    }
    if (answer === "e" || answer === "edit") {
      try {
        const edited = editInExternalEditor({
          content: body,
          filename: "domain-spec.json",
        });
        const parsed = DomainSpecSchema.parse(JSON.parse(edited));
        await writeFile(
          specPath,
          JSON.stringify(parsed, null, 2) + "\n",
          "utf8",
        );
        process.stdout.write(`  ✓ saved edited DomainSpec to ${specPath}\n`);
      } catch (e) {
        process.stdout.write(
          `\n  ✗ edit not saved: ${(e as Error).message}\n` +
            `    (your changes were discarded; original ${specPath} kept)\n`,
        );
      }
      continue;
    }
    process.stdout.write(`  unknown choice "${answer}"; try A/E/Q\n`);
  }
}

/**
 * Assemble the full set of stage runners. Deterministic runners (02x, 03, 04,
 * 07–10) are always registered. LLM-driven runners (01, 02a, 02b, 05, 06) are
 * only registered when an `LlmProvider` is available; otherwise they will be
 * recorded as `skipped` with reason `no-runner-registered`.
 *
 * Used by both `almanac new` and `almanac update` so the two commands agree
 * on what's runnable in the current environment.
 */
function buildRunners(): {
  runners: StageRunners;
  providerAvailable: boolean;
} {
  const provider = resolveProvider();
  const runners: StageRunners = {
    "02x-source-discovery-executor": createSourceDiscoveryExecutorRunner({
      prober: createHttpUrlProber(),
      webSearcher: process.env["BRAVE_SEARCH_API_KEY"]
        ? createBraveWebSearcher()
        : createNullWebSearcher(),
      githubSearcher: createGithubSearcher(),
    }),
    "03-source-approve": createApproveRunner(),
    "04-source-fetch": createSourceFetchRunner(),
    // Stage 7 is template-only by default; if a provider is available it
    // gets re-registered below with an LlmImplementer for custom tools.
    "07-tool-impl": createToolImplRunner(),
    "08-knowledge-index": createKnowledgeIndexRunner(),
    "09-contract-files": createContractFilesRunner(),
    "10-adapter-generation": createSkillAdapterRunner(),
    "12-benchmark-run": createBenchmarkRunRunner(),
  };
  if (provider !== null) {
    runners["01-domain-analysis"] = createDomainAnalysisRunner({ provider });
    runners["02a-source-discovery-planner"] =
      createSourceDiscoveryPlannerRunner({ provider });
    runners["02b-source-discovery-evaluator"] =
      createSourceDiscoveryEvaluatorRunner({ provider });
    runners["05-fact-extraction"] = createFactExtractionRunner({ provider });
    runners["06-tool-design"] = createToolDesignRunner({ provider });
    runners["11-benchmark-gen"] = createBenchmarkGenRunner({ provider });
    // Stage 7 with LLM-driven custom-tool generation: re-register the runner
    // with a real LlmCodeWriter + TscRunner + SmokeTestRunner so custom
    // tools designed in Stage 6 actually get implemented.
    runners["07-tool-impl"] = createToolImplRunner({
      customToolImplementer: new LlmImplementer(),
      llm: createLlmCodeWriter({ provider }),
      tsc: createBunxTscRunner(),
      smoke: createBunSmokeRunner(),
    });
  }
  return { runners, providerAvailable: provider !== null };
}

// ──────────────────────────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────────────────────────

interface NewOptions {
  displayName?: string;
  slug?: string;
  profile: FreshnessProfileId;
  depth: CompileOptions["depth"];
  target: CompileOptions["target"];
  source: string[];
  /**
   * Optional one-paragraph scope narrowing forwarded into the Stage 1
   * domain-analysis prompt. Useful for abstract or broad domain terms.
   */
  scope?: string;
  /**
   * After Stage 1 completes, pause and let the user review the generated
   * DomainSpec before paying for Stages 2-10. The user can accept, edit
   * the JSON in $EDITOR, or quit. Falls through automatically when stdin
   * is not a TTY (CI / non-interactive runs).
   */
  review?: boolean;
  requireApproval?: boolean;
  root: string;
  bootstrapOnly?: boolean;
  /**
   * Resume a previously-interrupted compilation: skip the bootstrap step,
   * load the existing manifest + compile-state, and let `runPipeline`
   * re-execute any stage that is not already `completed`.
   *
   * Required when `<almanacDir>` already exists.
   */
  resume?: boolean;
}

async function cmdNew(domain: string, opts: NewOptions): Promise<void> {
  const slug = opts.slug ?? slugify(domain);
  if (slug.length === 0) {
    fail(`could not derive a canonicalSlug from "${domain}"; pass --slug=<id>`);
  }
  const displayName = opts.displayName ?? titleCase(domain);
  const almanacDir = almanacDirPath(opts.root, slug);
  const alreadyExists = existsSync(almanacDir);

  if (alreadyExists && !opts.resume) {
    fail(
      `almanac directory already exists: ${almanacDir}\n` +
        `       use \`almanac new ${slug} --resume\` to continue a previous run,\n` +
        `       or remove the directory first.`,
    );
  }
  if (!alreadyExists && opts.resume) {
    fail(
      `--resume requires an existing almanac at ${almanacDir}; ` +
        "drop --resume to bootstrap a new one.",
    );
  }

  let manifest: AlmanacManifest;
  let stage0CompletedState: CompileState;

  if (opts.resume) {
    process.stdout.write(`▶ resuming almanac "${slug}" (${displayName})\n`);
    manifest = await readManifest(almanacDir);
    stage0CompletedState = await readCompileState(almanacDir);
    if (stage0CompletedState.stages["00-bootstrap"].status !== "completed") {
      fail(
        `--resume: Stage 0 in ${almanacDir}/.compile/compile-state.json is not "completed"`,
      );
    }
  } else {
    const compileOptions: CompileOptions = {
      depth: opts.depth,
      sourcesHint: opts.source,
      ...(opts.scope !== undefined && opts.scope.length > 0
        ? { scopeHint: opts.scope }
        : {}),
      target: opts.target,
      autoApprove: opts.requireApproval !== true,
      language: "ts",
    };

    const runId = generateRunId();
    process.stdout.write(`▶ bootstrapping almanac "${slug}" (${displayName})\n`);

    const bootstrapped = bootstrapAlmanac({
      almanacId: slug,
      domain,
      displayName,
      freshnessProfileId: opts.profile,
      runId,
      forgerVersion: FORGER_VERSION,
      options: compileOptions,
    });
    manifest = bootstrapped.manifest;

    await ensureAlmanacLayout(almanacDir);
    await writeManifest(almanacDir, manifest);

    // Stage 0 is "complete" by virtue of having produced these two artifacts.
    // Hash them together so the outputHash is deterministic and verifiable.
    const stage0Hash = sha256Hex(
      JSON.stringify(manifest) + "\n" + JSON.stringify(bootstrapped.compileState),
    );
    stage0CompletedState = markStageCompleted(
      bootstrapped.compileState,
      "00-bootstrap",
      new Date(),
      { outputHash: stage0Hash },
    );
    await writeCompileState(almanacDir, stage0CompletedState);

    process.stdout.write(`  ✓ wrote ${almanacDir}\n`);
  }

  if (opts.bootstrapOnly) {
    process.stdout.write(
      `\nDone. \`almanac inspect ${slug}\` to see status.\n`,
    );
    return;
  }

  process.stdout.write("▶ running pipeline (stages 01–12)\n");
  const { runners, providerAvailable } = buildRunners();
  if (!providerAvailable) {
    process.stdout.write(
      "  ! ANTHROPIC_API_KEY not set; LLM-driven stages (01, 02a, 02b, 05, 06, 11) will be skipped " +
        "and Stage 7 will implement only the four default tools (custom tools disabled).\n",
    );
  }

  // --review: split the pipeline into two passes around Stage 1 so the user
  // can sanity-check the DomainSpec before any further LLM spend.
  let stateForFinalRun: CompileState = stage0CompletedState;
  if (opts.review === true) {
    process.stdout.write(
      "▶ --review: pausing after Stage 1 for human approval\n",
    );
    const stage1Result = await runPipeline({
      almanacDir,
      state: stage0CompletedState,
      manifest,
      runners,
      persistState: (s) => writeCompileState(almanacDir, s),
      persistManifest: (m) => writeManifest(almanacDir, m),
      stopAfterStageId: "01-domain-analysis",
      log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
    });
    if (stage1Result.failed.length > 0) {
      process.stderr.write(
        `\nStage 1 failed; cannot review. See ${almanacDir}/.compile/compile-state.json.\n`,
      );
      process.exit(1);
    }
    const decision = await reviewDomainSpec(almanacDir);
    if (decision === "quit") {
      process.stdout.write(
        `\nReview: quit. Re-run \`almanac new ${slug} --resume\` to continue.\n`,
      );
      return;
    }
    // After approval, reload state from disk in case user edited it.
    stateForFinalRun = await readCompileState(almanacDir);
  }

  // Stages 2+ are still skeletons; they will be marked `no-runner-registered`.
  const result = await runPipeline({
    almanacDir,
    state: stateForFinalRun,
    manifest,
    runners,
    persistState: (s) => writeCompileState(almanacDir, s),
    persistManifest: (m) => writeManifest(almanacDir, m),
    log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
  });

  process.stdout.write(
    `\n  succeeded: ${result.succeeded.length}` +
      `   skipped: ${result.skipped.length}` +
      `   failed: ${result.failed.length}\n`,
  );

  if (result.failed.length > 0) {
    process.stderr.write(
      `\nPipeline halted at: ${result.failed.join(", ")}\n` +
        `See ${almanacDir}/.compile/compile-state.json for details.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nDone. \`almanac inspect ${slug}\` to see status.\n`,
  );
}

interface ListOptions {
  root: string;
  json?: boolean;
}

async function cmdList(opts: ListOptions): Promise<void> {
  const items = await listAlmanacs(opts.root);
  if (opts.json) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return;
  }
  if (items.length === 0) {
    process.stdout.write(`no almanacs found in ${opts.root}\n`);
    return;
  }
  // Print a compact table.
  const rows = items.map((it) => ({
    id: it.almanacId,
    name: it.manifest.displayName,
    facts: it.manifest.factCount,
    tools: it.manifest.toolCount,
    profile: it.manifest.freshnessProfileId,
    compiledAt: it.manifest.compiledAt,
  }));
  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    facts: 6,
    tools: 6,
    profile: Math.max(7, ...rows.map((r) => r.profile.length)),
    compiledAt: 24,
  };
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  const header =
    `${pad("ID", widths.id)}  ${pad("NAME", widths.name)}  ${pad("FACTS", widths.facts)}  ${pad("TOOLS", widths.tools)}  ${pad("PROFILE", widths.profile)}  ${pad("COMPILED", widths.compiledAt)}`;
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.id, widths.id)}  ${pad(r.name, widths.name)}  ${pad(String(r.facts), widths.facts)}  ${pad(String(r.tools), widths.tools)}  ${pad(r.profile, widths.profile)}  ${pad(r.compiledAt, widths.compiledAt)}\n`,
    );
  }
}

interface InspectOptions {
  root: string;
  json?: boolean;
}

async function cmdInspect(id: string, opts: InspectOptions): Promise<void> {
  const dir = almanacDirPath(opts.root, id);
  if (!existsSync(dir)) {
    fail(`almanac not found: ${dir}`);
  }
  const manifest = await readManifest(dir);
  const state = await readCompileState(dir);
  const knowledge = await readKnowledgeIndexManifest(dir);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ almanacDir: dir, manifest, state, knowledge }, null, 2) + "\n",
    );
    return;
  }

  process.stdout.write(`almanac: ${manifest.almanacId} (${manifest.displayName})\n`);
  process.stdout.write(`  dir            ${dir}\n`);
  process.stdout.write(`  domain         ${manifest.domain}\n`);
  process.stdout.write(`  version        ${manifest.version}\n`);
  process.stdout.write(`  profile        ${manifest.freshnessProfileId}\n`);
  process.stdout.write(`  facts/tools    ${manifest.factCount} / ${manifest.toolCount}\n`);
  process.stdout.write(`  bootstrapped   ${manifest.bootstrappedAt}\n`);
  process.stdout.write(`  compiled       ${manifest.compiledAt}\n`);
  process.stdout.write(`  forger         ${manifest.forgerVersion}\n`);
  if (knowledge !== null) {
    process.stdout.write(
      `  knowledge      ${knowledge.factCount} facts, sqlite ${knowledge.sqliteVersion}\n`,
    );
  }

  process.stdout.write(`\nstages:\n`);
  for (const stageId of STAGE_IDS as readonly StageId[]) {
    const s = state.stages[stageId];
    const status = s.status.padEnd(9);
    const tail =
      s.status === "completed" && s.outputHash
        ? `  hash=${s.outputHash.slice(0, 12)}…`
        : s.status === "failed" && s.error
          ? `  ${s.error.code}: ${s.error.message}`
          : s.status === "skipped" && s.skipReason
            ? `  (${s.skipReason})`
            : "";
    process.stdout.write(`  ${stageId.padEnd(34)} ${status}${tail}\n`);
  }
}

interface PathOptions {
  root: string;
}

function cmdPath(id: string, opts: PathOptions): void {
  process.stdout.write(almanacDirPath(opts.root, id) + "\n");
}

interface UpdateOptions {
  root: string;
  fromStage: StageId;
  bump: "major" | "minor" | "patch";
  /** Skip the version bump; useful when re-running because of an aborted update. */
  noBump?: boolean;
}

/**
 * Default stage to reset on `almanac update`. Stage 4 is the first stage that
 * touches external data (re-fetches sources), so refreshing from here picks up
 * any upstream changes while preserving the (LLM-derived) domain spec and
 * source-discovery decisions.
 */
const DEFAULT_UPDATE_FROM_STAGE: StageId = "04-source-fetch";

async function cmdUpdate(id: string, opts: UpdateOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }

  if (!STAGE_IDS.includes(opts.fromStage)) {
    fail(
      `--from-stage: unknown stage id "${opts.fromStage}". ` +
        `valid: ${STAGE_IDS.join(", ")}`,
    );
  }
  if (opts.fromStage === "00-bootstrap") {
    fail(
      "--from-stage=00-bootstrap is not supported; delete the almanac and use " +
        "`almanac new` to re-bootstrap from scratch.",
    );
  }

  const prevManifest = await readManifest(almanacDir);
  const prevState = await readCompileState(almanacDir);

  const nextVersion = opts.noBump
    ? prevManifest.version
    : bumpSemver(prevManifest.version, opts.bump);

  const nextManifest: AlmanacManifest = {
    ...prevManifest,
    version: nextVersion,
    forgerVersion: FORGER_VERSION,
  };

  const runId = generateRunId();
  const resetState = resetStagesForUpdate(prevState, opts.fromStage, {
    runId,
    now: new Date(),
  });

  await writeManifest(almanacDir, nextManifest);
  await writeCompileState(almanacDir, resetState);

  process.stdout.write(
    `▶ updating almanac "${id}" (${prevManifest.displayName})\n` +
      `    version       ${prevManifest.version} → ${nextVersion}\n` +
      `    fromStage     ${opts.fromStage}\n` +
      `    runId         ${runId}\n`,
  );

  const { runners, providerAvailable } = buildRunners();
  if (!providerAvailable) {
    process.stdout.write(
      "  ! ANTHROPIC_API_KEY not set; LLM-driven stages (01, 02a, 02b, 05, 06, 11) will be skipped " +
        "and Stage 7 will implement only the four default tools (custom tools disabled).\n",
    );
  }
  process.stdout.write("▶ running pipeline (stages 01–12)\n");

  const result = await runPipeline({
    almanacDir,
    state: resetState,
    manifest: nextManifest,
    runners,
    persistState: (s) => writeCompileState(almanacDir, s),
    persistManifest: (m) => writeManifest(almanacDir, m),
    log: (e) => process.stdout.write(`  · ${JSON.stringify(e)}\n`),
  });

  process.stdout.write(
    `\n  succeeded: ${result.succeeded.length}` +
      `   skipped: ${result.skipped.length}` +
      `   failed: ${result.failed.length}\n`,
  );

  if (result.failed.length > 0) {
    process.stderr.write(
      `\nPipeline halted at: ${result.failed.join(", ")}\n` +
        `See ${almanacDir}/.compile/compile-state.json for details.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nDone. \`almanac inspect ${id}\` to see status.\n`,
  );
}

interface ServeOptions {
  root: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// remove
// ──────────────────────────────────────────────────────────────────────────────

interface RemoveOptions {
  root: string;
  /** If false (default), print what would happen but don't touch disk. */
  apply?: boolean;
  /** Skip the client-config cleanup pass; only delete the almanac dir. */
  keepRegistrations?: boolean;
}

async function cmdRemove(id: string, opts: RemoveOptions): Promise<void> {
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);
  const apply = opts.apply === true;
  const serverName = mcpServerName(manifest.almanacId);

  process.stdout.write(
    `▶ remove almanac "${manifest.almanacId}" (${manifest.displayName})\n` +
      `    dir           ${almanacDir}\n` +
      `    mode          ${apply ? "APPLY (deletes will happen)" : "DRY RUN (re-run with --apply to delete)"}\n\n`,
  );

  // Pass 1 — client-config cleanup. Iterate every known ClientProfile and
  // try to remove any entry for this almanac. Missing configs are fine —
  // the user may have only registered with one client.
  if (opts.keepRegistrations !== true) {
    for (const profile of Object.values(CLIENT_PROFILES)) {
      await unregisterMcp({
        profileName: profile.name,
        serverName,
        mcpConfigPath: profile.mcpConfigPath,
        apply,
      });
      if (profile.skillsDir !== null) {
        await unregisterSkill({
          profileName: profile.name,
          almanacId: manifest.almanacId,
          skillsDir: profile.skillsDir,
          apply,
        });
      }
    }
    process.stdout.write("\n");
  }

  // Pass 2 — delete the almanac dir itself.
  process.stdout.write(`◆ almanac directory\n    ${almanacDir}\n`);
  if (!apply) {
    process.stdout.write("    (would rm -rf)\n");
  } else {
    const { rm } = await import("node:fs/promises");
    await rm(almanacDir, { recursive: true, force: true });
    process.stdout.write("    ✓ removed\n");
  }

  if (!apply) {
    process.stdout.write(
      "\nNothing was written. Re-run with --apply to perform the removal.\n",
    );
  }
}

/**
 * Remove `mcpServers[<serverName>]` from a client's MCP config, if present.
 * Missing configs and missing entries are no-ops (the user may have only
 * registered with a subset of clients).
 */
async function unregisterMcp(args: {
  profileName: RegisterClient;
  serverName: string;
  mcpConfigPath: string;
  apply: boolean;
}): Promise<void> {
  process.stdout.write(`◆ ${args.profileName} mcp server "${args.serverName}"\n`);
  if (!existsSync(args.mcpConfigPath)) {
    process.stdout.write(`    skipped — config not found at ${args.mcpConfigPath}\n`);
    return;
  }
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(args.mcpConfigPath, "utf8"));
  } catch (e) {
    process.stdout.write(
      `    ! config at ${args.mcpConfigPath} is not valid JSON: ${(e as Error).message} — skipping\n`,
    );
    return;
  }
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(args.serverName in servers)) {
    process.stdout.write(`    skipped — no entry at mcpServers["${args.serverName}"]\n`);
    return;
  }
  process.stdout.write(`    config ${args.mcpConfigPath}\n`);
  process.stdout.write(`    would remove mcpServers["${args.serverName}"]\n`);
  if (!args.apply) return;
  delete servers[args.serverName];
  const tmp = `${args.mcpConfigPath}.almanac-tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, args.mcpConfigPath);
  process.stdout.write(`    ✓ removed\n`);
}

/**
 * Remove `<skillsDir>/almanac-<id>/` if present. Missing dir = no-op.
 */
async function unregisterSkill(args: {
  profileName: RegisterClient;
  almanacId: string;
  skillsDir: string;
  apply: boolean;
}): Promise<void> {
  process.stdout.write(`◆ ${args.profileName} skill\n`);
  const skillDir = join(args.skillsDir, `almanac-${args.almanacId}`);
  if (!existsSync(skillDir)) {
    process.stdout.write(`    skipped — no skill at ${skillDir}\n`);
    return;
  }
  process.stdout.write(`    would rm -rf ${skillDir}\n`);
  if (!args.apply) return;
  const { rm } = await import("node:fs/promises");
  await rm(skillDir, { recursive: true, force: true });
  process.stdout.write(`    ✓ removed\n`);
}

async function cmdServe(id: string, opts: ServeOptions): Promise<void> {
  const dir = almanacDirPath(opts.root, id);
  if (!existsSync(dir)) {
    fail(`almanac not found: ${dir}`);
  }
  // stdout is reserved for the JSON-RPC stream; structured logs go to stderr.
  await serveAlmanacOverStdio({
    almanacDir: dir,
    serverInfo: { name: `almanac-${id}`, version: FORGER_VERSION },
    log: (e) => process.stderr.write(JSON.stringify(e) + "\n"),
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// register
// ──────────────────────────────────────────────────────────────────────────────

type RegisterClient = "claude-code" | "claude-desktop" | "cursor";
type RegisterTarget = "skill" | "mcp" | "both";

interface RegisterOptions {
  root: string;
  client: RegisterClient;
  target: RegisterTarget;
  /** If false (default), print what would happen but don't touch disk. */
  apply?: boolean;
  /** Override the destination skills directory. */
  skillsDir?: string;
  /** Override the MCP config path. */
  mcpConfig?: string;
}

interface ClientProfile {
  /** Human-friendly client name. */
  readonly name: RegisterClient;
  /** Default MCP config path. */
  readonly mcpConfigPath: string;
  /**
   * Default skill destination directory. `null` for clients that don't have
   * a skills concept; `--target=skill` (or `both`) becomes a no-op for them.
   */
  readonly skillsDir: string | null;
}

const CLIENT_PROFILES: Readonly<Record<RegisterClient, ClientProfile>> = {
  "claude-code": {
    name: "claude-code",
    mcpConfigPath: join(homedir(), ".claude.json"),
    skillsDir: join(homedir(), ".claude", "skills"),
  },
  "claude-desktop": {
    name: "claude-desktop",
    // macOS-only default. Linux/Windows users can override with --mcp-config.
    // See https://modelcontextprotocol.io/quickstart/user
    mcpConfigPath: join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
    skillsDir: null, // Claude Desktop has no skills concept.
  },
  cursor: {
    name: "cursor",
    mcpConfigPath: join(homedir(), ".cursor", "mcp.json"),
    skillsDir: null, // Cursor has no skills concept.
  },
};

/**
 * The MCP server name advertised by `almanac serve <id>` is `almanac-<id>` —
 * Stage 10's SKILL.md hard-codes `mcp__almanac-<id>__<tool>` references, so
 * the registered MCP config MUST use this exact key for tool routing to work.
 */
function mcpServerName(almanacId: string): string {
  return `almanac-${almanacId}`;
}

/**
 * Absolute path to this CLI entry. Used so the generated MCP command works
 * regardless of the user's current working directory.
 */
function selfCliPath(): string {
  return fileURLToPath(import.meta.url);
}

async function cmdRegister(id: string, opts: RegisterOptions): Promise<void> {
  const profile = CLIENT_PROFILES[opts.client];
  if (profile === undefined) {
    fail(
      `unsupported --client "${opts.client}"; supported: ${Object.keys(CLIENT_PROFILES).join(", ")}`,
    );
  }
  const almanacDir = almanacDirPath(opts.root, id);
  if (!existsSync(almanacDir)) {
    fail(`almanac not found: ${almanacDir}`);
  }
  const manifest = await readManifest(almanacDir);
  const apply = opts.apply === true;
  const skillsDir = opts.skillsDir ?? profile.skillsDir;
  const mcpConfigPath = opts.mcpConfig ?? profile.mcpConfigPath;
  const serverName = mcpServerName(manifest.almanacId);

  process.stdout.write(
    `▶ register almanac "${manifest.almanacId}" (${manifest.displayName}) → ${opts.client}\n` +
      `    target        ${opts.target}\n` +
      `    mode          ${apply ? "APPLY (writes will be made)" : "DRY RUN (re-run with --apply to write)"}\n\n`,
  );

  if (opts.target === "skill" || opts.target === "both") {
    if (skillsDir === null) {
      process.stdout.write(
        `◆ skill\n  ! ${opts.client} has no skills concept; skipping\n\n`,
      );
    } else {
      await registerSkill({
        almanacDir,
        almanacId: manifest.almanacId,
        skillsDir,
        apply,
      });
      process.stdout.write("\n");
    }
  }

  if (opts.target === "mcp" || opts.target === "both") {
    await registerMcp({
      almanacId: manifest.almanacId,
      serverName,
      mcpConfigPath,
      cliPath: selfCliPath(),
      almanacRoot: resolve(opts.root),
      apply,
    });
    process.stdout.write("\n");
  }

  if (!apply) {
    process.stdout.write(
      "Nothing was written. Re-run with --apply to perform the registration.\n",
    );
  }
}

async function registerSkill(args: {
  almanacDir: string;
  almanacId: string;
  skillsDir: string;
  apply: boolean;
}): Promise<void> {
  const srcPath = join(args.almanacDir, "adapters", "skill", "SKILL.md");
  const destDir = join(args.skillsDir, `almanac-${args.almanacId}`);
  const destPath = join(destDir, "SKILL.md");

  process.stdout.write(`◆ skill\n`);
  if (!existsSync(srcPath)) {
    process.stdout.write(
      `  ! source SKILL.md not found at ${srcPath}\n` +
        `    (run Stage 10 — \`almanac update ${args.almanacId} --from-stage=10-adapter-generation\` — first)\n`,
    );
    return;
  }
  process.stdout.write(`    from   ${srcPath}\n`);
  process.stdout.write(`    to     ${destPath}\n`);
  if (!args.apply) return;
  await mkdir(destDir, { recursive: true });
  await copyFile(srcPath, destPath);
  process.stdout.write(`    ✓ copied\n`);
}

async function registerMcp(args: {
  almanacId: string;
  serverName: string;
  mcpConfigPath: string;
  cliPath: string;
  almanacRoot: string;
  apply: boolean;
}): Promise<void> {
  const entry = {
    command: "bun",
    args: ["run", args.cliPath, "serve", args.almanacId, "--root", args.almanacRoot],
  };
  process.stdout.write(`◆ mcp server "${args.serverName}"\n`);
  process.stdout.write(`    config ${args.mcpConfigPath}\n`);
  process.stdout.write(
    `    entry  ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n           ")}\n`,
  );

  if (!args.apply) return;

  // Read-modify-write the config. If it doesn't exist yet, create a minimal one.
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existsSync(args.mcpConfigPath)) {
    const raw = await readFile(args.mcpConfigPath, "utf8");
    try {
      config = JSON.parse(raw);
    } catch (e) {
      fail(
        `MCP config at ${args.mcpConfigPath} is not valid JSON: ${(e as Error).message}\n` +
          `       fix the file or pass --mcp-config=<path> to use a different one.`,
      );
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      fail(
        `MCP config at ${args.mcpConfigPath} is not a JSON object (got ${typeof config}).`,
      );
    }
  }
  const servers: Record<string, unknown> =
    (config.mcpServers as Record<string, unknown>) ?? {};
  const existed = args.serverName in servers;
  servers[args.serverName] = entry;
  config.mcpServers = servers;

  // Atomic-ish: write to a sibling temp then rename.
  const tmp = `${args.mcpConfigPath}.almanac-tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  // `rename` is atomic on the same filesystem; we expect both paths to share it.
  const { rename } = await import("node:fs/promises");
  await rename(tmp, args.mcpConfigPath);
  process.stdout.write(
    `    ✓ ${existed ? "updated" : "added"} mcpServers["${args.serverName}"]\n`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Wire up commander
// ──────────────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("almanac")
  .description("Compile a domain almanac. Always-fresh. As CLI, MCP, and Skill.")
  .version(FORGER_VERSION);

const rootOption = new Option(
  "--root <dir>",
  "Almanac root directory (env: ALMANAC_ROOT)",
).default(defaultAlmanacRoot(), "$ALMANAC_ROOT or ~/.almanac/almanacs");

program
  .command("new <domain>")
  .description("bootstrap a new almanac and run the compile pipeline")
  .option("--display-name <name>", "Title-case display name (default: derived from domain)")
  .option("--slug <id>", "canonicalSlug (default: slugify(domain))")
  .addOption(
    new Option("--profile <id>", "Freshness profile")
      .choices(["static-heavy", "mixed", "live-heavy"])
      .default("mixed"),
  )
  .addOption(
    new Option("--depth <level>", "Compile depth")
      .choices(["quick", "standard", "deep"])
      .default("standard"),
  )
  .addOption(
    new Option("--target <which>", "Adapter target")
      .choices(["mcp", "skill", "both"])
      .default("both"),
  )
  .option("--source <hint...>", "User-supplied source hint(s); repeatable", [])
  .option(
    "--scope <text>",
    "One-paragraph scope narrowing fed into Stage 1 (useful for abstract domains)",
  )
  .option("--require-approval", "Require human approval after Stage 2 (default: auto-approve)")
  .option(
    "--review",
    "Pause after Stage 1 to review (and optionally edit) the DomainSpec before continuing",
  )
  .option("--bootstrap-only", "Stop after Stage 0 (skip the rest of the pipeline)")
  .option(
    "--resume",
    "Continue a previously-interrupted run: skip bootstrap and re-execute any non-completed stages",
  )
  .addOption(rootOption)
  .action(cmdNew);

program
  .command("list")
  .description("list compiled almanacs under the root directory")
  .option("--json", "Emit JSON instead of a table")
  .addOption(rootOption)
  .action(cmdList);

program
  .command("inspect <id>")
  .description("print manifest + per-stage state for an almanac")
  .option("--json", "Emit JSON instead of a human-readable summary")
  .addOption(rootOption)
  .action(cmdInspect);

program
  .command("path <id>")
  .description("print the absolute path to an almanac directory")
  .addOption(rootOption)
  .action(cmdPath);

program
  .command("update <id>")
  .description(
    "refresh an existing almanac: reset stages from --from-stage onwards and re-run the pipeline",
  )
  .addOption(
    new Option(
      "--from-stage <id>",
      "Earliest stage to reset back to pending (default: 04-source-fetch)",
    ).default(DEFAULT_UPDATE_FROM_STAGE),
  )
  .addOption(
    new Option("--bump <kind>", "Semver bump for manifest.version")
      .choices(["major", "minor", "patch"])
      .default("patch"),
  )
  .option(
    "--no-bump",
    "Do not bump manifest.version (keep the current version string)",
  )
  .addOption(rootOption)
  .action(cmdUpdate);

program
  .command("serve <id>")
  .description("start the MCP server for an almanac (stdio transport)")
  .addOption(rootOption)
  .action(cmdServe);

program
  .command("remove <id>")
  .description(
    "delete a compiled almanac and clean up any client registrations (dry-run by default)",
  )
  .option("--apply", "Actually perform the deletions (default: dry-run)")
  .option(
    "--keep-registrations",
    "Skip the client-config cleanup pass; only remove the almanac directory",
  )
  .addOption(rootOption)
  .action(cmdRemove);

program
  .command("register <id>")
  .description(
    "register an almanac with a downstream client (copies SKILL.md when supported, merges MCP server entry)",
  )
  .addOption(
    new Option("--client <name>", "Target client")
      .choices(Object.keys(CLIENT_PROFILES))
      .default("claude-code"),
  )
  .addOption(
    new Option("--target <what>", "What to register")
      .choices(["skill", "mcp", "both"])
      .default("both"),
  )
  .option("--apply", "Actually perform the writes (default: dry-run)")
  .option(
    "--skills-dir <path>",
    "Override the destination skills directory (default: per-client; null for clients without skills)",
  )
  .option(
    "--mcp-config <path>",
    "Override the MCP config path (default: per-client — Claude Code, Claude Desktop, and Cursor have distinct defaults)",
  )
  .addOption(rootOption)
  .action(cmdRegister);

program.parseAsync(process.argv).catch((e) => {
  fail((e as Error).message);
});
