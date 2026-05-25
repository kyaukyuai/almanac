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

[Unreleased]: https://github.com/kyaukyuai/almanac/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/kyaukyuai/almanac/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/kyaukyuai/almanac/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kyaukyuai/almanac/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kyaukyuai/almanac/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kyaukyuai/almanac/releases/tag/v0.1.0
