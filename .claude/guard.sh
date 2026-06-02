#!/usr/bin/env bash
# Hard guard: blocks irreversible/destructive commands even under bypassPermissions.
# Scans the raw PreToolUse payload (no external deps). Errs toward over-blocking.
payload=$(cat)
if echo "$payload" | grep -Eq 'drizzle-kit[[:space:]]+push|rm[[:space:]]+-rf[[:space:]]+/|git[[:space:]]+push[[:space:]].*--force|git[[:space:]]+reset[[:space:]].*--hard'; then
  echo "Guard: blocked a destructive command (drizzle-kit push / rm -rf / / force push / hard reset)" >&2
  exit 2
fi
exit 0
