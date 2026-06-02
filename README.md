# almanac

> **Compile a domain almanac. Always-fresh. As CLI, MCP, and Skill.**

`almanac` is a meta-generator that turns a single domain name into a
self-contained, always-fresh knowledge surface — exposed simultaneously as a
**CLI**, an **MCP server**, and a **Claude Code Skill**.

```bash
almanac new cooking
# → ~/.almanac/almanacs/cooking/ is compiled (tools/, knowledge/, contract files)
# → MCP:  almanac serve cooking     # stdio MCP server for host LLMs
#         almanac serve cooking --transport=http --port=7331  # Streamable HTTP/SSE
# → Skill: almanac register cooking --client=claude-code   # installs SKILL.md + MCP entry
```

Want to see the product without API keys first:

```bash
tmp=$(mktemp -d)
almanac demo --root "$tmp"
almanac inspect sqlite-demo --root "$tmp"
almanac profile sqlite-demo --root "$tmp"
almanac sources sqlite-demo --root "$tmp"
almanac benchmark sqlite-demo --root "$tmp"
almanac doctor sqlite-demo --root "$tmp"
almanac run sqlite-demo --tool query_facts --input '{"q":"transactions atomic"}' --root "$tmp"
almanac runs sqlite-demo --root "$tmp"
almanac wiki sqlite-demo --root "$tmp" --output "$tmp/sqlite-demo-wiki"
```

The demo creates a complete offline almanac with curated SQLite facts, source
review metadata, default tools, contract files, a Skill adapter, and human
golden benchmark fixtures.

End-user conversational use still happens through the host LLM (Claude Code,
Cursor, Claude Desktop, …) after `register`. The `almanac` CLI also includes a
deterministic `run --tool` path so users and CI can validate compiled tools
locally without standing up an MCP client.
For release gates and local evaluation, `almanac ask` provides an optional
one-shot answer path over the same compiled tools. Unlike `run --tool`, it is
LLM-backed and requires `ANTHROPIC_API_KEY` unless `ALMANAC_LLM=mock` is used
for smoke tests.

An almanac has **no persona**. It is a domain-specialized retrieval-and-tools
layer that returns sourced, freshness-aware answers. Every fact carries a
`fetchedAt`, every topic is classified by volatility (static / slow / fast /
live), and stale data is surfaced rather than masked.

## Design pillars

1. **Headless runtime + adapters** — one operation contract (`listTools` /
   `execTool` / `listResources` / `readResource`) is the source of truth;
   the MCP server and the Claude Code Skill are derived from it. A single
   generic `almanac serve` binary serves any compiled almanac.
2. **Always fresh** — every artifact knows its volatility class and TTL.
   `update` is a first-class command, not an afterthought. Inspired by
   [`last30days-skill`](https://github.com/mvanhorn/last30days-skill).
3. **Cite or abstain** — every tool returns `citations[]`. No grounded source,
   no answer.
4. **Compile, don't configure** — the only required input is the domain name.
   Source discovery, tool design, and code generation are automated; humans
   review the draft and approve.

See [`docs/design.md`](./docs/design.md) for the full technical specification.

## Status

**v0.7.0 shipped.** The 12-stage compile pipeline (bootstrap → domain analysis
→ source discovery → fact extraction → tool design + implementation →
knowledge index → contract files → SKILL.md → benchmark) runs end-to-end
against both mocked and real Anthropic LLMs. The runtime (`almanac serve`) is
wired into the MCP ecosystem; `register` configures Claude Code / Claude
Desktop / Cursor / Codex.

v0.5.0 adds run-first operations for local validation and auditability:
`almanac run --tool` invokes compiled tools directly, `almanac run --save`
persists `.runs/run-*.json` audit artifacts with label/note metadata, and
`almanac runs` lists, filters, reads, and prunes those artifacts. `almanac
export` keeps `.runs/` out of portable bundles by default and includes it only
with `--include-runs`.

v0.6.0 ships the refresh automation line: `refresh due` reports deterministic
refresh decisions without writes, `refresh run` executes a manual locked
refresh over the update pipeline, and `.runs/` now has a typed envelope for
both tool artifacts and refresh artifacts. `inspect`, `profile`, and `doctor`
surface the latest saved refresh run so operators can see failed or locked
refresh attempts without opening the JSON artifact by hand. See
[`docs/refresh-scheduler.md`](./docs/refresh-scheduler.md) for the cron, CI,
and launchd contract.

v0.7.0 ships an optional LLM-backed `almanac ask` mode: a one-shot answer
orchestration boundary over compiled tools, with strict cited-answer or
abstain behavior and optional saved answer artifacts under `.runs/`. See
[`docs/v0.7-plan.md`](./docs/v0.7-plan.md).

v0.8 is planned as answer quality and diagnostics: structured answer traces,
deterministic ask replay fixtures, answer-mode quality gates over replayed
answers, and doctor/profile readiness for answer sessions. See
[`docs/v0.8-plan.md`](./docs/v0.8-plan.md). The answer-mode operator contract
is documented in [`docs/answer-mode.md`](./docs/answer-mode.md), and the
release-candidate smoke sequence lives in
[`docs/v0.8-rc-smoke.md`](./docs/v0.8-rc-smoke.md).

v0.4.0 adds measurable comparison coverage, approved-source reuse, optional
embedding/vector artifacts, hybrid RRF retrieval, Streamable HTTP/SSE MCP
transport, and `almanac wiki` inspection exports. The release also includes the
late-v0.3 and v0.4 product hardening work: `almanac profile`, community source
discovery, `feed --replace`, PDF text extraction, and source/benchmark
hardening from the Kubernetes operators smoke runs.

v0.4.1 adds a generated benchmark coverage floor
(8 positive / 5 negative / 13 total fixtures), Stage 11 retry behavior when
preflight filtering would fall below that floor, a longer default Anthropic
request timeout for large source-candidate evaluations, and deterministic
rejection of known zero-fact landing-page sources.

v0.4.2 patches `almanac wiki` artifact metadata so `artifacts.json.files`
includes `artifacts.json` itself with a byte length that matches the file
written to disk.

The v0.3 series closed eight structural failure classes that surfaced
in the v0.2.5 cross-domain validation — see `docs/design.md §8.5`
for the per-release breakdown.

### Cross-domain benchmark

Each almanac is shipped with its own LLM-authored benchmark set
(Stage 11) executed end-to-end through the runtime (Stage 12). Latest
real-Anthropic smokes at `--depth=standard`:

| domain | version | facts | tools (custom) | passed | citationRate | negatives passed |
|-------:|--------:|------:|---------------:|-------:|-------------:|-----------------:|
| Enterprise AI | main |   387 |              2 |  17/17 |         1.00 |              6/6 |
| sqlite |  v0.3.0 |   620 |              2 |  14/15 |         0.90 |              5/5 |
| Rust   | v0.3.10 |  1438 |              3 |  11/15 |         0.60 |              5/5 |

The Enterprise AI smoke was run on 2026-05-30 against main with
`--profile mixed --depth standard`. It produced 387 facts from 7 evidence
sources, 6 tools total, generated 11 positive and 6 negative fixtures, and
passed Stage 12 with 100% citation rate.

Rust's pass count fluctuates ±2 across v0.3.x runs due to Stage 2
source-discovery non-determinism (different source sets pick up
different fixture topics). The signal that *is* stable across all
six recent Rust smokes: **all 5 negative fixtures pass.** The
spurious-citation hallucinations that v0.2.x suffered from are
structurally closed.

### Capabilities

- **`almanac new <domain>`** — one-shot compile from a domain name.
- **`almanac demo [id]`** — create a complete offline sample almanac with no
  API keys required.
- **`almanac feed <id> <url>`** — incrementally add one source to a
  compiled almanac without re-running the LLM-heavy upstream stages.
  Fetches, extracts, and reindexes in place.
- **`almanac update <id> --from-stage=NN`** — rewind to any stage and
  re-run the rest. Stage 7 GCs stale tool files from prior runs.
- **`almanac sources <id>`** — review accepted/rejected sources, trust
  scores, ingestion modes, and coverage by kind.
- **`almanac profile <id>`** — summarize expertise readiness, evidence
  coverage, supported query shapes, benchmark status, and declared limits.
- **`almanac benchmark <id> --init` / `almanac benchmark <id>`** — create
  editable human golden JSONL fixtures, then run them through the runtime.
- **`almanac run <id> --tool <name>`** — invoke one compiled tool locally with
  JSON input, human or JSON output, and citation visibility. Use
  `--list-tools` to inspect enabled tools and `--save` to persist an audit
  artifact.
- **`almanac ask <id> <question>`** — run a one-shot LLM-backed answer session
  over enabled compiled tools. The planner can only invoke
  `AlmanacRuntime.execTool`; synthesis must cite observed tool citations or
  abstain. Requires `ANTHROPIC_API_KEY` for real runs, supports `--json`,
  `--model`, and explicit `--save` answer artifacts.
- **`almanac ask-replay <id>`** — replay saved answer artifacts or JSONL answer
  fixtures without an LLM provider. Use `--from-runs` with an optional
  `--label`, or `--fixture <path>` for deterministic CI checks.
- **`almanac runs <id>`** — list, inspect, filter, and prune saved
  `.runs/run-*.json` tool artifacts, `.runs/refresh-*.json` refresh artifacts,
  and `.runs/answer-*.json` answer artifacts. Use `--kind tool`,
  `--kind refresh`, or `--kind answer` to narrow history. Cleanup is dry-run by
  default and requires `--apply` to delete files.
- **`almanac refresh due <id>`** — read-only refresh planning for CI/cron:
  reports expired sources, failed/pending stages, missing benchmark reports,
  and the recommended `--from-stage` without writing files or requiring
  provider keys.
- **`almanac refresh run <id>`** — execute the refresh recommendation or an
  explicit `--from-stage`, with per-almanac lock protection. Use `--save` with
  `--label`/`--note` to persist a `.runs/refresh-*.json` audit artifact.
  Scheduler integration guidance lives in
  [`docs/refresh-scheduler.md`](./docs/refresh-scheduler.md).
- **`almanac doctor [id]`** — check local runtime, environment keys, artifact
  health, source coverage, benchmark status, and latest saved refresh run
  status.
- **`almanac export <id>`** — package a compiled almanac as a
  portable `.tar.gz` archive (≈190 KiB for a 231-fact almanac).
  Unpack anywhere; `almanac serve` works immediately. Stage scratch
  `.compile/` and saved run audit records `.runs/` are excluded by default;
  use `--include-compile` or `--include-runs` when intentionally handing off
  those artifacts.
- **`almanac wiki <id>`** — write a Markdown inspection bundle
  (`README.md`, `sources.md`, `facts.md`, `tools.md`, `benchmark.md`)
  for review, handoff, and debugging.
- **`almanac list / inspect / path / remove`** — basic management.
- **`almanac serve <id>`** — MCP server exposing the four
  default tools (`query_facts`, `fetch_official_docs`,
  `web_search_recent`, `latest_releases`) plus 0–3 domain-specific
  tools generated by the Stage 7 LLM implementer. Defaults to stdio;
  `--transport=http` starts a Streamable HTTP/SSE endpoint at `/mcp`.
- **`almanac register <id> --client=<name>`** for `claude-code`,
  `claude-desktop`, `cursor`, and `codex` (TOML config support via
  [`smol-toml`](https://github.com/squirrelchat/smol-toml)).
- **GitHub repo snapshot** mirrors `ingestion.scope`-matched files
  from permissively-licensed repos into `sources/raw/`. Path-desc
  sort favors newer numeric-prefixed paths (v0.3.3 — newest RFCs
  / KEPs / SLEPs land in the corpus instead of the oldest).
- **Stage 7 static validator** (v0.3.4 + v0.3.6 + v0.3.9) rejects
  three classes of LLM-generated implementer code before they ship:
  hardcoded URL fallback arrays, test mocks that don't reference
  any documented `sampleUrl`, and impls that fetch hosts outside
  `capabilities.network`.
- **`ToolManifest.sampleUrls`** (v0.3.6 + v0.3.7) — Stage 6
  populates real documented URLs (including anchor-fragment URLs
  for tools accepting qualified names like `Arc::clone`). Stage 7's
  generated smoke must mock at least one. Closes the
  wrong-URL-template-paired-with-wrong-mock failure class
  end-to-end.
- **GitHub Actions CI** runs typecheck + the full test suite on
  every push and PR.

### v0.3 — shipped (2026-05-26..27)

Eleven point releases (v0.3.0 through v0.3.10) closed the following
structural failure classes empirically validated across Rust smokes:

1. Stage 4 silent fetch failures (v0.3.1, v0.3.2)
2. Stage 4 github snapshot path-asc bias toward oldest files
   (v0.3.3)
3. Stage 7 hardcoded URL fallback array hallucination (v0.3.4)
4. Stage 11 fixture error-code vocab mismatch (v0.3.5)
5. Stage 7 wrong URL template for bare item names (v0.3.6)
6. Stage 7 wrong URL template for qualified names like
   `Arc::clone` (v0.3.7)
7. Stage 11 `contains` substring-guessing for live-fetch tools
   (v0.3.8)
8. Stage 7 fetching hosts outside `capabilities.network` (v0.3.9)
9. Stage 5 atomic-only extraction missing X-vs-Y tradeoff facts
   (v0.3.10 — corpus tradeoff density 6.1%)

The original v0.3 architectural thrusts (vector retrieval, HTTP
transport, wiki export) shipped in v0.4 after the structural fixes
that the v0.2.5 smokes empirically motivated.

### v0.4 — shipped (2026-05-29)

- Stage 11 tradeoff-aware fixture generation for comparison-shaped coverage.
- Approved-source reuse to reduce source-discovery drift across reruns.
- Embedding provider abstraction with deterministic, Voyage, OpenAI, and local
  configuration paths.
- Optional vector index artifacts plus hybrid FTS5/vector RRF retrieval.
- Streamable HTTP/SSE MCP transport for browser and network MCP clients.
- `almanac wiki` Markdown inspection export for review and handoff.

### v0.5 — shipped (2026-06-01)

- Deterministic local `almanac run --tool` invocation over the same runtime
  contract used by MCP.
- Optional saved `.runs/` audit artifacts with label and note metadata.
- `almanac runs` viewer with JSON output, status/label/latest/limit filters,
  detail reads, and retention cleanup.
- `almanac export --include-runs`, with `.runs/` excluded by default.
- Release smoke covering typecheck, the full test suite, offline demo,
  run/runs workflows, wiki self-entry, and export inclusion/exclusion.

Question-mode orchestration and a hosted refresh daemon remain future work;
v0.5 keeps the local run path deterministic and LLM-free. See
[`docs/design.md §8`](./docs/design.md) for the worked release summary and
[`docs/v0.5-plan.md`](./docs/v0.5-plan.md) for the shipped implementation
sequence. The v0.6 refresh scheduling readiness sequence is archived in
[`docs/v0.6-plan.md`](./docs/v0.6-plan.md), and the v0.4 implementation
sequence remains in
[`docs/v0.4-plan.md`](./docs/v0.4-plan.md).

### v0.6 — shipped (2026-06-01)

- Read-only `almanac refresh due` planning from source freshness, compile
  state, benchmark state, and latest refresh artifacts.
- Manual `almanac refresh run` over the update pipeline with explicit
  `--from-stage`, per-almanac locking, stable exit codes, and optional saved
  refresh artifacts.
- Typed `.runs/` operational artifact envelope for both tool and refresh runs,
  with kind-aware listing, filtering, detail reads, and retention cleanup.
- `inspect`, `profile`, and `doctor` visibility for latest refresh status,
  failed/locked readiness issues, and benchmark result.
- Scheduler contract docs for cron, CI, and launchd, plus export/retention
  hardening so refresh artifacts remain private unless `--include-runs` is
  explicitly requested.

### v0.7 — shipped (2026-06-01)

- One-shot `almanac ask` answer orchestration over compiled tools.
- LLM-backed tool selection with explicit call and duration budgets.
- Final cite-or-abstain gate requiring citations returned by observed tool
  results.
- Optional saved answer artifacts under `.runs/`, with kind-aware listing,
  retention, and explicit export inclusion.
- Release smoke covers grounded answers, abstention, saved answer artifacts,
  `runs --kind answer`, answer retention, and export inclusion/exclusion.

### v0.8 — planned

- Structured planner/tool/citation/abstain traces for saved answer artifacts.
- Improved `almanac runs <id> <answer-id>` detail output for answer debugging.
- Deterministic ask replay from saved answer runs or fixture JSONL.
- Ask-mode quality gates for citation rate, unsupported claims, stale citation
  handling, and expected abstention behavior in live traces and replay reports.
- `doctor` and `profile` answer readiness signals for fixture coverage, latest
  saved answer status, and latest quality gate verdict.
- Answer-mode docs and an RC smoke runbook for sqlite-demo, Enterprise AI,
  real-provider ask, and saved-answer replay.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a concise version history.
The [GitHub Releases](https://github.com/kyaukyuai/almanac/releases)
page carries the long-form motivation and worked examples for each
version.

For product-oriented setup, source review, benchmark fixture editing, and
example CLI output, see [docs/product-guide.md](./docs/product-guide.md).

## License

MIT — see [LICENSE](./LICENSE).
