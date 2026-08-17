#!/usr/bin/env bash
# Hard guard: blocks irreversible/destructive commands even under bypassPermissions.
#
# This hook is the THIRD line of defence for `main`, not the first. Above it sit
# the harness classifier (which refuses to let this session edit its own
# guardrails without David approving the write) and GitHub's ruleset on `main`
# -- Block force pushes, Restrict deletions, Require linear history, Require a
# pull request before merging, Require status checks to pass, all verified ON
# on 2026-08-05. That ruleset is the real control: server-side, applied to every
# actor, and not dependent on a local regex enumerating every spelling.
#
# So this hook does not try to reimplement it. Its one job is to make the LEASE
# MANDATORY on the branches this session owns, because the container is
# ephemeral: the local reflog dies with it, so an overwritten remote branch has
# no second copy to recover from.
#
# The decision logic lives in scripts/guard-decision.mjs -- next to the repo's
# other guards, unit-tested in scripts/__tests__/guard-decision.test.mjs, and
# wired into build.yml. Keeping it there rather than inline is what lets the
# block/allow matrix be asserted rather than asserted-about; the previous
# version of this file blocked `git push --force` while waving `git push -f`
# straight through, and nothing would have caught that.
#
# If node is somehow unavailable this falls back to a conservative regex scan
# that blocks every force push including the permitted one -- degraded, never
# weaker than the version it replaced.
set -uo pipefail

payload=$(cat)
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1; then
  printf '%s' "$payload" | node "$here/../scripts/guard-decision.mjs"
  exit $?
fi

# Two judgements sit behind this hook, and they must stay isolated in the
# degraded path exactly as they are in scripts/guard-decision.mjs. Running both
# greps over every payload leaks in both directions: a commit message quoting
# "@codex review" gets refused as a review request, and an ordinary PR comment
# quoting a force push gets refused as a destructive command. So route on
# tool_name first. An unrecognised payload shape runs BOTH scans -- if we
# cannot tell what this is, both refusals apply. (Codex, round 2.)
scan_destructive() {
  if printf '%s' "$payload" | grep -Eq 'drizzle-kit[[:space:]]+push|rm[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+/|git[[:space:]]+.*push[[:space:]].*(--force|--mirror|-[a-zA-Z]*f[a-zA-Z]*)|git[[:space:]]+update-ref'; then
    echo "Guard: blocked a destructive command (node unavailable -- conservative fallback)" >&2
    exit 2
  fi
}

# Reading the budget receipts needs node, so the fallback cannot check the
# count -- and a budget guard that fails OPEN is a budget guard that disappears
# exactly when something is already wrong. The degraded path therefore refuses
# the review request outright and says why.
scan_review_request() {
  if printf '%s' "$payload" | grep -Eqi '@codex[[:space:]]+review'; then
    echo "Guard: blocked an @codex review post -- the round budget cannot be checked (node unavailable -- conservative fallback)" >&2
    exit 2
  fi
}

if printf '%s' "$payload" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"Bash"'; then
  scan_destructive
elif printf '%s' "$payload" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"mcp__github__'; then
  scan_review_request
else
  scan_destructive
  scan_review_request
fi
exit 0
