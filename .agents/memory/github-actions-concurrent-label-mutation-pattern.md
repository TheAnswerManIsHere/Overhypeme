## Writing a GitHub Action that mutates issue labels concurrently with agents/humans

> **The worked example is retired; the pattern is not.**
> `scripts/sync-test-run-completion.mjs` (PR #334), which this note was
> extracted from, was deleted 2026-08-15 along with the
> `test-run-completion.yml` Action and the TEST_RUN file pattern it served
> (see `decisions.md`, 2026-08-15) — do not go looking for the script or
> schedule verification of it. This note survives as design history: the
> settled shape for **any future** Action that mutates labels concurrently
> with agents/humans, bought with ~12 review rounds that should not be
> re-paid.

The original context: the script wrote `stage:`/`waiting:`
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
   **stage** label set is a **subset** of `{expectedFromStage, targetStage}`
   — not just "contains an allowed stage." A non-atomic concurrent swap can
   leave the actor's genuinely-new stage sitting *alongside* the expected
   old one for a moment; a presence-only check passes right through that
   and the cleanup then deletes the new stage as "stale." **This
   revalidation covers `stage:` labels only — it does not extend to
   `waiting:` labels.** A concurrent actor that changes only the `waiting:`
   label (stage unchanged) passes the check undetected, and that
   newly-asserted `waiting:` label is then classified stale by point 3
   below and deleted, the same way the DELETE-loop race in point 3
   deletes a freshly-asserted label. Left as an accepted residual per
   point 5, not a claim that ownership is validated for every label this
   pattern touches.
3. **"Stale" is the intersection of a `before` snapshot with a fresh `after`
   read — never derived from `after` alone.** The two GETs bracket the
   mutating **POST** (the add call) that sits between them; deriving
   deletions straight from the second GET would treat anything a concurrent
   actor added in that gap as fair game to delete, including a label your
   own `before` read never even knew to flag. Intersecting only ever *drops*
   a stale candidate (if the other actor already removed it themselves) — it
   never invents a new one. **This does NOT bracket the DELETE calls that
   follow** — they run sequentially after the single `after` GET, so a race
   in that narrower window (a concurrent actor removes, then re-adds, the
   same-named label between the `after` read and this loop's own DELETE of
   it) still deletes the actor's newly-asserted label; a name-based
   intersection can't tell "still the original stale instance" from "a fresh
   instance that happens to share the name." Left as an accepted residual
   per point 5 below, not a claim that every mutation is race-free.
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
   **The body PATCH is the one exception this "self-healing" framing does
   not cover.** The script re-fetches the body immediately before the PATCH
   to narrow (not eliminate) the window, but it is explicitly not a
   conditional/CAS write — a concurrent body edit landing in that narrower
   window is silently overwritten, permanently, since this script only
   fires again on a future TEST_RUN-doc deletion for that *same* PR, which
   won't happen twice. Don't assume a lost body edit here self-corrects;
   it needs a human to notice and fix it manually.

`docs/ai-context/workstream-tracking.md` records what this now-retired
Action used to own. The script itself is deleted (per the header above) —
there is no live implementation to consult; the points above are the
complete, standalone record of the pattern.
