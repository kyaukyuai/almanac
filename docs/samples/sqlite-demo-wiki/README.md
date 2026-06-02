# SQLite Operations Demo

| Field | Value |
| --- | --- |
| Almanac ID | sqlite-demo |
| Domain | sqlite operations demo |
| Version | 0.1.0 |
| Profile | static-heavy |
| Health | ok |
| Facts | 3 |
| Knowledge index | 3 facts, sqlite 3.51.0 |
| Tools | 4 |
| Sources | 3 accepted / 0 rejected |
| Benchmark | 2/2 passed, citationRate 100% |
| Source directory | <generated-root>/sqlite-demo |

## Summary

A small offline demonstration almanac for SQLite transaction, query-plan, and pragma lookup workflows.

## Stage Status

Completed 11, skipped 4, failed 0, running 0, pending 0.

| Stage | Status | Output |
| --- | --- | --- |
| 00-bootstrap | completed | 7b3d00249f1f |
| 01-domain-analysis | completed | 32d736be83d0 |
| 02a-source-discovery-planner | skipped | demo-curated-sources |
| 02x-source-discovery-executor | skipped | demo-curated-sources |
| 02b-source-discovery-evaluator | completed | 0b77a995f4d4 |
| 03-source-approve | completed | aaf77192e036 |
| 04-source-fetch | skipped | demo-uses-curated-facts |
| 05-fact-extraction | completed | c1a130283049 |
| 06-tool-design | completed | 9acd0b3eb85f |
| 07-tool-impl | completed | 3b9397e9f186 |
| 08-knowledge-index | completed | 8ab3261bed22 |
| 09-contract-files | completed | e580c9360d31 |
| 10-adapter-generation | completed | d3267435b30f |
| 11-benchmark-gen | skipped | demo-uses-human-golden-fixtures |
| 12-benchmark-run | completed | ae1d49208abc |

## Artifact Paths

- manifest: <generated-root>/sqlite-demo/manifest.json
- compile state: <generated-root>/sqlite-demo/.compile/compile-state.json
- knowledge manifest: <generated-root>/sqlite-demo/knowledge/index-manifest.json
- facts: <generated-root>/sqlite-demo/extracted/facts.jsonl
- benchmark report: <generated-root>/sqlite-demo/.compile/benchmark-result.json
