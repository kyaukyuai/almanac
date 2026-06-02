# Answer Mode

`almanac ask` is the optional one-shot answer path for a compiled almanac. It is
designed for release gates, operator checks, and local debugging of the same
compiled tools that MCP clients use.

Answer mode is deliberately narrower than a chat agent:

- it does not add memory,
- it does not browse outside compiled tool capabilities,
- it does not run hidden refreshes,
- it requires cited tool evidence or abstains.

## Runtime Boundary

`almanac ask <id> <question>` asks the configured LLM provider to plan bounded
tool calls over the compiled tool manifests. The planner can only call tools
through `AlmanacRuntime.execTool`; it cannot directly read files, hit arbitrary
URLs, or invoke uncompiled tools.

`almanac run --tool` remains the deterministic no-provider path for a single
tool invocation. Use `run --tool` when CI needs to validate one tool contract.
Use `ask` when the release gate needs to validate planner, tool execution,
synthesis, citations, and abstention behavior together.

Real provider runs require `ANTHROPIC_API_KEY`. Offline smoke tests can set
`ALMANAC_LLM=mock` and provide canned planner/synthesis responses with
`ALMANAC_MOCK_RESPONSES`.

## Saved Answer Artifacts

Use `--save` when an answer session should be inspectable later:

```bash
almanac ask sqlite-demo "Are SQLite transactions atomic?" \
  --save \
  --label rc-answer \
  --json \
  --root "$tmp"
```

Saved answer artifacts live under `.runs/answer-*.json` and are excluded from
exports unless `almanac export --include-runs` is used.

Inspect the latest saved answer:

```bash
answer_id="$(
  almanac runs sqlite-demo --kind answer --latest --json --root "$tmp" \
    | jq -r '.runs[0].runId'
)"

almanac runs sqlite-demo "$answer_id" --root "$tmp"
almanac runs sqlite-demo "$answer_id" --json --root "$tmp"
```

The saved artifact includes a compact answer trace:

- planner calls, chosen tool inputs, validation status, and stop reason,
- tool observations with status, duration, citation count, and error code,
- citation ledger entries and final citation usage,
- synthesis status,
- abstention reason when the answer abstains,
- ask-mode quality verdict when the gate has run.

The trace is intended for diagnosis. It does not persist API keys, environment
dumps, or raw provider request/response bodies.

## Fixture Authoring

Use `almanac ask-fixtures` to create deterministic replay fixtures without
calling an LLM provider.

Initialize the standard fixture file:

```bash
almanac ask-fixtures init sqlite-demo --root "$tmp"
```

The default path is `tests/ask.jsonl` under the compiled almanac. Alternate
recognized fixture paths are `tests/ask-replay.jsonl`, `fixtures/ask.jsonl`,
and `fixtures/ask-replay.jsonl`.

Promote a saved answer artifact into the fixture file:

```bash
answer_id="$(
  almanac runs sqlite-demo --kind answer --latest --json --root "$tmp" \
    | jq -r '.runs[0].runId'
)"

almanac ask-fixtures add-from-run sqlite-demo "$answer_id" --root "$tmp"
```

The added row keeps the saved question, recorded tool calls, expected final
answer status, citation expectations, and abstention reason when present. The
default fixture id is the saved `answer-*` id; pass `--fixture-id` when a
shorter stable id is preferable. Duplicate fixture ids are rejected.

## Replay

`almanac ask-replay` reruns answer-mode checks without calling an LLM provider.
It has two input modes and exactly one must be selected.

Replay saved answer artifacts:

```bash
almanac ask-replay sqlite-demo \
  --from-runs \
  --label rc-answer \
  --json \
  --root "$tmp"
```

Replay fixture JSONL:

```bash
cat > "$tmp/ask-fixtures.jsonl" <<'JSONL'
{"id":"sqlite-transactions-ok","question":"Are SQLite transactions atomic?","toolCalls":[{"tool":"query_facts","input":{"q":"transactions atomic"},"expectedStatus":"ok"}],"expectedStatus":"ok","minCitations":1,"maxStaleCitations":0,"maxUnsupportedClaims":0}
JSONL

almanac ask-replay sqlite-demo \
  --fixture "$tmp/ask-fixtures.jsonl" \
  --json \
  --root "$tmp"
```

Fixture rows are intentionally small. Stable fields are:

- `id`
- `question`
- `toolCalls[]`
- `expectedStatus`
- `minCitations`
- `maxStaleCitations`
- `unsupportedClaims`
- `maxUnsupportedClaims`
- `expectedAbstentionReason`

Replay is an answer-mode regression surface. It complements Stage 11/12
benchmarks; it does not replace them.

## Ask Suite Gate

`almanac ask-suite` runs the deterministic fixture suite as an ask-mode gate.
It discovers the recognized fixture paths by default and does not call an LLM
provider:

```bash
almanac ask-suite sqlite-demo --json --root "$tmp"
```

Use `--fixture <path>` one or more times to gate an explicit fixture set instead
of the standard paths.

Exit codes:

- `0`: all replay cases and quality gates passed,
- `1`: at least one replay case or quality gate failed,
- `2`: suite setup failed, such as missing fixtures, malformed JSONL, duplicate
  ids, or a missing almanac directory.

## Quality Gate

Answer-mode quality checks are deterministic and operational. They are not a
full entailment proof. The gate reports:

- citation rate,
- unsupported claim count,
- stale citation count,
- expected vs actual abstention status and reason.

Default expectations:

- `ok` answers need at least one citation,
- unsupported claims fail unless the fixture explicitly allows them,
- stale citations fail unless allowed by the fixture,
- expected abstentions must abstain for the expected reason family.

Live saved answers persist the gate verdict in `trace.quality`. Replay reports
both per-case quality and aggregate quality.

## Readiness

`profile` and `doctor` summarize answer readiness without provider calls:

```bash
almanac profile sqlite-demo --root "$tmp"
almanac doctor sqlite-demo --root "$tmp"
```

Readiness considers:

- compiled tools and benchmark state,
- ask fixture coverage,
- latest saved answer status,
- latest saved answer quality verdict,
- malformed answer artifacts,
- stale citation warnings.

States:

- `ready`: benchmark passed, fixtures exist, latest answer gate passed.
- `needs-validation`: answer mode can run but fixtures or saved quality evidence
  are missing.
- `not-ready`: benchmark/runtime state is missing or the latest answer failure
  indicates a blocking runtime issue.
