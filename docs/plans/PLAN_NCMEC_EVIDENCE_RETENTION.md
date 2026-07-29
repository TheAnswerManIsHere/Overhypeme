# Plan — Quarantine evidence retention & admin-confirmed expiry

**Status:** draft, in Codex plan review
**Subsystem:** legal/safety moderation (`artifacts/api-server/src/lib/moderation/`)
**Companion plan:** `PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md` (separate review PR — the
ISPWS client, submission worker, and `/admin/safety` ledger). Neither plan depends on
the other's outcome; §7 covers the one place they touch.

---

## 1. Product intent

Quarantined CSAM evidence currently accumulates forever. `objectStorage.deleteObject`
refuses any `restricted/` path unless `force: true` is passed, and **nothing in the
codebase passes it.** The `quarantine_evidence_retention_days` key seeded in migration
0043 (line 95) is read by zero lines of code.

That is the safe direction to be wrong in, and it is why this is not urgent. But it is
still wrong: there is no defined lifecycle, no way to act on one, and storage grows
without bound.

The intent is a lifecycle that errs, at every branch, toward keeping evidence: a long
preservation floor, deletion that a human authorizes rather than a timer, and hard
blocks that make unlawful deletion structurally impossible rather than merely unlikely.

**This plan is the most dangerous code in the moderation subsystem.** It is the only
code permitted to destroy legally-preserved evidence, its failure mode is silent and
irreversible, and neither of David's safety nets catches it — a wrong deletion is
invisible in product testing and looks correct in a diff. That is precisely why it is
reviewed on its own rather than bundled into the submission work.

## 2. Settled decisions

David's calls, made 2026-07-29:

1. **Deletion is admin-confirmed, never automatic.** A sweep computes eligibility and
   surfaces a queue; a human authorizes each purge. No timer ever deletes anything.
2. **The floor is 12 months, not the statutory 90 days.** § 2258A sets a minimum, not a
   deadline. Storage at this volume is negligible; the downside of deleting too early
   is not.
3. **Evidence for a report that has not been confirmed submitted is never deletable** —
   my call, not a preference: destroying evidence for a report still stuck mid-flow is
   indefensible under any reading.

## 3. Must not change

1. **`deleteObject`'s restricted-path guard stays.** This plan does not weaken it. It
   becomes its first and only legitimate `force: true` caller.
2. **Database rows are never deleted.** `quarantined_memes` and `ncmec_reports` rows are
   permanent. Only the *bytes* expire. The ledger must still show that an incident
   occurred, was reported, and had its evidence purged on a given date by a given admin.
3. **Soft-delete semantics on `quarantined_memes` are unchanged** — `deleted_at` stays
   the existing tombstone and is unrelated to evidence expiry.
4. **No evidence is served over HTTP.** This plan adds no viewer, no signed URL, no
   proxy. Same invariant as the companion plan.
5. **Detection and quarantine behavior are untouched.**

## 4. What exists today

| Fact | Location |
|---|---|
| Restricted-path delete guard | `objectStorage.ts:220-224` — throws unless `force: true` |
| `force: true` callers | **None** |
| `evidence_retention_until` | `ncmec_reports`, default `now() + interval '90 days'` |
| `quarantine_evidence_retention_days` | Seeded in 0043 (min 30, **max 365**), read by nothing |
| Retention timestamp on `quarantined_memes` | **None** — the table owning the object path has no clock |
| Existing retention sweeps | `lib/dataLifecycle.ts:53` `runRetentionWindowJobs()` — unrelated tables |

The gap that matters structurally: `quarantined_memes` owns `evidence_object_path`, but
only `ncmec_reports` has a retention clock — and a quarantine row exists for every hit
while an NCMEC report exists only for reportable ones. So today a `fal_safety`,
`classifier`, or `manual` quarantine holds bytes governed by no clock at all.

## 5. Design

### 5.1 One object, several claims — the `evidence_claims` registry

An evidence object can be referenced by a `quarantined_memes` row and, when the hit was
reportable, by an `ncmec_reports` row pointing at the same path. Two rows, two clocks,
one object.

**The rule: an object survives until the latest expiry among every row that claims it,
and is eligible only when every claim is simultaneously satisfied.** Not the earliest,
not whichever the sweep happens to query first. Getting this backwards — deleting when
*any* claim expires — is the single easiest way for this feature to destroy evidence it
was obliged to keep.

**A hand-written union query is not a sufficient mechanism for that rule.** An earlier
draft of this plan claimed a single `max()` query across the two known path columns
would stop a future table from shortening an object's life. It would not: a table added
later is simply invisible to a static query until somebody remembers to edit it, and
"somebody remembers" is exactly the guarantee this subsystem cannot rest on. The
failure would be silent and would delete evidence.

So claims become **data, not a query**. A new table `evidence_claims` is the single
registry of every claim on every restricted object:

| Column | Purpose |
|---|---|
| `id` | PK |
| `object_path` | The restricted-prefix object claimed |
| `claim_kind` | `quarantine` \| `ncmec_report` \| future kinds |
| `claim_ref_table`, `claim_ref_id` | The owning row |
| `retention_until` | This claim's clock (§5.3) |
| `released_at` | Non-null when this claim no longer blocks deletion |

Eligibility is then one query over one table, and adding a claim-bearing feature means
inserting a row rather than remembering to amend a predicate. Both current writers
(`quarantineImage()` and `submitNcmecReport()`) insert their claim **in the same
transaction** that creates their own row, so a claim can never be missing for a row that
exists.

**Backstop CI guard.** A registry only helps if new code uses it. Following this repo's
own convention of turning a recurring failure into a deterministic check
(`known-failure-patterns.md`), a build-time guard fails if any schema file introduces a
column referencing a `restricted/` object path without a corresponding
`evidence_claims` writer. That is the mechanical half of Codex's "structurally
exhaustive" bar; the registry is the structural half.

### 5.2 Eligibility

An object is eligible for deletion only when **all** hold:

1. `retention_until <= now()` for **every** unreleased claim in `evidence_claims` (§5.1).
2. No claiming row has `retention_hold = true` (§5.4).
3. **The reporting obligation is affirmatively discharged** (see below).
4. `evidence_deleted_at` is null (not already purged).

**Rule 3 cannot be phrased as a condition on `ncmec_reports` rows.** The obvious
phrasing — *"every claiming `ncmec_reports` row is `submitted`"* — is **vacuously true
when no such row exists**, and there is a real path that produces exactly that state:
`quarantine.ts:103-124` catches a failed `submitNcmecReport()` and only logs it, by
design, so the upload rejection is never blocked. The result is a quarantine row for a
genuine Arachnid hit with **no** NCMEC row at all — which under the vacuous phrasing
becomes deletable the moment its clock expires, despite never having been reported.
That is the precise outcome settled decision 3 exists to prevent.

So the obligation is recorded as **positive state at quarantine time**, not inferred
from the absence of a row. `quarantined_memes` gains `report_required` (boolean, derived
from source and config in the same transaction that inserts the quarantine row) and
`report_satisfied_at`. Rule 3 becomes:

> `report_required = false`, **or** `report_satisfied_at` is non-null — set only when a
> linked `ncmec_reports` row reaches `submitted` (or `filed_manually`).

An Arachnid hit whose report insert failed is therefore `report_required = true` with
`report_satisfied_at` null, and is **never eligible**, indefinitely, until the report is
actually filed. Failing to file is converted from a silent deletion into a permanent
block that surfaces in the blocked queue (§5.7) — visible and fixable, which is the
whole point.

**Eligibility is computed server-side at the moment of deletion**, never taken from the
client. The admin UI submits ids; the endpoint re-derives eligibility for each and
refuses any that no longer qualify. A stale browser tab must not be able to authorize a
purge that became invalid after the page loaded.

**Re-deriving is not the same as serializing.** Re-reading eligibility immediately
before the storage call still leaves a window: between the read and the destruction,
another request can set a hold, retract a report, or insert a new claim for the same
object. Ordinary row locks do not close it either, because a *new* claim row is not
locked by reading the existing ones. So all four mutators — purge, hold set/clear,
report status change, and claim insertion — participate in one object-level protocol:

- `evidence_claims` rows for a given `object_path` are locked `FOR UPDATE` by every
  writer, and **claim insertion takes the same lock**, so a concurrent insert blocks
  rather than slipping in behind the eligibility read.
- The purge path holds that lock across re-derivation, the deletion-intent write
  (§5.6), and the final stamp transaction.
- A `deletion_intent` marker on the object makes hold-setting and claim-insertion fail
  loudly rather than silently lose a race — a claim arriving mid-purge is an event worth
  seeing, not one to resolve by ordering luck.

### 5.3 Schema — migration `0095_evidence_retention.sql`

**New table `evidence_claims`** (§5.1) — the registry. Unique on
`(claim_ref_table, claim_ref_id)`, indexed on `(object_path)` and on
`(retention_until) WHERE released_at IS NULL`.

On `quarantined_memes` (it owns the object path and currently has no clock):

| Column | Type | Purpose |
|---|---|---|
| `evidence_deleted_at` | `timestamptz` | Set when bytes are purged; row itself persists |
| `retention_hold` | `boolean not null default false` | §5.4 |
| `report_required` | `boolean not null` | §5.2 rule 3 — positive obligation state |
| `report_satisfied_at` | `timestamptz` | §5.2 rule 3 — set when the report reaches `submitted` |

On `ncmec_reports`: `evidence_deleted_at`, `retention_hold`.

**The clock is a calendar year, not 365 days.** David's decision was *12 months*, and
`created_at + interval '365 days'` is a day short of that for any window spanning a leap
day — a claim created 2027-03-01 would expire 2028-02-29 rather than 2028-03-01. The
difference is one day, but it is a day of preservation the settled policy grants, and
there is no reason to round it away. **`interval '12 months'` is used throughout**;
Postgres calendar arithmetic lands on the same day-of-month a year later.

**One authoritative materialization path.** The config key is the floor, so it must
actually govern. Today nothing reads `quarantine_evidence_retention_days` — and a
schema-only change would leave an operator able to raise the floor to ten years while
new claims kept expiring at the old value, producing premature eligibility that looks
configured-away. So a single helper `materializeRetentionUntil()` reads the key and is
called by **both** claim writers when they insert into `evidence_claims`. The column
default exists only as a fallback for a direct SQL insert, never as the normal path.

The key becomes `quarantine_evidence_retention_months` (default **12**, bounded
`1..120`), replacing the days-based key — months, because the unit the policy is stated
in should be the unit the config is stored in, and because `interval` arithmetic on
months is what gives the calendar-correct result above. Migration 0043's
`quarantine_evidence_retention_days` is retired in the same migration so two keys cannot
disagree.

**Raising the floor is monotonic.** When the config increases, a sweep extends existing
unreleased claims to the new floor; lowering it never shortens an existing claim, only
affects claims created afterward. The extension is the same one-directional shape as the
backfill:

```sql
UPDATE evidence_claims
   SET retention_until = source_created_at + make_interval(months => $configured)
 WHERE released_at IS NULL
   AND retention_until < source_created_at + make_interval(months => $configured);
```

**Backfill.** Existing `ncmec_reports` rows carry 90-day windows and no quarantine row
has a clock at all. The migration inserts an `evidence_claims` row per existing claim
with `retention_until = created_at + interval '12 months'`, and for any pre-existing
`evidence_retention_until` already **beyond** that, keeps the longer value. The `WHERE`
clause makes the statement lengthen-only, idempotent, and safe to re-run. Per
`overhype-migration-review`, it reports affected-row counts.

**Backfilling `report_required` for historical rows.** Existing `quarantined_memes` rows
predate the column. `report_required` is set true where the source is `arachnid`, false
otherwise — matching what the reporting rule would have been at the time — and
`report_satisfied_at` is set from any linked `ncmec_reports` row already `submitted`.
Historical Arachnid rows with no submitted report therefore land as blocked, which is
the correct and conservative result: they are exactly the rows that may never have been
filed.

**New audit table** `evidence_deletion_audit`, append-only:

| Column | Purpose |
|---|---|
| `id` | PK |
| `object_path` | What was deleted |
| `quarantine_id`, `ncmec_report_id` | Claiming rows |
| `deleted_by_user_id` | Which admin authorized it |
| `deleted_at` | When |
| `eligibility_snapshot` (`jsonb`) | Retention timestamps, report status, and hold flags **as evaluated at authorization time** |

The snapshot is the point. If a deletion is ever questioned, the record shows the exact
state the decision was made on, rather than requiring reconstruction from rows that have
since moved on.

**Migration numbering.** This plan and the companion plan each add a migration; the
companion claims `0094`. Whichever merges second renumbers to avoid a collision. Noted
here because parallel review makes this easy to miss.

### 5.4 Retention holds

`retention_hold` on either claiming row makes an object permanently ineligible until
explicitly cleared. Its purpose is the case the clock cannot anticipate: a law
enforcement preservation request, an active investigation, an ongoing legal matter.

Set and cleared from the admin UI, with the reason recorded. A hold always wins — there
is no override, no expiry on the hold itself, and no bulk-clear.

### 5.5 The sweep — computes, never deletes

An `async_jobs` handler (`evidence_retention_sweep`, `bulk` lane) runs the §5.2 query and
records the eligible set. **It performs no deletion and calls no storage API.** Its only
outputs are a count and a queue for a human.

Separating computation from destruction means the scheduled, unattended component has no
destructive capability at all. A bug in the sweep produces a wrong *list*, which an admin
reviews, rather than a wrong deletion, which nobody sees.

### 5.6 Deletion — the only `force: true` caller

`lib/moderation/evidenceRetention.ts` exposes `purgeEvidence()`, reached only from
`POST /admin/safety/retention/purge` (`requireAdmin`).

Per object, in this order:

1. **Lock the object's claims** `FOR UPDATE` (§5.2) and **re-derive eligibility**.
   Ineligible → skip, report why, continue.
2. **Dry-run check.** If `evidence_deletion_dry_run` is true (**default true**), log the
   intended deletion and stop. Nothing is destroyed until an operator deliberately turns
   dry-run off.
3. **Write and commit a deletion-intent record** — `deletion_attempted_at`,
   `deletion_attempted_by`, and the eligibility snapshot — *before* touching storage.
4. `deleteObject(path, { force: true })`, capturing **whether the object existed**.
5. **One transaction**: stamp `evidence_deleted_at` on every claiming row, release the
   claims, and insert the `evidence_deletion_audit` row. All of it, or none of it.

**Why the stamps and the audit are one transaction.** Stamping the rows and then
inserting the audit separately has a failure that eats itself: if the stamps commit and
the audit insert fails, eligibility rule 4 (`evidence_deleted_at is null`) now rejects
the object on retry, so the permanent record of who authorized the deletion is **never
written and never can be**. The audit trail is the artifact this whole feature exists to
make trustworthy, so it is committed atomically with the state it describes, and a
failed transaction leaves the object retryable with neither stamp nor audit.

**Why delete precedes the stamps.** Stamping first would produce rows asserting evidence
was purged while the bytes remain — an audit trail that lies in the more dangerous
direction. Delete-first can only leave the opposite: bytes gone, rows not yet stamped,
which the intent record (step 3) makes recoverable.

**Not-found is not unconditionally success.** `ObjectStorageService.deleteObject`
returns silently when the object is absent (`objectStorage.ts`, `ObjectNotFoundError` →
`return`), so "missing" on its own cannot distinguish *"our previous attempt succeeded"*
from *"the bytes were already gone before we ever tried"* — the second being corruption,
a bad stored path, or an out-of-band deletion. Auditing that second case as a successful
admin purge would record a falsehood and, worse, bury an incident where preserved
evidence went missing. The intent record disambiguates:

| Object missing, and… | Meaning | Action |
|---|---|---|
| `deletion_attempted_at` **is set** | Our earlier attempt landed; this is a retry | Converge — stamp and audit, flagged `converged_after_retry` |
| `deletion_attempted_at` **is null** | The bytes were gone before we tried | **Not a successful deletion.** Record `evidence_missing_at`, alert admins, write **no** purge audit row |

This requires knowing whether the object existed, which `deleteObject`'s `void` return
does not currently expose. It is extended to return `{ existed: boolean }` — additive,
and no existing caller has to change.

Each object is independent; one failure never aborts the batch.

**Confirmation.** The endpoint requires a typed confirmation string echoing the object
count. Cheap, and it makes an accidental bulk purge take deliberate effort.

### 5.7 Admin surface

Extends `/admin/safety` (introduced in the companion plan) with a **Retention** tab:

- The eligible queue, each row showing why it became eligible: both retention
  timestamps, the report status that unblocked it, and the age of the evidence.
- Blocked items with their reason — *"report still `failed`"*, *"on hold"*, *"not yet
  expired (expires 2027-03-14)"*. Seeing what is deliberately **not** deletable is more
  valuable than seeing what is; it is the surface where a stuck report becomes visible.
- Hold set/clear with a reason field.
- Purge with typed confirmation, showing the dry-run state prominently. An admin must
  never be able to click purge while unsure whether it is live.
- Deletion history from `evidence_deletion_audit`.

Standalone-safe: if the companion plan has not merged, this ships as its own page and
merges into `/admin/safety` when the other lands.

### 5.8 Config keys

| Key | Default | Effect |
|---|---|---|
| `evidence_deletion_dry_run` | `true` | Purge logs but destroys nothing |
| `quarantine_evidence_retention_months` | **`12`** | The floor, bounded `1..120`. Read by `materializeRetentionUntil()` on every claim insert (§5.3) — it genuinely governs, rather than being a label on a hardcoded value. Replaces `quarantine_evidence_retention_days`, which is retired so two keys cannot disagree. |
| `evidence_retention_sweep_enabled` | `true` | Sweep is read-only, so on by default is safe |

## 6. Testing

`moderation.evidenceRetention.test.ts`. The negative cases carry the weight here — the
tests that matter are the ones asserting deletion **does not** happen.

Must-not-delete:
- Report `pending` / `in_progress` / `failed` / `retracted`, retention long expired →
  ineligible in every case.
- **`report_required = true` with a failed report insert — no `ncmec_reports` row at
  all** — and an expired clock → **ineligible**, no storage delete. The vacuous-truth
  hole; this is the test that proves rule 3 is affirmative rather than inferred.
- `retention_hold` on the quarantine row, or on the NCMEC row → ineligible.
- `retention_until` one second in the future → ineligible.
- Two claims, one expired and one not → ineligible (**the §5.1 composition rule**;
  asserted from both directions, quarantine-newer and report-newer).
- **A synthetic third claim kind** inserted into `evidence_claims` with a future clock
  blocks deletion **without any change to the eligibility query** — the registry's
  structural guarantee (§5.1).
- Dry-run on → `deleteObject` is **never called** (asserted on a spy, not inferred from
  absence of effect).
- Client submits an id that fails server-side re-derivation → refused, nothing deleted.
- **Concurrency:** purge paused after its eligibility read, then each blocking state
  added concurrently — a hold set, a report retracted, a new claim inserted — proves
  `deleteObject` is never called in any of the three (§5.2 serialization).

Must-delete:
- All conditions satisfied → object deleted, all claims stamped and released, audit row
  written with a populated snapshot, **in one transaction**.
- **Retry after a known attempt**: `deletion_attempted_at` set, storage reports missing →
  converges, stamps and audits with `converged_after_retry`.

Must-not-mis-audit:
- **First attempt, object already missing** (`deletion_attempted_at` null) → records
  `evidence_missing_at` and alerts; writes **no** successful-purge audit row. Distinguishes
  a retry from pre-existing loss (§5.6).
- Audit insert fails inside the final transaction → **neither** stamp nor audit persists,
  and the object remains retryable (§5.6).

Invariant:
- A repository-wide assertion that `{ force: true }` is passed to `deleteObject` from
  `evidenceRetention.ts` **and nowhere else.** A grep-style test, deliberately brittle:
  if someone adds a second `force` caller, this should fail loudly and make them justify
  it in review.
- The §5.1 CI guard: a schema file introducing a restricted-path column without an
  `evidence_claims` writer fails the build.

Migration:
- Backfill only extends. Seeded with a claim already beyond 12 months and one inside it;
  the former is untouched, the latter extended.
- Re-running the backfill is a no-op (idempotency).
- **Leap-day window**: a claim created 2027-03-01 expires 2028-03-01, not 2028-02-29.
- **Raising `quarantine_evidence_retention_months` to 120 extends existing unreleased
  claims** and governs newly created ones; lowering it never shortens an existing claim.
- `report_required` backfill marks historical Arachnid rows without a submitted report as
  blocked rather than eligible.
- Snapshot validator passes.

## 7. Interaction with the companion plan

One real coupling and one cosmetic one:

**Real:** eligibility rule 3 clears only when `report_satisfied_at` is set, and that is
set when a linked report reaches `submitted` — a status only the companion plan's worker
ever produces. If this plan merges first, no `report_required` claim ever satisfies, so
nothing with a reporting obligation becomes eligible and nothing is deleted. It fails
**closed**, which makes merge order a sequencing question rather than a safety one.
`report_satisfied_at` is owned by this plan's schema, so it does not depend on the
companion's migration existing; the companion simply becomes the thing that sets it.

Note the companion plan also adds `filed_manually` for reports filed by hand. This plan
treats `filed_manually` as satisfying the obligation alongside `submitted` — a report
genuinely filed through the manual form discharges the duty just as an automated one
does. If the companion has not merged, that status is unreachable and the predicate is
simply never true, which again fails closed.

**Cosmetic:** the `/admin/safety` page and the migration numbers (§5.3).

## 8. Open questions

**8.1 — Is 12 months right, or should it be indefinite-until-reviewed?** David chose 12
months over 90 days. An alternative worth naming: never expire automatically at all,
and let the queue surface old evidence for a periodic human decision with no clock
involved. The design already supports it — set
`quarantine_evidence_retention_months` to 120 and the queue becomes a decade-out review
rather than an expiry pipeline. Not a decision to relitigate now; a knob worth knowing
exists, and §5.3's monotonic-raise semantics mean turning it up later is safe.

**8.2 — Does deletion warrant a second approver?** Currently any admin can authorize.
This repo has no multi-role model (`architecture-map.md:158`), so two-person control
would mean building one. My read is that dry-run plus typed confirmation plus a
permanent audit trail is proportionate at current scale, and a role model is a large
change to make for this alone. Raising it so the choice is explicit rather than default.

**8.3 — Should NCMEC be notified before evidence is purged?** ISPWS has no such
endpoint and the reports are already filed with the bytes delivered, so my read is no.
Worth confirming on the walkthrough call Maya Mizuki offered.

## 9. Out of scope

- **Submission.** The companion plan owns the client, worker, and ledger.
- **Detection tuning.** Untouched.
- **`quarantined_memes.deleted_at`.** The existing soft-delete tombstone is unrelated to
  evidence expiry and keeps its current meaning.
- **General object-storage lifecycle.** This plan governs `restricted/quarantine/` only.
  Ordinary user media has its own unrelated rules.
