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
# So this hook does not try to reimplement it. It has SEVERAL responsibilities
# and this list is NOT exhaustive -- read guard-decision.mjs for the authority:
#
#   - Making the LEASE MANDATORY on the branches this session owns. The
#     container is ephemeral: the local reflog dies with it, so an overwritten
#     remote branch has no second copy to recover from.
#   - Refusing `curl` and `wget` (2026-08-17) -- a silent failure mode rather
#     than a destructive one. See docs/ai-context/decisions.md, 2026-08-17.
#   - Refusing root-shaped `rm -rf` and `drizzle-kit push`, which belong to
#     neither of the above and predate both.
#
# An earlier version of this header called the lease the "FIRST" job and the
# fetcher refusal the "SECOND", which reads as exhaustive and is false -- a
# maintainer could conclude their command is outside the guard's contract when
# it is not. Ordinals are avoided here for that reason. (Codex, #499 round 4.)
#
# Note what the ruleset above does and does not cover: it protects `main` and
# does NOT target `claude/*` or `plan-review/*`, so on the branches the lease
# rule actually governs, this hook is the ONLY line -- not the third one. No
# responsibility above is backstopped server-side; they differ in how they
# FAIL, not in what stands behind them.
#
# The decision logic lives in scripts/guard-decision.mjs -- next to the repo's
# other guards, unit-tested in scripts/__tests__/guard-decision.test.mjs, and
# wired into build.yml. Keeping it there rather than inline is what lets the
# block/allow matrix be asserted rather than asserted-about; the previous
# version of this file blocked `git push --force` while waving `git push -f`
# straight through, and nothing would have caught that.
#
# If node is unavailable this falls back to the regex scan below. Its coverage
# is MIXED -- not "weaker", and not "stricter" either. Both adjectives were
# tried here and both were false. Measured (#499 rounds 3-4):
#
#   command                                       node path   fallback
#   git push -f origin claude/x                    BLOCK       BLOCK
#   git push --force-with-lease origin claude/x    allow       BLOCK   <- stricter
#   git-push -f origin claude/x                    BLOCK       allow   <- LOOSER
#   rm -rf /                                       BLOCK       BLOCK
#   drizzle-kit push                               BLOCK       BLOCK
#   curl https://api.github.com/x                  BLOCK       allow   <- LOOSER
#
# So the fallback over-blocks the one permitted force push, and under-blocks
# both the direct `git-push` executable form and every fetcher. Any claim that
# a responsibility above holds "in the guard" is really a claim about the node
# path; only the rows marked BLOCK in both columns hold unconditionally.
# Closing the two LOOSER rows is a behavioral change and belongs in its own
# bugfix PR, not in the documentation harvest that found them.
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
