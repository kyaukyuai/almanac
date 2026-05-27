# Changelog

All notable changes to `almanac` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/) — with the
pre-1.0 latitude that minor bumps may introduce features and patch bumps
may include small additions alongside fixes.

GitHub Release pages carry the long-form prose, motivation, and worked
examples for each version. This file is the concise index.

## [Unreleased]

### Fixed

- **CLI version now derives from `package.json`.** `almanac --version` and
  MCP server metadata no longer drift from the package release version.
- **`createAlmanacRuntime()` now delegates to the concrete runtime.** The
  public core factory no longer exposes the old skeleton-only throw path.
- **Legacy artifact counts render from actual artifacts.** `almanac list`
  and `almanac inspect` now prefer `knowledge/index-manifest.json` and
  implemented tool pairs when old manifests still report `0 / 0`, while
  showing the stale manifest counts explicitly.
- **Local `.antigravitycli/` metadata is ignored.**

## [0.3.10] — 2026-05-27

### Changed

- **Stage 5 prompt v1 — actively extract `tradeoff` facts from
  X-vs-Y patterns.** Adds explicit guidance on what to scan for
  (side-by-side comparison sections, "prefer X over Y when …",
  RFC Alternatives sections, `X vs Y` headings) and requires that
  the `entities` array list both sides so comparison tools at the
  fact-store can find paired material. Also notes that
  `fast-live-dominant` chunks may hide stable X-vs-Y claims —
  extract those rather than skipping the whole chunk.

### Why

The v0.3.9 Rust smoke had `compare_async_runtimes('tokio',
'async-std')` return `no-results`. The Rust corpus has tons of
async-runtime comparison content in RFCs, blog posts, and the
async-book — but Stage 5 atomizes content into single-side claims,
so a query for "tokio vs async-std" finds individual statements
about each but no paired comparison. Teaching Stage 5 to recognize
and capture the comparison as a single `tradeoff` fact closes the
loop for downstream comparison tools.

## [0.3.9] — 2026-05-27

### Added

- **Stage 7 static validator rule #3 — `detectUnallowedHostInImpl`.**
  Scans the generated impl for `http(s)://HOST/...` string literals
  and rejects when any literal `HOST` is not in
  `manifest.capabilities.network`. The host is checked even when the
  *path* is template-interpolated (the v0.3.8 empirical case had
  `https://github.com/rust-lang/rust/releases/tag/${ver}` — literal
  host, templated path). Skipped when the *host* itself is interpolated
  (`https://${host}/...`) or when allowedHosts is empty (back-compat).
- Stage 7 prompt v1 hard requirement #10 — "only fetch hosts in
  capabilities.network. Note exact-match: `github.com` and
  `api.github.com` are distinct."

### Why

The v0.3.8 Rust smoke had `version_changelog` fetch
`https://github.com/rust-lang/rust/releases/tag/...` while
`manifest.capabilities.network = ["api.github.com",
"raw.githubusercontent.com"]`. The runtime correctly threw
`NetworkNotAllowedError`. The smoke mock had no allowlist
restriction, so the unit test passed; the runtime call failed.
Static analysis on `:Stage 7 impl source catches this before ship.

Cross-version empirical scan: 16 historical custom tools (sqlite +
rust × multiple versions). 15 pass clean, 1 flagged — exactly the
v0.3.8 `version_changelog`. **0 false positives.**

## [0.3.8] — 2026-05-27

### Changed

- **Stage 11 prompt v3 — `contains` rules split by tool class.** The
  existing `factSample[i].text` guidance now applies explicitly to
  `query_facts` / fact-store-reading tools only. A new section for
  custom tools that fetch live recommends
  `expectedShape: "match-outputSchema"` as the default, and lists the
  three reliable anchors when `contains` is unavoidable: substring of
  any `sampleUrl`, an outputSchema field name the impl always
  populates, or the full input identifier (with a caveat that impls
  may normalize/split it). Documents the two v0.3.7 failure modes
  (`contains: ["Residual"]` for `Option::Residual`, `contains:
  ["race"]` for thread-local-race) as anti-patterns.

## [0.3.7] — 2026-05-27

### Changed

- **Stage 6 prompt v3 — anchor-fragment `sampleUrls` for tools that
  accept qualified names.** When the tool's `inputSchema` accepts
  qualified identifiers like `X::Y` (e.g., `Arc::clone`), Stage 6 must
  include at least one sampleUrl with the canonical anchor fragment
  (`...struct.Arc.html#method.clone`). Teaches the impl that qualified
  inputs route to the type's page plus a documented anchor rather than
  fabricating a sub-path. Motivated by the v0.3.6 Rust smoke's
  `rust-pos-arc-signature` failure where `lookup_std_item('Arc::clone')`
  built `/std/Arc/fn.clone.html` (wrong) instead of using
  `#method.clone` on the struct page.

## [0.3.6] — 2026-05-27

### Added

- **`ToolManifest.sampleUrls`** — optional 0–5 array of real
  documented URLs the tool will plausibly fetch. Defaults to `[]`
  (back-compatible). Schema rule: must be empty when
  `capabilities.network` is empty (the tool can't fetch).
- **Stage 6 prompt v3 hard requirement #7** — when a custom tool has
  network capability, populate `sampleUrls` with 1–3 verifiable real
  URLs from public documentation. Explicit "do not invent URL
  patterns you are unsure exist" guidance.
- **Stage 7 prompt v1 contract #6** — when `manifest.sampleUrls` is
  non-empty, the generated smoke MUST mock `ctx.fetch` to return 200
  for at least one `sampleUrl`, and at least one example input must
  drive the impl to fetch that URL. Includes a concrete `mkCtx`
  example.
- **Stage 7 static validator rule #2** — `requireSampleUrlInTestCode`
  checks that the generated test source references at least one
  `sampleUrl` substring. If not, surfaces as `validator-failed` and
  retries. Skipped when `sampleUrls.length === 0` (back-compat with
  legacy / knowledge-only tools).

### Why

The v0.3.4 (`std::sync::Arc`) and v0.3.5 (`Iterator::map`) Rust
smokes both surfaced the same class of failure: the LLM-generated
`lookup_std_item` impl built the wrong URL pattern AND wrote a test
mock against that wrong pattern, so smoke passed by self-consistency
but the real upstream returned 404. v0.3.4's static validator only
catches hardcoded URL arrays — this class slipped through.

Ground-truth `sampleUrls` from Stage 6 anchor the smoke against
documented reality. If the impl confabulates a URL the test mock
doesn't recognize, the smoke fails — exactly the discrimination that
was missing. Stage 6 carries the URL knowledge (LLM training data on
canonical doc patterns); Stage 7 enforces it.

## [0.3.5] — 2026-05-26

### Changed

- **Stage 11 prompt v3 — canonical error-code taxonomy.** The
  benchmark-gen prompt now lists the exact `error.code` strings that
  Stage 7 tools actually emit (`bad-input`, `not-found`, `no-results`,
  `no-source`, `bad-response`, `network-not-allowed`,
  `capability-missing`, `knowledge-missing`, `timeout`, `rate-limited`)
  and explicitly forbids near-synonyms like `invalid-input` /
  `input-error` / `missing-input`. The `expectedErrorCode` field type
  hint in the JSON schema example changes from
  `"kebab-or-snake-case"` to `"canonical-code"` with a pointer to
  the list. Motivated by the v0.3.4 Rust smoke's
  `rust-neg-future-edition-2027` failure, where the LLM-generated
  fixture asked for `expectedErrorCode: "invalid-input"` while the
  Stage 7 `edition_diff` impl correctly returned the canonical
  `"bad-input"`, causing a 1-fixture string-compare miss.

## [0.3.4] — 2026-05-26

### Added

- **Stage 7 static validator — catches hallucinated URL fallback lists.**
  After `tsc` and before `bun test`, the LlmImplementer now runs
  `validateGeneratedTool({ code, testCode })`. The first rule flags
  implementations that contain two or more adjacent hardcoded
  `https?://...` string literals (template-interpolated URLs do not
  count). Such "fallback arrays" pass the generated smoke test —
  because the mock fetch resolves every URL the same way — but at
  runtime the fallback URLs are real, always-200 pages, so the tool
  silently returns those pages' contents for any input.
- A new `ImplementationOutcome` variant `validator-failed` propagates
  the static-check diagnostics back to the next `generate` call,
  same retry mechanism as `tsc-failed` / `smoke-failed`.
- Stage 7 prompt v1 gains hard requirement #9 ("no hardcoded URL
  fallback lists") and a `validator-failed` entry in the Retry
  feedback section, so the LLM avoids the pattern on the first
  attempt where possible.

### Why

The v0.3.2 Rust smoke had `rust-neg-nonexistent-trait` returning 1
spurious citation (expected 0). Reading
`/tmp/almanac-rust-v032-smoke/rust/tools/lookup_std_item.ts` showed
the LLM-generated impl carried a literal array of 5 `doc.rust-lang.org`
URLs as fallbacks: `https://.../std/${itemPath}`, then four hardcoded
pages (Vec, Iterator, Arc, println). The smoke test's mock fetch
returned the same canned HTML for any URL, so all 5 candidates
resolved equally and the smoke passed. At runtime, the first URL
404s for "Frobnicator" and the next URL (`.../std/vec/struct.Vec.html`)
is a real 200, so the tool returned Vec's docs as the answer to
`lookup_std_item({ item: "Frobnicator" })`.

This is one of the three v0.3.2 follow-ups; the other two (`Stage 5
chunk-skip policy`, `Stage 11 negative fixtures`) were misdiagnoses
of the same underlying class — Stage 7 implementer hallucination
passing smoke because the smoke mock is too forgiving. The validator
is the first structural countermeasure. The `version_diff` "no
release notes" failure (wrong upstream URL template) is a different
pattern not yet covered; future rules can land in
`src/compile/stages/s07/static-validator.ts` without rewiring the
LlmImplementer.

## [0.3.3] — 2026-05-26

### Changed

- **`GithubRepoFetcher` snapshot sorts matched paths descending
  before `slice(0, SNAPSHOT_MAX_FILES=50)`.** GitHub's tree API
  returns paths in ascending order. For repos with numeric-prefixed
  paths the alphabetical slice took the *oldest* 50 files and
  silently excluded everything modern.
- One new test pins the behavior: a 70-entry numeric-prefixed
  tree yields exactly RFC numbers 0021..0070 in the snapshot, with
  `text/0001-rfc.md` excluded.

### Why

Diagnosed while investigating why `rfc_lookup("async await")` returned
0 results in the Rust v0.3.2 smoke even though `gh-rust-lang-rfcs`
snapshotted successfully with 50 docs and Stage 5 extracted 895 facts
across them. The 50 docs were `text/0001-...` through `text/0168-...`
— the *oldest* RFCs from 2014–2015. Async/await is RFC #2394 (2019),
so it was never in the corpus. Reordering to descending picks up
modern RFCs first; older fundamental RFCs are reachable through the
cap-extension follow-up (deferred).

## [0.3.2] — 2026-05-26

### Changed

- **HTTP fetchers fall through for non-bare-github `kind:repo`.**
  Drop the `source.kind === "repo"` rejection from
  `HttpIndexOnlyFetcher.canHandle` and
  `GenericHttpFetcher.canHandle`. The `kind === "file"` rejection
  stays. Chain ordering puts `GithubRepoFetcher` first, so bare
  `https://github.com/{owner}/{repo}` URLs continue to route to
  the GitHub API path; only sources `GithubRepoFetcher` rejects
  (github.io URLs, github.com URLs with a path suffix like
  `/releases`, `mode:feed` sources) now fall through to the HTTP
  fetchers instead of failing `unknown-mode`.
- Three new tests cover the new behavior plus the precedence
  invariant: `HttpIndexOnlyFetcher.canHandle` true for `kind:repo`
  + github.io URL + `index-only`;
  `GenericHttpFetcher.canHandle` true for `kind:repo` +
  github.com path URL + `feed`; the default chain still routes
  bare github.com to `github-repo` (regression guard).

### Why

The v0.3.1 Rust smoke surfaced two silent failures (now visible
via `stage4:fetch:failed`) that both came from Stage 2
classifying GitHub Pages or release feeds as `kind:repo` but
giving them URLs `GithubRepoFetcher` cannot serve:

- `rust-lang-github-io-api-guidelines` —
  `https://rust-lang.github.io/api-guidelines/`, kind=repo,
  mode=index-only. github.io is plain HTTP; the bare-repo regex
  rejects it.
- `gh-rust-lang-rust-releases` —
  `https://github.com/rust-lang/rust/releases`, kind=repo,
  mode=feed. The path suffix loses it the regex, and feed mode
  is also outside `GithubRepoFetcher`'s allowlist.

Both are now claimed by the HTTP fetcher chain.

## [0.3.1] — 2026-05-26

### Added

- **Stage 4 — per-source failure events.** `runSourceFetch` now
  emits `stage4:fetch:failed` whenever an entry's status is
  `failed`, both from the orchestrator's catch path (unknown-mode,
  fetcher-thrown errors) and when a fetcher returns a failed
  entry on its own (HTTP 404 etc). Previously these were captured
  in `sources/manifest.summary.json` only, so a silent fetch fail
  on a source that later showed up in a Stage 6 tool's
  `sourceDependencies` was invisible until benchmark time. The
  Rust v0.3.0 smoke surfaced this exactly:
  `gh-rust-lang-rust-releases` silently failed `unknown-mode`
  (its URL `https://github.com/rust-lang/rust/releases` includes
  a `/releases` path the `GithubRepoFetcher` regex rejects).
  Stage 6 then designed `error_explain` with that source in
  sourceDependencies, and the empty corpus only surfaced as a
  failed benchmark.

### Changed

- **Stage 6 prompt v2 → v3.** Adds a "Pre-computed source-mode
  summary" block to the User message, populated by a new
  `buildSourceModeSummary` helper in the runner. The summary
  carries counts plus ids per ingestion mode (`snapshotIds`,
  `indexOnlyIds`, `feedIds`) so the model can scan one block
  instead of aggregating across the nested sources JSON.
  Motivated by the v0.3.0 sqlite smoke, where the LLM's
  rationale claimed "zero snapshot-mode sources" while three of
  nine sources were in fact snapshot. The conclusion
  (`customTools: []`) was safe — `pragma_lookup` specifically
  targeted the index-only `sqlite-org-lang` source — but the
  rationale itself was factually wrong, a sign the model was
  failing to aggregate `ingestion.mode` from the input on its
  own. The Rust v0.3.1 smoke confirms the fix: the v3 rationale
  now correctly identifies `doc-rust-lang-org-std` as
  index-only and `gh-rust-lang-rfcs` as snapshot.

### Known limitations (deferred to v0.4)

- `GithubRepoFetcher` rejects repo URLs with path suffixes
  (e.g., `/releases`, `/tree/foo`). Stage 4 now logs the silent
  failure but the underlying URL canonicalisation / scope-aware
  fetch is a larger fix. Same shape: github.io docs URLs
  (`rust-lang-github-io-api-guidelines`) also currently fail
  `unknown-mode` because no fetcher claims them.

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
