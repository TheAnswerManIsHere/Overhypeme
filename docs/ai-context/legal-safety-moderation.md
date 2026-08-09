# Legal/Safety Moderation

> The CSAM/abuse-scanning, quarantine, evidence-preservation, and NCMEC
> CyberTipline reporting path — **a system entirely separate from
> content-quality review.** That one (`pending_reviews`, the three human
> gates, "is this joke good enough") is
> [`moderation-workflow.md`](./moderation-workflow.md); this one is "is
> this content illegal," and the two share no state, no queue, and no
> surface. Primary code: `artifacts/api-server/src/lib/moderation/`,
> `lib/db/src/schema/moderation.ts`, `lib/db/migrations/0097_ncmec_submission.sql`.
>
> ## ⚠️ This document is deliberately incomplete, and must stay that way
>
> This repo is public. Detection specifics — thresholds, score cutoffs,
> endpoint shapes, vendor match-label semantics, timeouts, rate-limit
> numbers, which conditions cause a scanner to fail open or be skipped,
> and the specific known gaps tracked in code — are **deliberately
> omitted here** and must not be added. They are readable in the code by
> anyone who needs them and are documented in-code at their call sites.
> Publishing them in a discoverable narrative doc would be a roadmap for
> evading child-safety detection. **If you are an agent updating this
> file: adding those details is not "improving the docs," it is the
> failure mode this header exists to prevent.** Describe *that* a control
> exists, *who* it serves, and *what happens to content* — never the
> values that would let someone test against it.

## What is actually live vs. what is not

This distinction matters more than anything else in this document.
Documenting aspirational safety infrastructure as though it were
operational would be actively harmful.

**Live and running in production code paths today:**
- Three-layer scanning on the upload and generation paths (below).
- The reject contract: a generic, non-specific error to the caller that
  never reveals which check fired (`types.ts:11-12,49`).
- Quarantine: evidence bytes written to an unservable restricted prefix,
  plus a `quarantined_memes` audit row (`quarantine.ts:72-132`).
- An `ncmec_reports` row + admin email, for hash-match hits only
  (`ncmec.ts:33-73`).
- The `ncmec_reports_link_quarantine_trg` DB trigger, which backfills
  `quarantine_id` on those inserts (`0097_ncmec_submission.sql:423-447`).
- The reserved-config 403 guard (`ncmecConfig.ts`, enforced at
  `routes/admin.ts:2628-2642`).
- `deleteObject()`'s refusal to delete anything under `/restricted/`
  without an explicit force flag (`objectStorage.ts:213-226`).

**Built, tested, and deliberately unwired — zero production callers:**
- The ISPWS HTTP client (`ncmecClient.ts`) and the report XML builders
  (`ncmecXml.ts`).
- `isSubmittable` / `classifyWaitingState` (`ncmecWorker.ts` — despite
  the filename, two pure functions, not a worker; its own header says
  "no callers yet").
- The `ncmec_safety_audit_log` table and its append-only DB triggers.

**Not built at all:** the submission worker, the reconciler,
`POST /admin/safety/config`, the `/admin/safety` page, failure alerting,
the production-activation gate, the evidence-retention purge job, the
activation runbook, and any read path, UI, or exit mechanism for
quarantined content.

**Never happened: a CyberTipline filing.** `submitNcmecReport()` has
never contacted NCMEC. Both filing switches are seeded off, and
classifier-hit reporting is additionally hard-blocked in code pending an
answer from NCMEC on which incident type applies
(`0097_ncmec_submission.sql:1014-1022`).

**Phase status:** phases 1–3 of 8 shipped (PR #293 merged 2026-08-07,
PR #349 merged 2026-08-08). Phases 4–8 remain: provenance capture in
`quarantine.ts`, the submission worker + reconciler, admin routes, the
`/admin/safety` page, alerting, and the production-activation gate. See
[`current-roadmap.md`](./current-roadmap.md#in-progress-slices).

## The three scanning layers

Named as such in `lib/moderation/types.ts:1-12`:

1. **Project Arachnid Shield** (Canadian Centre for Child Protection) —
   hash-based CSAM matching (`arachnid.ts`).
2. **fal.ai built-in safety** — a request-side safety field plus
   response-side inspection of the model's own NSFW flag
   (`falSafety.ts`).
3. **A fal.ai NSFW classifier** on generated/composited imagery
   (`nsfwClassifier.ts`).

Where they run: user photo upload gets layers 1 and 3
(`userImageUpload.ts:138-284`); AI meme generation gets layers 2 and 3
(`aiMemePipeline.ts`); meme-record creation and the video pipeline's
still frame get layer 3 (`createMemeRecord.ts:322`,
`videoPipelineRunner.ts:989`).

**Hash matching runs only on the user-photo upload path** — generated
imagery is never hash-matched, only classifier-scanned. The per-user
daily upload cap runs *before* the scanning pipeline, deliberately, so a
rate-limited caller never burns scanner calls (`uploadRateLimit.ts:8-10`).

**The reject contract is uniform and deliberately uninformative**: a
rejected upload gets HTTP 422 and a fixed generic message
(`GENERIC_REJECT_MESSAGE`, `types.ts:49`); the response never indicates
which layer fired. Preserve this property in any change to these paths.

## Quarantine is a one-way door

`quarantineImage()` (`quarantine.ts:72-132`) writes the bytes to a
restricted object-storage prefix, inserts a `quarantined_memes` audit
row, and — for hash-match hits only — calls `submitNcmecReport()`.

**The bytes are never served to anyone.** The restricted prefix is owned
by a synthetic `system:quarantine` principal, explicitly "so no end-user
is the legal 'owner' of CSAM evidence" (`objectStorage.ts:254-271`), and
both the public and private serve routes hard-404 anything under it
*before* any ACL or auth check (`routes/storage.ts:151-154,193-199`).
There is no admin viewer, no signed-URL path, no proxy. Evidence bytes
are to be read in-process only; `ncmecClient.ts:27-33` states signed URLs
for evidence are "forbidden, categorically."

**The original content is refused, not hidden.** Quarantine happens on
the reject path — on upload the caller gets a 422 and no meme row is ever
created; in generation the pipeline throws. There is consequently no
artifact for anyone to review.

**Nothing exits quarantine.** Rows are soft-delete-capable but
`deletedAt` is never written by any code. There is no release, appeal, or
re-review mechanism, by design (`types.ts:7-12`, `quarantine.ts:14`).

**`quarantined_memes` is write-only.** No code reads it; nothing displays
it. Referenced by exactly one non-test file, and only to INSERT.

**Two schema vocabulary items have no writer and must not be described as
behavior:** `MEME_STATUSES`'s `"quarantined"` value has zero references
outside its own declaration, and `QUARANTINE_SOURCES`'s `"manual"` is
never written. There is no "flip a meme to quarantined status" path and
no manual-escalation path.

## Evidence retention

**The legal basis is stated in code: US 18 USC § 2258A** — once an ESP has
actual knowledge of apparent CSAM, the report and supporting bytes must
be preserved for at least 90 days (`ncmec.ts:10-16`,
`schema/moderation.ts:81-86`).

Two mechanisms implement it: `ncmec_reports.evidence_retention_until`
defaults to 90 days out and is NOT NULL
(`schema/moderation.ts:96-99`), and `deleteObject()` refuses any
`/restricted/` path without an explicit force flag
(`objectStorage.ts:213-226`).

**No code ever passes that force flag.** The purge/retention worker does
not exist, so in practice evidence is currently retained **indefinitely**,
not for 90 days. Document this as "preserved for at least 90 days by
design; no expiry job is built yet" — the floor is enforced, the ceiling
isn't implemented.

**Evidence deliberately survives a user hard-delete.** Three FKs are
`ON DELETE SET NULL` on purpose — `ncmec_reports.user_id`,
`quarantined_memes.user_id`/`meme_id`, and `ncmec_reports.quarantine_id`
(`schema/moderation.ts:30-31,100,211-215`). An admin hard-delete of a
user nulls the attribution while the report row, the quarantine row, and
the bytes all survive; the hard-delete's storage-cleanup step never
touches the restricted prefix, and `deleteObject`'s guard would refuse it
if it tried.

**The audit ledger goes the other way, deliberately.**
`ncmec_safety_audit_log.report_id` is `ON DELETE RESTRICT` so a report
with logged handling cannot be deleted at all, and `actor_user_id`
carries **no** foreign key specifically so that deleting an admin account
cannot erase attribution for suppressing a federal report;
`actor_label` is NOT NULL and a mutation is refused rather than recorded
anonymously (`schema/moderation.ts:309-352`).

## What happens today when the reporting path fires

For a hash-match hit only (`ncmec.ts:33-73`): insert one `ncmec_reports`
row with `submission_status = 'pending'`; a BEFORE INSERT trigger
backfills `quarantine_id`; a best-effort email goes to every active admin
with notifications enabled; and a `logger.warn` records that real
submission is out-of-band. **That is the entire behavior — no network
call to NCMEC is made.**

**Notification is asymmetric, and this is an operational gap worth
knowing.** A hash-match quarantine emails admins. A **classifier**
quarantine — the common case, covering every generation path — passes
`reportToNcmec: false` at every call site, so `submitNcmecReport()` is
never called and **nobody is notified at all**. The row is written and
that is the end of it. Combined with `quarantined_memes` being write-only
and there being no UI, classifier quarantines are currently recorded and
never seen by a human.

## The reserved config keys

Five keys reject writes with a 403 (`ncmecConfig.ts:26-45`):
`ncmec_submission_enabled`, `ncmec_ispws_environment`,
`ncmec_report_classifier_hits`, `ncmec_backlog_audit_cutoff`,
`ncmec_backlog_audit_completed_at`. Three seeded keys are deliberately
**not** reserved (`ncmecConfig.ts:77-81`): the safety alert email and two
async-retry keys.

**The membership rule is explicit**: "could this write make us file, or
make filing permissible?" — *not* "is this key NCMEC-related"
(`ncmecConfig.ts:21-25`).

**Why the guard exists:** migration 0097 seeded these keys into
`admin_config`, whose generic `PATCH /admin/config/:key` validates only
data type and bounds. Without the guard, an admin could have flipped
filing on and pointed it at production through a route that knows nothing
about the activation gate. The refusal fires **before the body is
inspected**, deliberately, so a validation error never misleads a caller
about why (`routes/admin.ts:2631-2638`). Its guarded replacement,
`POST /admin/safety/config`, lands in phase 6; until then the reserved
keys are writable by nothing at all, which is the intended posture.

**The three unreserved keys' own code comment self-corrects an earlier
overstatement** — their real protections don't exist yet, and the comment
used to describe them as though they did (`ncmecConfig.ts:56-75`). The
argument that this is safe rather than merely scheduled is structural:
every invariant those keys need is conditioned on production filing being
live, and the master switch is reserved and seeded false, so the
precondition is unreachable.

## Relationship to content-quality review

**Strictly separate; they do not touch.** `quarantined_memes` and
`ncmec_reports` appear in no file that touches `pending_reviews` or the
review routes, and nothing in `artifacts/api-server/src/lib/moderation/`
reads or writes review
state. The only shared plumbing is the admin-email helper and the
`admin_config` store.

A quarantined item **cannot** reach the review queue — quarantine happens
on the reject path, so no meme row exists to review. A moderator
therefore cannot approve something quarantined, not because a guard
forbids it but because there is no artifact and no surface. There is
likewise no path to escalate a content-quality item into legal/safety
quarantine.

## Files to inspect before legal/safety work

- `artifacts/api-server/src/lib/moderation/` — `types.ts` (the layer
  contract and reject-message rule), `arachnid.ts`, `falSafety.ts`,
  `nsfwClassifier.ts`, `quarantine.ts`, `ncmec.ts` (the stub),
  `ncmecClient.ts` / `ncmecXml.ts` / `ncmecWorker.ts` (unwired),
  `ncmecConfig.ts`, `uploadRateLimit.ts`.
- `lib/db/src/schema/moderation.ts` — all three tables and the FK
  directionality reasoning.
- `lib/db/migrations/0097_ncmec_submission.sql` — the trigger, the
  append-only ledger triggers, and the seeded switches.
- `artifacts/api-server/src/lib/objectStorage.ts` — the restricted-prefix
  ownership and the delete guard.
- `artifacts/api-server/src/routes/storage.ts` — the pre-auth 404 guards
  on the restricted prefix.
- Tests: `moderation.ncmecClient.test.ts`, `migrations.0097.test.ts`,
  `moderation.ncmecWorker.test.ts`, `ncmecAuditBoundaryStatus.test.ts`,
  `moderation.arachnid.test.ts`, `moderation.nsfwClassifier.test.ts`,
  `moderation.falSafety.test.ts`, `moderation.uploadRateLimit.test.ts`,
  `moderation.quarantine.test.ts` (CI-skipped — needs the live storage
  sidecar), and the reserved-key cases in `routes.admin.test.ts`.
- For content-quality review, a different system entirely:
  [`moderation-workflow.md`](./moderation-workflow.md).
