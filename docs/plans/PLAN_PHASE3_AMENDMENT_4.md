# Plan amendment 4 — Launch Phase 3, increment 8: adoption creates the functions and triggers Replit's copy dropped

Amends `docs/plans/PLAN_PHASE3_AMENDMENT_3.md` (sha256 `4024dc239b3a2785455d581418b0c40a90c43c5fa8726f5d89b12fb1c80042fc`), which amends `PLAN_PHASE3_AMENDMENT_2.md`. Workstream: Issue #770.

```plan-oracle
# Oracle — Launch Phase 3, amendment 4: adoption creates the functions and triggers Replit's copy dropped

Agreed with David 2026-10-30 ("Go with option 1", replying to the banner whose
option 1 read: "Amendment 4: adoption creates the missing functions and
triggers from the code's build, then proves everything. Inside the same
transaction, it creates each missing function and trigger using the reference
database's own definitions, which the runner built from code, and sets each
trigger's firing mode to match. It then re-runs the full structure comparison
before committing, so the commit happens only if production now matches the
code exactly. Limits: only functions and triggers, and only ones that are
absent. Anything that exists but differs, and any missing table or column,
still refuses. Nothing comes from dev.").

## Why

The adoption run of 2026-10-30 (~18:40 UTC) refused and changed nothing.
Eligibility passed. The structure differed only by 15 lines present in the
reference and absent from production, every one diagnosed "transfer" (dev
has them): 5 functions (`backfill_feature_permissions`,
`entitlement_source_disputes_guard_absorbing`,
`membership_entitlements_guard_immutable`, `ncmec_reports_link_quarantine`,
`ncmec_safety_audit_log_append_only`), their 5 triggers and their 5 trigger
modes. Replit's publish copies tables but not functions or triggers.

## Product intent of this amendment

1. Amendments 2 and 3's intent stands: production comes back up on a
   database whose structure is exactly what the code builds, holding no
   pre-reset data, and nothing is adopted on trust.
2. A function or trigger the reference has and production lacks is created
   from the reference's own definition, and each trigger's firing mode is
   set to the reference's.
3. The commit happens only if, inside the transaction, production's whole
   compared structure then equals the reference's.

## Must not change

- Amendments 2 and 3's must-not-change lists, in full.
- Only absent functions and triggers are created. A function or trigger
  present in production but different, any line only in production, and any
  other kind of missing object (table, column, index, constraint, sequence,
  extension) still refuses before anything is written.
- Nothing is copied from dev; dev is read only for the diagnosis.

## Settled decisions

- Amendments 2 and 3's settled decisions.
- Option 1, as quoted above (David, 2026-10-30).

## Ceremony tier

Sensitive. One PR, Codex review on every changed head.
```

## The change

- **Pre-write gate.** The comparison of production with the reference may
  differ only by lines present in the reference alone, and only of the kinds
  `function`, `trigger` and `trigger-mode`. A line present in production
  alone, or a missing line of any other kind, refuses as before.
- **Inside the transaction**, before the rows are installed: each function
  that the reference has and production lacks (matched by signature) is
  created from `pg_get_functiondef` on the reference. Then each trigger the
  reference has and production lacks (matched by table and name) is created
  from `pg_get_triggerdef`, and its mode is set from the reference's
  `tgenabled` (`A` enable always, `R` enable replica, `D` disable). Both are
  operations a table owner may perform; no superuser is needed.
- **Full proof before the commit**: the ledger (amendment 3), the functions
  and triggers, then the rows and sequences. Then production's whole compared
  structure must equal the reference's, or everything rolls back.
- **Report:** `installed.created` lists the functions and triggers created.

## Verification

- A test in production's measured shape: no `drizzle`, a `_system` record,
  and the five functions and their triggers dropped. Adoption succeeds; every
  function and trigger exists, with the audit log's two triggers reading `A`;
  the structure then equals the code's build.
- A function that exists but differs still refuses before anything is
  written.
- A missing table still refuses.
- Every earlier case still passes, the ALWAYS→ORIGIN trigger-mode refusal
  included.
- Live: the run through the connector on David's go, then amendment 2's live
  checks.
