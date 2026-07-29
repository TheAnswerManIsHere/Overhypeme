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

### 5.1 One object, several claims — the composition rule

An evidence object can be referenced by a `quarantined_memes` row and, when the hit was
reportable, by an `ncmec_reports` row pointing at the same path. Two rows, two clocks,
one object.

**The rule: an object survives until the latest expiry among every row that claims it,
and is eligible only when every claim is simultaneously satisfied.** Not the earliest,
not whichever the sweep happens to query first. A `max()` across claims, evaluated in a
single query, so a new claiming table added later cannot silently shorten an object's
life by being forgotten in a second code path.

Getting this backwards — deleting when *any* claim expires — is the single easiest way
for this feature to destroy evidence it was obliged to keep. It is called out here so
review can attack it directly.

### 5.2 Eligibility

An object is eligible for deletion only when **all** hold:

1. `evidence_retention_until <= now()` for **every** row claiming it (§5.1).
2. No claiming row has `retention_hold = true` (§5.4).
3. **Every claiming `ncmec_reports` row has `submission_status = 'submitted'` with a
   non-null `finished_at`.** A `pending`, `in_progress`, `failed`, or `retracted` report
   blocks deletion indefinitely. A report we never successfully filed is a report whose
   evidence we may yet need to file.
4. `evidence_deleted_at` is null (not already purged).

Eligibility is computed **server-side at the moment of deletion**, never taken from the
client. The admin UI submits ids; the endpoint re-derives eligibility for each and
refuses any that no longer qualify. A stale browser tab must not be able to authorize a
purge that became invalid after the page loaded.

### 5.3 Schema — migration `0095_evidence_retention.sql`

On `quarantined_memes` (it owns the object path and currently has no clock):

| Column | Type | Purpose |
|---|---|---|
| `evidence_retention_until` | `timestamptz not null` | Backfilled `created_at + 365 days` |
| `evidence_deleted_at` | `timestamptz` | Set when bytes are purged; row itself persists |
| `retention_hold` | `boolean not null default false` | §5.4 |

On `ncmec_reports`:

| Column | Type | Purpose |
|---|---|---|
| `evidence_deleted_at` | `timestamptz` | Same |
| `retention_hold` | `boolean not null default false` | §5.4 |

**Default and backfill.** `evidence_retention_until`'s default moves from
`now() + interval '90 days'` to `now() + interval '365 days'`. Existing rows are
extended with a deliberately one-directional backfill:

```sql
UPDATE ncmec_reports
   SET evidence_retention_until = created_at + interval '365 days'
 WHERE evidence_retention_until < created_at + interval '365 days';
```

The `WHERE` clause means the statement can only ever *lengthen* a retention window,
never shorten one. It is idempotent, safe to re-run, and safe if a future admin has
manually extended a specific row — that row is left alone. Per
`overhype-migration-review`, the migration reports affected-row counts.

**Config constraint.** `quarantine_evidence_retention_days` is bounded `30..365`, so 365
sits exactly at the ceiling. The migration raises the max to `3650` — leaving a
legally-motivated setting pinned against an arbitrary bound invites someone to lower the
value rather than raise the bound.

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

1. **Re-derive eligibility** (§5.2). Ineligible → skip, report why, continue.
2. **Dry-run check.** If `evidence_deletion_dry_run` is true (**default true**), log the
   intended deletion and stop. Nothing is destroyed until an operator deliberately turns
   dry-run off.
3. `deleteObject(path, { force: true })`.
4. Stamp `evidence_deleted_at` on every claiming row.
5. Append the `evidence_deletion_audit` row with the §5.3 snapshot.

**Ordering and partial failure.** Delete-then-stamp is deliberate. If the delete succeeds
and the stamp fails, the object is gone but rows still claim it; the next authorization
retries, receives not-found from storage, treats that as success, and completes the
stamp. The state converges. Stamping first would produce the worse failure: rows
asserting evidence was purged while the bytes remain, which corrupts the audit trail —
the one artifact that has to be trustworthy. **Not-found is therefore an explicit success
case**, not an error.

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
| `quarantine_evidence_retention_days` | `90` → **`365`** | The floor; bound raised to 3650 |
| `evidence_retention_sweep_enabled` | `true` | Sweep is read-only, so on by default is safe |

## 6. Testing

`moderation.evidenceRetention.test.ts`. The negative cases carry the weight here — the
tests that matter are the ones asserting deletion **does not** happen.

Must-not-delete:
- Report `pending` / `in_progress` / `failed` / `retracted`, retention long expired →
  ineligible in every case.
- `retention_hold` on the quarantine row, or on the NCMEC row → ineligible.
- `evidence_retention_until` one second in the future → ineligible.
- Two claims, one expired and one not → ineligible (**the §5.1 composition rule**;
  asserted from both directions, quarantine-newer and report-newer).
- Dry-run on → `deleteObject` is **never called** (asserted on a spy, not inferred from
  absence of effect).
- Client submits an id that fails server-side re-derivation → refused, nothing deleted.

Must-delete:
- All conditions satisfied → object deleted, both rows stamped, audit row written with a
  populated snapshot.
- Not-found from storage on a retry → treated as success, stamp completes, no error.

Invariant:
- A repository-wide assertion that `{ force: true }` is passed to `deleteObject` from
  `evidenceRetention.ts` **and nowhere else.** A grep-style test, deliberately brittle:
  if someone adds a second `force` caller, this should fail loudly and make them justify
  it in review.

Migration:
- Backfill only extends. Seeded with a row already beyond 365 days and one inside it;
  the former is untouched, the latter extended.
- Re-running the backfill is a no-op (idempotency).
- Snapshot validator passes.

## 7. Interaction with the companion plan

One real coupling and one cosmetic one:

**Real:** eligibility rule 3 depends on `submission_status = 'submitted'` and
`finished_at`. `finished_at` is added by the companion plan's migration `0094`, and
`submitted` is only ever *reached* by its worker. If this plan merges first, rule 3
evaluates against a status no row currently attains — which fails **closed**: nothing
becomes eligible, nothing is deleted. That is the correct degradation, and it means merge
order is a matter of sequencing, not of safety. If this merges first, the `finished_at`
predicate is written defensively so an absent column is impossible rather than assumed —
this plan's migration adds it if not present, and the companion's becomes a no-op for it.

**Cosmetic:** the `/admin/safety` page and the migration numbers (§5.3).

## 8. Open questions

**8.1 — Is 12 months right, or should it be indefinite-until-reviewed?** David chose 12
months over 90 days. An alternative worth naming: never expire automatically at all,
and let the queue surface old evidence for a periodic human decision with no clock
involved. The design already supports it — set the floor to 3650 days and the queue
becomes an annual review rather than an expiry pipeline. Not a decision to relitigate
now; a knob worth knowing exists.

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
