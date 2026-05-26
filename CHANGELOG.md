# Changelog

All notable changes to `almanac` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/) — with the
pre-1.0 latitude that minor bumps may introduce features and patch bumps
may include small additions alongside fixes.

GitHub Release pages carry the long-form prose, motivation, and worked
examples for each version. This file is the concise index.

## [Unreleased]

— nothing yet.

## [0.3.0] — 2026-05-26

### Added

- **v0.3 main thrust — Stage 6 source-mode awareness.** Addresses
  the empirical 80 % ceiling identified in v0.2.6 cross-domain
  validation. In v0.2.6 Stage 6 designed fact-store-reading
  tools on top of `index-only` sources (Stage 4 had not
  snapshotted their bodies), so the runtime calls returned
  empty (`pragma_lookup`, `lookup_std_item`).
  - `ToolManifestSchema` gains `sourceDependencies: string[]`
    (defaults to `[]`). Lists the approved `sources[*].id`
    values a custom tool reads content from.
  - New `parseToolDesignResultWithSources(raw, sources)`
    performs two cross-checks the pure schema cannot:
    (1) every `sourceDependencies[*]` resolves to an approved
    source id; (2) when `knowledgeUsage.facts === true`,
    `sourceDependencies` must contain at least one
    `ingestion.mode === "snapshot"` source. Violations throw
    `ToolDesignSourceValidationError`.
  - Stage 6 prompt v1 → v2. Adds a "Source modes" preamble,
    makes `sourceDependencies` mandatory in the schema block,
    and teaches the model to redesign fact-reading tools as
    live-fetch wrappers when the relevant source is
    `index-only`. Worked examples (kubernetes / cooking /
    crypto) all carry `sourceDependencies` now.
  - Stage 6 runner: `STAGE6_PROMPT_VERSION = "v2"`. Validation
    failures from the new cross-check feed back into the retry
    loop with a `source-mode-validation` reason and a tailored
    feedback message that explicitly points the model at the
    live-fetch redesign path.

### Validated

Cross-domain real-LLM smokes on 2026-05-26 with the v2 prompt
running against fresh `/tmp/almanac-*-v03-smoke` builds:

| domain | passed | citationRate | customTools | failure modes |
|-------:|-------:|-------------:|------------:|:--------------|
| sqlite (v0.2.6) | 12 / 15 | 0.70 | 1 (broken `pragma_lookup`) | structural empty-result + live-web variance |
| sqlite (v0.3.0) | **14 / 15** | **0.90** | 0 (LLM redesigned away) | only live-web variance (`web_search_recent` for "sqlite new pragma") |
| rust   (v0.2.6) | 13 / 15 | 0.80 | 1 (broken `lookup_std_item`) | structural empty-result + live-web variance |
| rust   (v0.3.0) | 13 / 15 | 0.80 | **3 (all correctly designed)** | E0277 corpus gap (Stage 4 silent fetch fail) + live-web variance |

The Rust numbers are flat by count but the failure *modes* are
new: `lookup_std_item` is no longer broken — Stage 6 redesigned
it as `facts:false` + `volatilityClass:"fast"` live-fetch over
`doc-rust-lang-org-std`, exactly the path the v2 prompt teaches.
The remaining 2 failures are inherent (live-web variance, Stage
4 silent fetch fail of `gh-rust-lang-rust-releases` losing E0277
content) — neither is a Stage 6 issue. The sqlite +2 / +0.20
lift is the same effect from the opposite direction: the LLM
correctly returned `customTools: []` because no design honored
the new invariants for that source mix.

## [0.2.6] — 2026-05-25

### Added

- `IntentKindSchema` gains `debug` as a seventh value. Covers
  diagnostic / troubleshooting queries (compiler errors, stack
  traces, symptom → root-cause mapping). Stage 1 and Stage 11
  prompts updated to reference the new value; the Stage 1
  worked example moves the CrashLoopBackOff query into `debug`
  and gives `explain` a cleaner conceptual example.
- `INTENT_LENIENT_REMAP` + `normalizeStage11Output` —
  pre-schema remap of common LLM intent typos
  (`diagnose-error`, `diagnose`, `troubleshoot`,
  `troubleshooting`) onto canonical `debug`. Same pattern as
  `FACT_TYPE_LENIENT_REMAP`. Added because the Rust smoke
  proved that simply listing `debug` in the prompt schema does
  not override the model's strong `diagnose-error` naming prior
  — the retry still fires on attempt 1. Remap absorbs the
  variance at the parse boundary, saving the retry's ~$0.05 and
  ~20s.

### Fixed

- `normalizeExtractionResult` now truncates
  `coverage.extractable` and `coverage.nonExtractable` to the
  300-char schema cap, alongside the existing `fact.excerpt`
  truncation. First observed on `blog-rust-lang-org` during the
  v0.2.5 Rust smoke, which dropped one otherwise-fine chunk on
  `nonExtractable` overflow.

## [0.2.5] — 2026-05-25

### Changed

- Stage 11 prompt v2 → v3. Two prompt-induced failure modes
  surfaced by the v0.2.4 sqlite smoke are addressed:
  - **Worked-example leakage.** The v2 prompt's inline mini-
    example used sqlite-flavored vocabulary (`"FTS5 external
    content"`). When Stage 11 actually ran on the sqlite domain,
    the LLM copied that phrase as a query even though the
    corpus did not contain it. v3 uses kubernetes-flavored
    tokens uniformly (matching the canonical example) and adds
    an explicit CRITICAL section warning the LLM not to import
    example tokens into its output.
  - **`expected.contains` against `entities`.** v2 said
    `contains` substrings should come from "fact text" loosely;
    the LLM picked the kebab-cased `entities` value
    (`"virtual-table"`) instead of the natural-prose form
    (`"virtual tables"`), and the substring check failed
    against the data. v3 documents the rule explicitly:
    `contains` is matched against the **`text`** field, never
    against `entities`; the matcher is case-insensitive but
    does NOT normalize hyphens, whitespace, or punctuation.

## [0.2.4] — 2026-05-25

### Changed

- `STAGE11_DEFAULT_FACT_SAMPLE_SIZE` raised from 20 → 60. The
  earlier 3 % surface (20 of ~620 facts on the sqlite corpus)
  systematically hid secondary terminology (`vdbe`,
  `wal transaction`, `jsonb`, `sqlean`) from the benchmark
  author, so Stage 11 invented queries that no fact could match.
  At 10 % surface the LLM anchors fixture queries to real corpus
  vocabulary. Sqlite smoke moved 9/15 → 10/15 (citationRate
  0.4 → 0.6) with Stage 11 LLM cost +0 (same single call) and
  prompt token cost +~2 KB.

## [0.2.3] — 2026-05-25

### Fixed

- Stage 12 `expected.contains` substring match is now case-
  insensitive. Fact corpora often preserve original casing (e.g.
  "FTS5") while LLM-authored fixtures default to lowercase per the
  Stage 11 prompt; the case mismatch caused otherwise-correct
  matches to register as false-negative failures. Observed on the
  sqlite smoke (`q: "fts5"` hit the fact "FTS5 external content
  tables..." but `contains: ["fts5"]` did not). Score moved 8/15 →
  9/15 with no other changes.

## [0.2.2] — 2026-05-25

### Added

- `almanac register --client=codex` — TOML config support via
  `smol-toml`. Writes `[mcp_servers.almanac-<id>]` tables to
  `~/.codex/config.toml`. Closes the design.md §3 register triad —
  all four downstream clients (claude-code, claude-desktop, cursor,
  codex) are now supported.

### Changed

- `src/manage/mcp-config.ts` — new module factoring out the JSON +
  TOML MCP-config IO (`parseMcpConfig`, `serializeMcpConfig`,
  `writeMcpConfigAtomic`) shared by `register` and `remove`.
- `CLIENT_PROFILES` carries `format` and `mcpServersKey` per client
  so register / remove dispatch on those rather than hard-coding
  JSON + `mcpServers`.

## [0.2.1] — 2026-05-25

### Added

- `almanac export <id>` — package a compiled almanac as a portable
  `.tar.gz`. Pairs with `feed` to complete the build → grow → share
  lifecycle. Excludes `.compile/` by default; opt in with
  `--include-compile`. Uses the system `tar` binary via `Bun.spawn`.

## [0.2.0] — 2026-05-25

### Added

- `almanac feed <id> <url>` — incrementally add one source to a
  compiled almanac without re-running the LLM-heavy upstream stages.
  Smart defaults (`kind=docs`, `trust=0.85`, `mode=snapshot`),
  dry-run by default, idempotent against duplicate URLs.

### Fixed

- Stage 7 prompt: `KnowledgeReader` API mismatch — taught the wrong
  method (`ctx.knowledge.search`) instead of the real one
  (`ctx.knowledge.searchFacts`). LLM-generated tools crashed at
  runtime. Both the interface block and the worked example are
  corrected. Existing almanacs need a Stage 7 rerun to pick up.
- `fetch_official_docs.capabilities.network` is now populated from
  the approved sources' hostnames. Previously empty, so the runtime's
  allowlisted fetch rejected every URL.
- `sanitizeFtsQuery` splits hyphens (`full-text` → `full + text`)
  instead of stripping them. The stripped variant produced tokens
  the FTS5 indexer never stored. Implicit AND semantics kept after
  briefly trying OR — OR over-matched and broke negative-fixture
  expectations.

## [0.1.1] — 2026-05-25

### Fixed

- Stage 2x URL prober: `finalUrl` is now omitted when a redirect
  chain ends at a 4xx/5xx (schema invariant: `finalUrl` set iff
  `fetchStatus === "redirect"`).
- Stage 2x GitHub searcher: clamps `description` to the 500-char
  `CandidateSchema.snippet` cap at the trust boundary.
- Stage 2b: `parseDraftSourcesFile` recomputes
  `generatedBy.acceptedCount` and `coverage[kind]` from `sources[]`
  before schema validation. LLMs miscount; counting is mechanical.
- Stage 4 fetcher routing: `GithubRepoFetcher.canHandle` now accepts
  both `index-only` AND `snapshot` modes (gracefully degrades the
  latter to index-only metadata in v0.1; full repo snapshot landed
  in fe628b6). New `HttpIndexOnlyFetcher` handles any non-repo
  HTTP source with `mode: index-only`.
- Stage 7 prompt: numbered hard requirement that generated tools
  must check `ctx.knowledge` / `ctx.fetch` for `undefined` and
  return a typed error envelope rather than crash. `sourceTimestamp`
  must be strict ISO 8601.
- Stage 7 runner: garbage-collects stale `tools/<name>.{json,ts,test.ts}`
  triplets left over from a prior run whose custom-tool set differed.
- Stage 11 prompt: `intent` enum aligned with the canonical
  `IntentKindSchema` (`lookup|howto|compare|calc|explain|track`).
- Stage 5 parser: lenient remap of common LLM type mistakes
  (`pattern → framework`, `antipattern → tradeoff`, etc.) and
  truncation of over-300-char excerpts before schema validation.

## [0.1.0] — 2026-05-25

### Added

- Initial release of `almanac` — a meta-generator that compiles a
  per-domain knowledge surface from a single domain name and serves
  it through MCP plus a Claude Code Skill.
- 12-stage compile pipeline (bootstrap → domain analysis → 2a/2x/2b
  source discovery → approve → fetch → fact extraction → tool design
  → LLM tool implementation → knowledge index → contract files →
  SKILL.md → benchmark gen → benchmark run).
- Stage 7 LLM implementer with the `generate → write → tsc → bun test
  → retry` loop. Template-only path covers the four default tools;
  LLM-driven path covers domain-specific custom tools.
- GitHub repo snapshot fetcher: walks the Trees API, filters file
  paths against `ingestion.scope` globs, mirrors matching files to
  `sources/raw/`. Capped at 50 files / 10 MiB per repo.
- Knowledge index via `bun:sqlite` + FTS5 over `extracted/facts.jsonl`
  with freshness columns.
- MCP server (`almanac serve <id>`, stdio transport) with
  capability-gated `ToolContext` (knowledge / fetch / secrets / log)
  and `ToolResult` envelope validation at the runtime boundary.
- `almanac new` / `update --from-stage` / `list` / `inspect` / `path` /
  `serve` / `register` / `remove`.
- `register --client` for `claude-code`, `claude-desktop`, `cursor`.
- GitHub Actions CI (typecheck + bun test on ubuntu-latest).
- MIT license.

[Unreleased]: https://github.com/kyaukyuai/almanac/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/kyaukyuai/almanac/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/kyaukyuai/almanac/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/kyaukyuai/almanac/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/kyaukyuai/almanac/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/kyaukyuai/almanac/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/kyaukyuai/almanac/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kyaukyuai/almanac/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kyaukyuai/almanac/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kyaukyuai/almanac/releases/tag/v0.1.0
