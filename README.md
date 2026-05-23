# almanac

> **Compile a domain almanac. Always-fresh. As CLI, MCP, and Skill.**

`almanac` is a meta-generator that turns a single domain name into a
self-contained, always-fresh knowledge surface — exposed simultaneously as a
**CLI**, an **MCP server**, and a **Claude Code Skill**.

```bash
almanac new cooking
# → ~/.almanac/almanacs/cooking/ is compiled
# → CLI:  almanac run cooking "ブイヤベースの本場のレシピ"
# → MCP:  almanac serve cooking
# → Skill: almanac register cooking --client=claude-code
```

An almanac has **no persona**. It is a domain-specialized retrieval-and-tools
layer that returns sourced, freshness-aware answers. Every fact carries a
`fetchedAt`, every topic is classified by volatility (static / slow / fast /
live), and stale data is surfaced rather than masked.

## Design pillars

1. **Headless runtime + adapters** — same operation contract across CLI / MCP /
   Skill. Inspired by [`ai-clone`](https://github.com/kyaukyuai/ai-clone)
   ADR-0004.
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

Pre-implementation design phase. The thread that produced this design is at
[Amp T-019e0670…](https://ampcode.com/threads/T-019e0670-942c-711f-b948-f350ac93e96d).

## Repository

The repository is currently named `savant-forge`. Rename to `almanac` is
pending (GitHub rename + local clone path).

## License

MIT
