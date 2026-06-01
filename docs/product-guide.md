# Product guide

This guide covers the product-facing path: prove the tool works without API
keys, inspect the generated artifact, review its expertise profile, review
sources, and gate changes with human golden fixtures.

## Offline demo

```bash
almanac demo
```

Creates `sqlite-demo` under the default almanac root. It includes:

- curated SQLite source metadata in `sources/sources.json`
- three offline facts in `extracted/facts.jsonl`
- a SQLite FTS index in `knowledge/almanac.sqlite`
- the four default tools in `tools/`
- `DOMAIN.md`, `AGENTS.md`, `SKILLS.md`, and `adapters/skill/SKILL.md`
- human golden fixtures in `tests/positive.jsonl` and `tests/negative.jsonl`
- a Stage 12 report in `.compile/benchmark-result.json`

Use a disposable root when evaluating:

```bash
tmp=$(mktemp -d)
almanac demo --root "$tmp"
```

## Inspect

```bash
almanac inspect sqlite-demo --root "$tmp"
```

Expected shape:

```text
almanac: sqlite-demo (SQLite Operations Demo)
  facts/tools    3 / 4
  health         ok (11 completed, 4 skipped, 0 failed, 0 pending)
  sources        approved, 3 accepted / 0 rejected (docs=3)
  fixtures       1 positive / 1 negative
  benchmark      2/2 passed, citationRate 100%
```

`inspect --json` includes the manifest, compile state, knowledge manifest,
source summary, benchmark fixtures, benchmark report, health issues, and next
actions.

## Expertise profile

```bash
almanac profile sqlite-demo --root "$tmp"
```

`profile` is the product-readiness view. It answers whether the almanac is
usable as a specialist, which evidence supports it, what query shapes it was
compiled to handle, and which validation gaps remain.

Expected shape:

```text
expert profile: sqlite-demo (SQLite Operations Demo)
  status         usable
  evidence       3 facts from 3 sources
  source review  approved, 3 accepted / 0 rejected (docs=3)
  benchmark      2/2 passed, citationRate 100%
```

Use `profile --json` in scripts or release gates. The JSON includes identity,
evidence counts, source coverage, fact type/freshness distribution, benchmark
status, readiness gaps, artifact paths, and next actions.

## Source review

```bash
almanac sources sqlite-demo --root "$tmp"
almanac sources sqlite-demo --root "$tmp" --rejected
almanac sources sqlite-demo --root "$tmp" --kind docs
```

The review output is meant for a human deciding whether an almanac is grounded
enough to trust:

- source id and URL
- source kind
- trust score
- ingestion mode and refresh interval
- rationale
- rejected candidate reasons when available

## Refresh due checks

Use `refresh due` before wiring an almanac into cron or CI. The command is
read-only: it does not mutate compile state, fetch sources, run LLM stages, or
require provider credentials.

```bash
almanac refresh due sqlite-demo --root "$tmp"
almanac refresh due sqlite-demo --root "$tmp" --json
```

The JSON output includes `due`, stable reason codes, source expiry summaries,
stage failures or pending stages, benchmark report status, and a
`recommendedFromStage` value suitable for a later `almanac update` or refresh
runner.

Run a manual refresh when the due check says work is needed, or when an
operator wants to force a specific stage boundary:

```bash
almanac refresh run sqlite-demo --root "$tmp"
almanac refresh run sqlite-demo --from-stage 12-benchmark-run --root "$tmp"
```

`refresh run` acquires a per-almanac lock before mutating compile state. A lock
conflict returns a stable `locked` result with nonzero exit code. JSON output is
intended for CI/cron:

```bash
almanac refresh run sqlite-demo --from-stage 12-benchmark-run --json --root "$tmp"
```

Persist a refresh audit artifact explicitly:

```bash
almanac refresh run sqlite-demo \
  --from-stage 12-benchmark-run \
  --save \
  --label rc-smoke \
  --root "$tmp"
```

For recurring cron, GitHub Actions, or launchd usage, see
[`refresh-scheduler.md`](./refresh-scheduler.md). That contract documents exit
codes, provider key requirements, lock conflicts, saved refresh artifacts,
retention, and export behavior.

## Run artifacts

Use `almanac run --save` when a local tool invocation should leave an audit
record. Use `almanac ask --save` when a cited answer session should be retained
for review:

```bash
almanac run sqlite-demo \
  --tool query_facts \
  --input '{"q":"transactions"}' \
  --label release-smoke \
  --save \
  --root "$tmp"

almanac ask sqlite-demo "Are SQLite transactions atomic?" \
  --label answer-smoke \
  --save \
  --root "$tmp"
```

Saved artifacts live under `.runs/`. Tool artifacts use `run-*.json`; refresh
artifacts use `refresh-*.json`; answer artifacts use `answer-*.json`.
`almanac runs` reads all three envelopes and can filter by artifact kind:

```bash
almanac runs sqlite-demo --root "$tmp"
almanac runs sqlite-demo --kind tool --root "$tmp"
almanac runs sqlite-demo --kind refresh --root "$tmp"
almanac runs sqlite-demo --kind answer --root "$tmp"
```

`inspect`, `profile`, and `doctor` also surface the latest saved refresh run.
Failed or locked latest refresh artifacts are treated as validation signals, so
operators can see a broken manual refresh even if the current compiled almanac
still serves successfully.

Retention cleanup is dry-run by default:

```bash
almanac runs sqlite-demo --prune --keep-latest 20 --dry-run --root "$tmp"
almanac runs sqlite-demo --prune --older-than 30d --apply --root "$tmp"
```

Scope retention by artifact kind when scheduled refresh history or saved answer
sessions should be managed independently from saved tool invocations:

```bash
almanac runs sqlite-demo \
  --kind refresh \
  --prune \
  --keep-latest 30 \
  --dry-run \
  --root "$tmp"

almanac runs sqlite-demo \
  --kind answer \
  --prune \
  --keep-latest 20 \
  --dry-run \
  --root "$tmp"
```

Portable exports exclude `.runs/` by default. Use `--include-runs` only when
the receiver should get saved tool, refresh, and answer artifacts:

```bash
almanac export sqlite-demo --include-runs --root "$tmp"
```

## Human golden benchmarks

Generated Stage 11 fixtures are useful, but product acceptance needs a small
human-owned set. For an almanac that does not already have fixtures,
initialize editable files:

```bash
almanac benchmark my-almanac --init
```

The offline demo already includes fixtures; use `--force` only when you mean
to replace them.

Then edit:

- `tests/positive.jsonl` for queries that must return sourced answers
- `tests/negative.jsonl` for queries that must abstain or remain uncited
- `query` for the human-facing question
- `invocation.input.q` for the exact runtime search query
- `expected.contains` for substrings that must appear in positive results
- `expected.expectedErrorCode` for strict negative refusal checks

Run them:

```bash
almanac benchmark my-almanac
```

The command writes `.compile/benchmark-result.json` and exits non-zero when any
fixture fails or errors, so it can be used in release scripts.

Generated benchmarks also have a coverage floor. `inspect`, `profile`, and
`doctor` expect at least 8 positive fixtures, 5 negative fixtures, and 13 total
fixtures for a generated Stage 11 set. When the generation pipeline owns the
fixtures, Stage 11 retries if deterministic preflight filtering would leave the
set below that floor. Human-owned benchmark files can still be smaller for a
focused acceptance gate, but release smoke runs should preserve the generated
coverage minimum.

## Doctor

```bash
almanac doctor
almanac doctor sqlite-demo
almanac doctor sqlite-demo --strict
```

`doctor` reports local runtime status, CLI version, expected environment keys,
root existence, stage health, knowledge index health, actual vs manifest counts,
source file status, fixture status, the latest benchmark result, and the latest
saved refresh run when one exists.

Use `--strict` in automation when warnings should block promotion.
