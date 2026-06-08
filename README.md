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
the repository and install dependencies first:

```bash
git clone https://github.com/kyaukyuai/almanac.git
cd almanac
bun install
```

Verify the source entrypoint before linking:

```bash
bun src/cli.ts --version
bun src/cli.ts doctor
```

`doctor` does not call an LLM provider. It reports local setup status and a
readiness section for demo, provider-backed compile, answer mode, refresh,
registration, and optional judge checks.

Then link the local CLI with Bun:

```bash
bun link
```

After linking, `almanac` should resolve to this checkout and work from outside
the repository:

```bash
tmpdir="$(mktemp -d)"
(cd "$tmpdir" && almanac --version && almanac doctor)
```

For one-off use without linking, run the same commands with `bun src/cli.ts`
from the repository root.

If `almanac --version` is stale or points at the wrong checkout, inspect the
resolved binary and rerun `bun link` from the repository you intend to use:

```bash
which almanac
readlink "$(which almanac)" 2>/dev/null || true
bun link
```

## Quick Start

Ask Almanac for the safest first step. This does not require API keys.

```bash
tmp=$(mktemp -d)
almanac start --root "$tmp"
almanac start "Build an almanac for production AI governance checks" --root "$tmp"
almanac demo --root "$tmp"
almanac start --root "$tmp"
almanac list --root "$tmp"
almanac status sqlite-demo --root "$tmp"
almanac inspect sqlite-demo --root "$tmp"
almanac profile sqlite-demo --root "$tmp"
almanac benchmark sqlite-demo --root "$tmp"
almanac ask-fixtures init sqlite-demo --seed-demo --root "$tmp"
almanac refresh run sqlite-demo \
  --from-stage 12-benchmark-run \
  --ask-suite \
  --save \
  --root "$tmp"
almanac maintain sqlite-demo --dry-run --root "$tmp"
almanac run sqlite-demo \
  --tool query_facts \
  --input '{"q":"transactions atomic"}' \
  --root "$tmp"
almanac export sqlite-demo --root "$tmp"
handoff_root=$(mktemp -d)
almanac import ./almanac-sqlite-demo-0.1.0.tar.gz --root "$handoff_root"
almanac import ./almanac-sqlite-demo-0.1.0.tar.gz --root "$handoff_root" --apply
almanac status sqlite-demo --root "$handoff_root"
almanac wiki sqlite-demo --root "$tmp"
```

`start "<goal>"` is planning-only: it drafts a domain, scope, reference
checklist, first questions, and an explicit `almanac new ...` command. It does
not compile, call a provider, or write files until you run a follow-up command.

The demo creates a complete local almanac with curated SQLite facts, source
review metadata, default tools, contract files, a Skill adapter, and human
golden benchmark fixtures.

`ask-fixtures init --seed-demo` and the Stage 12 `refresh run --ask-suite`
bootstrap answer readiness without provider credentials for the offline demo.
`maintain --dry-run` previews future upkeep. `operations` lists explicit
guided operations, and `studio` opens a local dashboard with Run buttons for
safe provider-free operations:

```bash
almanac operations sqlite-demo --root "$tmp"
almanac operations run sqlite-demo <operation-id> --root "$tmp"
almanac studio --root "$tmp"
```

For a committed inspection snapshot and answer-mode handoff commands, see
the [sample almanacs guide](./docs/sample-almanacs.md).

`export` creates a portable archive that excludes saved `.runs/` records by
default. `import` validates that archive in dry-run mode before writing files;
add `--apply` to install it into another root. Use `--include-runs` only when
the receiver should get saved tool, refresh, and answer artifacts. `wiki`
creates a Markdown inspection bundle for reviewing sources, facts, tools,
benchmarks, and the generated file manifest.

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
almanac register cooking --client=claude-code --status
almanac register cooking --client=claude-code --apply
almanac serve cooking
```

Supported registration targets are `claude-code`, `claude-desktop`, `cursor`,
and `codex`. `register --status` is read-only and reports missing Skill files,
missing MCP entries, stale installed Skills, and mismatched MCP command paths
before you open the host client.

## Core Commands

| Command | Purpose |
| --- | --- |
| `almanac new <domain>` | Compile an almanac from a domain name. |
| `almanac demo [id]` | Create a no-key offline demo almanac. |
| `almanac list` | List installed almanacs with lifecycle status and readiness hints. |
| `almanac status <id>` | Show whether one installed almanac is usable now and what to do next. |
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
| `almanac register <id>` | Inspect or install Skill and MCP config entries for supported clients. |
| `almanac export <id>` | Package a compiled almanac as a portable archive. |
| `almanac import <archive>` | Validate or install an exported archive into a root. |
| `almanac wiki <id>` | Export a Markdown inspection bundle for review and handoff. |
| `almanac doctor [id]` | Diagnose local runtime, credentials, root hygiene, artifacts, and readiness. |

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

`v0.16.0` is shipped. `v0.17` is in RC validation for Guided First Useful
Almanac. The 12-stage compile pipeline runs end-to-end against
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
- `v0.9`: ask fixture authoring, suite-level ask gates, refresh-integrated ask
  validation, and hardened answer readiness reporting
- `v0.10`: optional answer entailment judging, compile stability diagnostics,
  retrieval readiness reporting, and v0.10 RC smoke coverage
- `v0.11`: source-first install sanity, task-oriented first-run readiness,
  sqlite-demo handoff, and compile failure recovery UX
- `v0.12`: installed almanac lifecycle inventory, per-almanac status, import
  handoff, registration visibility, root hygiene, and cleanup guidance
- `v0.13`: personal maintenance reports, due-only maintenance apply,
  repair/cleanup candidates, scheduler handoff snippets, and ask fixture upkeep
- `v0.14`: guided first-run start, natural-language intake, user-facing
  vocabulary, no-key answer-readiness bootstrap, and local read-only studio
- `v0.15`: activation milestones, guided create apply, suggested questions,
  first-answer guidance, replay prompts, and Studio activation state
- `v0.16`: guided operation metadata, provider-free operation execution,
  answer-readiness evidence save, and Studio Run buttons for bounded actions
- `v0.17`: first-use reports, natural-language setup/source checklist
  guidance, first-answer promotion, abstention recovery, and Studio first-use
  visibility

`v0.16.0` turns guided activation into guided operations: users can list the
safe local work available for an almanac, run provider-free bounded operations
from the CLI or Studio, save answer-readiness evidence, and keep
provider-backed work as explicit CLI handoff.

`v0.17` turns guided operations toward the first useful personal almanac:
empty-root start, natural-language setup planning, source checklist handoff,
first answer promotion, and abstention recovery are surfaced through CLI status
and Studio before users need to learn the artifact model.

See [CHANGELOG.md](./CHANGELOG.md) for the concise release history.

## Benchmarks

Each compiled almanac ships with its own generated benchmark fixtures, executed
end-to-end through the runtime. Latest real-Anthropic smokes at
`--depth=standard`:

| domain | version | facts | tools (custom) | passed | citationRate | negatives passed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Enterprise AI | v0.16.0 RC | 374 | 6 (2) | 15/15 | 1.00 | 5/5 |
| sqlite | v0.3.0 | 620 | 2 | 14/15 | 0.90 | 5/5 |
| Rust | v0.3.10 | 1438 | 3 | 11/15 | 0.60 | 5/5 |

The stable signal across the validation runs is that negative fixtures pass:
out-of-domain or unsupported questions abstain instead of fabricating
citations.

The v0.10.0 Enterprise AI RC smoke also passed a real-provider ask check with a
cited answer, replayed the saved answer artifact deterministically, promoted it
to `tests/ask.jsonl`, passed `ask-suite`, persisted refresh-integrated ask
validation, and recorded an optional judge failure with concrete
unsupported/uncertain claims for review.

The v0.11.0 no-key RC smoke passed source and linked CLI checks, sqlite-demo
first-run handoff, default export/wiki generation, saved answer replay,
`ask-suite`, refresh-integrated ask validation, and mocked compile failure
recovery on `main`.

The v0.12.0 RC smoke passed the installed lifecycle gate on `main`: source and
linked CLI sanity, sqlite-demo lifecycle status, export/import/wiki handoff,
registration visibility with temporary configs, root hygiene checks, dry-run
remove guidance, Enterprise AI fresh compile benchmark at 305 facts and 15/15
fixtures, real-provider Enterprise AI ask with two citations, saved-run replay,
fixture promotion, `ask-suite`, refresh-integrated ask validation, and
doctor/profile reporting answer mode as ready.

The v0.13.0 RC smoke passed the personal maintenance gate on `main`: source and
linked CLI sanity, sqlite-demo provider-free maintenance apply, saved
maintenance evidence, provider-required boundary checks, repair/cleanup
dry-runs, scheduler handoff generation for cron/launchd/GitHub Actions,
Enterprise AI fresh compile benchmark at 407 facts and 15/15 fixtures, valid
real-provider Enterprise AI abstention with saved-run replay pass, and
maintenance dry-run reporting provider-free planned steps.

The v0.14.0 RC smoke passed the first-run guided gate on `main`: source and
linked CLI sanity, provider-free guided start, natural-language planning,
sqlite-demo answer-readiness bootstrap via seeded ask fixtures and
refresh-backed ask-suite evidence, local read-only studio HTML/API and
localhost boundary checks, Enterprise AI fresh compile benchmark at 185 facts
and 15/15 fixtures, real-provider Enterprise AI answer with one citation, and
saved-run replay pass.

The v0.15.0 RC smoke passed the guided activation gate on `main`: static gates,
source and linked CLI sanity, provider-free activation start, deterministic
mock guided create apply, sqlite-demo suggested questions, seeded answer
readiness, mock first-answer guidance, saved answer replay, Studio activation
HTML/API and localhost boundary checks, maintenance dry-run, Enterprise AI
fresh compile benchmark at 138 facts and 15/15 fixtures, valid real-provider
Enterprise AI abstention with quality pass, and saved-run replay pass.

The v0.16.0 RC smoke passed the guided operations gate on `main`: static gates,
source and linked CLI sanity, sqlite-demo provider-free operation listing,
CLI operation runner, answer-readiness evidence save, Studio action API/UI,
localhost and POST safety checks, maintenance dry-run, Enterprise AI fresh
compile benchmark at 374 facts and 15/15 fixtures, valid real-provider
Enterprise AI abstention with quality pass, and saved-run replay pass.

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
- [Sample almanacs](./docs/sample-almanacs.md): committed sqlite-demo wiki
  snapshot, export handoff, and answer-mode sample commands
- [v0.9 plan](./docs/v0.9-plan.md): ask fixture authoring, suite gates,
  refresh validation, and answer readiness hardening
- [v0.9 RC smoke](./docs/v0.9-rc-smoke.md): release-candidate validation for
  ask fixture authoring, ask suites, refresh ask validation, and provider ask
- [v0.10 plan](./docs/v0.10-plan.md): optional entailment judging, compile
  stability controls, retrieval defaults, and release smoke targets
- [v0.10 RC smoke](./docs/v0.10-rc-smoke.md): release-candidate validation for
  entailment judging, compile stability diagnostics, retrieval readiness, and
  ask-suite workflows
- [v0.11 plan](./docs/v0.11-plan.md): source-first install, first successful
  almanac, demo handoff, and compile failure recovery
- [v0.11 RC smoke](./docs/v0.11-rc-smoke.md): release-candidate validation for
  first-run readiness, demo handoff, saved answer replay, and failure recovery
- [v0.12 plan](./docs/v0.12-plan.md): installed almanac lifecycle, inventory,
  status, import handoff, registration visibility, and cleanup
- [v0.12 RC smoke](./docs/v0.12-rc-smoke.md): release-candidate validation for
  installed lifecycle, import handoff, registration visibility, and cleanup
- [v0.13 plan](./docs/v0.13-plan.md): personal almanac maintenance, maintain
  runner, repair/cleanup, scheduler handoff, and answer fixture upkeep
- [v0.13 RC smoke](./docs/v0.13-rc-smoke.md): release-candidate validation for
  provider-free maintenance, scheduler handoff, and Enterprise AI provider
  smoke
- [v0.14 plan](./docs/v0.14-plan.md): first-run guided experience, natural
  language intake, user-facing terminology, answer readiness bootstrap, and
  local read-only studio
- [v0.14 RC smoke](./docs/v0.14-rc-smoke.md): release-candidate validation for
  guided start, no-key answer readiness bootstrap, local studio, and
  Enterprise AI provider smoke
- [v0.15 plan](./docs/v0.15-plan.md): guided activation, explicit create
  apply, first-answer guidance, activation milestones, and Studio activation
  surface
- [v0.15 RC smoke](./docs/v0.15-rc-smoke.md): release-candidate validation
  for guided activation, mock guided create apply, first-answer guidance,
  Studio activation, and Enterprise AI provider smoke
- [v0.16 plan](./docs/v0.16-plan.md): Actionable Studio, guided operations,
  provider-free local action execution, operation result envelopes, and
  evidence persistence simplification
- [v0.16 RC smoke](./docs/v0.16-rc-smoke.md): release-candidate validation for
  guided operation listing, provider-free operation runner, Studio action
  API/UI, evidence save, maintenance dry-run, and Enterprise AI provider smoke
- [v0.17 plan](./docs/v0.17-plan.md): Guided First Useful Almanac, first-use
  reports, natural-language setup guidance, abstention recovery, and first
  answer promotion
- [v0.17 RC smoke](./docs/v0.17-rc-smoke.md): release-candidate validation for
  empty-root first-use guidance, source checklist handoff, first-answer
  promotion, abstention recovery, Studio first-use/recovery visibility, and
  Enterprise AI provider smoke
- [Refresh scheduler](./docs/refresh-scheduler.md): cron, CI, launchd, locks,
  exit codes, and retention
- [Changelog](./CHANGELOG.md): version history

## License

MIT. See [LICENSE](./LICENSE).
