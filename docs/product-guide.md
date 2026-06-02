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

## Install sanity

Before compiling anything, verify the source-first CLI path from the repository
root:

```bash
bun src/cli.ts --version
bun src/cli.ts doctor
```

If you use `bun link`, verify the linked binary from outside the repository so
the command is not accidentally depending on the current working directory:

```bash
bun link
tmpdir="$(mktemp -d)"
(cd "$tmpdir" && almanac --version && almanac doctor)
```

When `almanac --version` is stale, check which binary is being used and relink
from the intended checkout:

```bash
which almanac
readlink "$(which almanac)" 2>/dev/null || true
bun link
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
- source-set drift when discovery was rerun against prior approved sources

When Stage 2b runs with an existing approved `sources/sources.json`,
`almanac sources` also prints a `drift` line. The JSON form includes
`stability`, which records prior accepted count, current accepted count,
preserved/restored/replaced source ids, newly added source ids, and dropped
prior sources with reasons such as `not-fetchable`, `explicitly-rejected`, or
`policy-rejected`.

## Retrieval Modes

Almanac always has a SQLite FTS index after Stage 8 succeeds. Embeddings are
optional:

- `fts-only`: default mode; deterministic, local, and valid for normal use
- `hybrid`: SQLite FTS plus built vector artifacts
- `vector-configured-but-skipped`: semantic retrieval was requested or
  available, but vector artifacts were not built or cannot run

`profile` prints the active retrieval mode and includes the same data in
`evidence.retrieval` for release gates. `doctor` treats missing optional
embeddings as `ok`; it warns only when embeddings were requested but cannot be
used.

Recommended defaults:

- leave embeddings unset for deterministic local smoke and personal offline use
- use `VOYAGE_API_KEY` as the preferred hosted provider configuration when
  semantic retrieval is enabled
- use `ALMANAC_EMBEDDINGS=openai` only when OpenAI embeddings are explicitly
  desired
- use `ALMANAC_EMBEDDINGS=deterministic` for tests

Hosted provider configuration is surfaced for readiness; it does not create a
hidden provider call from `doctor`, `profile`, or default answer workflows.

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

When ask fixtures exist, run the deterministic answer suite as part of the
refresh command:

```bash
almanac refresh run sqlite-demo \
  --from-stage 12-benchmark-run \
  --ask-suite \
  --save \
  --label rc-smoke \
  --root "$tmp"
```

`--ask-suite` invokes compiled tools only. A passing suite keeps the refresh
exit code at `0`; a failing suite exits `1`; missing or unreadable ask fixtures
exit `2`. Saved refresh artifacts include only a compact ask-suite summary.

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

## Demo handoff

Use `export` when the receiver needs a runnable almanac directory. The default
archive includes the compiled artifact, knowledge index, sources, facts, tools,
contract files, and adapters; it excludes `.compile/` and `.runs/` by default.

```bash
almanac export sqlite-demo --root "$tmp"
tar -tzf almanac-sqlite-demo-0.1.0.tar.gz | head
```

Use `--include-runs` only when saved operational artifacts are part of the
handoff. Saved runs may include tool inputs, tool outputs, answer text, labels,
and notes.

Use `wiki` when the receiver needs a human-readable review bundle instead of a
runnable archive:

```bash
almanac wiki sqlite-demo --root "$tmp"
open almanac-sqlite-demo-0.1.0-wiki/README.md
```

The wiki bundle writes `README.md`, `sources.md`, `facts.md`, `tools.md`,
`benchmark.md`, and `artifacts.json`. `artifacts.json` includes its own
manifest entry so reviewers can verify the exact file list and byte sizes.

## Answer mode

`almanac ask` is the local answer gate. It is intentionally different
from `almanac run --tool`:

- `run --tool` is deterministic and no-key friendly. It invokes exactly one
  compiled tool through `AlmanacRuntime.execTool`.
- `ask` is LLM-backed. It asks the provider to plan bounded tool calls over the
  compiled tool manifests, executes only those tools through the runtime, then
  synthesizes a final cited answer or abstains.
- Real `ask` runs require `ANTHROPIC_API_KEY`. Local smoke tests can use
  `ALMANAC_LLM=mock` with `ALMANAC_MOCK_RESPONSES`.

Grounded answer:

```bash
almanac ask sqlite-demo "Are SQLite transactions atomic?" --json --root "$tmp"
```

Abstention/no-source case:

```bash
almanac ask sqlite-demo "What is the capital of France?" --json --root "$tmp" || true
```

Persist an answer artifact explicitly:

```bash
almanac ask sqlite-demo "Are SQLite transactions atomic?" \
  --save \
  --label rc-answer \
  --json \
  --root "$tmp"

almanac runs sqlite-demo --kind answer --json --root "$tmp"
answer_id="$(
  almanac runs sqlite-demo --kind answer --latest --json --root "$tmp" \
    | jq -r '.runs[0].runId'
)"
almanac runs sqlite-demo "$answer_id" --root "$tmp"
```

Replay saved answers or hand-authored fixture rows without provider keys:

```bash
almanac ask-replay sqlite-demo \
  --from-runs \
  --label rc-answer \
  --json \
  --root "$tmp"

cat > "$tmp/ask-fixtures.jsonl" <<'JSONL'
{"id":"sqlite-transactions-ok","question":"Are SQLite transactions atomic?","toolCalls":[{"tool":"query_facts","input":{"q":"transactions atomic"},"expectedStatus":"ok"}],"expectedStatus":"ok","minCitations":1,"maxStaleCitations":0}
JSONL

almanac ask-replay sqlite-demo \
  --fixture "$tmp/ask-fixtures.jsonl" \
  --json \
  --root "$tmp"
```

Replay reports include an ask-mode quality gate. The gate records citation
rate, unsupported claim count, stale citation count, and abstention
expected/actual matching separately from benchmark fixtures. Fixture rows can
set `answer`, `unsupportedClaims`, `minCitations`, `maxStaleCitations`, and
`expectedAbstentionReason` to make replay failures explicit.

When a saved answer or fixture row includes answer text, add `--judge` to
`ask-replay` or `ask-suite` to run an explicit LLM entailment judge over the
answer and replayed citations. The judge is provider-backed and opt-in;
deterministic replay remains provider-free by default.

`profile` and `doctor` also expose answer readiness without calling a provider:
ask fixture coverage by path, latest saved refresh ask-suite status, latest
saved answer status, latest answer quality verdict, and stale citation
warnings. Missing ask fixtures, missing saved ask-suite evidence, stale fixture
coverage, or missing saved answer quality gates are warnings so an otherwise
compiled almanac can remain usable while answer mode still needs validation.

The output exit code is part of the contract: grounded `ok` answers exit `0`,
abstentions and model/tool failures exit `1`, and usage or tool-input errors
exit `2`. Scripts should inspect the JSON `status` when they need to
distinguish `abstained`, `tool-error`, `budget-exhausted`, and `model-error`.

For the full answer-mode contract, including trace contents, replay fixture
fields, quality gate behavior, and readiness states, see
[`answer-mode.md`](./answer-mode.md).

For the v0.8 release-candidate smoke sequence, see
[`v0.8-rc-smoke.md`](./v0.8-rc-smoke.md).
For the v0.9 ask-suite operations release-candidate smoke sequence, see
[`v0.9-rc-smoke.md`](./v0.9-rc-smoke.md).
For the v0.10 answer trust and retrieval readiness release-candidate smoke
sequence, see [`v0.10-rc-smoke.md`](./v0.10-rc-smoke.md).

Minimal answer-mode smoke:

```bash
tmp=$(mktemp -d)
almanac demo --root "$tmp"

almanac run sqlite-demo \
  --tool query_facts \
  --input '{"q":"transactions atomic"}' \
  --json \
  --root "$tmp"

almanac ask sqlite-demo "Are SQLite transactions atomic?" --json --root "$tmp"
almanac ask sqlite-demo "What is the capital of France?" --json --root "$tmp" || true

almanac ask sqlite-demo "Are SQLite transactions atomic?" \
  --save \
  --label rc-answer \
  --json \
  --root "$tmp"

almanac runs sqlite-demo --kind answer --json --root "$tmp"
almanac runs sqlite-demo --kind answer --prune --keep-latest 1 --dry-run --json --root "$tmp"
almanac export sqlite-demo --root "$tmp"
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

Stage 11 writes compiler-managed stability metadata into
`.compile/stage11-output.json`. The `stability` object records the required
coverage floor, final fixture coverage, and, when runtime preflight is enabled,
each preflight attempt's included, skipped, failed, and dropped fixture ids.
Use it to tell whether benchmark variance came from generated fixture coverage,
live/network-backed fixtures, or deterministic runtime failures.

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

It also prints a task-oriented `readiness` section. Use it before a first run to
see what can be done immediately (`demo`), what needs setup
(`real-compile`, `answer`, `refresh`, `registration`), and which optional gates
are available (`judge`). These checks are local artifact and environment checks;
`doctor` does not call an LLM provider.

Use `--strict` in automation when warnings should block promotion.
