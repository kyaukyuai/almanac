# almanac

> Compile domain-specific, freshness-aware knowledge surfaces as CLI tools,
> MCP servers, and Claude Code Skills.

`almanac` turns a single domain name into a self-contained knowledge surface
that host LLMs can use through tools. Each compiled almanac contains sourced
facts, freshness metadata, generated tool manifests, runtime contracts, review
artifacts, and adapters for MCP and Claude Code Skills.

It is deliberately not a persona or chatbot. The host LLM still does the
reasoning. `almanac` provides the grounded retrieval layer, live tools, source
citations, and validation artifacts.

## What It Builds

Given a domain such as `sqlite`, `rust`, or `enterprise-ai`, `almanac` compiles:

- a curated source set with accepted and rejected source metadata
- extracted facts with `fetchedAt`, freshness class, and source citations
- a SQLite FTS knowledge index, with optional vector retrieval artifacts
- default tools for facts, official docs, recent web search, and releases
- 0-3 domain-specific tools generated from the discovered source contract
- a generic MCP runtime over `listTools`, `execTool`, `listResources`, and
  `readResource`
- a Claude Code Skill adapter and client registration support
- benchmark fixtures and deterministic runtime reports
- saved run, refresh, and answer artifacts for audits and release gates

The result can be served by one generic binary:

```bash
almanac serve sqlite-demo
almanac serve sqlite-demo --transport=http --port=7331
```

## Requirements

- Bun 1.1.0 or newer
- `ANTHROPIC_API_KEY` for real LLM-backed compile or answer runs
- optional `BRAVE_SEARCH_API_KEY` for web source discovery
- optional `VOYAGE_API_KEY`, `OPENAI_API_KEY`, or `ALMANAC_EMBEDDINGS` for
  vector retrieval artifacts

## Install

`almanac` is currently source-first and is not published as a package. Clone
the repository, install dependencies, and link the local CLI with Bun:

```bash
git clone https://github.com/kyaukyuai/almanac.git
cd almanac
bun install
bun link
```

After linking, `almanac` should resolve to the local checkout:

```bash
almanac doctor
```

For one-off use without linking, run the same commands with `bun src/cli.ts`
from the repository root.

## Quick Start

Run the offline demo first. It does not require API keys.

```bash
tmp=$(mktemp -d)
almanac demo --root "$tmp"
almanac inspect sqlite-demo --root "$tmp"
almanac profile sqlite-demo --root "$tmp"
almanac benchmark sqlite-demo --root "$tmp"
almanac run sqlite-demo \
  --tool query_facts \
  --input '{"q":"transactions atomic"}' \
  --root "$tmp"
```

The demo creates a complete local almanac with curated SQLite facts, source
review metadata, default tools, contract files, a Skill adapter, and human
golden benchmark fixtures.

If you did not run `bun link`, replace `almanac` with `bun src/cli.ts` in the
examples.

## Compile a Real Almanac

Real compilation uses Anthropic-backed LLM stages for domain analysis, source
discovery, fact extraction, tool design, tool implementation, and benchmark
generation.

```bash
export ANTHROPIC_API_KEY=...
export BRAVE_SEARCH_API_KEY=... # optional

almanac new cooking
almanac inspect cooking
almanac profile cooking
almanac sources cooking
almanac benchmark cooking
```

Register it with a host client:

```bash
almanac register cooking --client=claude-code --apply
almanac serve cooking
```

Supported registration targets are `claude-code`, `claude-desktop`, `cursor`,
and `codex`.

## Core Commands

| Command | Purpose |
| --- | --- |
| `almanac new <domain>` | Compile an almanac from a domain name. |
| `almanac demo [id]` | Create a no-key offline demo almanac. |
| `almanac update <id> --from-stage <stage>` | Re-run part of the compile pipeline. |
| `almanac feed <id> <url> --apply` | Add one source and reindex without a full rebuild. |
| `almanac inspect <id>` | Show manifest, stage health, sources, fixtures, and benchmark status. |
| `almanac profile <id>` | Summarize expertise readiness, evidence, query shapes, and limits. |
| `almanac sources <id>` | Review accepted and rejected source candidates. |
| `almanac benchmark <id>` | Run human golden fixtures through the runtime. |
| `almanac run <id> --tool <name>` | Invoke one compiled tool deterministically. |
| `almanac ask <id> <question>` | Run one LLM-backed cited answer session over compiled tools. |
| `almanac ask-replay <id>` | Replay saved answer artifacts or JSONL fixtures without an LLM. |
| `almanac runs <id>` | List, inspect, filter, and prune saved operational artifacts. |
| `almanac refresh due <id>` | Check refresh readiness without writing files or requiring keys. |
| `almanac refresh run <id>` | Run a locked manual refresh over the update pipeline. |
| `almanac serve <id>` | Start the generic MCP server over stdio or Streamable HTTP/SSE. |
| `almanac register <id>` | Install Skill and MCP config entries for supported clients. |
| `almanac export <id>` | Package a compiled almanac as a portable archive. |
| `almanac wiki <id>` | Export a Markdown inspection bundle for review and handoff. |
| `almanac doctor [id]` | Diagnose local runtime, credentials, artifacts, and readiness. |

## Runtime Model

The compiled almanac directory is data. The runtime loads that data and exposes
the same four-operation contract everywhere:

```ts
interface AlmanacRuntime {
  listTools(): Promise<ToolManifest[]>;
  execTool(name: string, input: unknown): Promise<ToolResult<unknown>>;
  listResources(): Promise<ResourceDescriptor[]>;
  readResource(uri: string): Promise<{ contents: string; mimeType: string }>;
}
```

MCP, local CLI execution, answer orchestration, benchmarks, and Skill adapters
all use this boundary. That keeps the per-domain artifact portable while the
serving binary stays generic.

## Design Principles

- **Headless runtime + adapters**: MCP and Skill support derive from the same
  operation contract.
- **Always fresh**: facts and tools carry freshness policy, TTL, and
  staleness signals. Stale data is surfaced, not hidden.
- **Cite or abstain**: tool results must return `citations[]`. No grounded
  source means no answer.
- **Compile, do not configure**: source discovery, tool design, code
  generation, and benchmarks are automated from the domain name, with human
  review points.
- **No persona**: an almanac is a retrieval-and-tools layer for a host LLM,
  not a simulated identity.

## Status

`v0.8.0` is shipped. The 12-stage compile pipeline runs end-to-end against
mocked and real Anthropic providers, and the runtime is wired into the MCP
ecosystem for Claude Code, Claude Desktop, Cursor, and Codex registration.

Current shipped lines include:

- `v0.4`: optional vector artifacts, hybrid FTS5/vector RRF retrieval,
  Streamable HTTP/SSE MCP transport, and wiki exports
- `v0.5`: deterministic `run --tool`, saved run artifacts, retention cleanup,
  and portable export hardening
- `v0.6`: refresh due checks, locked manual refresh runs, refresh artifacts,
  and scheduler docs
- `v0.7`: one-shot `ask`, bounded LLM-backed tool planning, cite-or-abstain
  synthesis, and saved answer artifacts
- `v0.8`: answer trace diagnostics, deterministic ask replay, answer quality
  gates, and doctor/profile answer readiness signals

`v0.8.0` hardens answer mode as an operator workflow: saved answer artifacts
show planner/tool/citation/abstention traces, `ask-replay` can regression-test
saved runs or fixture JSONL without provider calls, quality gates separate
answer behavior from compile-time benchmarks, and readiness signals explain
whether an almanac is prepared for ask-mode use.

See [CHANGELOG.md](./CHANGELOG.md) for the concise release history.

## Benchmarks

Each compiled almanac ships with its own generated benchmark fixtures, executed
end-to-end through the runtime. Latest real-Anthropic smokes at
`--depth=standard`:

| domain | version | facts | tools (custom) | passed | citationRate | negatives passed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Enterprise AI | v0.8.0 RC | 642 | 3 | 15/15 | 1.00 | 5/5 |
| sqlite | v0.3.0 | 620 | 2 | 14/15 | 0.90 | 5/5 |
| Rust | v0.3.10 | 1438 | 3 | 11/15 | 0.60 | 5/5 |

The stable signal across the validation runs is that negative fixtures pass:
out-of-domain or unsupported questions abstain instead of fabricating
citations.

The v0.8.0 Enterprise AI RC smoke also passed a real-provider ask check with a
correct no-citation abstention and replayed the saved answer artifact
deterministically through `ask-replay`.

## Development

```bash
bun install
bun run typecheck
bun test
```

The CLI entrypoint is [src/cli.ts](./src/cli.ts). The core runtime surface
lives in [src/core/runtime.ts](./src/core/runtime.ts), the MCP adapter in
[src/serve/mcp-server.ts](./src/serve/mcp-server.ts), and the compile stages in
[src/compile/stages](./src/compile/stages).

## Docs

- [Product guide](./docs/product-guide.md): demo, inspection, source review,
  benchmarks, refreshes, and saved artifacts
- [Design document](./docs/design.md): architecture, directory layout,
  compile stages, and runtime contract
- [Answer mode](./docs/answer-mode.md): `ask`, citations, abstention, and
  replay behavior
- [Refresh scheduler](./docs/refresh-scheduler.md): cron, CI, launchd, locks,
  exit codes, and retention
- [Changelog](./CHANGELOG.md): version history

## License

MIT. See [LICENSE](./LICENSE).
