# almanac

> **Compile a domain almanac. Always-fresh. As CLI, MCP, and Skill.**

`almanac` is a meta-generator that turns a single domain name into a
self-contained, always-fresh knowledge surface — exposed simultaneously as a
**CLI**, an **MCP server**, and a **Claude Code Skill**.

```bash
almanac new cooking
# → ~/.almanac/almanacs/cooking/ is compiled (tools/, knowledge/, contract files)
# → MCP:  almanac serve cooking     # stdio MCP server for host LLMs
# → Skill: almanac register cooking --client=claude-code   # installs SKILL.md + MCP entry
```

End-user querying happens through the host LLM (Claude Code, Cursor, Claude
Desktop, …) after `register`. The `almanac` CLI itself is for build and
management only — there is no built-in `run` orchestrator in v0.1.

An almanac has **no persona**. It is a domain-specialized retrieval-and-tools
layer that returns sourced, freshness-aware answers. Every fact carries a
`fetchedAt`, every topic is classified by volatility (static / slow / fast /
live), and stale data is surfaced rather than masked.

## Design pillars

1. **Headless runtime + adapters** — one operation contract (`listTools` /
   `execTool` / `listResources` / `readResource`) is the source of truth;
   the MCP server and the Claude Code Skill are derived from it. A single
   generic `almanac serve` binary serves any compiled almanac.
2. **Always fresh** — every artifact knows its volatility class and TTL.
   `update` is a first-class command, not an afterthought. Inspired by
   [`last30days-skill`](https://github.com/mvanhorn/last30days-skill).
3. **Cite or abstain** — every tool returns `citations[]`. No grounded source,
   no answer.
4. **Compile, don't configure** — the only required input is the domain name.
   Source discovery, tool design, and code generation are automated; humans
   review the draft and approve.

See [`docs/design.md`](./docs/design.md) for the full technical specification.

## Status

**v0.1 in progress.** The 12-stage compile pipeline (bootstrap → domain
analysis → source discovery → fact extraction → tool design + implementation
→ knowledge index → contract files → SKILL.md → benchmark) runs end-to-end
against a mocked LLM, and the runtime (`almanac serve`) + `register` for
Claude Code are wired and exercised by `src/e2e.test.ts`.

Capabilities that landed during v0.1 iteration:

- **Stage 7 LLM tool implementer** — domain-specific tools designed in
  Stage 6 are generated through a real `generate → write → tsc → bun test`
  retry loop. The four template defaults (`query_facts`,
  `fetch_official_docs`, `web_search_recent`, `latest_releases`) still
  ship in every almanac.
- **`register --client`** supports `claude-code`, `claude-desktop`,
  and `cursor`. Codex requires TOML config and is deferred to v0.2.
- **`almanac remove`** with dry-run by default, cleans up client
  registrations across all known clients.
- **GitHub repo snapshot** mirrors `ingestion.scope`-matched files
  from permissively-licensed repos into `sources/raw/`.
- **GitHub Actions CI** runs typecheck + the full test suite on every
  push and PR.

What's still deferred:

- `register --client=codex` (TOML support needed).
- `almanac feed`, `almanac export` (v0.2).

The original design thread is at
[Amp T-019e0670…](https://ampcode.com/threads/T-019e0670-942c-711f-b948-f350ac93e96d).

## License

MIT — see [LICENSE](./LICENSE).
