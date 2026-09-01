---
name: the git-lock sweeper was deleted — the Replit constraint it worked around is gone, and it could delete a LIVE lock
description: Why scripts/clean-stale-git-locks.sh and its watcher were removed rather than hardened, and what evidence to gather before anyone proposes rebuilding automatic .git lock cleanup.
---

# The git-lock sweeper, and why it is not coming back

## What it was

`scripts/clean-stale-git-locks.sh` plus a `git-lock-watcher` Replit workflow
that ran it every 10 seconds, and a one-shot sweep at the top of
`dev-supervisor.sh` on every workflow start. David had Replit Agent build it
before Claude Code or Codex were involved, for a real problem: a git command
killed mid-write leaves `.git/index.lock` behind, everything then refuses to
run, and **the Replit Agent sandbox could not delete files under `.git/`** — so
the only fix was opening a Shell and running `rm` by hand.

## Why it was deleted (2026-09-01), not hardened

Three findings, in the order that decided it:

1. **The constraint it worked around no longer exists.** Probed live in the
   Repl: `touch .git/__probe && rm .git/__probe` → `agent CAN delete in .git`.
   The Agent can now clear a stale lock itself, on request, in one step.
2. **It had never once done its job.** Every `[git-lock-sweeper]` line in every
   log the Repl could reach was `skip ... too fresh` from its own test suite.
   `ANY_REMOVED=no`. No doc, memory entry or incident in this repo records a
   real stale-lock event; Replit Agent's own answer to "when did this last
   happen" was `unknown`. The watcher workflow was not even running.
3. **It could delete a lock that was in use.** Reproduced deterministically:
   the sweeper checks "is any git process running?", then deletes — and never
   re-checks. A lock git creates in that window is deleted and logged with the
   *old* lock's age:

   ```
   [git-lock-sweeper] removed .git/index.lock (age=600s)
   LIVE lock created by 'git' AFTER pgrep check   <- what it actually deleted
   ```

   Two sweepers could also race each other: `dev-supervisor.sh` ran the sweep
   *before* taking its singleton `flock`, so concurrent workflow starts each
   swept unserialized.

A working fix exists and was prototyped — capture `(inode, mtime)` when a lock
is judged stale, serialize instances with `flock`, and re-`stat` immediately
before `rm`, deleting only if both still match. It passed the race, the
concurrent case, and both controls. **It was still not shipped**, because
hardening a tool with no remaining job only buys maintenance and a second repo
to port it to. That prototype is the starting point if the problem ever returns.

## The rule

**Do not rebuild automatic `.git` lock deletion on the strength of one stale
lock.** Any automated deleter has the same check-then-act hazard, and the cost
of being wrong is a corrupted in-flight git operation — strictly worse than the
inconvenience it prevents.

If stale locks actually recur:

- **First**, just remove the lock — the Agent can now do this directly.
- **If it recurs often enough to automate, automate DETECTION, not deletion**:
  log "stale lock present, remove `.git/index.lock`" and let a human or the
  Agent act. Detection cannot corrupt anything.
- **Only then**, if deletion is genuinely required, start from the re-verify
  design above. Never from a bare stale-age threshold plus a process check.

## The general lesson

A workaround outlives the platform limitation that justified it, and nothing
announces the moment it stops being needed. Before hardening any inherited
workaround, check two things first: whether the underlying constraint still
exists, and whether the tool has ever actually fired. Both answers here were
no, and both were one command away.
