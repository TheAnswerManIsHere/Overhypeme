# Async Job Queue Hardening — Captured Context (draft, not yet planned)

**Status: context capture only.** This is not a plan under active
Codex review. It exists so the deep technical findings from PR #252's
extended plan-review loop (rounds 18-25 on
`docs/plans/PLAN_VARIANT_INDEPENDENCE.md`) aren't lost when that plan's
scope narrows to defer this work. David's instruction (2026-07-25):
*"Let's put the job queue hardening into another PR that we track
independently. We'll finish the core work of this PR and then start a
completely new round to tackle hardening of the queue. I don't want to
lose the context we've already established so please make sure to
capture it for the next plan we build."*

When this becomes an active plan, it should go through the same
Codex draft-PR review loop
([`docs/ai-context/plan-review-contract.md`](../ai-context/plan-review-contract.md))
as any other feature plan — this document is the starting material, not
a substitute for that process.

## Why this exists — the triggering discovery

While designing a new durable `fact_ai_meme_backfill` queue (PR #252,
rounds 18-24) to satisfy `AGENTS.md`'s async-status rule, the design
needed a fact-level crash-recovery marker (`ai_meme_backfill_status`)
written atomically with the job enqueue, to avoid two failure modes:

1. A worker claims the job and sets `processing` before the enqueuer's
   own status write lands, clobbering it back to `pending` (fixed by
   writing status BEFORE calling `enqueueJob`, not after — converged,
   stays in PR #252's plan).
2. The `enqueueJob` insert throws *after* the status write already
   committed, leaving the fact orphaned at `pending` forever with no job
   to resolve it (the deeper problem — see below).

Round 24 proposed closing gap 2 by wrapping both statements in one
`db.transaction`, using `enqueueJob`'s existing `dbOverride` parameter
for exactly this kind of composition. Round 25 found that fix unsafe:

## The core architectural finding

**`enqueueJob` (`artifacts/api-server/src/lib/asyncJobs.ts:242-317`) is
not safely composable inside a caller-managed transaction when a dedupe
conflict is possible.**

Mechanism, verified against the actual source:

- `enqueueJob(options: EnqueueOptions, dbOverride?: Pick<typeof
  defaultDb, "insert">): Promise<EnqueueJobResult>` accepts a
  `dbOverride` so a caller can run the insert inside its own transaction
  handle (`tx`).
- Its insert can hit a Postgres unique-constraint violation (`23505`) on
  the job's dedupe key — this is the *expected*, common case when a
  fact already has an in-flight job for that queue, not an error
  condition.
- On that conflict, `enqueueJob`'s catch block does a fallback `SELECT`
  to find and return the existing job (`inserted: false`) instead of
  throwing — **but that fallback `SELECT` always queries via the module's
  `defaultDb`, never the caller's `dbOverride`/`tx`.**
- Postgres aborts an entire transaction on any statement error inside
  it, including a caught-and-handled one — the abort happens at the
  database level the instant the `INSERT` fails, regardless of whether
  application code catches the resulting error. So if `enqueueJob` is
  called with a caller-supplied `tx` and the insert hits a dedupe
  conflict, the **outer transaction is aborted** even though
  `enqueueJob`'s own recovery technically succeeds (the fallback read
  returns the right `EnqueueJobResult`) — any other statement run on
  that same `tx` afterward (or the transaction's own commit) fails.

Net effect: wrapping "write fact status" + "enqueueJob" in one
`db.transaction` looks correct and passes the happy path, but breaks
exactly the dedupe scenario the whole queue system is built around —
two overlapping bulk-backfill calls for the same fact, which is a
*normal*, expected occurrence this codebase explicitly tests for
elsewhere (see PR #252's own Testing Plan, "two overlapping bulk-trigger
calls for the same fact dedupe onto one job").

**This makes it genuinely shared, cross-cutting infrastructure work, not
a narrow fix scoped to one queue** — `enqueueJob` is the single shared
enqueue path used by every queue in the repo (`fact_pexels`,
`fact_ai_meme_backfill`, `fact_send_back`, `email`,
`fact_enrichment_backfill`, `fact_visual_concepts`,
`projection_repair`, `image_prompt_generation`, `image_generation`,
`review_render_scenarios_prepare`). A fix has to preserve dedupe-conflict
behavior for every existing caller, most of which call it *without* a
`dbOverride` today.

## What "done" would look like

The underlying goal, unchanged from PR #252's rounds 18-24: make
"write a fact-level status marker" + "enqueue the job that will resolve
it" atomic — either both happen or neither does — for any queue that
needs a crash-recovery-safe status marker (today: the AI-meme backfill
queue's `ai_meme_backfill_status`, and by the same reasoning,
`factPexelsJobs.ts`'s existing `pexelsStatus` write in
`enqueueFactPexels`, which has shipped with the same non-atomic
unconditional-pre-write pattern for longer and was never atomic even
before PR #252 touched it).

Candidate directions (not evaluated or decided — this is capture, not
design):

- Make `enqueueJob`'s dedupe-conflict fallback `SELECT` use whatever db
  handle it was given (its own `dbOverride` or `defaultDb`), so it's
  transaction-safe by construction for every caller. Needs verifying
  this doesn't change behavior for callers relying on `defaultDb` reads
  specifically (e.g. read-after-write consistency assumptions elsewhere).
- Give `enqueueJob` an explicit "composed inside a transaction" mode that
  documents/enforces the caller must pass a `tx`-scoped fallback read.
- Move the dedupe check earlier (a `SELECT ... FOR UPDATE` or advisory
  lock before the insert) so the insert itself can't hit `23505` inside
  the composed transaction in the first place.
- Accept the non-atomic order as permanent for low-stakes queues and
  scope true atomicity only to queues where an orphaned `pending` marker
  has real operational cost.

## A second failure mode — late dedupe during the marker/job-finalization gap

Found in PR #252 round 27, while hardening `fact_ai_meme_backfill`'s own
crash-recovery entry guard (a narrower, related problem to the core
finding above, but distinct — it doesn't require composing `enqueueJob`
inside a transaction at all, so it's a separate mechanism to fix).

**The gap:** a queue job's *fact-level* status marker (e.g.
`ai_meme_backfill_status = "ok"`) is written by the handler as its own
statement, separately from the *job-level* `async_jobs` row being
finalized to `done` by the worker framework after the handler returns.
There is a real, if narrow, window between these two writes. If a second
enqueue call for the same fact lands in that window:

1. The enqueue-side conditional write (`UPDATE facts SET
   ai_meme_backfill_status = 'pending' WHERE ... IS DISTINCT FROM
   'processing'`) fires, because the current value is `"ok"` (distinct
   from `'processing`'), clobbering the fresh `"ok"` back to `"pending"`.
2. `enqueueJob` is then called — the previous job's `async_jobs` row is
   still `processing` (not yet finalized), so its dedupe key is still
   active; the new enqueue call dedupes onto that job instead of
   creating a new one.
3. The original handler has already returned and will never run again.
   Nothing is left to transition the marker back to `"ok"`.
4. Net result: the marker is permanently stuck at `"pending"` despite
   the underlying work having genuinely succeeded.

**Bounded impact, not data loss:** the underlying business data
(`facts.aiMemeImages`, written by the pipeline independently of the
status column) is correct either way — only the polling/observability
marker goes stale. PR #252 ships with this documented as an accepted,
deliberately deferred limitation rather than fixed (Codex round 27
found it, Codex round 28 flagged that this document needed to actually
name it, which this section does).

**Why it's the same family as the core finding, not a duplicate:**
closing this fully needs a way to distinguish "the marker is terminal
because a genuinely new job should now proceed" from "the marker is
terminal because THIS exact job already finished" — i.e. a discriminator
beyond the current status enum (e.g. a per-fact monotonic generation
counter written alongside each enqueue, checked by both the
enqueue-side conditional write and the handler's entry guard). That's
new design surface, not a corollary of fixing `enqueueJob` itself — a
follow-up plan should treat it as a second, separate scope item, not
assume fixing `enqueueJob`'s transaction-composability automatically
resolves it too.

## Scope for the follow-up plan

At minimum, when this becomes an active plan it should:

1. Fix (or deliberately re-confirm as accepted risk, with reasoning) the
   `enqueueJob` transaction-composability gap itself.
2. Apply whatever fix results to **both** queues that need it:
   `fact_ai_meme_backfill`'s `ai_meme_backfill_status` (PR #252 ships
   this non-atomic, by design, per David's 2026-07-25 deferral) and
   `factPexelsJobs.ts`'s `pexelsStatus` (never atomic, pre-existing,
   out of PR #252's scope entirely).
3. Verify every other `enqueueJob` caller's behavior is unchanged
   (regression risk: this is shared infrastructure, not additive).
4. Re-run PR #252's dedupe-conflict test ("two overlapping bulk-trigger
   calls for the same fact dedupe onto one job") against the fixed
   `enqueueJob` to confirm the fix doesn't regress it.
5. Design and fix the late-dedupe/marker-orphaning race described above
   (a per-fact generation discriminator or equivalent), for both queues
   that carry a fact-level status marker — treat this as a distinct
   scope item from #1, not something #1's fix incidentally resolves.
6. Add a regression test for the late-dedupe scenario itself: a second
   enqueue landing between a handler's terminal marker write and its
   job row's finalization to `done` must not leave the marker orphaned
   at `"pending"`.

## Cross-references

- PR #252, `docs/plans/PLAN_VARIANT_INDEPENDENCE.md` — rounds 18-25 of
  Codex review, where the core `enqueueJob` finding was discovered;
  round 27 found the second, late-dedupe race while hardening the
  crash-recovery guard; round 28 required this document to explicitly
  capture that second race rather than only gesture at it. The plan's
  Proposed Design section (AI-meme queue point 3) documents both
  accepted-limitation notes and cites this document.
- `artifacts/api-server/src/lib/asyncJobs.ts:242-317` — `enqueueJob`
  itself.
- `artifacts/api-server/src/lib/factPexelsJobs.ts:57-66` —
  `enqueueFactPexels`, the pre-existing non-atomic precedent.
- `docs/ai-context/architecture-map.md#async-jobs-and-queues` — the
  canonical async-jobs doc, for the shared `async_jobs` table shape and
  lane model this work sits inside.
