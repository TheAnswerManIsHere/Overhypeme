---
name: overhype-implementation
description: Implement an already-approved Overhype.me plan safely. Use when David asks to build/implement a plan he has explicitly approved. Re-reads the plan + relevant context docs, stays in scope, makes the smallest coherent change, runs the repo's real tests, and reports files changed / tests run / failures / risks. Stops and reports if the implementation reveals a plan-breaking issue instead of improvising a major change.
---

# Overhype implementation

Turn an **approved** plan into a safe, in-scope change.

## Preconditions

- The plan must be **explicitly approved by David.** If it isn't, stop — this is
  the wrong skill (use `overhype-plan-review` first).
- Re-read: [`AGENTS.md`](../../../AGENTS.md), [`.agents/PLANS.md`](../../../.agents/PLANS.md),
  the approved plan, and the relevant `docs/ai-context/*` files for the subsystem.

## Do

0. **If this plan ships in phases and the phase you're starting has no
   sub-issue yet** — its Phases checklist line still reads `not yet
   opened` — open it now, before touching code. Per
   [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
   *Phased features* section: full label set (`stage:coding`, `waiting:`
   set to whoever's about to hold it, `mode:feature`), linked under the
   parent as a native sub-issue, `Workstream: #<phase-issue>` on the
   eventual PR. Update the checklist line from `not yet opened` to the new
   issue number in the same edit. This applies identically to phase 1 and
   phase 8 — `plan-review-loop` only ever writes the checklist at
   approval, never opens a phase itself, so this is the one place every
   phase actually starts.
   **In the same edit, also move the parent** to `stage:coding` with
   `waiting:` mirroring whoever now holds the phase, and update its State
   of Play. This matters most at phase 1: `plan-review-loop`'s handoff
   leaves the parent at `stage:plan-approval`/`waiting:david`, and nothing
   else transitions it out of that — without this step the parent sits
   labeled "awaiting approval" for the entire build, `/status-all` reports
   a stale gate, and `pr-watch`'s later toggles only ever touch `waiting:`,
   never repairing a wrong `stage:`. For phase 2 onward this is a no-op
   (`pr-watch` already holds the parent at `stage:coding`), so it's safe
   to apply unconditionally rather than special-casing phase 1.
1. **Confirm the affected files** by inspecting them before editing.
2. **Make the smallest coherent change** that satisfies the plan. No scope creep,
   no speculative abstraction, no new external vendor.
3. **Preserve the invariants** the context docs call out — human overrides survive
   re-enrichment; single source of truth; runtime matches preview; server-side
   permissions; async status per-item + aggregate; ship the UI surface with the
   behavior.
4. **Update docs** in the same change if product/architecture truth shifts
   (`docs/ai-context/*`), so the next agent isn't working from stale context.
5. **Run relevant tests** via the repo runners (see
   [`docs/tests/TESTING.md`](../../../docs/tests/TESTING.md)) —
   never raw `node --test`. Add regression tests that prove the general invariant.

## Stop-and-report

If implementation reveals a **plan-breaking issue** (the design doesn't fit, a
source-of-truth conflict, a needed schema change the plan didn't cover, or genuine
product ambiguity), **stop and report it to David** — do not improvise a major
architecture change mid-build.

## Report after

- Files changed.
- Tests run (exact commands) + results; valid failures vs environment/deferred-to-CI.
- What remains risky or unverified.
