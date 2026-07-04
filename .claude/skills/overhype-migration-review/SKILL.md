---
name: overhype-migration-review
description: Review or implement Overhype.me schema/data migrations and backfills. Use for schema, Drizzle, migration, backfill, enrichment versioning, processing-signature, or bulk data work. Enforces idempotency, observability counts, the old/new/partial/failed/skipped/no-op row-state matrix, human-override preservation, and rollback for destructive ops.
---

# Overhype migration review

For any schema change, migration, or backfill (including enrichment versioning,
processing signatures, or bulk data reprocessing).

## Read first

- [`docs/engineering/migrations-and-backfills.md`](../../../docs/engineering/migrations-and-backfills.md)
- The relevant `docs/ai-context/*` (e.g.
  [`taxonomy-and-enrichment.md`](../../../docs/ai-context/taxonomy-and-enrichment.md)
  for enrichment/versioning/signature work).

## Require

- **Row-state matrix.** Reason explicitly about old / new / partially migrated /
  failed / skipped / no-op rows where relevant.
- **Idempotency.** Safe to run more than once; hand-authored `IF NOT EXISTS` SQL
  (the `drizzle-kit generate` snapshot is broken — follow the existing idempotent
  pattern, don't rely on the generator).
- **Observability counts.** Broad data changes expose processed/succeeded/failed/
  skipped/no-op counts; surface async work with per-item + aggregate status.
- **Human-decision preservation.** Bulk jobs must not silently overwrite manual
  overrides (mirror `factEnrichmentBackfillJob`'s skip-unless-forced).
- **Tests or clear manual verification** for high-risk data changes: apply →
  `run-test.sh --setup` → run affected tests; assert idempotency (twice == once).
- **No destructive ops** (drops, irreversible rewrites) unless the plan explicitly
  includes recovery/rollback. Prefer additive changes.

## Note the current gap

Processing signatures are a **TODO** (`signature: null // TODO(PR3-signature)`);
the columns and copy-at-promote path exist but nothing stamps a signature yet.
Don't assume signatures are live — closing this is real work, not a given.

## Output

Prioritized findings (correctness/data-durability first), the row-state matrix,
idempotency + observability check, and — for destructive changes — the
rollback/recovery path. Escalate schema-shape decisions with product consequences
to David.
