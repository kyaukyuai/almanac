# Sample Almanacs

This page defines the committed sample surface for evaluating `almanac`
without spending provider tokens.

## Golden No-Key Sample: sqlite-demo

`sqlite-demo` is the golden no-key sample. It is intentionally small:

- 3 facts from three official SQLite documentation pages,
- 4 default tools,
- 1 positive and 1 negative benchmark fixture,
- SQLite FTS retrieval only,
- no provider credentials required.

Create it locally:

```bash
tmp="$(mktemp -d)"
almanac demo --root "$tmp"
almanac inspect sqlite-demo --root "$tmp"
almanac profile sqlite-demo --root "$tmp"
almanac benchmark sqlite-demo --root "$tmp"
```

Run the primary fact lookup:

```bash
almanac run sqlite-demo \
  --tool query_facts \
  --input '{"q":"transactions atomic"}' \
  --json \
  --root "$tmp"
```

Expected shape:

```json
{
  "status": "ok",
  "toolName": "query_facts",
  "citationsCount": 1
}
```

## Committed Wiki Snapshot

The committed wiki snapshot is under
[`docs/samples/sqlite-demo-wiki`](./samples/sqlite-demo-wiki/README.md).

It shows the inspection bundle produced by:

```bash
almanac wiki sqlite-demo --output docs/samples/sqlite-demo-wiki --root "$tmp"
```

Snapshot contents:

- [`README.md`](./samples/sqlite-demo-wiki/README.md): identity, health,
  stages, and artifact paths,
- [`sources.md`](./samples/sqlite-demo-wiki/sources.md): accepted source set,
- [`facts.md`](./samples/sqlite-demo-wiki/facts.md): fact distribution and
  sample facts,
- [`tools.md`](./samples/sqlite-demo-wiki/tools.md): enabled tools and network
  allowlists,
- [`benchmark.md`](./samples/sqlite-demo-wiki/benchmark.md): benchmark result,
- [`artifacts.json`](./samples/sqlite-demo-wiki/artifacts.json): machine
  manifest, including the `artifacts.json` entry itself.

The snapshot uses `<generated-root>` placeholders where a local run would
contain disposable absolute paths.

## Export Handoff

The portable archive is generated rather than committed:

```bash
almanac export sqlite-demo \
  --output "$tmp/sqlite-demo.tar.gz" \
  --root "$tmp"
```

Default export excludes `.compile/` and `.runs/`. Use `--include-compile` or
`--include-runs` only when the receiver needs diagnostics or saved run/answer
artifacts.

Validate the handoff before writing files, then import it into a fresh root:

```bash
handoff_root="$(mktemp -d)"
almanac import "$tmp/sqlite-demo.tar.gz" --root "$handoff_root"
almanac import "$tmp/sqlite-demo.tar.gz" --root "$handoff_root" --apply
almanac status sqlite-demo --root "$handoff_root"
almanac benchmark sqlite-demo --root "$handoff_root"
```

## Answer-Mode Sample

To make the sample answer-ready without a live provider, use the mock provider
flow from the v0.12 RC smoke:

```bash
export ALMANAC_LLM=mock
export ALMANAC_MOCK_RESPONSES="$(
  cat <<'JSON'
{
  "answer-planner@planner-v1": [
    "{\"action\":\"call_tool\",\"toolName\":\"query_facts\",\"input\":{\"q\":\"transactions atomic\",\"limit\":3}}",
    "{\"action\":\"stop\",\"reason\":\"enough-evidence\"}"
  ],
  "answer-synthesis@synthesis-v1": "{\"status\":\"ok\",\"answer\":\"SQLite transactions are atomic.\",\"citations\":[{\"sourceId\":\"sqlite-transactions\",\"url\":\"https://www.sqlite.org/lang_transaction.html\",\"fetchedAt\":\"2026-01-01T00:00:00.000Z\"}]}"
}
JSON
)"

answer_json="$tmp/sqlite-answer.json"
almanac ask sqlite-demo \
  "Are SQLite transactions atomic?" \
  --save \
  --label sample-answer \
  --json \
  --root "$tmp" \
  > "$answer_json"

answer_id="$(jq -r '.answerId' "$answer_json")"

unset ALMANAC_LLM
unset ALMANAC_MOCK_RESPONSES

almanac ask-replay sqlite-demo \
  --from-runs \
  --label sample-answer \
  --json \
  --root "$tmp"

almanac ask-fixtures init sqlite-demo --root "$tmp"
almanac ask-fixtures add-from-run sqlite-demo "$answer_id" \
  --fixture-id sqlite-transactions-atomic \
  --root "$tmp"
almanac ask-suite sqlite-demo --root "$tmp"
```

Expected outcome:

- saved answer status is `ok`,
- at least one citation and one tool call are present,
- saved replay passes without provider credentials,
- `ask-suite` passes without provider credentials,
- `profile` reports answer mode as ready after fixture promotion.

## Credentialed Release Sample

Enterprise AI remains the credentialed release sample because it exercises real
provider compile, source discovery, generated tools, benchmark generation,
real-provider ask, saved answer replay, and ask-suite promotion. The current
commands are maintained in
[`docs/v0.12-rc-smoke.md`](./v0.12-rc-smoke.md#7-enterprise-ai-fresh-compile-and-update-smoke).

Keep the committed sample small and deterministic. Keep the Enterprise AI
sample generated on demand because its sources, provider outputs, and costs are
intentionally live.
