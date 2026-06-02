# Refresh Scheduler Contract

This document defines the stable contract for wiring `almanac refresh due` and
`almanac refresh run` into cron, GitHub Actions, launchd, or another
caller-owned scheduler.

Almanac v0.6 is scheduler-ready, not a resident daemon. The scheduler owns when
to wake up. Almanac owns deterministic due detection, safe refresh execution,
locking, benchmark validation, and saved refresh artifacts.

## Command Contract

Use `refresh due` as the read-only planning step:

```bash
almanac refresh due <id> --json --root "$ALMANAC_ROOT"
```

`refresh due` does not mutate the almanac, does not fetch sources, does not run
LLM stages, and does not require provider credentials. It returns JSON with:

- `due`: whether any refresh reason is present
- `recommendedFromStage`: the earliest stage that should be rerun
- `reasons`: stable reason codes such as `source-expired`, `stage-failed`,
  `stage-pending`, `benchmark-missing`, and `benchmark-failed`
- source freshness counts and next due timestamp
- benchmark status

Use `refresh run` as the mutating step:

```bash
almanac refresh run <id> --save --label cron-nightly --root "$ALMANAC_ROOT"
```

When `--from-stage` is omitted, `refresh run` uses the same
`recommendedFromStage` that `refresh due` would report. Use an explicit stage
when the scheduler policy is intentionally narrower or broader:

```bash
almanac refresh run <id> \
  --from-stage 04-source-fetch \
  --save \
  --label cron-nightly \
  --root "$ALMANAC_ROOT"
```

The recommended default for routine refreshes is `04-source-fetch`. Earlier
source discovery stages are available, but should be explicit because they are
LLM-heavy and can change the accepted source set.

## Exit Codes

`almanac refresh due` exits `0` when it can produce a status, whether the
almanac is due or not due. It exits nonzero when the almanac cannot be read or
an artifact is invalid.

`almanac refresh run` uses these command-facing exit codes:

| exit | meaning |
| ---: | ------- |
| `0` | Refresh completed successfully, or no refresh was due and no explicit `--from-stage` was supplied. |
| `1` | The update pipeline or benchmark run failed, or the almanac could not be read. |
| `2` | Refresh was blocked by the per-almanac lock, or CLI usage was invalid. |

Schedulers should treat `0` as success, `1` as a failed refresh attempt, and
`2` as either "another refresh is already running" or operator error. JSON
output includes `status`, `exitCode`, `effectiveFromStage`, stage summaries,
benchmark summaries, and saved artifact location when `--save` is set.

## Provider Credentials

`refresh due` needs no provider keys.

`refresh run` reuses the compile/update pipeline. The required keys depend on
the starting stage:

- `ANTHROPIC_API_KEY` is required for normal LLM-driven stages such as source
  evaluation, fact extraction, tool design, and benchmark generation.
- `BRAVE_SEARCH_API_KEY` is required only for source discovery paths that use
  web search.
- `GITHUB_TOKEN` is optional but recommended for GitHub source discovery and
  repository snapshots to avoid low unauthenticated rate limits.
- Embedding keys are needed only when vector indexing is configured.

For CI, fail before running a networked refresh if required keys are missing:

```bash
test -n "$ANTHROPIC_API_KEY" || {
  echo "ANTHROPIC_API_KEY is required for refresh run"
  exit 1
}

almanac refresh run enterprise-ai \
  --save \
  --label "nightly-${GITHUB_RUN_ID:-local}" \
  --json \
  --root "$ALMANAC_ROOT"
```

## Locking

`refresh run` acquires a per-almanac lock at `.compile/refresh.lock` before it
mutates compile state. A second refresh exits with status `locked` and exit
code `2`.

Do not delete the lock automatically in scheduler scripts. Treat lock cleanup
as an operator action after checking whether the recorded process is still
running. The lock payload can include the pid, command, and acquired timestamp.

A lock conflict is still useful evidence when `--save` is set: the refresh
artifact records `status: "locked"` and the lock holder details.

## Saved Refresh Artifacts

Use `--save` for scheduled runs. Saved artifacts are written under
`.runs/refresh-*.json` and can be inspected through the normal run artifact
viewer:

```bash
almanac runs <id> --kind refresh --latest --root "$ALMANAC_ROOT"
almanac runs <id> <refresh-id> --root "$ALMANAC_ROOT"
```

Use labels that identify the scheduler and cadence:

```bash
almanac refresh run enterprise-ai \
  --save \
  --label cron-nightly \
  --note "nightly production refresh" \
  --root "$ALMANAC_ROOT"
```

If the almanac has ask replay fixtures, add the deterministic answer suite gate
to the refresh command:

```bash
almanac refresh run enterprise-ai \
  --save \
  --label cron-nightly \
  --ask-suite \
  --root "$ALMANAC_ROOT"
```

`--ask-suite` runs after an `ok` refresh or a `not-due` decision. It does not
call an LLM provider. A failing suite changes the refresh result to `failed`;
missing or invalid ask fixtures use setup exit code `2`.

Saved refresh artifacts intentionally do not store API keys, environment dumps,
raw provider requests, raw provider responses, or unredacted secrets from tool
input.
When `--ask-suite` is used, artifacts store only aggregate suite status,
fixture counts, quality counters, and fixture file paths.

`inspect`, `profile`, and `doctor` show the latest saved refresh run. A latest
`failed` or `locked` refresh is surfaced as a health/readiness signal even if
the currently compiled almanac still serves.

## Retention And Export

The `.runs/` directory is excluded from `almanac export` by default. Include it
only when the receiver should see operational history:

```bash
almanac export <id> --include-runs --root "$ALMANAC_ROOT"
```

Pruning is dry-run by default and can target refresh artifacts without touching
tool artifacts:

```bash
almanac runs <id> \
  --kind refresh \
  --prune \
  --keep-latest 30 \
  --dry-run \
  --root "$ALMANAC_ROOT"

almanac runs <id> \
  --kind refresh \
  --prune \
  --older-than 30d \
  --apply \
  --root "$ALMANAC_ROOT"
```

## Cron Example

This example runs hourly. It checks due status first and only runs refresh when
needed.

```bash
#!/usr/bin/env bash
set -euo pipefail

export ALMANAC_ROOT="/srv/almanacs"
ALMANAC_ID="enterprise-ai"

due_json="$(mktemp)"
almanac refresh due "$ALMANAC_ID" --json --root "$ALMANAC_ROOT" > "$due_json"

if jq -e '.due == true' "$due_json" >/dev/null; then
  from_stage="$(jq -r '.recommendedFromStage' "$due_json")"
  almanac refresh run "$ALMANAC_ID" \
    --from-stage "$from_stage" \
    --save \
    --label "cron-hourly" \
    --json \
    --root "$ALMANAC_ROOT"
fi
```

Cron entry:

```cron
17 * * * * /srv/almanac-refresh-enterprise-ai.sh >> /var/log/almanac-refresh.log 2>&1
```

## GitHub Actions Example

```yaml
name: almanac refresh

on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:

jobs:
  refresh:
    runs-on: ubuntu-latest
    env:
      ALMANAC_ROOT: ${{ github.workspace }}/.almanacs
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      BRAVE_SEARCH_API_KEY: ${{ secrets.BRAVE_SEARCH_API_KEY }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Check due status
        id: due
        run: |
          bun src/cli.ts refresh due enterprise-ai \
            --json \
            --root "$ALMANAC_ROOT" > due.json
          echo "due=$(jq -r '.due' due.json)" >> "$GITHUB_OUTPUT"
          echo "from_stage=$(jq -r '.recommendedFromStage' due.json)" >> "$GITHUB_OUTPUT"
      - name: Run refresh
        if: steps.due.outputs.due == 'true'
        run: |
          bun src/cli.ts refresh run enterprise-ai \
            --from-stage "${{ steps.due.outputs.from_stage }}" \
            --save \
            --label "github-actions-${{ github.run_id }}" \
            --json \
            --root "$ALMANAC_ROOT"
      - name: Inspect latest refresh
        if: always()
        run: |
          bun src/cli.ts runs enterprise-ai \
            --kind refresh \
            --latest \
            --json \
            --root "$ALMANAC_ROOT" || true
```

This example assumes the almanac directory is restored or created earlier in
the workflow. If the almanac lives outside the repository, add explicit cache,
artifact download, or deployment storage steps.

## launchd Example

Use a shell script for the actual refresh logic, then let launchd schedule it.

`/Users/example/bin/almanac-refresh-enterprise-ai.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

export ALMANAC_ROOT="$HOME/Library/Application Support/almanac"
export ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s ALMANAC_ANTHROPIC_API_KEY -w)"

almanac refresh run enterprise-ai \
  --save \
  --label launchd-hourly \
  --root "$ALMANAC_ROOT"
```

`~/Library/LaunchAgents/com.example.almanac-refresh-enterprise-ai.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.almanac-refresh-enterprise-ai</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/example/bin/almanac-refresh-enterprise-ai.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>/tmp/almanac-refresh-enterprise-ai.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/almanac-refresh-enterprise-ai.err</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.example.almanac-refresh-enterprise-ai.plist
```

## Promotion Checklist

Before relying on a scheduled refresh in production, run these once manually:

```bash
almanac doctor <id> --root "$ALMANAC_ROOT"
almanac refresh due <id> --json --root "$ALMANAC_ROOT"
almanac ask-suite <id> --json --root "$ALMANAC_ROOT"
almanac refresh run <id> --save --label scheduler-smoke --ask-suite --json --root "$ALMANAC_ROOT"
almanac runs <id> --kind refresh --latest --json --root "$ALMANAC_ROOT"
almanac inspect <id> --root "$ALMANAC_ROOT"
almanac profile <id> --root "$ALMANAC_ROOT"
```

The scheduler is ready when:

- `doctor` has no failures,
- `refresh run` exits `0`,
- the latest refresh artifact is visible through `runs`, `inspect`,
  `profile`, and `doctor`,
- benchmark status is passed,
- ask-suite status is passed when ask fixtures are configured,
- retention and export choices are explicit for `.runs/`.
