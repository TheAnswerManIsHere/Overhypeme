# Plan: mark estimated costs in the generation ledger

## Problem

The per-user spend ceiling is enforced by summing `user_generation_costs`. Two
things are wrong with what goes into that sum.

**A generation gated on a fallback estimate is recorded nowhere.** Both
synchronous writers guard their `recordCost` call on a provider-resolved price
(`if (userId && cachedImgPrice)`, and `if (… && cachedPriceForRecording &&
estimatedCostUsd > 0)`). PR #474 made those paths *gate* correctly on the
engine's configured estimate — and then they decline to *record* what they just
gated. Across a sustained fal pricing outage a user keeps generating, each
request is checked against a total that stops growing, and the ceiling
progressively stops binding. The symptom is invisible: no error, no log, a spend
history that simply under-reports.

**Nothing says which rows are measured and which are guessed.** The ledger
already contains operator-configured estimates — `videoPipelineRunner` writes
them unconditionally for stages 1 and 3, and for stage 2 when pricing lookup
fails — but a reader cannot tell them apart from provider-confirmed prices.
Worse, those rows carry `pricing_fetched_at: new Date()`, which asserts a
pricing fetch that never happened.

A third, related defect is folded in here rather than done separately, because
it changes the same function: **`recordCost` swallows its own write failure**.
It logs at WARN and returns, deliberately — it runs after a successful fal call,
so throwing would fail a generation the user has already been charged compute
for. But there is no retry and no backfill, so **one** lost insert permanently
under-states the ledger, and a later request can pass
`currentSpend + proposedCost <= limit` while real cumulative spend has crossed
it.

## Direction

Serves the spend-enforcement direction established by #409 → PR #443 → PR #474:
**the spend ceiling must bind on real cumulative spend, and enforcement must
never silently stop applying.** Those three increments hardened the *gate*; this
one hardens the *ledger the gate reads*.

What this increment makes true that wasn't before: every synchronous generation
that passes the gate leaves a ledger row, and every row states whether its cost
was measured or estimated.

## Product Intent

1. A generation that was gated on an estimate is **recorded**, at the estimate,
   rather than omitted.
2. Every ledger row says whether its cost is provider-confirmed or estimated.
3. Spend views (the user's own history and the admin per-user panel) **include**
   estimated rows in the total and **mark** any period that contains one.

## Must Not Change

- **The gate's fail-closed behaviour.** `BudgetGateError` (cannot tell → 503,
  retry-able) and `BudgetExceededError` (over limit → 429) stay distinct and
  keep their current semantics. Nothing here may turn a "cannot tell" into an
  allow.
- **The enforcement SUM counts every row**, estimated included. Excluding them
  would reopen the fail-open PR #474 closed.
- **Existing rows' contribution to totals.** The backfill classifies rows; it
  must not alter `computed_cost_usd`, so no user's displayed or enforced total
  moves as a result of this change.
- **`recordCost` still never fails a user's generation.** It runs after the
  provider call has already cost money; the fix improves what happens on write
  failure, it does not make the write fatal.
- **Ceiling values and tier policy.** Untouched.

## Settled Decisions

1. **A dedicated column, not an inferred flag** (David, 2026-08-16). Rejected:
   deriving "was this an estimate?" at read time from other columns. Provenance
   is a fact about the write and must be recorded at write time; the analysis
   below shows read-time inference is not even reliably possible.
2. **Include and label in the display** (David, 2026-08-17). Rejected: excluding
   estimated rows from the display (the shown total would under-report what the
   gate enforces, so a user could be blocked at their ceiling while their
   history shows less — invisible from the UI); and labelling only for admins
   (`SpendHistory.tsx` is one component serving both endpoints, so audience
   branching costs more than a shared flag, not less).
3. **The `recordCost` swallowed-write gap is folded in**, per
   `deferred-work.md`'s sequencing note — both changes touch the same function,
   and doing them separately means the second partly reverts the first's
   assumptions.

## Repo Context Inspected

- `lib/db/src/schema/falPricing.ts` — `user_generation_costs` definition.
- `artifacts/api-server/src/lib/budgetGate.ts` — `checkBudget` (the enforcement
  SUM, lines ~197-210) and `recordCost` (~223-238).
- `artifacts/api-server/src/lib/aiMemePipeline.ts` — ledger writes at 448, 711.
- `artifacts/api-server/src/routes/videos.ts` — ledger write at 791.
- `artifacts/api-server/src/lib/videoPipelineRunner.ts` — ledger writes at 1488
  (stage 1), 1519 (stage 2 priced), 1534 (stage 2 fallback), 1583 (stage 3).
- `artifacts/api-server/src/routes/users.ts` — `GET /api/users/me/spend`.
- `artifacts/overhype-me/src/components/ui/SpendHistory.tsx` — the shared
  component behind both the user and admin spend views.
- `lib/db/src/schema/engines.ts` — `estimated_cost_usd_per_call`,
  `estimated_cost_usd_per_second`.
- `docs/ai-context/security-model.md` (generation-spend section),
  `docs/engineering/migrations-and-backfills.md`,
  `docs/ai-context/known-failure-patterns.md` (the gate-precondition pattern).

## Current Behavior

Seven ledger call sites across three modules. Their provenance differs, and this
table is the load-bearing input to the backfill:

| # | Site | Cost source | `pricing_fetched_at` | `job_reference_id` |
|---|---|---|---|---|
| 1 | `aiMemePipeline:448` | provider price; **skipped when unpriced** | real fetch time | object storage path |
| 2 | `aiMemePipeline:711` | provider price; **skipped when unpriced** | real fetch time | object storage path |
| 3 | `videos.ts:791` | provider price; **skipped when unpriced, and when cost is 0** | real fetch time | fal request id / row id |
| 4 | `videoPipelineRunner:1488` | **estimate**, or hard-coded `0.03` if the engine row can't be read | `new Date()` — false | `videoJob_<id>_stage1_<n>` |
| 5 | `videoPipelineRunner:1519` | provider price | real fetch time | `videoJob_<id>_stage2` |
| 6 | `videoPipelineRunner:1534` | **estimate** | `new Date()` — false | `videoJob_<id>_stage2` |
| 7 | `videoPipelineRunner:1583` | **estimate**, or hard-coded fallback | `new Date()` — false | `videoJob_<id>_stage3` |

Three consequences worth stating explicitly, because each one invalidates an
approach that looks reasonable:

- **`pricing_fetched_at` cannot discriminate.** It is `NOT NULL` and estimate
  rows fill it with the current time, so it is populated and plausible on every
  row while being false on four of the seven.
- **`job_reference_id` alone cannot discriminate either.** Sites 5 and 6 —
  priced and estimated — write the **same** reference id
  (`videoJob_<id>_stage2`). An earlier framing of this work assumed the suffix
  was sufficient; it is sufficient for stages 1 and 3 and ambiguous for stage 2.
- **The obvious composite is unsafe in general — and worse than "approximately
  unsafe."** Estimate rows have `billing_units = 1` and
  `unit_price_at_creation = computed_cost_usd`. Read
  `computeImageCost` (`costComputation.ts:104`): its **default** branch is
  per-image pricing, which returns `billingUnits = count` and
  `costUsd = count * unitPrice`. For a single image that is *exactly*
  `billing_units = 1` and `unit_price_at_creation = computed_cost_usd` — the
  estimate signature, matched precisely, by a fully provider-priced row. (The
  megapixel branch gets there too for a ~1MP image: 1000x1000 is exactly 1.0.)
  So the composite does not merely risk collision; every single-image
  per-image-priced row in the table satisfies it. Scoping it to a reference-id
  pattern is therefore **load-bearing, not caution** — applied repo-wide it
  would mislabel a whole class of correctly-measured image rows as estimates.

The display path: `GET /api/users/me/spend` groups by year/month and returns
`SUM(computed_cost_usd)`; the admin endpoint mirrors it; `SpendHistory.tsx`
renders whichever it is pointed at.

## Source-of-Truth Analysis

- **Cumulative spend for enforcement** — `user_generation_costs`, summed in
  `checkBudget`. Unchanged, and remains the only source.
- **Per-row cost provenance** — *new*: the `is_estimated` column. Today this
  fact exists only implicitly, in which branch of which writer ran, and is
  partially unrecoverable afterwards. This plan makes the write site record it
  rather than creating a second derived source; nothing else may infer
  provenance from `pricing_fetched_at`, `billing_units`, or the reference id
  after this lands.
- **The estimate value itself** — the persisted `engines` row
  (`estimated_cost_usd_per_call` / `_per_second`), per PR #474's precedence
  decision (persisted row over code seed). Unchanged.
- **Ceiling values** — `admin_config` plus the per-user override. Untouched.

No new source of truth is created; one implicit fact becomes explicit.

## Data Model and Migration Impact

**Column.** `is_estimated boolean` on `user_generation_costs`.

**The nullability decision is the crux of this plan.** Three states must be
representable, and collapsing them is how a backfill on a payment path goes
quietly wrong:

| State | Meaning |
|---|---|
| `false` | cost came from a provider-resolved price |
| `true` | cost came from an operator-configured estimate or a hard-coded fallback |
| `NULL` | provenance is genuinely unrecoverable for this historical row |

So the column is **nullable, with no default**, and new writes always supply it
explicitly. A `NOT NULL DEFAULT false` would be the tidier schema and is
rejected: it would assert "measured" for every historical row, including the
site-6 rows we know are estimates and cannot always identify. Recording an
unknown as a known false is exactly the failure this column exists to prevent.

**Backfill, by reference-id pattern, most-certain first:**

| Rows | Set | Certainty |
|---|---|---|
| `job_reference_id LIKE 'videoJob_%_stage1_%'` | `true` | certain — site 4 is the only writer of that pattern, and it is always an estimate |
| `job_reference_id LIKE 'videoJob_%_stage3'` | `true` | certain — same argument for site 7 |
| `job_reference_id LIKE 'videoJob_%_stage2'` AND `billing_units = 1` AND `unit_price_at_creation = computed_cost_usd` | `true` | high — site 6's signature, scoped so the megapixel collision cannot reach it |
| `job_reference_id LIKE 'videoJob_%_stage2'` (remainder) | `false` | high — site 5 computes `billing_units` from pixels × fps × duration, which is ≫ 1 |
| everything else | `false` | certain — sites 1-3 record only when a provider price resolved |
| anything the above leaves unmatched | `NULL` | honest unknown |

The final row is not decoration: it is the reason the column is nullable. If the
patterns fail to cover something, the migration must leave it unknown rather
than sweep it into `false`.

**Idempotency.** Column add is `IF NOT EXISTS`; the backfill is a set of
`UPDATE … WHERE is_estimated IS NULL AND <pattern>`, so re-running converges and
never revisits a classified row. **Rollback** is `DROP COLUMN` — no data loss,
since nothing else is modified. **Observability**: the migration reports counts
per bucket, including the `NULL` remainder, and the remainder count is the
number to look at.

**Row-state matrix** (`old` = pre-migration rows, `new` = written after):

| | classified `true` | classified `false` | left `NULL` | new writes |
|---|---|---|---|---|
| enforcement SUM | included | included | included | included |
| display total | included | included | included | included |
| display marking | marked | not marked | **marked** — see below | per flag |

`NULL` is displayed as marked rather than unmarked: "we are not certain this was
measured" belongs on the same side as "this was estimated," because the marking
claims precision and an unknown does not have it.

**Which value new writes use is the second design point.** Sites 4, 6 and 7 are
already estimates and become `true` with no behavioural change. Sites 1-3 gain
an estimate path (that is the recording gap) and pass `true` on it, `false`
otherwise.

**`pricing_fetched_at` on estimate rows.** It is `NOT NULL` and currently gets
`new Date()`, which is false. This plan does **not** relax the constraint —
that is a second schema change on the same table for a field nothing currently
reads. Instead, `is_estimated = true` becomes the documented signal that
`pricing_fetched_at` on that row is the write time, not a fetch time, recorded
in the schema comment and in `security-model.md`. Making the column nullable is
noted as a **next**, not a now.

## Runtime Behavior

**Recording an unpriced generation.** Sites 1-3 lose their price-conditional
guard and record either way: with the resolved price (`is_estimated = false`) or
with the same engine-configured estimate the gate already used
(`is_estimated = true`). The estimate is resolved through the *same* helper the
gate uses, so the recorded figure and the gated figure cannot diverge — a
generation is never checked against one number and recorded at another.

Site 3 additionally drops its `estimatedCostUsd > 0` condition. A deliberate
zero is a real price for a free endpoint, and discarding it is the same `> 0`
null-guard mistake already recorded in `.agents/memory/`.

**When the estimate itself cannot be resolved** — the engines row is unreadable —
the gate already denies with `BudgetGateError`, so no generation happens and
there is nothing to record. Unchanged.

**`recordCost` write failure.** Still non-fatal, still WARN. What changes: the
failure becomes *visible* rather than only logged, so a silently under-counting
ledger is detectable. The minimum is a counter or health field that an admin
surface can read, consistent with the async-status rule; the plan's requirement
is that a lost ledger write is observable somewhere a human looks, not the
specific surface. Retry is deliberately **out of scope**: a retry loop after a
completed provider call is its own failure mode, and the observable-failure
requirement is what closes the "silently stops binding" hole.

## Admin/User UX Impact

`SpendHistory.tsx` (both audiences) gains a marker on any period containing at
least one estimated or unknown row: the figure carries a `~` and the period
shows a short "includes estimated costs" note. Empty, loading and error states
are unchanged. No new screen, no new route.

The manual's payments chapter already states that a spend history is a good
estimate rather than a bill; this makes that visible per period instead of only
in prose.

## Security, Permissions, and Validation

No new routes and no change to route protection: `/api/users/me/spend` stays
self-scoped and the admin endpoint stays behind `requireAdmin`. The new field is
a boolean with no user-supplied path into it — it is set by the writer, never
accepted from a request. No PII. The relevant security property is the one in
*Must Not Change*: enforcement continues to count every row, so the ceiling
cannot be widened by this change.

## Testing Plan

Automated, `pnpm --filter @workspace/api-server test`:

1. **The recording gap, per synchronous writer.** With pricing unresolvable, a
   generation that passes the gate produces a ledger row whose cost equals the
   engine estimate and whose `is_estimated` is `true`. This is the regression
   that must fail without the fix.
2. **Gated and recorded figures agree.** For the same unpriced generation, the
   value the gate used and the value recorded are equal — proving they resolve
   through one path.
3. **A deliberate zero is recorded**, not discarded (site 3's `> 0`).
4. **Enforcement counts estimated rows.** A ceiling is reached by estimated rows
   alone; the next request is refused with `BudgetExceededError`.
5. **The backfill classifier**, against seeded rows in every shape from the
   Current Behavior table — including the two stage-2 shapes, which must
   classify differently despite identical reference ids, and an unmatched shape
   that must remain `NULL`.
6. **Backfill idempotency**: running twice produces the same classification and
   the same counts.
7. **`recordCost` failure is observable**: with the insert forced to fail, the
   generation still succeeds and the failure is visible through the surface
   chosen.

Frontend, `pnpm --filter @workspace/overhype-me test`: a period containing an
estimated row renders marked; an all-confirmed period does not; a `NULL`-bearing
period renders marked.

Manual QA is a UAT doc: generate with pricing available and unavailable, and
confirm the spend view marks the second.

## Implementation Steps

1. Schema: add the nullable column + schema comment; generate the migration.
2. Backfill in the same migration, ordered most-certain-first, reporting per-bucket counts.
3. `recordCost`: accept and persist `isEstimated`; make a failed write observable.
4. Sites 4, 6, 7: pass `true` (no behaviour change).
5. Sites 1, 2: record on the estimate path; pass the flag.
6. Site 3: same, and drop the `> 0` condition.
7. Both spend endpoints: return a per-period `hasEstimates` flag.
8. `SpendHistory.tsx`: render the marker.
9. Docs: `security-model.md` (what the flag means, and the `pricing_fetched_at`
   caveat), `deferred-work.md` (close the two folded entries).

Steps 1-6 are shippable without 7-8; the display is the last increment, not the
enabling one.

## Risks and Mitigations

- **A wrong backfill mislabels historical spend.** Mitigated by classifying
  most-certain-first, scoping the ambiguous composite to a reference-id pattern,
  and leaving unmatched rows `NULL` rather than guessing. `computed_cost_usd` is
  never written, so a misclassification is cosmetic and correctable, never a
  change to anyone's total.
- **The estimate path diverges from the gate's estimate**, so a user is checked
  against one figure and charged another. Mitigated by resolving both through
  one helper, and asserted directly by test 2.
- **Recording more rows raises spend totals**, so users hit ceilings sooner.
  This is the intended correction — the previous totals were wrong — but it is a
  live behavioural change worth naming in the UAT rather than discovering in
  support.
- **The stage-2 composite misfires** on a shape not seen in the current data.
  Mitigated by the `NULL` bucket and by reporting its count; a large remainder
  is the signal to stop and re-derive rather than proceed.

## Questions for David

None outstanding. The display question (include / label / exclude) was answered
on 2026-08-17: include and label.

## Definition of Done

- [ ] Migration applies and rolls back cleanly; per-bucket counts reported; the `NULL` remainder is small and explained.
- [ ] Every synchronous writer records an unpriced generation, at the same figure the gate used.
- [ ] Enforcement sums estimated rows; the ceiling binds on them.
- [ ] A failed ledger write is visible to a human, not only in a log line.
- [ ] Both spend views mark periods containing estimated or unknown rows, and their totals are unchanged by the migration.
- [ ] The behaviour can be exercised in the product: generate with pricing unavailable, then see the marked period in the spend view (UAT doc).
