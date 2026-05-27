# Product guide

This guide covers the product-facing path: prove the tool works without API
keys, inspect the generated artifact, review sources, and gate changes with
human golden fixtures.

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

Run them:

```bash
almanac benchmark my-almanac
```

The command writes `.compile/benchmark-result.json` and exits non-zero when any
fixture fails or errors, so it can be used in release scripts.

## Doctor

```bash
almanac doctor
almanac doctor sqlite-demo
almanac doctor sqlite-demo --strict
```

`doctor` reports local runtime status, CLI version, expected environment keys,
root existence, stage health, knowledge index health, actual vs manifest counts,
source file status, fixture status, and the latest benchmark result.

Use `--strict` in automation when warnings should block promotion.
