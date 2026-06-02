# Facts

Total facts: 3

## By Type

| Key | Count |
| --- | ---: |
| definition | 1 |
| fact | 1 |
| reference | 1 |

## By Freshness

| Key | Count |
| --- | ---: |
| static | 3 |

## Top Sources

| Source | Facts | Kind | Trust |
| --- | ---: | --- | ---: |
| sqlite-transactions | 1 | docs | 0.98 |
| sqlite-query-plan | 1 | docs | 0.98 |
| sqlite-pragmas | 1 | docs | 0.98 |

## Sample Facts

- **fact** (static, sqlite-transactions) SQLite transactions are atomic: either all changes inside COMMIT persist or none do after ROLLBACK.
- **definition** (static, sqlite-query-plan) SQLite EXPLAIN QUERY PLAN reports whether a statement scans or searches each table or index.
- **reference** (static, sqlite-pragmas) SQLite PRAGMA journal_mode controls rollback journal behavior, including WAL mode selection.
