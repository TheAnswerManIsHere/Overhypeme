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
that reaches the recording point leaves a ledger row, and every row states
whether its cost came from a **provider-resolved rate** or an
**operator-configured estimate**.

## Product Intent

1. A generation that was gated on an estimate is **recorded**, at the estimate,
   rather than omitted — *at the point where recording happens today*. See the
   scope boundary immediately below, which is narrower than it first appears.
2. Every ledger row says whether its cost came from a **provider-resolved rate**
   or an **operator-configured estimate**.
3. Spend views **include** estimated rows in the total and **mark** any period
   that contains one.

**The binary is NOT measured-versus-estimated, and saying so would overclaim.**
`deferred-work.md` records the canonical distinction and this plan is bound by
it: *no* row holds an actual provider charge. `getCachedPrice` returns an
hourly-refreshed unit rate and `costComputation.ts` derives a cost from
dimensions, count and duration without ever reading a billing result. So
`false` means "fal's published rate for that endpoint, applied to this
request's parameters" and `true` means "our own configured guess." Both are
computed. An unmarked period is *better sourced*, not *actual*, and the
user-facing copy must not imply otherwise.

### Scope boundary: this plan does not move the recording point

**What "every generation leaves a row" actually means here, stated precisely
because the looser version is false.** `recordCost` runs *after* post-processing
— after moderation, after the image URL is read, after download, classification
and storage; for synchronous video, after the job row is updated. A provider
call that succeeds and then fails downstream has consumed real money and still
records nothing, and **this plan does not change that.**

Those paths are not the recording gap this plan closes (which is "priced
correctly, gated correctly, then declined to record"). Moving accounting to the
successful-provider-response boundary is a different and larger change: it needs
failure metadata, an idempotency key so the later success path doesn't
double-record, and — most importantly — a product decision about whether a
user's budget is consumed by a generation they never received. That last part is
not mine to decide, so it is **Q3** below rather than an assumption.

Until it is answered, this increment's claim is the narrow one: *a generation
that reaches the recording point is recorded, with its provenance*. The plan
says so rather than implying the broader guarantee.

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
- **The estimate value itself** — *not* a single source, and the plan's first
  draft said it was. `fallbackImageCostUsd` resolves through a precedence
  chain: **persisted-exact** (the `engines` row for that model) → **catalogue-
  exact** (the code seed for that model) → **max-across-persisted**, with a
  model-specific figure always beating an aggregate, per PR #474's decision. The
  video stages add a fourth tier: a **hard-coded constant** (`STAGE1_FALLBACK_
  COST = 0.03`, and its stage-3 equivalent) used when the engine row cannot be
  read at all.

  The consequence for this plan is a requirement, not a caveat: **the value
  recorded is the exact value the gate used**, carried from the gate to the
  ledger rather than re-derived at the write site. Re-reading "the engine row"
  at recording time would silently disagree with the gate whenever the chain
  fell past its first tier — which is precisely the situation in which an
  estimate is being recorded at all. `is_estimated = true` means "this figure
  came from somewhere in that chain," not "this came from the engines row."
- **Ceiling values** — `admin_config` plus the per-user override. Untouched.

No new source of truth is created; one implicit fact becomes explicit.

## Data Model and Migration Impact

**Column.** `is_estimated boolean` on `user_generation_costs`.

**The nullability decision is the crux of this plan.** Three states must be
representable, and collapsing them is how a backfill on a payment path goes
quietly wrong:

| State | Meaning |
|---|---|
| `false` | cost derived from fal's published rate for that endpoint |
| `true` | cost derived from an operator-configured estimate or a hard-coded fallback |
| `NULL` | provenance is genuinely unrecoverable for this historical row |

So the column is **nullable, with no default**, and new writes always supply it
explicitly. A `NOT NULL DEFAULT false` would be the tidier schema and is
rejected: it would assert "measured" for every historical row, including the
site-6 rows we know are estimates and cannot always identify. Recording an
unknown as a known false is exactly the failure this column exists to prevent.

**Backfill — positive proof only, in a dry run first.**

Two rules govern it, and both exist because the first draft of this plan broke
them:

1. **Only positively-proven shapes are written.** An "everything else → false"
   sweep is forbidden: it would consume every unmatched row and make the `NULL`
   bucket unreachable, which contradicts the entire reason the column is
   nullable. Any row that matches no rule is *left untouched*.
2. **No `UPDATE` runs until a read-only preflight has been inspected.** The
   migration ships as two steps: a dry run that reports the counts each rule
   *would* affect plus the unmatched remainder, and the mutation, which runs
   only after those counts are reviewed and is aborted by the guard below.

| Rule | Rows | Set | Basis |
|---|---|---|---|
| R1 | `job_reference_id LIKE 'videoJob_%_stage1_%'` | `true` | site 4 is the only writer of that pattern and is always an estimate |
| R2 | `job_reference_id LIKE 'videoJob_%_stage3'` | `true` | same argument for site 7 |
| R3 | `job_reference_id LIKE 'videoJob_%_stage2'` AND `billing_units = 1` | `true` | site 6's shape; site 5 computes `billing_units` from pixels x fps x duration, which is never 1 |
| R4 | `job_reference_id LIKE 'videoJob_%_stage2'` AND `billing_units > 1` | `false` | site 5's shape, stated positively rather than as a remainder |
| R5 | `job_reference_id NOT LIKE 'videoJob_%'` | `false` | sites 1-3 record only when a provider price resolved |
| — | anything matching no rule | **left `NULL`** | provenance genuinely unrecoverable |

**`unit_price_at_creation = computed_cost_usd` is NOT part of R3, and must not
be reintroduced.** It looks like a natural discriminator — site 6 writes the
same JS number into both columns — but the columns have different scales
(`numeric(12,6)` and `numeric(10,4)`), so Postgres stores a cost of `0.61728`
as `0.617280` and `0.6173`, which are not equal. Verified directly:

```sql
select (0.61728::numeric(12,6))::text, (0.61728::numeric(10,4))::text,
       (0.61728::numeric(12,6) = 0.61728::numeric(10,4));
--  0.617280 | 0.6173 | f
```

Any operator-configured rate with more than four decimal places would therefore
fail the equality, fall through, and be labelled provider-resolved — silently
mislabelling exactly the rows this column exists to identify. `billing_units = 1`
alone carries the distinction, and is scale-independent.

**Scoping every rule to a reference-id pattern is load-bearing**, per the
Current Behavior analysis: `billing_units = 1` is also the signature of every
single-image per-image-priced row, so an unscoped rule would mislabel a whole
class of correctly-measured image rows.

**Abort condition.** The mutation step refuses to run if the unmatched remainder
exceeds a threshold agreed from the dry-run output, or if R3 and R4 do not
partition the stage-2 rows exactly (their counts must sum to the total number of
stage-2 rows — any row with `billing_units` neither `1` nor `> 1`, i.e. a value
below 1, is unaccounted for and stops the migration). A surprising distribution
must **prevent** the write, not be discovered in its output.

**Idempotency.** Every rule is `UPDATE … WHERE is_estimated IS NULL AND <rule>`,
so re-running converges and never revisits a classified row. Re-running the dry
run is free.

**Rollout ordering, and the window it closes.** Migrations run at server
startup (`await runMigrations()` in `index.ts`), and autoscale can have several
instances, so "add the column and backfill in one step" leaves a window: after
the transaction commits, still-running old instances keep inserting rows with no
flag, and because the migration is hash-recorded it never runs again — those
rows stay `NULL` permanently and invisibly. The rollout is therefore three
phases, in this order:

1. **Release A — expand.** Add the nullable column only. No backfill.
   Backward-compatible: old instances keep inserting successfully, their rows
   simply carry `NULL`.
2. **Release B — writers.** Every ledger site supplies the flag. Then wait for
   the old instances to drain, and *verify* the drain rather than assuming it.
3. **Operator-run preflight.** The read-only dry run, executed and inspected by
   a human. Not a migration.
4. **Release C — classify.** The mutating backfill, shipped only after step 3's
   counts have been approved.

**A later migration *file* is not a later *phase*, and this is the correction
that matters.** `index.ts` runs every pending migration at startup before the
instance listens, with no pause for anyone to look at anything — so two
migration files in the same release execute back-to-back on the same boot, in
the same window, with no drain between them and no opportunity to inspect a dry
run. The phases must therefore be **separate deploys**, and the preflight must
sit *outside* the migration runner entirely (a script an operator runs against
the database, not a migration the server executes for them).

This is the single most collapsible part of the plan: shipping A, B and C
together is one merge away, and it silently reintroduces both the old-binary
window and the un-inspected mutation.

**Rollback is app-first, and the column stays.** `DROP COLUMN` is not a lossless
rollback once phase 2 has shipped — it discards provenance that only exists
there — and dropping it while the new app is live breaks that app's inserts and
spend queries. So: to roll back, revert the *application* and leave the column
in place. It is nullable and unread by the old code, so it is inert. Dropping it
is reserved for abandoning the work entirely, and is an explicit acceptance that
provenance written since phase 2 is lost. Recovery after phase 2 is otherwise
**forward-only**.

**Observability.** The dry run reports per-rule counts and the unmatched
remainder before anything is written; the mutation reports what it actually
changed. The remainder is the number to look at.

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

**Every column of an estimated row is specified, not left to the implementer.**
`recordCost` requires `unit_price_at_creation`, `billing_units`,
`computed_cost_usd` and `pricing_fetched_at`, and the fallback helpers produce
only a scalar. Guessing the decomposition is how the component fields end up
disagreeing with the total:

| Column | Per-call estimate (images, stages 1/3) | Per-second estimate (video) |
|---|---|---|
| `computed_cost_usd` | the scalar the gate used | the scalar the gate used |
| `unit_price_at_creation` | the same scalar | the per-second rate |
| `billing_units` | `1` | the duration in seconds |
| `pricing_fetched_at` | write time — see the caveat below | write time |

The invariant to assert in the recording tests is
`unit_price_at_creation * billing_units = computed_cost_usd` for every estimated
row. That also keeps the backfill's R3 (`billing_units = 1`) meaningful for rows
written after this change, rather than accidentally true.

**When the estimate itself cannot be resolved** — the engines row is unreadable —
the gate already denies with `BudgetGateError`, so no generation happens and
there is nothing to record. Unchanged.

**The admin path is the exception, and it needs stating explicitly.**
`checkBudget` returns at its admin exemption *before* invoking the cost thunk —
deliberately, since resolving a fallible read ahead of an exemption is the
ordering bug PR #474 fixed. So for an admin's unpriced generation there is no
gate-resolved figure to carry forward, and the invariant above ("record what the
gate used") has no referent. Two things follow, and neither may be traded for
the other:

- **The gate must not resolve the estimate for admins.** Making `checkBudget`
  evaluate the thunk before the exemption in order to give the recorder a value
  would reintroduce exactly the fail-closed-before-exemption bug. Off the table.
- **Recording resolves it after the provider call, inside the non-fatal
  envelope — but only where it must.** This applies to the **image** paths
  (sites 1-2), which pass a thunk the gate never invokes for an admin. It does
  **not** apply to synchronous video (site 3): that route computes its estimate
  eagerly from an already-loaded engine *before* calling `checkBudget`, so the
  exact figure is in memory whether or not the gate consumed it. Site 3 carries
  that precomputed value forward; re-resolving it post-call would manufacture a
  failure window in which an engines-table outage loses a row that was never at
  risk. Where a post-call lookup is genuinely needed, it is wrapped so a failure
  logs and skips the row rather than throwing `BudgetGateError` into a
  generation that has already completed and already cost money. A skip is one of
  the lost-write cases the accounting-health signal must surface.

So an admin's unpriced generation is recorded on a best-effort basis, and its
absence is visible rather than silent. That is weaker than the guarantee for
non-admin rows, and deliberately so: admins are exempt from the ceiling, so
their rows are cost telemetry rather than enforcement input.

**`recordCost` write failure — and a correction to what this plan first claimed
about it.** The first draft said observability "closes the silently-stops-binding
hole." **It does not, and that sentence was wrong.** A swallowed insert leaves
the SUM permanently low; a counter tells a human it happened, but the ceiling is
still measured against an under-stated total from that moment on. Making a
failure *visible* and making the ceiling *bind* are different properties, and
only the first is delivered by observability.

That leaves a genuine fork, and it is **David's to decide, not mine** — it trades
a widened ceiling against either added machinery or refused generations. It is
escalated in *Questions for David* below. Until it is answered, this plan
specifies only the part that is not in dispute:

- **Storage:** a single-row `admin_config`-style counter (`ledger_write_failures`
  total, plus `ledger_write_failure_last_at`), incremented in its own statement.
  Not a per-failure table: the point is a health indicator, not a forensic log,
  and a second unbounded write path on a failing database makes things worse.
- **Its own failure semantics, which are the interesting case.** If
  `recordCost`'s insert failed *because the database is unavailable*, the health
  write fails for the same reason. That is acknowledged rather than papered
  over: **the structured log line is the floor**, and the counter is a
  best-effort improvement on it. A signal that claims to survive its own
  dependency's outage would be a lie, and specifying one would produce an
  implementation that quietly doesn't.
- **What that means for detection:** a *total* database outage is already loud
  through other means (every request fails). The failure this counter exists to
  catch is the quiet one — a constraint violation, a serialization failure, a
  single lost insert against an otherwise-healthy database — where the write
  does succeed and nothing else is on fire.
- **Presentation:** surfaced in the existing admin health area, reachable
  without a new screen. Per the async-status rule, an operator must be able to
  see it without reading logs.
- **Tests:** force an insert failure with the database otherwise healthy and
  assert the counter moves and the generation still succeeds; and force a
  failure of the counter write itself and assert the log line still carries the
  event.
- The same signal covers the admin-path skip described above.

**If David picks option 2 in Q1** (fail closed on unhealthy accounting), this
counter is insufficient by construction — blocking a *specific user* needs
per-user attribution, which a global counter does not have. That is part of
option 2's cost, and is stated in the question rather than discovered during
implementation.

**Retry is not the automatic answer.** A retry loop after a completed provider
call is its own failure mode — it can double-count if the first insert actually
succeeded and the acknowledgement was lost. Any retry design has to be
idempotent on a key this table does not currently have, which is part of what
makes the fork a real decision rather than an oversight.

## Admin/User UX Impact

**The admin half is straightforward.** `SpendHistory.tsx` gains a marker on any
period containing at least one estimated or unknown row: the figure carries a
`~` and the period shows a short "includes estimated costs" note. Empty, loading
and error states are unchanged.

**The user half cannot be delivered as scoped, and this plan does not pretend
otherwise.** Product Intent #3 says users see their estimated periods marked.
But `SpendHistory.tsx` has exactly **one** mount in the entire frontend —
`SpendInline` in `pages/admin/users.tsx`, passed `isAdmin` — so
`GET /api/users/me/spend` is a live, self-scoped endpoint with **no user-facing
UI at all**. Marking a component that no user can reach satisfies nothing.

This is a scope addition (a new user-facing screen or panel, and where it
lives), so per the now/next/never rule it goes to David rather than being
absorbed. Escalated below. The consequence for sequencing: **steps 1-7 are
unaffected and remain shippable**; only the user-facing render waits on that
answer.

The manual's payments chapter already states that a spend history is a good
estimate rather than a bill; this makes that visible per period instead of only
in prose — for whichever audiences can actually see it.

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
   that must **remain `NULL`** rather than being swept into `false`.
6. **A fallback cost with more than four decimal places** (e.g. `0.61728`)
   classifies as an estimate. This is the regression test for the scale trap:
   the rejected `unit_price = computed_cost` discriminator passes every test
   with a 2-decimal cost and fails only here.
7. **A stage-2 row with `billing_units` below 1** trips the abort condition
   rather than being classified, since R3 and R4 must partition the stage-2
   rows exactly.
8. **Backfill idempotency**, stated so a correct implementation can pass it:
   the second run must report **zero changed rows** while the **final bucket
   totals stay identical**. The earlier wording ("the same counts") conflated
   those two numbers and was unsatisfiable — every rule is guarded by
   `is_estimated IS NULL`, so a correct second run changes nothing by
   construction.
9. **The rolling-deploy window**: a row inserted with no flag *after* the expand
   phase — an old binary's write — is classified by the phase-3 backfill, not
   left `NULL` forever. The test models old-app/new-schema, not just
   pre-migration and new-writer rows.
10. **An unpriced generation by an admin** produces a row on the happy path, and
    on a forced estimate-lookup failure produces no row, no thrown error into
    the completed generation, and an incremented lost-write signal.
11. **`recordCost` failure is observable**: with the insert forced to fail but
    the database otherwise healthy, the generation still succeeds and the
    counter moves.
12. **The health signal's own failure**: with the counter write itself forced to
    fail, the structured log line still carries the event — the floor the plan
    admits to rather than claiming a signal that survives its own dependency.

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
   caveat), `deferred-work.md` (close the folded entries that this plan actually
   closes — see the note below).

**Phasing, restated after round 1.** Step 1 is the *expand* phase and ships
alone; steps 3-6 are the writers; the backfill (step 2) is a **separate later
migration** that runs after the writers have drained the old instances, per the
rollout ordering above. Steps 1-7 are unaffected by either open question. Step 8
(the user-facing render) is blocked on Q2, and the `recordCost` recovery
mechanism beyond the health signal is blocked on Q1 — so `deferred-work.md`'s
`recordCost` entry closes only if David picks option 1 or 3; under option 2 it
is superseded rather than closed.

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

The display question (include / label / exclude) was answered on 2026-08-17:
include and label. Codex round 1 raised two further decisions that are genuinely
product-owner calls, and both are held rather than guessed.

### Q1 — What should happen when a ledger write is lost?

Observability alone leaves the ceiling measured against an under-stated total
(see Runtime Behavior). Three options, each with a real cost:

1. **Accept the widened ceiling; make it visible.** Cheapest, ships now, and the
   exposure is bounded by how often inserts actually fail (today: unmeasured,
   which is itself the argument for the health signal). Ramification: a user who
   hits a lost write can spend past their ceiling by that row's value, silently
   for them and visibly for us.
2. **Fail closed on unhealthy accounting.** If lost writes are detected, refuse
   further generation for that user until reconciled. Ramification: the ceiling
   holds absolutely, but a database hiccup becomes a user-facing outage — and
   this is a *stricter* fail-closed posture than anything currently in the
   system.
3. **Durable reconciliation.** Persist the intent before the provider call and
   reconcile after, so a lost insert is recoverable. Ramification: correct
   without refusing anyone, but it is a second table and an idempotency key this
   ledger does not have — comfortably its own plan, not a fold-in here.

**My recommendation: 1 now, 3 as a follow-up plan**, with the health signal
built now either way so the decision is informed by real numbers rather than
speculation. Option 2 trades a rare accounting error for a visible outage, which
is the wrong direction pre-launch.

### Q3 — Is a user's budget consumed by a generation they never received?

Surfaced in round 2. A fal call that succeeds and then fails downstream —
moderation rejection, missing image URL, a download or storage failure — has
cost real money and is recorded nowhere, because recording sits after
post-processing. Options:

1. **Leave it (narrow the claim).** Recording stays where it is; the plan's
   guarantee is scoped to generations that reach the recording point, as written
   above. Ramification: real provider spend stays invisible to the ceiling, in a
   failure mode nobody currently measures. It is the status quo, not a
   regression.
2. **Record at the provider-response boundary.** Every successful fal call is
   accounted for. Ramification: correct on cost, but a user whose generation was
   rejected by moderation still loses budget — which may be right (the compute
   happened) or may feel punitive, and that is a product judgement. Needs an
   idempotency key so the success path doesn't double-record.
3. **Record at the boundary, but refund on downstream failure.** Ramification:
   most accurate and most machinery — a compensating write, and a decision about
   what happens if *that* write fails.

**My recommendation: 1 now, and open 2 as its own plan** with the moderation
question asked explicitly. The gap is real but it is pre-existing and unmeasured;
folding a recording-point move into a migration that is already three releases
deep would be the scope accretion the stopping rule warns about.

### Q2 — Where does a user's own spend history live?

There is no user-facing spend surface today. Options: a section on the profile
page; a panel in the meme-builder near where budget is consumed; or **next**,
deferring the user-facing half entirely and shipping the admin marking now.

**My recommendation: defer it (next).** The enforcement and provenance work is
valuable on its own and unblocked; adding a user-facing screen is a design
question about what users should see about their own spending, which deserves
its own conversation rather than being decided inside a migration plan. If that
is the call, Product Intent #3 narrows to the admin surface for this increment,
and the user-facing view becomes its own plan.

## Definition of Done

- [ ] Migration applies and rolls back cleanly; per-bucket counts reported; the `NULL` remainder is small and explained.
- [ ] Every synchronous writer records an unpriced generation, at the same figure the gate used.
- [ ] Enforcement sums estimated rows; the ceiling binds on them.
- [ ] A failed ledger write is visible to a human, not only in a log line.
- [ ] Both spend views mark periods containing estimated or unknown rows, and their totals are unchanged by the migration.
- [ ] The behaviour can be exercised in the product: generate with pricing unavailable, then see the marked period in the spend view (UAT doc).
