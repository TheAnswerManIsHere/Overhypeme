## Writing a GitHub Action that mutates issue labels concurrently with agents/humans

`scripts/sync-test-run-completion.mjs` (PR #334) writes `stage:`/`waiting:`
labels on a workstream issue that Claude, Codex, and David can all also be
touching at any moment. Getting this safe took ~12 review rounds of
increasingly subtle bugs, each one a real concurrency window the previous
fix didn't close. The settled pattern, in order of what actually broke:

1. **Add-then-clean, never delete-then-add.** Adding a label is idempotent
   (GitHub no-ops on a label that's already there); deleting the old stage
   before adding the new one has a crash window where the issue has NO
   `stage:` label at all — invisible to any dispatch check that looks for
   "which stage is this at," so an interrupted run gets silently abandoned
   instead of resumed.
2. **Revalidate ownership before mutating, not just before dispatching.**
   Re-fetch immediately before writing, and only proceed if the current
   label set is a **subset** of `{expectedFromStage, targetStage}` — not
   just "contains an allowed stage." A non-atomic concurrent swap can leave
   the actor's genuinely-new stage sitting *alongside* the expected old one
   for a moment; a presence-only check passes right through that and the
   cleanup then deletes the new stage as "stale."
3. **"Stale" is the intersection of a `before` snapshot with a fresh `after`
   read — never derived from `after` alone.** Two GETs bracket every
   mutating call; deriving deletions straight from the second GET treats
   anything a concurrent actor added in that gap as fair game to delete,
   including a label your own `before` read never even knew to flag.
   Intersecting only ever *drops* a stale candidate (if the other actor
   already removed it themselves) — it never invents a new one.
4. **A retry must re-derive its target from scratch, not trust the
   dispatch-time read.** A retry (of a partially-completed prior run) can
   start minutes after the read that decided "this needs a UAT transition."
   By execution time the issue may have moved on for a completely unrelated
   reason. Re-fetch and recompute the same deterministic target the retry
   is *supposed* to be finishing, and bail if the current state no longer
   matches it — don't blindly reconcile toward a stage that's stale by the
   time you get there.
5. **Know where you stopped tightening.** Revalidating immediately before
   every downstream side-effect (a board sync, a body PATCH) chases an
   unreachable asymptote — every sequential REST call has a gap after it
   where something can change, and there's no compare-and-swap primitive on
   labels/issues to close it to zero. The defensible stopping point:
   harden the *authoritative* state (labels) as hard as you can, then treat
   projections of it (a board mirror, a narrative body block) as
   self-healing best-effort — a rare race leaving a projection briefly
   stale corrects itself the next time anything touches the issue, rather
   than being a silent permanent rollback of someone else's real work.

See `docs/ai-context/workstream-tracking.md` for what this Action owns; see
the script's own comments for the current, load-bearing implementation of
each point above.
