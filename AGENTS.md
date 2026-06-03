# Agent Guide

This file applies to the whole repository.

## Project

`almanac` is a source-first Bun/TypeScript CLI that compiles domain-specific
knowledge surfaces into portable almanac directories. A compiled almanac
contains sources, facts, freshness metadata, generated tools, runtime
contracts, benchmark fixtures, saved run and answer artifacts, MCP adapters,
and client registration files.

The product is not a chatbot persona. The host LLM does reasoning; `almanac`
provides grounded retrieval, tools, citations, freshness, validation, and
handoff artifacts.

## Repository Map

- `src/cli.ts`: CLI entrypoint and command wiring.
- `src/core/`: shared schemas, runtime contracts, artifact helpers, and
  validation logic.
- `src/compile/`: source discovery, fetching, staged compile pipeline, prompt
  definitions, generated-tool templates, and stage tests.
- `src/serve/`: MCP server adapter over the generic runtime.
- `src/manage/`: registration, export, wiki, runs, refresh, ask, and related
  management flows.
- `src/embeddings/`: optional vector index provider configuration and
  deterministic/local embedding support.
- `docs/`: design, product guide, version plans, RC smoke runbooks, and sample
  almanac docs.
- `docs/samples/sqlite-demo-wiki/`: committed no-key golden sample wiki
  snapshot.

## Runtime And Product Invariants

- Keep the runtime boundary generic: `listTools`, `execTool`,
  `listResources`, and `readResource` should remain the core operation model.
- Compiled almanac directories are data artifacts. Avoid baking domain-specific
  behavior into the generic runtime unless the contract requires it.
- Cite or abstain: grounded answer and tool paths should prefer explicit
  citations and deterministic abstention over unsupported output.
- Preserve freshness signals. Stale, warm, and fresh states should be surfaced
  instead of silently ignored.
- Keep no-key flows working. `almanac demo`, `doctor`, benchmark replay,
  `ask-replay`, and sample handoff paths should not require provider keys.
- Treat real-provider paths as smoke/release checks, not as ordinary unit test
  requirements.

## Common Commands

Install and validate:

```bash
bun install
bun run typecheck
bun test
```

Run the source CLI:

```bash
bun src/cli.ts --version
bun src/cli.ts doctor
```

Run the no-key sqlite demo:

```bash
tmp="$(mktemp -d)"
bun src/cli.ts demo --root "$tmp"
bun src/cli.ts inspect sqlite-demo --root "$tmp"
bun src/cli.ts profile sqlite-demo --root "$tmp"
bun src/cli.ts benchmark sqlite-demo --root "$tmp"
bun src/cli.ts run sqlite-demo \
  --tool query_facts \
  --input '{"q":"transactions atomic"}' \
  --json \
  --root "$tmp"
```

Generate wiki/export handoff artifacts:

```bash
bun src/cli.ts wiki sqlite-demo --root "$tmp"
bun src/cli.ts export sqlite-demo --root "$tmp"
```

Use real-provider compile or answer commands only when credentials are present:

```bash
test -n "$ANTHROPIC_API_KEY"
```

Optional provider keys include `BRAVE_SEARCH_API_KEY`, `VOYAGE_API_KEY`,
`OPENAI_API_KEY`, and `ALMANAC_EMBEDDINGS`.

## Testing Guidance

- Run `bun run typecheck` and `bun test` before publishing code changes.
- For docs-only changes, still run `git diff --check`; run typecheck/test when
  the docs include executable commands or generated sample artifacts.
- For generated JSON artifacts, validate with `jq '.' <file>`.
- For CLI behavior changes, add or update tests in `src/cli.test.ts` or the
  relevant focused module test.
- For compile-stage changes, prefer deterministic mocked providers and stage
  unit tests over live provider calls.
- Do not make unit tests depend on external network, real API keys, or mutable
  user-level state such as `bun link`.

## Release And Smoke Docs

- Version plans live in `docs/vX.Y-plan.md`.
- Release-candidate smoke runbooks live in `docs/vX.Y-rc-smoke.md`.
- Keep smoke docs concrete: include commands, expected output shape, and the
  credential boundary.
- When a smoke captures a local disposable path, replace it with a placeholder
  before committing docs.
- The committed golden sample is `sqlite-demo`; Enterprise AI is the
  credentialed, generated-on-demand release sample.

## Git And PR Hygiene

- Work from `main` after `git pull --ff-only`.
- Use `codex/<topic>` branches for agent changes.
- Keep commits scoped. Do not mix unrelated refactors with requested work.
- Do not revert user changes unless explicitly asked.
- Before opening a PR, ensure `git status --short` is clean after commit.
- PR descriptions should include what changed and the validation commands run.

## Style

- Use TypeScript and existing local patterns; prefer Zod schemas for structured
  data validation.
- Prefer explicit, deterministic artifact formats over ad hoc strings.
- Keep CLI output task-oriented and actionable.
- Keep docs command examples runnable from the repository root unless stated
  otherwise.
- Use ASCII in repository text unless the surrounding file already requires
  non-ASCII.
