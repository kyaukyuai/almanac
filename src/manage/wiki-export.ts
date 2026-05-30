/**
 * `almanac wiki <id>` - export a human-readable inspection bundle.
 *
 * This is deliberately separate from `almanac export`: tar export is for
 * moving a runnable almanac, while wiki export is for reviewing what was built.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  approvedSourcesPath,
} from "../compile/stages/s03-approve-runner.ts";
import { factsJsonlPath } from "../compile/stages/s05-fact-extraction.ts";
import { benchmarkResultPath } from "../compile/stages/s12-benchmark-run-runner.ts";
import {
  compileStatePath,
  knowledgeIndexManifestPath,
  manifestPath,
  readCompileState,
  readKnowledgeIndexManifest,
  readManifest,
  toolsDirPath,
} from "../compile/storage.ts";
import {
  BenchmarkReportSchema,
  DomainSpecSchema,
  FactRecordSchema,
  SourcesFileSchema,
  STAGE_IDS,
  ToolManifestSchema,
  type BenchmarkReport,
  type CompileState,
  type DomainSpec,
  type FactRecord,
  type KnowledgeIndexManifest,
  type SourcesFile,
  type StageId,
  type ToolManifest,
} from "../core/types.ts";
import { domainSpecPath } from "../compile/stages/s01-domain-analysis.ts";

export interface RunWikiExportInput {
  /** Absolute path to the compiled almanac directory. */
  almanacDir: string;
  /** Absolute directory path to write Markdown files into. */
  outputDir: string;
  /** Structured event log. Defaults to no-op. */
  log?: (event: object) => void;
}

export interface WikiExportFile {
  name: string;
  path: string;
  byteLength: number;
}

export interface WikiExportResult {
  outputDir: string;
  files: WikiExportFile[];
}

export async function runWikiExport(
  input: RunWikiExportInput,
): Promise<WikiExportResult> {
  if (!isAbsolute(input.almanacDir)) {
    throw new Error(
      `runWikiExport: almanacDir must be absolute (got "${input.almanacDir}")`,
    );
  }
  if (!isAbsolute(input.outputDir)) {
    throw new Error(
      `runWikiExport: outputDir must be absolute (got "${input.outputDir}")`,
    );
  }
  if (!existsSync(input.almanacDir)) {
    throw new Error(
      `runWikiExport: almanacDir does not exist: ${input.almanacDir}`,
    );
  }

  const log = input.log ?? (() => {});
  await mkdir(input.outputDir, { recursive: true });
  log({
    event: "wiki-export:start",
    almanacDir: input.almanacDir,
    outputDir: input.outputDir,
  });

  const manifest = await readManifest(input.almanacDir);
  const state = await readCompileState(input.almanacDir);
  const knowledge = await readKnowledgeIndexManifest(input.almanacDir);
  const domainSpec = await readDomainSpec(input.almanacDir);
  const sources = await readSources(input.almanacDir);
  const facts = await readFacts(input.almanacDir);
  const tools = await readTools(input.almanacDir);
  const benchmark = await readBenchmark(input.almanacDir);

  const files: WikiExportFile[] = [];
  const writeMarkdown = async (name: string, body: string): Promise<void> => {
    const path = join(input.outputDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, ensureTrailingNewline(body), "utf8");
    files.push({ name, path, byteLength: (await stat(path)).size });
  };

  await writeMarkdown(
    "README.md",
    renderOverview({
      almanacDir: input.almanacDir,
      manifest,
      state,
      knowledge,
      domainSpec,
      sources,
      facts,
      tools,
      benchmark,
    }),
  );
  await writeMarkdown("sources.md", renderSources(sources));
  await writeMarkdown("facts.md", renderFacts(facts, sources));
  await writeMarkdown("tools.md", renderTools(tools));
  await writeMarkdown("benchmark.md", renderBenchmark(benchmark));

  const artifactsPath = join(input.outputDir, "artifacts.json");
  const artifactsFile: WikiExportFile = {
    name: "artifacts.json",
    path: artifactsPath,
    byteLength: 0,
  };
  files.push(artifactsFile);
  const artifactsBody = renderArtifactsManifest({
    almanacId: manifest.almanacId,
    version: manifest.version,
    sourceDir: input.almanacDir,
    files,
  });
  artifactsFile.byteLength = Buffer.byteLength(artifactsBody, "utf8");
  await writeFile(artifactsPath, artifactsBody, "utf8");

  log({ event: "wiki-export:done", outputDir: input.outputDir, files: files.length });
  return { outputDir: input.outputDir, files };
}

export function defaultWikiExportDir(args: {
  almanacId: string;
  version: string;
  cwd?: string;
}): string {
  const cwd = args.cwd ?? process.cwd();
  return resolve(cwd, `almanac-${args.almanacId}-${args.version}-wiki`);
}

async function readDomainSpec(almanacDir: string): Promise<DomainSpec | null> {
  const path = domainSpecPath(almanacDir);
  if (!existsSync(path)) return null;
  return DomainSpecSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readSources(almanacDir: string): Promise<SourcesFile | null> {
  const path = approvedSourcesPath(almanacDir);
  if (!existsSync(path)) return null;
  return SourcesFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readBenchmark(
  almanacDir: string,
): Promise<BenchmarkReport | null> {
  const path = benchmarkResultPath(almanacDir);
  if (!existsSync(path)) return null;
  return BenchmarkReportSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readFacts(almanacDir: string): Promise<FactRecord[]> {
  const path = factsJsonlPath(almanacDir);
  if (!existsSync(path)) return [];
  const out: FactRecord[] = [];
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    out.push(FactRecordSchema.parse(JSON.parse(line)));
  }
  return out;
}

async function readTools(almanacDir: string): Promise<ToolManifest[]> {
  const dir = toolsDirPath(almanacDir);
  if (!existsSync(dir)) return [];
  const out: ToolManifest[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    out.push(ToolManifestSchema.parse(JSON.parse(await readFile(path, "utf8"))));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function renderOverview(input: {
  almanacDir: string;
  manifest: Awaited<ReturnType<typeof readManifest>>;
  state: CompileState;
  knowledge: KnowledgeIndexManifest | null;
  domainSpec: DomainSpec | null;
  sources: SourcesFile | null;
  facts: FactRecord[];
  tools: ToolManifest[];
  benchmark: BenchmarkReport | null;
}): string {
  const stageCounts = countStages(input.state);
  const health = healthStatus(input.state, input.benchmark);
  return [
    `# ${input.manifest.displayName}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Almanac ID | ${cell(input.manifest.almanacId)} |`,
    `| Domain | ${cell(input.manifest.domain)} |`,
    `| Version | ${cell(input.manifest.version)} |`,
    `| Profile | ${cell(input.manifest.freshnessProfileId)} |`,
    `| Health | ${cell(health)} |`,
    `| Facts | ${input.facts.length} |`,
    `| Knowledge index | ${input.knowledge ? `${input.knowledge.factCount} facts, sqlite ${input.knowledge.sqliteVersion}` : "missing"} |`,
    `| Tools | ${input.tools.filter((tool) => !tool.disabled).length} |`,
    `| Sources | ${input.sources?.sources.length ?? 0} accepted / ${input.sources?.rejected.length ?? 0} rejected |`,
    `| Benchmark | ${formatBenchmarkSummary(input.benchmark)} |`,
    `| Source directory | ${cell(input.almanacDir)} |`,
    "",
    "## Summary",
    "",
    input.domainSpec?.summary ?? "(domain summary unavailable)",
    "",
    "## Stage Status",
    "",
    `Completed ${stageCounts.completed}, skipped ${stageCounts.skipped}, failed ${stageCounts.failed}, running ${stageCounts.running}, pending ${stageCounts.pending}.`,
    "",
    "| Stage | Status | Output |",
    "| --- | --- | --- |",
    ...STAGE_IDS.map((stageId) => {
      const stage = input.state.stages[stageId as StageId];
      const output =
        stage.status === "completed" && stage.outputHash
          ? stage.outputHash.slice(0, 12)
          : stage.status === "failed" && stage.error
            ? `${stage.error.code}: ${stage.error.message}`
            : stage.status === "skipped" && stage.skipReason
              ? stage.skipReason
              : "";
      return `| ${stageId} | ${stage.status} | ${cell(output)} |`;
    }),
    "",
    "## Artifact Paths",
    "",
    `- manifest: ${manifestPath(input.almanacDir)}`,
    `- compile state: ${compileStatePath(input.almanacDir)}`,
    `- knowledge manifest: ${knowledgeIndexManifestPath(input.almanacDir)}`,
    `- facts: ${factsJsonlPath(input.almanacDir)}`,
    `- benchmark report: ${benchmarkResultPath(input.almanacDir)}`,
  ].join("\n");
}

function renderArtifactsManifest(args: {
  almanacId: string;
  version: string;
  sourceDir: string;
  files: WikiExportFile[];
}): string {
  const generatedAt = new Date().toISOString();
  let byteLength = 0;
  while (true) {
    const body =
      JSON.stringify(
        {
          schemaVersion: "0.1.0",
          almanacId: args.almanacId,
          version: args.version,
          generatedAt,
          sourceDir: args.sourceDir,
          files: args.files.map((file) => ({
            name: file.name,
            byteLength:
              file.name === "artifacts.json" ? byteLength : file.byteLength,
          })),
        },
        null,
        2,
      ) + "\n";
    const nextByteLength = Buffer.byteLength(body, "utf8");
    if (nextByteLength === byteLength) return body;
    byteLength = nextByteLength;
  }
}

function renderSources(sources: SourcesFile | null): string {
  if (sources === null) {
    return "# Sources\n\nNo `sources/sources.json` artifact was found.\n";
  }
  return [
    "# Sources",
    "",
    `Status: ${sources.status}`,
    "",
    "## Accepted",
    "",
    "| ID | Kind | Trust | Mode | Refresh | URL |",
    "| --- | --- | ---: | --- | ---: | --- |",
    ...sources.sources.map(
      (source) =>
        `| ${cell(source.id)} | ${source.kind} | ${source.trust.toFixed(2)} | ${source.ingestion.mode} | ${source.ingestion.refreshIntervalHours}h | ${cell(source.url)} |`,
    ),
    "",
    "## Rejected",
    "",
    sources.rejected.length === 0
      ? "(none)"
      : [
          "| Reason | URL |",
          "| --- | --- |",
          ...sources.rejected.map(
            (source) => `| ${source.reason} | ${cell(source.url)} |`,
          ),
        ].join("\n"),
  ].join("\n");
}

function renderFacts(
  facts: FactRecord[],
  sources: SourcesFile | null,
): string {
  const byType = countBy(facts, (fact) => fact.type);
  const byFreshness = countBy(facts, (fact) => fact.freshnessClass);
  const bySource = countBy(facts, (fact) => fact.source.sourceId);
  const acceptedById = new Map((sources?.sources ?? []).map((source) => [source.id, source]));
  const topSources = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return [
    "# Facts",
    "",
    `Total facts: ${facts.length}`,
    "",
    "## By Type",
    "",
    renderCountsTable(byType),
    "",
    "## By Freshness",
    "",
    renderCountsTable(byFreshness),
    "",
    "## Top Sources",
    "",
    "| Source | Facts | Kind | Trust |",
    "| --- | ---: | --- | ---: |",
    ...topSources.map(([sourceId, count]) => {
      const source = acceptedById.get(sourceId);
      return `| ${cell(sourceId)} | ${count} | ${source?.kind ?? ""} | ${source?.trust.toFixed(2) ?? ""} |`;
    }),
    "",
    "## Sample Facts",
    "",
    ...facts.slice(0, 25).map(
      (fact) =>
        `- **${fact.type}** (${fact.freshnessClass}, ${fact.source.sourceId}) ${clip(fact.text, 220)}`,
    ),
  ].join("\n");
}

function renderTools(tools: ToolManifest[]): string {
  return [
    "# Tools",
    "",
    "| Name | Enabled | Volatility | Freshness | Facts | Network |",
    "| --- | --- | --- | --- | --- | --- |",
    ...tools.map((tool) => {
      const freshness =
        tool.freshness.cachePolicy === "ttl"
          ? `ttl ${tool.freshness.ttlSeconds}s`
          : tool.freshness.cachePolicy;
      return `| ${cell(tool.name)} | ${tool.disabled ? "no" : "yes"} | ${tool.volatilityClass} | ${freshness} | ${tool.knowledgeUsage.facts ? "yes" : "no"} | ${cell(tool.capabilities.network.join(", "))} |`;
    }),
    "",
    "## Descriptions",
    "",
    ...tools.map(
      (tool) =>
        `### ${tool.name}\n\n${tool.description}\n\nWhen to use: ${tool.whenToUse || "(not specified)"}\n`,
    ),
  ].join("\n");
}

function renderBenchmark(benchmark: BenchmarkReport | null): string {
  if (benchmark === null) {
    return "# Benchmark\n\nNo benchmark report was found.\n";
  }
  return [
    "# Benchmark",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Ran at | ${benchmark.ranAt} |`,
    `| Total | ${benchmark.summary.total} |`,
    `| Passed | ${benchmark.summary.passed} |`,
    `| Failed | ${benchmark.summary.failed} |`,
    `| Errored | ${benchmark.summary.errored} |`,
    `| Citation rate | ${(benchmark.summary.citationRate * 100).toFixed(0)}% |`,
    "",
    "## Results",
    "",
    "| Fixture | Kind | Status | Observed | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...benchmark.results.map(
      (result) =>
        `| ${cell(result.fixtureId)} | ${result.kind} | ${result.status} | ok=${result.observed.ok}, citations=${result.observed.citationsCount}, error=${result.observed.errorCode ?? ""} | ${cell(result.reason)} |`,
    ),
  ].join("\n");
}

function countStages(state: CompileState): {
  completed: number;
  skipped: number;
  failed: number;
  running: number;
  pending: number;
} {
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  for (const stageId of STAGE_IDS as readonly StageId[]) {
    const status = state.stages[stageId].status;
    if (status === "completed") completed += 1;
    else if (status === "skipped") skipped += 1;
    else if (status === "failed") failed += 1;
    else if (status === "running") running += 1;
    else if (status === "pending") pending += 1;
  }
  return { completed, skipped, failed, running, pending };
}

function healthStatus(
  state: CompileState,
  benchmark: BenchmarkReport | null,
): "ok" | "attention" | "failed" {
  const counts = countStages(state);
  if (counts.failed > 0) return "failed";
  if (
    counts.running > 0 ||
    counts.pending > 0 ||
    benchmark === null ||
    benchmark.summary.failed > 0 ||
    benchmark.summary.errored > 0
  ) {
    return "attention";
  }
  return "ok";
}

function formatBenchmarkSummary(benchmark: BenchmarkReport | null): string {
  if (benchmark === null) return "missing";
  return `${benchmark.summary.passed}/${benchmark.summary.total} passed, citationRate ${(benchmark.summary.citationRate * 100).toFixed(0)}%`;
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderCountsTable(counts: Map<string, number>): string {
  if (counts.size === 0) return "(none)";
  return [
    "| Key | Count |",
    "| --- | ---: |",
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => `| ${cell(key)} | ${count} |`),
  ].join("\n");
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
