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

To make the sample answer-ready without a live provider, seed the deterministic
SQLite answer check and persist the passing suite through the deterministic
Stage 12 refresh boundary:

```bash
almanac ask-fixtures init sqlite-demo --seed-demo --root "$tmp"
almanac ask-suite sqlite-demo --root "$tmp"
almanac refresh run sqlite-demo \
  --from-stage 12-benchmark-run \
  --ask-suite \
  --save \
  --root "$tmp"
almanac profile sqlite-demo --root "$tmp"
```

Expected outcome:

- one deterministic fixture is written to `tests/ask.jsonl`,
- `ask-suite` passes without provider credentials,
- `profile` reports answer mode as ready after saved ask-suite evidence.

For a live answer artifact workflow, use `almanac ask --save` with
`ANTHROPIC_API_KEY`, then replay or promote the saved answer with
`ask-replay` and `ask-fixtures add-from-run`.

## Credentialed Release Sample

Enterprise AI remains the credentialed release sample because it exercises real
provider compile, source discovery, generated tools, benchmark generation,
real-provider ask, saved answer replay, and ask-suite promotion. The current
commands are maintained in
[`docs/v0.14-rc-smoke.md`](./v0.14-rc-smoke.md#7-enterprise-ai-provider-smoke).

Keep the committed sample small and deterministic. Keep the Enterprise AI
sample generated on demand because its sources, provider outputs, and costs are
intentionally live.
