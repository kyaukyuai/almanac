# almanac — Design Document

Status: **v0.4.0 shipped + post-release hardening on main** · last updated 2026-05-30.

This document is the single source for the architectural and pipeline design of
`almanac`. It supersedes the original `savant-forge` README spec and the prior
draft v0.1.

---

## 1. What `almanac` is

`almanac` is a meta-generator that compiles a **per-domain knowledge surface**
from a single domain name. The compiled almanac is consumed by host LLMs
(Claude Code, Cursor, Claude Desktop, …) through two channels:

- **MCP server** (`almanac serve <domain>`) — primary
- **Claude Code Skill** (`adapters/skill/SKILL.md`) — secondary, registered
  alongside the MCP server

The `almanac` CLI itself is for **build and management only**: `new`, `update`,
`list`, `inspect`, `serve`, `register`. It does not include an LLM
orchestrator. End-user "use" of an almanac happens through the host LLM.

### What an almanac is *not*

- **Not a persona.** No identity, tone, or thinking patterns. It returns
  sourced facts and live tool results.
- **Not an LLM agent at runtime.** The host LLM does the reasoning. The
  almanac provides tools and indexed facts.
- **Not a static snapshot.** Every artifact is freshness-aware and refreshable
  via `almanac update`.
- **Not a per-almanac binary.** A single global `almanac` CLI serves any
  compiled almanac generically.

### Design pillars

1. **Headless runtime + adapters**: the operation contract is the source of
   truth; MCP server and Skill are derived from it. A single generic
   `almanac serve` binary serves any compiled almanac.
2. **Always fresh**: every fact carries a `freshnessClass` and `fetchedAt`;
   stale data is surfaced, not masked. (Inspired by
   [`last30days-skill`](https://github.com/mvanhorn/last30days-skill).)
3. **Cite or abstain**: every tool returns `citations[]`. No source → no
   answer.
4. **Compile, don't configure**: input is a domain name; humans review the
   draft and approve.
5. **Generic adapters**: no per-almanac code generation for MCP/CLI. The
   compiled almanac is data; the adapter is the same binary loading different
   data.

---

## 2. Architecture

```diagram
   ╭──────────────────────────────────────────────╮
   │ User-facing consumption                      │
   │                                              │
   │  ╭─────────────╮  ╭─────────╮  ╭──────────╮  │
   │  │ Claude Code │  │ Cursor  │  │ Claude   │  │
   │  │  + MCP      │  │  + MCP  │  │ Desktop  │  │
   │  │  + Skill    │  │         │  │  + MCP   │  │
   │  ╰──────┬──────╯  ╰────┬────╯  ╰─────┬────╯  │
   ╰─────────┼──────────────┼─────────────┼───────╯
             │              │             │
             ▼              ▼             ▼
   ╭──────────────────────────────────────────────╮
   │ almanac serve <domain>  (generic MCP server) │
   ╰──────────────────────────┬───────────────────╯
                              │ filesystem (read)
                              ▼
   ╭──────────────────────────────────────────────╮
   │ ~/.almanac/almanacs/<id>/  (LLM-free data)   │
   ╰──────────────────────────┬───────────────────╯
                              ▲
                              │ filesystem (write)
   ╭──────────────────────────┴───────────────────╮
   │ almanac CLI  (build / manage only)           │
   │ new · update · list · inspect · serve ·      │
   │ register                                     │
   ╰──────────────────────────────────────────────╯
```

### Minimum runtime interface

The almanac runtime exposes **4 operations**, mapped 1:1 to MCP primitives:

```ts
interface AlmanacRuntime {
  // tools (MCP tools/list, tools/call)
  listTools(): Promise<ToolManifest[]>;
  execTool(name: string, input: unknown): Promise<ToolResult<unknown>>;

  // resources (MCP resources/list, resources/read)
  listResources(): Promise<ResourceDescriptor[]>;
  readResource(uri: string): Promise<{ contents: string; mimeType: string }>;
}
```

That is the entire surface. Everything else (fact retrieval, source citation,
health check) is implemented as a tool.

### Compiled almanac directory layout

```text
~/.almanac/almanacs/cooking/
├── manifest.json           # id, version, freshnessProfile, generatedAt
├── DOMAIN.md               # what this almanac covers + freshness policy
├── AGENTS.md               # operating contract for host LLMs
├── SKILLS.md               # tools catalog (deterministic from tools/*.json)
├── sources/
│   ├── sources.yaml        # sources with volatility + refreshInterval
│   └── raw/                # cached fetches (TTL-bound)
├── extracted/
│   └── facts.jsonl         # static/slow facts only (fast/live never cached)
├── knowledge/
│   └── almanac.sqlite      # FTS5 over facts (+ freshness columns)
├── tools/                  # each tool = .ts impl + .json manifest pair
│   ├── query_facts.json
│   ├── query_facts.ts
│   ├── query_facts.test.ts
│   ├── fetch_official_docs.{json,ts,test.ts}
│   ├── web_search_recent.{json,ts,test.ts}
│   ├── latest_releases.{json,ts,test.ts}
│   └── <domain_specific>.{json,ts,test.ts}
├── adapters/
│   └── skill/
│       └── SKILL.md        # only Skill is per-almanac; MCP is generic
├── tests/
│   ├── positive.jsonl
│   └── negative.jsonl
└── .compile/
    ├── compile-state.json  # stage status, hashes, prompt versions
    ├── domain-spec.json    # Stage 1 output
    ├── sources-processed.json
    └── benchmark-result.json
```

Source-of-truth flow: `sources/raw/` → `extracted/facts.jsonl` →
`knowledge/almanac.sqlite`. Any `adapters/`, `knowledge/`, or derived files
can be regenerated from the SoT layer without loss.

---

## 3. CLI surface

The CLI is for **build and management**. End-user use happens through MCP.

| Command                                            | Purpose                                       | v0.1 |
|----------------------------------------------------|-----------------------------------------------|------|
| `almanac new <domain> [opts]`                      | compile from domain name                      | ✅   |
| `almanac update <domain>`                          | TTL-based refresh of sources / facts          | ✅   |
| `almanac list`                                     | list compiled almanacs                        | ✅   |
| `almanac inspect <domain>`                         | DOMAIN.md, tool list, freshness, bench score  | ✅   |
| `almanac serve <domain> [--transport=stdio\|http]` | start MCP server for one almanac              | ✅   |
| `almanac register <domain> --client=<name>`        | write MCP config + place SKILL.md             | ✅   |
| `almanac feed <domain> <source>`                   | add a single source incrementally             | v0.2 |
| `almanac remove <domain>`                          | delete almanac                                | ✅   |
| `almanac export <domain>`                          | bundle as portable archive                    | v0.2 |
| `almanac wiki <domain>`                            | export human-readable inspection bundle       | v0.4 |

`almanac new` flags (initial set):

```
--depth=<quick|standard|deep>      source discovery breadth (default: standard)
--sources=<list>                   override discovered sources with a list
--target=<mcp|skill|both>          which adapter(s) to install (default: both)
--auto-approve                     skip the source-approval gate (default: true)
--require-approval                 force the gate
--from-stage=<n>                   resume from a specific stage
--resume                           resume the previous run
--output=<path>                    custom output dir (default: ~/.almanac/almanacs/<id>)
```

`almanac register` clients in v0.1:

- `claude-code` — writes MCP server entry + symlinks SKILL.md into the user's
  Claude Code skills directory
- `claude-desktop` — writes `claude_desktop_config.json` MCP server entry
- `cursor` — writes Cursor MCP config entry
- `codex` — writes Codex MCP config entry

---

## 4. Compile pipeline (12 stages)

```diagram
       ╭─────────────╮
input  │ domain str  │
       │ + options   │
       ╰──────┬──────╯
              ▼
  ╭───────────────────────╮
0.│ bootstrap             │ → manifest.json, compile-state.json
  ╰──────┬────────────────╯
         ▼
  ╭───────────────────────╮
1.│ domain analysis       │  LLM      → .compile/domain-spec.json
  ╰──────┬────────────────╯              (incl. freshnessProfile)
         ▼
  ╭────────────────────────────────────╮
  │ 2. source discovery                │
  │  ┌──────────────────────────────┐  │
  │2a│ planner               (LLM)  │  │ → .compile/source-discovery-plan.json
  │  └──────────┬───────────────────┘  │
  │             ▼                      │
  │  ┌──────────────────────────────┐  │
  │  │ executor              (det.) │  │ → .compile/candidates.jsonl
  │  │ web search · github · probe  │  │   (Candidate[])
  │  └──────────┬───────────────────┘  │
  │             ▼                      │
  │  ┌──────────────────────────────┐  │
  │2b│ evaluator             (LLM)  │  │ → sources/sources.yaml (draft)
  │  └──────────────────────────────┘  │
  ╰──────┬─────────────────────────────╯
         │  ─ approval gate (auto by default; --require-approval to gate) ─
         ▼
  ╭───────────────────────╮
3.│ source approve        │  human/auto → sources.yaml (approved)
  ╰──────┬────────────────╯
         ▼
  ╭───────────────────────╮
4.│ source fetch          │  det.     → sources/raw/, sources/manifest.jsonl
  ╰──────┬────────────────╯
         ▼
  ╭───────────────────────╮
5.│ fact extraction       │  LLM      → extracted/facts.jsonl
  ╰──────┬────────────────╯           (static/slow only; fast/live skipped)
         ▼
  ╭───────────────────────╮
6.│ tool design           │  LLM      → tools/<name>.json
  ╰──────┬────────────────╯           (4 default + 1–3 domain-specific, ≤7)
         ▼
  ╭───────────────────────╮
7.│ tool implementation   │  LLM+loop → tools/<name>.ts + .test.ts
  ╰──────┬────────────────╯           (tsc → bun test; 2 retries → disable)
         ▼
  ╭───────────────────────╮
8.│ knowledge index       │  det.     → knowledge/almanac.sqlite (FTS5)
  ╰──────┬────────────────╯
         ▼
  ╭───────────────────────╮
9.│ contract files        │  LLM+det. → DOMAIN.md, AGENTS.md, SKILLS.md
  ╰──────┬────────────────╯
         ▼
  ╭───────────────────────╮
10│ adapter generation    │  det.     → adapters/skill/SKILL.md
  ╰──────┬────────────────╯           (MCP server is generic, not generated)
         ▼
  ╭───────────────────────╮
11│ benchmark gen         │  LLM      → tests/{positive,negative}.jsonl
  ╰──────┬────────────────╯
         ▼
  ╭───────────────────────╮
12│ benchmark run         │  det.+LLM → .compile/benchmark-result.json
  ╰───────────────────────╯           (E2E via MCP + direct retrieval)
```

Legend: **LLM** required · **det.** deterministic · **gate** human or auto.

### Per-stage contracts (summary)

| #   | Stage                       | Input                                         | Output                                              | Failure policy                |
|-----|-----------------------------|-----------------------------------------------|-----------------------------------------------------|-------------------------------|
| 0   | bootstrap                   | domain, options                               | manifest.json, compile-state.json                   | abort                         |
| 1   | domain analysis             | domain, depth                                 | domain-spec.json (incl. freshnessProfile)           | retry 1 → abort               |
| 2a  | source discovery — planner  | domain-spec.json, depth                       | source-discovery-plan.json                          | retry 1 → abort               |
| 2x  | source discovery — executor | source-discovery-plan.json                    | candidates.jsonl (`Candidate[]`)                    | per-source skip; continue     |
| 2b  | source discovery — evaluator| domain-spec, plan, candidates                 | sources.yaml (draft)                                | retry 1 → continue empty      |
| 3   | source approve              | sources.yaml (draft)                          | sources.yaml (approved)                             | wait or skip                  |
| 4   | source fetch                | sources.yaml, sources/manifest.jsonl          | sources/raw/<sha256>.{md,pdf,json}, manifest.jsonl  | per-source skip               |
| 5   | fact extraction             | sources/raw/, domain-spec, processed.json     | extracted/facts.jsonl, sources-processed.json       | per-source skip; 2-phase write |
| 6   | tool design                 | domain-spec, facts sample, sources            | tools/<name>.json                                   | retry 1 → abort               |
| 7   | tool impl                   | tools/<name>.json                             | tools/<name>.ts + .test.ts                          | per-tool disable (2 retries)  |
| 8   | knowledge index             | extracted/facts.jsonl                         | knowledge/almanac.sqlite                            | abort                         |
| 9   | contract files              | domain-spec, tools, facts sample              | DOMAIN.md, AGENTS.md, SKILLS.md                     | retry 1 → abort               |
| 10  | adapter generation          | DOMAIN/AGENTS/SKILLS, manifest                | adapters/skill/SKILL.md                             | abort                         |
| 11  | benchmark gen               | domain-spec, facts                            | tests/{positive,negative}.jsonl                     | warning; skip                 |
| 12  | benchmark run               | tests/, MCP server, knowledge/, tools/        | .compile/benchmark-result.json                      | warning; score=0              |

### Cross-cutting

- **State file**: `.compile/compile-state.json` tracks stage status, input/output
  hashes, prompt versions, LLM cost. Enables `--resume` and `--from-stage N`.
- **Hash-based incremental**: source `contentHash`, tool manifest hash, facts
  tail hash all gate re-execution.
- **Observability**: structured JSONL events to `stderr`; `stdout` reserved for
  `--json` final results (matches `clone-generator` output contract).
- **Prompt versioning**: prompts live at
  `src/compile/prompts/<stage>/<sub?>-v<N>.md`. Single-LLM stages use
  `v1.md`; stages with multiple LLM sub-calls use `<sub>-v1.md` (e.g.,
  `02-source-discovery/planner-v1.md` and `evaluator-v1.md`). The version
  string is recorded in every LLM-produced artifact for replay.
- **LLM provider abstraction**: `src/llm/provider.ts` interface; v0.1 default is
  Anthropic via `@anthropic-ai/sdk` (low-level SDK, no agent harness).

### Stage 2 — three sub-stages

Stage 2 is the only stage with multiple LLM calls separated by deterministic
work. It is implemented as three discrete sub-stages so that each can be
unit-tested, replayed, and budgeted independently.

| Sub | Kind | Prompt / Code                                            | Reads                          | Writes                            |
|-----|------|----------------------------------------------------------|--------------------------------|-----------------------------------|
| 2a  | LLM  | `prompts/02-source-discovery/planner-v1.md`              | `domain-spec.json`             | `.compile/source-discovery-plan.json` |
| 2x  | det. | `compile/fetchers/discovery-executor.ts`                 | plan                           | `.compile/candidates.jsonl`       |
| 2b  | LLM  | `prompts/02-source-discovery/evaluator-v1.md`            | domain-spec, plan, candidates  | `sources/sources.yaml` (draft)    |

The bridge type between 2a→2x→2b is `Candidate` (`src/core/types.ts`):

- **2a (planner)** produces a `SourceDiscoveryPlan` with explicit budgets
  (`maxWebSearchQueries`, `maxGithubQueries`, `maxUrlProbes`) and
  `coverageGoals` per source kind. The planner echoes every Stage 1
  `suggestedSource` as a `directProbe` and adds web/GitHub queries only to
  fill gaps.
- **2x (executor)** is deterministic: it fans out the plan, runs URL probes,
  web searches, and GitHub searches in parallel, and records each result as
  a `Candidate{ url, kind, title, snippet, preview, fetchedAt, fetchStatus,
  origin, meta }`. Failures are per-candidate (`fetchStatus: client-error |
  server-error | timeout | blocked`), never abort the stage.
- **2b (evaluator)** consumes (`DomainSpec`, plan, candidates) and emits a
  `SourcesFile` with `status: "draft"`. It scores trust per a fixed rubric,
  assigns volatility per source, picks `ingestion.mode` with licensing
  awareness, enforces `coverageGoals`, and caps total accepted at 12.

State recorded in `compile-state.json.stages`:

```jsonc
{
  "02a-source-discovery-planner":   { "status": "completed", "promptVersion": "v1", ... },
  "02x-source-discovery-executor":  { "status": "completed", ... },   // deterministic; no promptVersion
  "02b-source-discovery-evaluator": { "status": "completed", "promptVersion": "v1", ... }
}
```

`--from-stage=2` re-runs all three sub-stages. `--from-stage=2b` re-runs only
the evaluator (useful for tuning the evaluator prompt against fixed
candidates).

### Stage 12 benchmark — MCP-based E2E

Because the runtime is consumed via MCP by host LLMs, the benchmark must
exercise that surface, not just internal retrieval:

1. Spawn `almanac serve <id>` as a subprocess (stdio).
2. The benchmark harness acts as an MCP client + LLM orchestrator (uses
   Anthropic SDK directly, not Claude Agent SDK).
3. For each `positive` case: send the query, let the LLM choose tools, capture
   the final answer, score against `mustCiteSourceIds` and `mustUseTools`.
4. For each `negative` case: assert the LLM abstains (no factual claim, or
   explicit "no grounded source").
5. Also run a direct-retrieval baseline (no LLM) to separate retrieval quality
   from orchestration quality.

This keeps the runtime artifact LLM-free while measuring real-world behavior.

---

## 5. Freshness model — first-class

Every fact, source, and tool is classified into a **volatility class**:

| Class  | Max age (default) | Storage                            | Examples (varies by domain)            |
|--------|-------------------|------------------------------------|----------------------------------------|
| static | ∞                 | `extracted/facts.jsonl`            | k8s controller pattern, math, history  |
| slow   | 30d               | `facts.jsonl` + scheduled refresh  | wine grape characteristics, frameworks |
| fast   | 24h               | live fetch (no fact cache)         | latest releases, current best practice |
| live   | 0                 | live fetch every call (no cache)   | prices, gas fees, weather              |

`fast` and `live` topics are **never** written to `facts.jsonl` — keeping a
cache for them is a contract violation. They are reachable only through live
tools. This is enforced both at extraction (Stage 5) and at runtime (AGENTS.md
discipline).

### Default tool set (every almanac)

| Tool                    | Volatility   | Purpose                                                   |
|-------------------------|--------------|-----------------------------------------------------------|
| `query_facts`           | static/slow  | FTS5 over `facts.jsonl` (omitted if profile is live-heavy)|
| `fetch_official_docs`   | fast         | Real-time fetch from `kind: docs` sources                 |
| `web_search_recent`     | fast         | Web search with recency filter (last N days)              |
| `latest_releases`       | fast         | Releases / changelog from `kind: repo` sources            |

Plus 1–3 **domain-specific** tools generated in Stage 6, total ≤ 7 tools.

### Tool result contract (every tool, every call)

```ts
type ToolResult<T> = {
  ok: true;
  data: T;
  citations: Array<{
    sourceId: string;
    url: string;
    fetchedAt: string;             // ISO 8601, REQUIRED
    sourceTimestamp?: string;
    excerpt?: string;
  }>;
  freshness: {
    class: "static" | "slow" | "fast" | "live";
    maxAge: number | null;
    staleness: "fresh" | "warm" | "stale";
  };
} | {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
};
```

A tool that does not return `citations[]` and `freshness` is rejected at
compile time (Stage 7 smoke).

---

## 6. Contract files

### DOMAIN.md (what + freshness)

Templated, with LLM filling marked slots. No persona content.

Top-level sections (fixed order):

- frontmatter (`schemaVersion`, `almanacId`, `domain`, `freshnessProfile`, …)
- `# <displayName> Almanac` + 1-line description
- `## Scope` — Covers / Out of scope
- `## Freshness Policy` — table of classes with this domain's examples
- `## Source Citation Rule`
- `## Tools` (auto-rendered from manifests)
- `## Cautions` (domain-specific risks, e.g. legal/medical/financial)

### AGENTS.md (operating contract for host LLMs)

Mostly deterministic; LLM only writes `## Tool Selection Guidance`.

Mandatory sections:

- `## Mission`
- `## Non-Negotiables` — Cite or abstain · Respect freshness class · Surface
  staleness · Refuse outdated answers · Stay in scope
- `## Tool Selection Guidance` (LLM-written)
- `## Retrieval Discipline` — classify volatility → route → combine
- `## Output Discipline` — no invented `##` headers, inline citations, focused
- `## When to Refuse`
- `## Failure Modes to Surface`

### SKILLS.md (tools catalog)

100% deterministic from `tools/*.json`. One section per tool:

- name, description, when to use
- input schema (JSON), returns summary
- capabilities (network allowlist, fs, secrets)
- example
- `volatilityClass` badge

### adapters/skill/SKILL.md (Claude Code Skill)

Generated in Stage 10. Concatenates DOMAIN.md + AGENTS.md + SKILLS.md into
Claude Code skill format with frontmatter. No bundled scripts (tools are
reached via the MCP server registered alongside).

Frontmatter shape (modeled on `last30days-skill`):

```yaml
---
name: almanac-cooking
version: "0.1.0"
description: "Cooking domain almanac. Sourced facts and live retrieval. ..."
allowed-tools: [mcp__almanac-cooking__query_facts, mcp__almanac-cooking__fetch_official_docs, ...]
metadata:
  almanac:
    domain: cooking
    freshnessProfile: mixed
    toolCount: 6
    factCount: 1234
    compiledAt: ...
---
```

### Tool manifest schema

```ts
ToolManifest {
  name: string;                          // snake_case, MCP-compatible
  version: string;
  description: string;                   // for MCP tools/list
  whenToUse: string;
  returnsSummary: string;
  inputSchema: JSONSchema;               // MCP-compatible
  outputSchema: JSONSchema;
  capabilities: {
    network: string[];                   // host allowlist; [] = no network
    fs: "none" | "read" | "write";
    subprocess: string[];
    secrets: string[];                   // env var names
  };
  volatilityClass: "static" | "slow" | "fast" | "live";
  freshness: {
    cachePolicy: "no-cache" | "ttl" | "manual-refresh";
    ttlSeconds: number | null;
    sourceTimestamp: boolean;
  };
  knowledgeUsage: {
    facts: boolean;
    ftsQuery: string | null;
    embeddings: boolean;                 // v0.2
  };
  examples: Array<{                      // smoke fixtures
    description: string;
    input: unknown;
    expectedShape: "match-outputSchema" | { contains: string[] };
  }>;
  designedBy: { model: string; promptVersion: string };
  implementedBy?: {
    model: string; promptVersion: string;
    tscPassed: boolean; smokePassed: boolean; attempts: number;
  };
  disabled: boolean;
  disabledReason?: string;
}
```

Tool implementation (`tools/<name>.ts`) follows a fixed shape:

```ts
import type { ToolContext, ToolResult } from "almanac-core/runtime";
import type { Input, Output } from "./<name>.types";

export const manifest = /* loaded from <name>.json */;

export default async function execute(
  input: Input,
  ctx: ToolContext
): Promise<ToolResult<Output>> { /* ... */ }
```

`ToolContext` is constructed per call from the manifest's `capabilities`:

```ts
interface ToolContext {
  knowledge?: KnowledgeReader;     // only if knowledgeUsage.facts === true
  secrets: Record<string, string>; // only those declared in capabilities.secrets
  fetch?: typeof fetch;            // only if capabilities.network is non-empty
                                   // (allowlist enforced at the wrapper)
  log: (event: object) => void;
}
```

---

## 7. Stack and module layout

### Runtime / language

- **bun ≥ 1.1** (package manager, runtime, test runner, sqlite)
- **TypeScript** (strict, NodeNext-style ESM)
- `tsc --noEmit` kept as dev dependency for Stage 7 type checking
- Generated almanacs also require `bun ≥ 1.1`

### Key dependencies

| Use                       | Package                            |
|---------------------------|------------------------------------|
| CLI                       | `commander`                        |
| Schema                    | `zod`                              |
| Templates                 | `eta`                              |
| YAML                      | `yaml`                             |
| SQLite + FTS5             | `bun:sqlite` (built-in)            |
| MCP server                | `@modelcontextprotocol/sdk`        |
| LLM (compiler-side only)  | `@anthropic-ai/sdk`                |
| HTML → Markdown           | `@mozilla/readability` + `jsdom`   |
| PDF                       | `pdf-parse`                        |
| GitHub                    | `@octokit/rest`                    |
| Tests (compiler & smoke)  | `bun test` (built-in)              |
| Subprocess                | `bun.spawn` (built-in)             |
| ULID                      | `ulid`                             |

### Module layout

```text
almanac/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts                     # entry — commander
│   ├── core/                      # operation contract = SoT for adapters
│   │   ├── types.ts               # zod schemas
│   │   └── runtime.ts             # listTools / execTool / listResources / readResource
│   ├── compile/                   # the build pipeline
│   │   ├── pipeline.ts            # orchestrator (--resume, --from-stage)
│   │   ├── state.ts
│   │   ├── stages/
│   │   │   ├── s01-domain-analysis.ts
│   │   │   ├── s02a-source-planner.ts
│   │   │   ├── s02x-source-executor.ts
│   │   │   ├── s02b-source-evaluator.ts
│   │   │   ├── s04-source-fetch.ts
│   │   │   ├── s05-fact-extraction.ts
│   │   │   ├── s06-tool-design.ts
│   │   │   ├── s07-tool-impl.ts   # LLM + tsc + bun test loop
│   │   │   ├── s08-index.ts
│   │   │   ├── s09-contract.ts
│   │   │   ├── s10-adapters.ts    # SKILL.md only
│   │   │   ├── s11-benchmark-gen.ts
│   │   │   └── s12-benchmark-run.ts
│   │   ├── prompts/
│   │   │   ├── 01-domain-analysis/
│   │   │   │   └── v1.md
│   │   │   └── 02-source-discovery/
│   │   │       ├── planner-v1.md
│   │   │       └── evaluator-v1.md
│   │   ├── templates/             # eta
│   │   │   ├── domain.md.eta
│   │   │   ├── agents.md.eta
│   │   │   ├── skills.md.eta
│   │   │   └── skill.md.eta
│   │   └── fetchers/              # web/github/pdf/file
│   │       └── discovery-executor.ts  # 2x — fans out plan, emits Candidate[]
│   ├── serve/                     # `almanac serve` — generic MCP server
│   │   ├── mcp-server.ts
│   │   ├── tool-loader.ts         # dynamic import tools/*.ts
│   │   ├── tool-context.ts        # capability-gated context injection
│   │   └── resource-loader.ts     # DOMAIN/AGENTS/SKILLS/sources
│   ├── manage/                    # other CLI commands
│   │   ├── list.ts
│   │   ├── inspect.ts
│   │   ├── register.ts            # writes MCP config + Skill placement
│   │   └── update.ts
│   ├── llm/
│   │   ├── provider.ts
│   │   └── anthropic.ts
│   └── util/
│       ├── log.ts
│       ├── hash.ts
│       └── fsx.ts
└── test/
    ├── stages/                    # unit tests; LLM mocked
    └── fixtures/
```

---

## 8. Roadmap

### v0.1 (MVP) — **shipped 2026-05-25** (v0.1.0 + v0.1.1)

- `new` / `update` (TTL-based refresh, `--from-stage`) / `list` / `inspect` /
  `path` / `remove`
- `serve` (generic MCP stdio server) — the hero command
- `register` for claude-code, claude-desktop, cursor (JSON)
- Skill: `adapters/skill/SKILL.md` generation
- Source discovery: WebSearch + GitHub (planner → executor → evaluator)
- 12-stage compile pipeline; Stage 7 LLM implementer with
  `generate → tsc → smoke → retry` loop
- Tool budget: 4 default + ≤3 domain-specific custom tools
- Knowledge: `facts.jsonl` + `bun:sqlite` FTS5 (no vector yet)
- Benchmark: 10 positive + 5 negative, MCP-based E2E (Stages 11–12)
- GitHub Actions CI (typecheck + bun test) and MIT license

### v0.2 — **shipped through v0.2.5**

Shipped:

- `feed` — incremental single-source ingest (v0.2.0)
- `export` — portable `.tar.gz` bundle (v0.2.1)
- `codex` / TOML `register` (v0.2.2) — the four-client register triad is
  complete (claude-code, claude-desktop, cursor, codex)
- `CHANGELOG.md` + CI (v0.2.0+)
- Stage 11 hardening: `factSample`-aware prompt v2 (v0.2.2) → v3 (v0.2.5),
  case-insensitive `expected.contains` (v0.2.3), `factSample` default
  20 → 60 (v0.2.4)

Deferred to v0.3 (originally scoped here but unshipped):

- Vector retrieval (default provider + OpenAI optional)
- HTTP / SSE MCP transport
- Auto-refresh scheduler (cron / launchd helper)
- Wiki view export (human inspection surface)

### Empirical baseline — v0.2.5 cross-domain validation

After five fix-rolls on the sqlite smoke and an independent
cross-validation on Rust:

| domain  | depth     | facts | tools (custom) | passed | citationRate |
|--------:|-----------|------:|---------------:|-------:|-------------:|
| sqlite  | standard  |   620 |              2 |  12/15 | 0.70         |
| Rust    | standard  |   779 |              2 |  12/15 | 0.70         |

The remaining 20 % of failures clusters into two structural areas
(see v0.3 thrust below). v0.2.x is therefore considered
feature-complete — further patches at this stage would only nibble
at edges. The real lift requires v0.3-class structural work.

### v0.3 — **shipped through v0.3.11** (2026-05-26..27)

The v0.2.5 cross-domain validation surfaced one named failure mode
(custom tool ↔ source-mode mismatch) plus 20% residual failures
that turned out, on closer inspection during v0.3 development, to
be *eight distinct structural classes*. The eleven point releases
shipped during v0.3 each closed one class empirically.

#### v0.3.0 — Stage 6 source-mode awareness (the original plan)

`ToolManifest.sourceDependencies` + Stage 6 prompt v2 awareness of
each source's mode. Custom tools that depend solely on index-only
sources are now refused at Stage 6. Stage 6 prompt v3 (v0.3.1)
adds a pre-computed source-mode summary so the LLM doesn't
re-derive it from the SourcesFile.

This was the originally-planned "main thrust" of v0.3. It
materialized as v0.3.0–v0.3.1.

#### v0.3.2 — HTTP fetcher fall-through for non-bare-github
`kind:repo`

`HttpIndexOnlyFetcher` and `GenericHttpFetcher` no longer reject
sources with `kind:repo` when the URL is a github.io page or a
github.com path URL (`/releases`, etc.). Closed two silent Stage 4
failures from the v0.3.1 Rust smoke.

#### v0.3.3 — GitHub repo snapshot path-desc sort

`GithubRepoFetcher` sorts matched files by path descending before
`slice(0, SNAPSHOT_MAX_FILES=50)`. The tree API returns paths
ascending, so for numeric-prefixed paths (`text/0001-...` ..
`text/3700-...` in rust-lang/rfcs) the previous slice took the
*oldest* 50 RFCs. v0.3.3 swaps to the newest 50.

#### v0.3.4 + v0.3.6 + v0.3.9 — Stage 7 static validator

A new module `src/compile/stages/s07/static-validator.ts` runs
between `tsc` and `bun test` in the LLM implementer retry loop.
Three rules currently:

1. **`detectHardcodedFallbackUrls`** — two-or-more adjacent
   hardcoded `https?://...` string literals. Catches the v0.3.2
   `lookup_std_item` Vec-fallback hallucination: an array of
   fixed URLs the impl tried in sequence, always succeeding at
   the second-attempt's hardcoded URL.
2. **`requireSampleUrlInTestCode`** — when the manifest has
   non-empty `sampleUrls`, the generated test mock must reference
   at least one of them. Forces the smoke to anchor on documented
   URLs, so an impl that confabulates a different URL pattern
   gets caught.
3. **`detectUnallowedHostInImpl`** — every literal `http(s)://HOST/`
   in the impl must have `HOST` in `capabilities.network`. The
   host is checked even when the *path* is template-interpolated
   (the v0.3.8 case had `https://github.com/.../tag/${ver}` —
   literal host, templated path).

A new `ImplementationOutcome` variant `validator-failed` carries
diagnostics back to the next `generate()` call. Stage 7 prompt v1
gains hard requirements **#9** (no hardcoded URL fallback lists)
and **#10** (only fetch hosts in `capabilities.network`; exact-match
semantics, `github.com` ≠ `api.github.com`).

#### v0.3.5 — Stage 11 canonical error-code taxonomy

Stage 11 prompt v3 enumerates the ten canonical `error.code`
strings Stage 7 tools emit and forbids near-synonyms like
`invalid-input`. Closes the fixture-vs-impl vocab mismatch class.

#### v0.3.6 + v0.3.7 — `ToolManifest.sampleUrls`

New optional 0–5 array of real documented URLs the tool will
fetch. Stage 6 populates them (when the tool has network
capability), and Stage 7's smoke must mock at least one as a 200
response. v0.3.7 adds anchor-fragment URLs
(`...struct.Arc.html#method.clone`) for tools whose `inputSchema`
accepts qualified names (`X::Y`). Closes the
"impl-builds-wrong-URL-paired-with-matching-wrong-mock" class
end-to-end.

#### v0.3.8 — Stage 11 `contains` rules split by tool class

Stage 11 prompt v3 distinguishes two regimes:

- `query_facts` / fact-store-reading tools — keep picking
  substrings from `factSample[i].text`.
- Custom tools that fetch live — default `contains: []` and rely
  on the envelope (`ok: true`, `minCitations`, staleness).
  `contains` may only be used when anchored to a `sampleUrl`
  substring, an `outputSchema` field name, or the full input
  identifier.

Documents v0.3.7's `["Residual"]`-for-`Option::Residual` /
`["race"]`-for-thread-local anti-patterns explicitly.

#### v0.3.10 — Stage 5 tradeoff extraction hint

The `tradeoff` fact type was already in the schema enum but rarely
emitted. v0.3.10 prompt v1 adds explicit guidance: scan for
side-by-side comparison sections, "prefer X over Y when …", RFC
Alternatives sections, `X vs Y` headings. Both sides go into
`text`; both labels go into `entities`. Empirical:
1438-fact Rust corpus now 6.1% tradeoff facts (88 / 1438).

Closing the loop downstream — Stage 11 tradeoff-aware fixture
generation — is a v0.4 candidate.

#### v0.3.11 — Product onboarding and operations polish

v0.3.11 turns the compiler from a technical beta into a CLI product
beta. It adds a no-key `almanac demo` path, richer `inspect` health
and next-action summaries, `sources` review, human golden benchmark
initialization and execution, `doctor` diagnostics, product docs, and
a Node 24-capable CI checkout action.

### Empirical baseline — v0.3.x summary

After the structural v0.3.0-v0.3.10 sequence:

| domain | latest  | facts | tools (custom) | passed | citationRate | negatives passed |
|-------:|--------:|------:|---------------:|-------:|-------------:|-----------------:|
| sqlite |  v0.3.0 |   620 |              2 |  14/15 |         0.90 |              5/5 |
| Rust   | v0.3.10 |  1438 |              3 |  11/15 |         0.60 |              5/5 |

The Rust pass count fluctuated 11–13/15 across the v0.3.x runs
because Stage 2 source-discovery is non-deterministic and fixture
sets diverge. The stable signal: **all 5 negative fixtures pass for
six consecutive Rust smokes** (v0.3.5 through v0.3.10). Spurious-citation
hallucinations from the v0.2.x era are structurally closed.

The original v0.3 supporting thrusts (vector retrieval, HTTP/SSE
transport, wiki export) shipped in v0.4 after the empirical v0.3
hardening sequence.

### v0.4.0 — Answer quality, retrieval, transport, and inspection

v0.4.0 shipped as PRs #6 through #13. The release adds:

- **Stage 11 tradeoff-aware fixture generation.** Comparison-shaped
  positives are generated when the corpus contains grounded tradeoff
  facts and an enabled tool can answer the shape.
- **Approved-source reuse.** Source discovery carries forward
  still-valid human-approved sources to reduce benchmark drift across
  reruns.
- **Embedding provider abstraction.** Deterministic test embeddings,
  Voyage/OpenAI configuration discovery, and a local-provider mode are
  represented behind one internal interface.
- **Vector index artifacts.** Stage 8 can write optional vector JSONL
  and manifest metadata when embeddings are explicitly enabled.
- **Hybrid RRF retrieval.** Runtime fact lookup can combine FTS5 and
  vector cosine ranks while retaining the cite-or-abstain contract.
- **HTTP/SSE MCP transport.** `almanac serve --transport=http`
  exposes Streamable HTTP MCP with session handling, CORS, and
  `/health`.
- **Wiki inspection export.** `almanac wiki <id>` writes a Markdown
  bundle for source, fact, tool, benchmark, and artifact review.

Auto-refresh scheduling remains a v0.5+ candidate. See
[`v0.4-plan.md`](./v0.4-plan.md) for the archived implementation
sequence and release gates.

### Post-v0.4 hardening — Enterprise AI smoke

After v0.4.0, the Enterprise AI smoke exposed three product-readiness gaps:

- Stage 2b source evaluation can exceed a short client timeout when discovery
  produces larger candidate sets.
- High-trust landing pages can be fetchable but contribute zero facts.
- Stage 11 can pass runtime preflight after filtering but still leave too few
  generated fixtures to satisfy the benchmark coverage floor.

Main now addresses those gaps with a longer default Anthropic request timeout,
known zero-fact landing-page rejection, generated benchmark coverage reporting,
and Stage 11 retries when preflight filtering or stabilization would leave fewer
than 8 positive / 5 negative / 13 total fixtures.

Empirical result on 2026-05-30:

| domain | depth | facts | sources with facts | tools (custom) | fixtures | passed | citationRate |
|-------:|:------|------:|-------------------:|---------------:|---------:|-------:|-------------:|
| Enterprise AI | standard | 387 | 7 | 2 | 11 positive / 6 negative | 17/17 | 1.00 |

### v0.5+ (long-tail)

- Slack adapter
- Almanac marketplace
- Composable almanacs (one almanac calling another via MCP)
- Enterprise private deploy
- `almanac run` — local CLI orchestrator with bundled LLM SDK

---

## 9. Open questions / next steps

The original v0.1 deliverables listed here have all shipped, as
have the v0.3-era structural fixes and v0.4 feature set documented
in §8 above. Active questions carrying into v0.5+:

1. **Embedding-model default.** Voyage `voyage-3-lite` vs OpenAI
   `text-embedding-3-small` vs local
   `@xenova/transformers/all-MiniLM-L6-v2`. Tradeoff:
   cost-per-token vs bundle size vs offline support.
   Recommendation: Voyage for the default path, OpenAI as opt-in
   when the user already has that key, local as the air-gapped
   fallback.
2. **Hybrid retrieval recipe.** RRF (parameter-free, well-cited)
   vs a weighted linear blend (tunable per domain). Start with
   RRF; promote to weighted only if benchmark signals demand it.
3. **Snapshot allowlist.** Curated list of trusted hosts whose
   docs default to `snapshot` rather than `index-only`. Needs to
   be additive (never *block* a source, only *upgrade* the
   default mode) and explicit in `sources.json`. Partially
   relieved by v0.3.0 source-mode awareness but the curated list
   is still missing.
4. **Stage 11 `intent` enum coverage.** Stage 11 retries from
   intermittent enum-mismatch emissions (`diagnose-error`,
   `not-found` as a `refusalReason`, etc.) persisted into
   v0.3.x. The canonical enums work but the prompt's
   enum-framing is still weak enough that the LLM occasionally
   reaches for a near-synonym. Candidate: explicit
   "do-not-substitute" lists per enum, similar to the v0.3.5
   error-code taxonomy fix.
5. **Stage 2 source-discovery non-determinism.** The recurring
   ±2 pass-count swing across Rust smokes traces back to Stage 2
   picking partly different source sets each run. Stabilizing
   this (e.g. canonical source sets per domain after the first
   approval, or a seed-pinning option) would make benchmark
   comparisons cross-version more meaningful.
6. **Stage 7 prompt-vs-validator division of labor.** Through
   v0.3.x, every new validator rule has been paired with a
   prompt hard-requirement so the LLM avoids the pattern on the
   first attempt (and the validator is a structural backstop).
   Empirically, recent smokes have shown 0 `validator-failed`
   events — the prompt carries the work. Worth deciding whether
   the validator is permanent infrastructure or a transition aid
   that can retire once the prompts mature.
