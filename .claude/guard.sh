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
# So this hook does not try to reimplement it. Its FIRST job is to make the LEASE
# MANDATORY on the branches this session owns, because the container is
# ephemeral: the local reflog dies with it, so an overwritten remote branch has
# no second copy to recover from. Note what the ruleset above does and does not
# cover: it protects `main` and does NOT target `claude/*` or `plan-review/*`,
# so on the branches the lease rule actually governs, this hook is the ONLY
# line -- not the third one.
#
# Its SECOND, independent job as of 2026-08-17 is refusing `curl` and `wget`
# -- a different failure mode, silent rather than destructive. Neither job is
# backstopped server-side; they differ in how they FAIL, not in what stands
# behind them. See docs/ai-context/decisions.md, 2026-08-17.
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
#
# BUT BOTH JOBS LIVE IN guard-decision.mjs, SO THE FALLBACK DELIVERS NEITHER IN
# FULL. It is stricter than the parser on force pushes and has NO fetcher
# alternative at all: a `curl` payload exits 0 here. Measured, not assumed
# (#499 round 3). So the SECOND job above is a property of the node path, not
# of this file -- which is the honest scope of every "refuses curl and wget"
# claim in this repo. Closing it is a behavioral change and belongs in its own
# bugfix PR, not in the documentation harvest that found it.
set -uo pipefail

payload=$(cat)
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1; then
  printf '%s' "$payload" | node "$here/../scripts/guard-decision.mjs"
  exit $?
fi

if printf '%s' "$payload" | grep -Eq 'drizzle-kit[[:space:]]+push|rm[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+/|git[[:space:]]+.*push[[:space:]].*(--force|--mirror|-[a-zA-Z]*f[a-zA-Z]*)|git[[:space:]]+update-ref'; then
  echo "Guard: blocked a destructive command (node unavailable -- conservative fallback)" >&2
  exit 2
fi
exit 0
