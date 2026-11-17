# Plan — background jobs resume after the server stops mid-job

Workstream: Issue #1000. Tier: production phase, `sensitive` (spend and email).

```plan-oracle
# Oracle — background jobs resume after the server stops mid-job (Issue #1000)

Agreed with David 2026-11-17 (scope banner; "q12 1").

**Why (David, verbatim):** "I deferred the hardening work that is necessary to resume renders when the dev server stops mid-render. This is happening all the time now so we must complete the work to allow renders to be picked back up in the event that the server stops or is restarted during the process."

**Direction:** the deferred-work entry "Async-jobs reclaim finalize has no fencing token (PR #283)" (docs/engineering/deferred-work.md), placed in launch Phase 11 as a Seed blocker, built now.

**Product intent**
1. A job the server was running when it stopped is picked up again within about two minutes of a server being up, instead of after 30 minutes.
2. A job that is still genuinely running is never taken from under itself: nothing runs twice, nothing is paid for twice.
3. When an image request already reached the image service before the stop, the resumed job collects that picture rather than paying for a new one.
4. The moderator's tile tells the truth throughout: "Drawing…" only while something is actually drawing.

**Must not change:** what a render produces; the retry rules; what any queue does when the server does not stop.

**Now (Q12: 1 — every queue, renders first):** claims kept alive while a job runs; quick reclaim once the holder has gone quiet; an ownership check before the costly step and at finish; collecting an already-submitted image instead of resubmitting; a time limit per job (under the reclaim window); a no-duplicate key on email sends.

**Next / never:** nothing else folded in. Production uses the same code, so it benefits.

**Tier:** production phase, full ceremony; touches spend and email, so the specialist review applies.

**Evidence (development database, 2026-11-17):** render instance f9facfb7… last heartbeated 13:03:56 UTC with one job in flight (job 56874); its image request was recorded at 13:03:01 with no vendor request id; a new instance took over and the job stayed `processing`. The API server logged "Server listening" eight times that day.
```

## The problem, measured

On 2026-11-17 the development API server started eight times. Render-lane instance `f9facfb7…` last heartbeated at 13:03:56 UTC with one job in flight (job 56874, a moderation test render). Its image request had been recorded at 13:03:01 with no vendor request id. The new instance never touched the job: a `processing` row is reclaimed only once it is 30 minutes old (`RECOVER_STUCK_CUTOFF_MIN`), and the sweep runs inside a lane tick, so it waits behind that tick's batch.

Three things in today's code make a stop expensive:

- **No owner on a claim.** `asyncJobsTick` marks a row `processing` and nothing records who holds it, so the only way to tell a dead holder from a slow one is age.
- **Finish by row id alone.** A reclaimed job's original holder, if it was only slow, still finalizes and overwrites the second run (the deferred entry).
- **The image request's receipt is saved after the wait.** `imageGenerationHandler` calls `fal.subscribe`, which submits and waits; the vendor request id is written only when it returns. A stop during the wait loses the handle to a picture that is still being drawn and billed.

## Settled decisions this plan follows

- Q12: 1 (David, 2026-11-17): every queue, renders first.
- 2026-11-07 (`decisions.md`): comparison runs "fail ambiguous rather than call again". Their own resume path (request id stored before polling, `planning`/`requestSettings` markers) is kept unchanged.
- 2026-11-10 (`decisions.md`): an image's cost matters to David approximately, about a cent.
- Paid AI runs by agents stay within the fleet budget; nothing here adds a paid run to CI.

## Design

### A. Every claim has an owner and a lease (all queues)

- A claim stamps three things on the row: the claiming **instance id** (the id `worker_lane_heartbeats` already uses), a fresh **lease token**, and a **lease expiry** 90 seconds out.
- The **lease is renewed** every 20 seconds for every row the instance holds, by a timer of its own. It is not inside a lane tick, so a long bulk batch cannot hold it up. If a renewal finds the token changed or the lease already expired, that invocation has **lost ownership for good**: it starts no further effects.
- **Reclaim** runs every 30 seconds, also on its own timer. A `processing` row whose lease has expired goes back to `pending`, and the reclaim is logged with the old owner. Worst case from a stop to being picked up again: 90 s for the lease to lapse, plus up to 30 s to the sweep, plus the lane's poll interval. That is about two minutes (intent 1).
- **A claim takes only as many rows as there are free slots**, so no claimed job waits locally while its lease runs. Today a tick claims ten and runs them at bounded concurrency.
- **Ownership is enforced at each effect, atomically.** Ownership means the invocation's token, the row still `processing`, and an unexpired lease. Every finish (done, failed, retry), every domain write a second run would also make, every child-job enqueue and every abandonment hook runs inside a short transaction. That transaction locks the job row and checks ownership, so a reclaim cannot slip between the check and the write. A run that fails the check writes nothing and logs it. `onAbandon` runs only after a fenced terminal transition succeeds. A request already sent to a vendor is not undone by this. It follows its recovery protocol (C, F).
- **Recovered work runs only on a handler that knows how to recover it.** A handler declares the recovery protocol version it implements for its queue (none, until its increment builds it). A row taken back from a stopped holder for a queue that declares recovery goes to a new status, `recovering`, stamped with the protocol version it requires, and it **stays** `recovering`, through every later retry, deferral and reclaim, until it finishes. A worker claims a `recovering` row only if its own handler for that queue declares at least that version. So at every release boundary:
  - before this work → increment 1: the old code claims only `pending`, and increment 1 emits no `recovering` rows (no queue declares recovery yet);
  - increment 1 → 2: increment 2 emits `recovering` for the render queues only; an increment-1 worker's render handlers declare nothing, so it never claims them;
  - increment 2 → 3: the same for the remaining queues.
  Fresh `pending` work behaves as today on any version.
- **Increment 1 prepares every consumer of the status before any row carries it:** the dedupe index and the enqueue conflict lookup treat `recovering` as in flight, so a second job with the same key is refused rather than duplicated; the queue-health page and every other reader of job status map it.
- **Fast reclaim is switched on per queue**, only once that queue's recovery is built (C, E, F). Until then a queue keeps today's 30-minute rule.
- **Rows claimed by the old code** (no lease token) keep the 30-minute rule. During a deploy an old, unfenced worker can still be running one, and reclaiming it fast would double-run it. That means such a row, left by the last pre-release stop, still waits 30 minutes, once.

### B. Healthy long work is never cut short; a wedged run is (all queues)

Reclaim is decided by the lease, which a live run keeps renewing, not by how long the job has been running. A slow but healthy job is never reclaimed.

A **per-queue execution limit** frees a run that is alive but wedged. Each limit is derived from the queue's full permitted execution, retries included, with margin:
- prompt planning: two calls of 180 s each, so 10 minutes;
- image generation: submit, plus the provider's queue and drawing, plus storing, so 15 minutes;
- comparison: its own polling allowance plus margin;
- each other queue: its slowest permitted path, plus margin, listed in the build.

At its limit, the run's effect context is **stopped permanently**: local waits are aborted, and every later effect or paid-dispatch check from that invocation is refused at once, even though its lease may have up to 90 seconds left (the lease alone would still admit a late write in that interval). The timeout supervisor then makes the fenced retry-or-failure transition, if it still owns the claim, with the reason. An image request already sent to the provider is not discarded: its request id is on record, so the next run collects it (C) rather than submitting again.

These limits are longer than the 90-second lease. The oracle's words "a time limit per job (under the reclaim window)" assumed the 30-minute reclaim; David replaced them (Q15: 1).

### C. Image renders collect, never re-pay (intent 3)

- **Submit and wait become two steps.** The image handler submits with one POST, reusing the comparison's single-submission transport, which avoids the SDK's own submit retries. It stores fal's request id on the attempt's `image_generation_requests` row immediately, then waits on status and result with the endpoint and input it recorded.
- **A resumed render reads its request row first:**
  - **Request completed successfully:** go straight to storing it.
  - **Request still queued or running:** collect it. Nothing is submitted.
  - **Request failed** (including a content refusal): the existing retry rules apply, exactly as for an uninterrupted failure. A new attempt submits again, as today. A known failure is never "collected" repeatedly.
  - **Request row written but no request id** (the server stopped between submit and store): input and time identify *candidates*, never ownership. fal's request history (`GET https://api.fal.ai/v1/models/requests/by-endpoint`, documented with `request_id`, `sent_at`, inputs on payload expansion, and pagination) is searched, every page, from our row's write time. The request is collected only when the association is unambiguous: **exactly one** history candidate with our recorded input, and **no other unresolved request row of ours** (no request id yet) with the same endpoint and input, whenever it was recorded: an earlier-recorded request can have submitted later. A candidate already associated with another request is unavailable. The association is written atomically, so a concurrent recovery cannot claim the same request. Anything else is ambiguous.
  - **Ambiguous:** zero matches, more than one, a competing unresolved request of ours, a history lookup that fails, or a response missing its payloads. It is never treated as "no request existed". It is run again automatically and logged (Q13: 1). Storing the receipt the moment fal returns it already shrinks this window to milliseconds; the long wait while the picture draws is fully recoverable.
- **Picture already stored and recorded** but the job not finished: finish without drawing again.
- **Increment 1 measures the history**, using the app's own key. One real request, within the paid-run budget (about 5 cents), checks whether it appears in the history while still queued and running, with its input. If it does not appear reliably, every lost-id case is ambiguous, and the plan says so to David before the image increment builds on it.

### D. The tile tells the truth (intent 4)

One shared status mapping, read by every consumer (the moderation tile, the gag card, the eval pages). It comes from the job's state, its lease, and the provider's reported progress (`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`):

| Tile | When |
|---|---|
| Queued… | job pending, or held and preparing, or waiting in the provider's queue |
| Drawing… | the provider reports the request in progress |
| Picking back up… | the previous holder stopped; waiting for reclaim, or checking an interrupted request |
| Saving… | the provider finished; the picture is being stored |
| Retrying shortly | a retryable failure waiting for its automatic retry |
| Failed (reason) | terminal failure, or retries exhausted |

- Every in-flight state keeps the page polling and keeps "Draw again" unavailable.
- A successful resumed render clears the earlier attempt's error, since today an error outranks a stored picture.

### E. Email (intent 2)

- Before the first possible send, the job stores two things: the **resolved outgoing message** (from, reply-to, to, subject, body), and a stable **idempotency key** derived from the job id. Every attempt sends that stored message with that key, so a configuration change between attempts cannot make Resend reject the retry as a conflict.
- The job records its **sending state**: not yet submitted; possibly submitted (with the time of the first possible dispatch); or sent (with Resend's receipt).
- **On recovery:**
  - Not yet submitted: send normally.
  - Sent: finish without sending.
  - Possibly submitted, within 24 hours of the first dispatch: resend with the same key and message. Resend delivers it once.
  - Possibly submitted, more than 24 hours ago, or an email from before this release (sent with no key): marked failed with the reason and shown on queue health (Q14: 2).

### F. Completion checkpoints across the job chain (all queues)

Ownership stops a stale run. Checkpoints stop a legitimate successor from repeating what its predecessor already committed, or from skipping what it never got to. The build inventories each registered handler's completion boundaries. Known cases:
- **Prompt planning:** the plan is saved, then `image_generation` is enqueued, then the job finishes. On resume, a saved plan for this attempt is reused. No second planner call; the child is enqueued if missing.
- **Candidate enrichment:** results are committed and the review advanced, then visual concepts are enqueued. Today a stop in between leaves the review past `prep_pending` with no child, and recovery returns early. The result and the child enqueue move into one transaction, or the resume creates the missing child idempotently.
- **Every other handler:** its effect is either an idempotent write that is fenced (A), or it gets the same treatment: reuse a committed result, and finish missing downstream work idempotently.

Where no local checkpoint exists for a text call that was in flight, the call runs again and is logged (Q13: 1).

### G. Comparison queues

Their ambiguity policy is unchanged by decision (2026-11-07): fail ambiguous rather than call again. Their writes to cells and panels get the same ownership enforcement as every other effect (A).

## Increments

These are build steps of one programme. Each merges on its own, but **fast reclaim is enabled for a queue only when the increment that protects it lands**. A merged increment therefore never replays a queue faster than it can protect it.

1. **Leases, renewal, fenced effects, execution limits.** Covers A and B, for every queue. Includes the migration adding the owner, token and expiry columns (expand-only); the free-slot claim; the per-queue switch, all off; and the fal history measurement. On its own, it stops a slow run from ever overwriting a newer one.
2. **Render queues.** Covers C and D, plus F for prompt planning and image generation, and the comparison writes (G). Fast reclaim switched on for the render queues. **This is the increment that fixes the stuck tiles.**
3. **Every other queue.** Covers E, and F for enrichment and the remaining handlers. Fast reclaim switched on for each.

## Testing

- **A stop, simulated:** a held job whose lease is left to lapse is picked up by a second worker within the window. A healthy job renewing for longer than the window is never reclaimed.
- **The late returner:** a first run that loses its lease and then resumes makes none of these: no finish, no domain write, no child job, no abandonment effect. The second run's results stand.
- **Atomicity:** a reclaim forced between a run's ownership check and its write leaves the write undone.
- **Execution limit:** a run past its limit whose late result returns *before* its last lease expires writes nothing.
- **Release pairs:** for each adjacent pair (before → 1, 1 → 2, 2 → 3), a worker on the earlier version never claims a `recovering` row it cannot recover.
- **A recovered job that fails again** without submitting (for example a download error after collecting) stays `recovering` and is retried only by a recovery-capable worker.
- **Dedupe:** enqueueing a job whose key matches a `recovering` row is refused as a duplicate.
- **Free-slot claim:** with all slots busy, a tick claims nothing.
- **A busy bulk lane** does not delay renewal or reclaim.
- **Legacy rows** without a lease are reclaimed only at 30 minutes. A queue with fast reclaim off behaves exactly as today.
- **Execution limit:** a wedged run is ended, and its late result is refused.
- **Image resume** (each case asserts the number of POSTs to the provider's queue):
  - id stored and still running → collected, zero submits;
  - completed → stored, zero submits;
  - a real refusal → the existing retry, one new submit;
  - no id and exactly one unclaimed match → collected;
  - two identical matches, a history failure, or missing payloads → ambiguous;
  - two unresolved local requests with the same input, recorded at different times, and exactly one history match; the later-recorded one recovered first, then both concurrently → ambiguous for both, nothing collected;
  - picture already stored → finished, zero submits.
- **Checkpoints:** a run stopped after committing its result, after enqueueing its child, and before finishing. Recovery makes no second paid call and creates no duplicate child, and a missing child is created.
- **Tile:** each row of D, and polling continues through every in-flight state.
- **Email:** the stored message and key are reused across a configuration change; each recovery case in E behaves as stated.
- **Unchanged behaviour:** the existing asyncJobs, render and email suites pass unmodified, and captured prompts are unchanged.

## David's decisions (2026-11-17: "q13 1. q14 2. q15 1.")

- **Q13: 1.** When the server stops and we cannot prove whether a paid AI step already ran (an image whose receipt is lost and cannot be matched unambiguously in the history, or an AI text call that was in flight), the job runs it again automatically and logs it. Each affected call may cost one extra picture (about 5 cents) or one extra text call (around a cent). Astra recommended 2 (stop visibly); recorded as David's choice over that recommendation. Comparison runs keep "stop rather than call again" (2026-11-07).
- **Q14: 2.** An email that may already have gone out but can no longer be protected from a duplicate (more than 24 hours after its first possible dispatch, or interrupted before this release with no key) is marked failed with the reason and shown on the queue-health page for a person to decide. A never-submitted email sends normally.
- **Q15: 1.** The oracle's "a time limit per job (under the reclaim window)" becomes "a time limit per job, longer than its slowest healthy run, that ends a wedged job without ever ending a healthy one".
