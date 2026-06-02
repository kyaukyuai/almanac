# Tools

| Name | Enabled | Volatility | Freshness | Facts | Network |
| --- | --- | --- | --- | --- | --- |
| fetch_official_docs | yes | slow | ttl 2592000s | no | www.sqlite.org |
| latest_releases | yes | fast | ttl 86400s | no | api.github.com |
| query_facts | yes | slow | manual-refresh | yes |  |
| web_search_recent | yes | fast | ttl 86400s | no | html.duckduckgo.com |

## Descriptions

### fetch_official_docs

Fetch a single page of official documentation by URL. Returns the raw body (truncated at 200KB).

When to use: Use when the user needs the canonical, up-to-date version of an official documentation page. The URL must be on the manifest's network allowlist.

### latest_releases

Fetch recent releases for one GitHub repository via api.github.com.

When to use: Use when the user asks about new versions, changelogs, or recent releases of a tool/library tracked in this almanac.

### query_facts

Search the indexed fact store (FTS5) for facts matching a free-text query. Returns hits with citations.

When to use: Use for any factual recall against this almanac's domain — definitions, procedures, references, or static facts. Prefer this over web search for established knowledge.

### web_search_recent

Recent-bias web search via DuckDuckGo HTML. Returns the top results for the query.

When to use: Use when the user asks about recent events, news, or topics outside the cached fact store. Pair with `fetch_official_docs` to follow promising results.
