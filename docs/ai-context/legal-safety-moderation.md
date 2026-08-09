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
> This repo is public. Detection specifics are **deliberately omitted
> here and must not be added** — not tuning values, not per-path coverage
> maps, not vendor/configuration pairings for the classifier layers, not
> the conditions under which any check degrades, and not the observable
> differences between one check firing and another. Each is documented
> in-code beside the logic it governs, which is where it belongs.
>
> **If you are an agent updating this file: adding those details is not
> "improving the docs," it is the failure mode this header exists to
> prevent.** Describe *that* a control exists, *who* it serves, and *what
> happens to content and evidence* — never anything that would let
> someone determine where coverage is thinner, reproduce a check offline
> to tune against it, or tell from the outside which check they tripped.
>
> This applies to composition, not just to individual sentences. Several
> facts that are harmless alone compose into an evasion methodology; an
> adversarial review of an earlier draft of this file found exactly that,
> assembled from four separately-defensible sentences. Before adding
> anything here, ask what it enables *combined with the rest of the
> document*, not only on its own.

## What is actually live vs. what is not

This distinction matters more than anything else in this document.
Documenting aspirational safety infrastructure as though it were
operational would be actively harmful.

**Live and running in production code paths today:**
- Scanning on the upload and generation paths (below). **Note the layer
  count is a description of the available controls, not of any single
  path's depth** — no entry point runs all of them, and coverage differs
  by path.
- The reject contract: a generic, non-specific error to the caller that
  never reveals which check fired (`types.ts:11-12,49`).
- Quarantine: evidence bytes written to an unservable restricted prefix,
  plus a `quarantined_memes` audit row (`quarantine.ts:72-132`).
- An `ncmec_reports` row + admin email, for a subset of quarantines
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

## The scanning layers

Several independent controls exist, defined by the layer contract in
`lib/moderation/types.ts:1-12` and implemented in `arachnid.ts`,
`falSafety.ts`, and `nsfwClassifier.ts`.

**Do not read that as defense-in-depth on every path.** The suite has
multiple controls; an individual entry point does not necessarily run
more than one of them, and at least one live path runs exactly one
before content can be saved. Describe what the suite contains — never
assert that any given image received multiple independent checks.

**Two things about coverage are important, and only one belongs in this
document.** Which control runs on which entry point is *not* uniform, and
the controls differ in kind — one matches against known material, the
others assess imagery on its own. That shape is deliberate. The specific
per-path mapping is **intentionally not written down here**; read the
call sites if you're changing them, and see the header for why.

**The reject contract is uniform and deliberately uninformative**: a
rejected upload gets HTTP 422 and a fixed generic message
(`GENERIC_REJECT_MESSAGE`, `types.ts:49`); the response never indicates
which check fired. **Preserve this property in any change to these
paths — including in side effects.** The response body is not the only
channel a caller can observe; anything that varies visibly depending on
which check fired (a notification that does or doesn't arrive, an
account action that does or doesn't follow) weakens the same guarantee
the generic message exists to provide.

## Quarantine is a one-way door

`quarantineImage()` (`quarantine.ts:72-132`) writes the bytes to a
restricted object-storage prefix, inserts a `quarantined_memes` audit
row, and — for a subset of quarantines, determined at the call site —
calls `submitNcmecReport()`.

**The bytes are not reachable through the ordinary serve routes** — and
that is a narrower statement than "never served to anyone," which is what
this document previously claimed and could not support.

What is true: both the public and private serve routes hard-404 anything
under the restricted prefix **before any ACL or auth check**
(`routes/storage.ts:151-154,193-199`). There is no admin viewer and no
UI that displays quarantined content.

> ### ⚠️ Those two routes are not the only way to reach an object
>
> The serve-route 404s do **not** establish that evidence can never be
> read or turned into a user-visible derivative. Other code paths accept
> a caller-supplied object path and read it without a restricted-prefix
> or ownership check, and the URL-signing helper carries no restricted
> guard of its own (`objectStorage.ts:245-251`). Treat "unreachable" as
> an **objective this system has not yet fully met**, not a property you
> can rely on.
>
> Tracked privately as an access-control gap rather than detailed here.
> **Any new code that resolves a caller-supplied storage path must
> exclude the restricted prefix explicitly** — do not assume an upstream
> guard covers you, because for at least one live path it doesn't.

Evidence bytes are intended to be read in-process only;
`ncmecClient.ts:27-33` states signed URLs for evidence are "forbidden,
categorically" — an intent the signing helper does not currently
enforce.

**What is *not* implemented, despite the surrounding comments:** no
synthetic `system:quarantine` owner is recorded on these objects.
`uploadRestrictedObjectBuffer()` validates the prefix and delegates to
the ordinary upload helper, which writes no ACL and no owner
(`objectStorage.ts:260-273`). The stated intent — that no end-user is the
legal "owner" of CSAM evidence — is achieved only insofar as the serve
routes deny everyone; it is not backed by a recorded ownership principal.
Do not cite an ownership guarantee here, and if one is wanted, it has to
be built in the upload helper.

**The original content is refused, not hidden.** Quarantine happens on
the reject path — on upload the caller gets a 422 and no meme row is ever
created; in generation the pipeline throws. There is consequently no
artifact for anyone to review.

**But refusal and preservation are separate events, and not every
refusal preserves anything.** Some rejection paths return or throw
without calling `quarantineImage()` — the content is still blocked, but
no `quarantined_memes` row and no evidence bytes exist afterward. Treat
"refused" and "preserved as evidence" as distinct properties; the first
does not imply the second. Which paths differ is deliberately not mapped
here (see the header) — read the call sites before relying on
preservation for any particular flow. **If preservation is meant to be
universal it currently isn't, and closing that is a code change, not a
documentation one.**

**Nothing exits quarantine.** Rows are soft-delete-capable but
`deletedAt` is never written by any code. There is no release, appeal, or
re-review mechanism, by design (`types.ts:7-12`, `quarantine.ts:14`).

**`quarantined_memes` has no application or UI read path.** No
application code reads it and nothing displays it — it's referenced by
exactly one non-test file, and only to INSERT. It is **not** literally
write-only, though: migration 0097's `ncmec_reports_link_quarantine_trg`
reads it on report inserts to validate and backfill `quarantine_id`.
Schema work touching this table has to account for that trigger.

**Two schema vocabulary items have no writer and must not be described as
behavior:** `MEME_STATUSES`'s `"quarantined"` value has zero references
outside its own declaration, and `QUARANTINE_SOURCES`'s `"manual"` is
never written. There is no "flip a meme to quarantined status" path and
no manual-escalation path.

## Evidence retention

**The legal basis is stated in code: US 18 USC § 2258A** — once an ESP has
actual knowledge of apparent CSAM, the report and supporting bytes must
be preserved.

> ### ⚠️ The retention period in this codebase is very likely stale
>
> The code comment and the schema default both say **90 days**
> (`ncmec.ts:10-16`, `schema/moderation.ts:81-86`,
> `evidence_retention_until` defaulting to `now() + interval '90 days'`).
> **The REPORT Act (2024) amended § 2258A(h) to require preservation for
> one year.** If that reading is right, the stored deadline is roughly
> nine months short of the statutory minimum.
>
> **Nothing is currently destroyed early, because nothing deletes
> evidence at all** (below) — so this is latent, not active. But the
> planned retention worker must not take `evidence_retention_until` at
> face value: building to the current default would delete federal
> evidence before the preservation period expires. **Fix the default and
> confirm the period with legal advice before any purge job is built.**
> Tracked separately; this note is a warning to whoever builds that
> worker, not a substitute for the fix.

**This section describes the preservation half only, and citing the
statute is not a claim of compliance with it.** § 2258A's *reporting*
duty is precisely the part that is not performed — see "Never happened: a
CyberTipline filing" above. Do not read the detail below as evidence the
obligation is discharged; it documents what is retained, not that anyone
has been notified.

Two mechanisms exist: `ncmec_reports.evidence_retention_until` is
NOT NULL and carries a default deadline (`schema/moderation.ts:96-99`),
and `deleteObject()` refuses any `/restricted/` path without an explicit
force flag (`objectStorage.ts:213-226`).

**Neither of these enforces a retention floor, and the doc previously
claimed one.** `evidence_retention_until` is *stored data that nothing
reads* — `deleteObject()` checks only the path and the force flag, never
the deadline (`objectStorage.ts:220-226`), so any caller passing the flag
can delete restricted evidence immediately regardless of how long it was
meant to be kept. **The deadline check the statute requires does not
exist anywhere; the retention worker will have to implement it.**

What is true today is narrower and accidental: **no code passes the force
flag at all**, so evidence is currently retained **indefinitely** — not
because a floor is enforced, but because nothing deletes it. Describe the
current state as "nothing deletes evidence yet," never as "the minimum is
enforced."

**Evidence deliberately survives a user hard-delete.** Three FKs are
`ON DELETE SET NULL` on purpose — `ncmec_reports.user_id`,
`quarantined_memes.user_id`/`meme_id`, and `ncmec_reports.quarantine_id`
(`schema/moderation.ts:30-31,100,211-215`). An admin hard-delete of a
user nulls the attribution while the report row, the quarantine row, and
the bytes all survive; the hard-delete's storage-cleanup step never
touches the restricted prefix, and `deleteObject`'s guard would refuse it
if it tried.

**The audit ledger is designed to go the other way** —
`ncmec_safety_audit_log.report_id` is `ON DELETE RESTRICT` so a report
with logged handling can't be deleted, and `actor_user_id` carries **no**
foreign key specifically so that deleting an admin account cannot erase
attribution for suppressing a federal report; `actor_label` is NOT NULL
and a mutation is refused rather than recorded anonymously
(`schema/moderation.ts:309-352`).

**That boundary is not enforced yet, and the design only holds once it
is.** Migration 0097 is explicit that the ledger and its guard function
belong to the application role until a DBA transfers them to a dedicated
owner — and an owner can disable the append-only triggers. In the
default state, the same role can therefore remove an audit entry and
then delete the report the `ON DELETE RESTRICT` was protecting. The
hardening step is a separate, superuser-run procedure documented in
[`ncmec-audit-ledger-hardening.md`](../engineering/ncmec-audit-ledger-hardening.md).
**Until that runbook has been executed against an environment, describe
this as the intended boundary, not an active guarantee.**

## What happens today when the reporting path fires

When it fires (`ncmec.ts:33-73`): insert one `ncmec_reports` row with
`submission_status = 'pending'`; a BEFORE INSERT trigger backfills
`quarantine_id`; a best-effort email goes to every active admin with
notifications enabled; and a `logger.warn` records that real submission
is out-of-band. **That is the entire behavior — no network call to NCMEC
is made.**

**Not every quarantine produces a notification, and no quarantine
produces a reviewable item.** `quarantined_memes` has no application read
path, there is
no UI, and admin alerting is only partially wired — so a substantial
share of quarantines today are recorded and never seen by a human. This
is a real operational gap and it is tracked privately rather than
detailed here, because *which* quarantines alert and which don't is
externally observable and would let a caller infer which check they
tripped — the same property the generic reject message exists to deny
them. Read the call sites; don't restate the mapping in this file.

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

- `artifacts/api-server/src/lib/moderation/` — the whole directory. Start
  at `types.ts` for the layer contract and the reject-message rule; the
  rest is navigable from there. (Deliberately not annotated file-by-file
  here — see the header.)
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
