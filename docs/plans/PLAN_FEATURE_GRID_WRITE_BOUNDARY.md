# Plan: One write path into the Feature Permission Grid

> Status: **DRAFT — under Codex plan review.** Not approved. Approval is
> David's, explicitly, in words.

## Problem

[Plan 1a](./PLAN_ADMIN_PERMISSIONS_CORE.md) makes the Feature Permission Grid
the single source of truth for entitlements: one resolver reads it, the client
obeys it, and the Admin column becomes live. That plan's own application code
writes the grid correctly — through one creation path, one cell-write path,
each recording an audit row and advancing the revision.

Nothing at the database level requires the *next* writer to do the same.

This is not hypothetical. **Migration `0057` inserted a `feature_flags` row
with no `tier_feature_permissions` rows at all**, and nothing caught it — the
grid has carried an incomplete feature ever since. The mechanisms Plan 1a
introduces have the same exposure, one layer up:

| Invariant Plan 1a's code maintains | What happens if a future writer skips it |
|---|---|
| A feature has a complete four-row tier set | `0057` recurs — a feature the resolver can never answer for, failing closed for everyone |
| Every cell change writes an audit row | The audit trail silently has holes, and looks complete |
| Every cell change advances `entitlement_grid_revision` | Open clients never learn the grid moved; they hold a stale lock indefinitely |
| Exactly one revision row exists | The resolver's revision read is ambiguous; the version endpoint can fail |

"A future writer" is concrete: another migration, an ops script, a second
admin surface, or a well-meaning change to `setTierFeature` that takes a
shortcut. Plan 1a's CI guard constrains *this repository's* route code. It
cannot constrain SQL.

**The class is: an invariant enforced only by the code that happens to be
calling today is not an invariant.** This plan moves the four above into the
database, so a writer that skips them fails rather than silently corrupting
the source of truth the whole permissions architecture now rests on.

## Direction

Serves [`product-direction.md`'s *Permissions direction*](../ai-context/product-direction.md#permissions-direction),
merged in #412 — specifically its central claim that the grid is *the* source
of truth for entitlements. A source of truth that any writer can quietly put
into a state its readers can't handle is one by convention, not by
construction. This plan is what makes that claim durable; it adds no new
entitlement semantics and changes nothing a user can observe.

## Relationship to Plan 1a

**This plan was split out of Plan 1a (PR #421) at David's direction on
2026-08-12**, after that plan's growth tripwire fired (760 → 1168 lines,
+53.7%) and three consecutive review rounds returned rising finding counts
(10 → 13 → 14), with the rising material clustering almost entirely on
database-hardening mechanics. Five of round 3's fourteen findings are the
seed of this document and arrive here already addressed; they are named in
*Findings Inherited From Plan 1a's Review* below rather than starting from
zero, per the plan-review-loop skill's step-10 amendment.

**Both plans are independently shippable, in either order.** Plan 1a is
correct without this one: its own code paths maintain every invariant above,
and its *Must Not Change* already states that nothing gates on the hardened
state. This plan is correct without Plan 1a's resolver work too — the
mechanisms below constrain the grid tables, which exist today.

**The dependency is one of content, not correctness:** this plan hardens
three objects Plan 1a introduces (the audit table, the revision singleton,
the creation path). Sequencing this plan second is therefore the obvious
order and the one assumed throughout, but if Plan 1a slips, the pieces of
this plan that touch only today's `feature_flags` / `tier_feature_permissions`
still stand alone.

## Product Intent

1. **A feature cannot exist in the database without its complete tier
   row-set.** `0057`'s state becomes unreachable, not merely discouraged.
2. **A grid cell cannot change without its audit row and a revision bump.**
   All three land in one transaction or none do.
3. **There is exactly one revision row, always.** It cannot be duplicated or
   deleted.
4. **A deployment can report whether the boundary is genuinely enforced**, so
   "hardened" is an observable fact rather than an assumption.

## Must Not Change

- **Plan 1a's resolver, client contract, and lockout guards are untouched.**
  This plan changes how the grid is *written*, never how it is read or
  resolved.
- **No entitlement semantics change.** Union rules, view-as-user
  normalization, the four-rail classification, and every feature's row values
  are exactly as Plan 1a leaves them.
- **No end-user-visible behaviour changes at all.** Not one route's response
  differs.
- **Nothing gates on `boundaryEnforced`.** See Settled Decision #2 — this is
  the deliberate divergence from the NCMEC precedent, and it is what keeps an
  unhardened deployment fully functional.
- **`engine_experiments` stays incomplete and untouched**, as Plan 1a's *Grid
  Intent Review* establishes. It is the one declared exception to the
  completeness invariant and Plan 3 retires it.
- **The NCMEC ledger's own hardening is not touched, reused, or
  generalized.** This plan follows its *pattern* and cites its reasoning; it
  does not refactor it into shared machinery. Two instances do not yet
  justify an abstraction, and that ledger's boundary is legally load-bearing
  in a way this one is not.
- **No migration attempts the superuser steps.** See Settled Decision #3.

## Settled Decisions

1. **This follows `ncmec-audit-ledger-hardening.md`'s pattern, deliberately
   and without re-deriving it.** That document already worked out why a
   migration cannot establish an ownership boundary against the role running
   it, why `ALTER TABLE ... OWNER TO` cannot be self-applied usefully, and
   why a migration-created role is worse than none. Those arguments hold
   verbatim here. This plan cites them and mirrors the structure — migration
   installs objects and reports residual state; a superuser runbook closes
   the boundary; a status function reports which state you are in.
2. **Nothing gates on `boundaryEnforced` — this is the deliberate divergence
   from NCMEC.** There, Phase 6 refuses production filing while the boundary
   is open, because filing against an unprotected legal ledger is the actual
   harm. Here the analogous harm — a corrupted grid — is recoverable by an
   operator with a migration, affects a pre-launch product's feature flags,
   and is already prevented for every writer in this repository by the
   application-level path plus Plan 1a's CI guard. Gating anything on
   hardening would mean an unhardened deployment silently loses grid editing,
   which is a worse failure than the one being prevented. The unhardened
   state is honestly described as defense-in-depth against *future* writers,
   never claimed as a closed boundary.
3. **The superuser procedure is a runbook, not a migration step**, for the
   structural reason NCMEC documents: migrations run as the application role,
   which therefore owns what they create, and ownership bypasses ACLs
   entirely. A migration that "revokes" its own privileges reports a boundary
   it has not built.
4. **Enforcement lives in `SECURITY DEFINER` functions plus triggers, not in
   revoked privileges alone.** A revoke is meaningful only once ownership has
   moved; the functions and triggers are meaningful immediately. This is why
   the two halves ship together but are described separately: the migration's
   half works on day one, the runbook's half upgrades a convention into a
   boundary.

## Repo Context Inspected

- `docs/engineering/ncmec-audit-ledger-hardening.md` — the pattern this plan
  follows, in full, including its *Why the migration cannot do this itself*
  and *If you skip this* sections.
- `lib/db/src/schema/moderation.ts:280-320` — how a trigger-backed table is
  *documented* in a Drizzle schema file (the triggers themselves live in
  migration `0097`, because `pgTable` cannot model them).
- `lib/db/src/index.ts` — where `ncmecAuditBoundaryStatus()` lives and the
  shape of its four-condition report.
- `lib/db/migrations/0097_ncmec_submission.sql` — the append-only guard
  function and trigger pair, and its residual-state `WARNING`.
- `lib/db/src/migrate.ts` and `docs/engineering/migrations-and-backfills.md`
  — the canonical runner: no notice handler, result rows discarded,
  already-applied migrations skipped by hash.
- `lib/db/src/schema/featureFlags.ts`, `lib/db/migrations/0013`/`0028`/
  `0029`/`0057` — today's grid tables and the incomplete-feature precedent.
- `artifacts/api-server/src/lib/seed.ts:500-545` — the startup seed steps
  Plan 1a deletes, confirming no competing write path survives.

## Current Behavior

`feature_flags` and `tier_feature_permissions` are ordinary tables owned by
the application role, with no triggers, no constraints beyond their primary
and foreign keys, and no audit. Any connection holding the application role's
credentials can insert, update, or delete any row in either, in any
combination, including combinations the resolver cannot answer for.

`setTierFeature` is the only application-code writer today. It records
`updated_at` and nothing else — no actor, no prior value. Plan 1a adds the
audit row and the revision bump to that same function; this plan is what
makes those additions unbypassable.

Migration `0057` is the worked example of the gap: a `feature_flags` insert
with no accompanying tier rows, which passed every check that existed and
still shows up as `engine_experiments`'s empty row-set today.

## Proposed Design

### The two halves, and what each one actually buys

| | **Migration half** (ships in this PR) | **Runbook half** (a superuser runs it) |
|---|---|---|
| Installs | Functions, triggers, revokes, status reporter | Role pair, ownership transfers, re-grants |
| Effective against | Every caller that is not the table owner | The table owner too |
| Effective on day one | Yes | Only once run |
| If skipped | n/a — always installed | Nothing breaks; the boundary stays a convention (see Settled Decision #2) |

The migration half is not theatre even before the runbook runs: the triggers
fire for the owner as well (a trigger is not an ACL), so the completeness and
audit invariants hold immediately for every writer. What ownership transfer
adds is that the owner can no longer *disable* those triggers or re-grant
itself the revoked privileges.

### Sanctioned write functions

Three `SECURITY DEFINER` functions become the only supported way to change
grid structure or content.

**Each is declared `SECURITY DEFINER` with `SET search_path = pg_catalog,
public` and explicit `EXECUTE` grants to the application role, and no
`EXECUTE` to `PUBLIC`.** The fixed `search_path` is not optional decoration:
a `SECURITY DEFINER` function without one is the standard PostgreSQL
privilege-escalation shape, since a caller can prepend a schema and shadow an
unqualified object reference. Every table reference inside these functions is
schema-qualified as well.

**Why `SECURITY DEFINER` at all, and why it is the piece that makes the
hardened state usable:** once the runbook transfers table ownership away from
the application role and the role's direct `INSERT`/`UPDATE`/`DELETE` on the
grid tables is revoked, an ordinary invoker-rights function would execute
with the caller's revoked privileges and fail. The function must run as its
*owner* — the new grid-owner role — for the sanctioned path to keep working
in exactly the state the runbook creates. A plan that revoked the privileges
without this would harden the database into one where the grid cannot be
edited at all.

1. **`create_feature_flag(key, display_name, description, unregistered,
   registered, legendary, admin)`** — inserts the parent row and all four
   tier rows in one transaction, bumps the revision, returns the new
   revision. The deferred completeness trigger (below) validates the result
   at commit.

2. **`delete_feature_flag(key)`** — the creation function's counterpart, and
   the only path that may remove a feature. In one transaction it deletes the
   four tier rows, deletes the parent row, and bumps the revision. Ordering
   matters and is explicit: children first, then parent, so the
   deletion-protection trigger's own exemption (below) is the only thing that
   permits the child deletes. **Audit rows are unaffected** — Plan 1a stores
   `tier_feature_permission_audit.feature_key` as plain text with no foreign
   key precisely so that a feature's history survives the feature, and this
   function deliberately does not touch that table. Deleting a feature that
   has audit history succeeds; the history remains queryable afterward.

3. **`set_tier_feature(actor_id, tier, feature_key, enabled)`** — the only
   path that may change a cell. In one transaction it reads the prior value
   under a row lock, writes the new value, inserts the audit row recording
   both, and bumps the revision. **This is what makes Plan 1a's "the cell
   write and its audit row commit in the same transaction" an enforced
   property rather than a property of the TypeScript that happens to call
   it** — with direct `UPDATE` on `tier_feature_permissions` revoked, there
   is no way to move a cell without producing its audit row and revision
   bump. `actor_id` is a parameter rather than a session lookup because the
   database has no notion of the HTTP caller; Plan 1a's `setTierFeature`
   passes `req.user.id`.

Plan 1a's TypeScript `setTierFeature` becomes a thin wrapper over function 3
rather than issuing its own `UPDATE`. That is the only change this plan makes
to Plan 1a's application code, and it is behaviour-preserving.

### Triggers

Two trigger functions, both installed by the migration, both firing for every
writer including the owner:

1. **`feature_flags_require_complete_rowset()`** — a **deferred constraint
   trigger** (`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`) on
   `feature_flags`, checked at transaction commit. Asserts that every
   `feature_flags` row has a `tier_feature_permissions` row for each of the
   four tiers. Deferral is what lets `create_feature_flag`'s multi-statement
   insert be legal — the parent row exists alone momentarily, which an
   immediate trigger would reject. `engine_experiments` is excluded by
   explicit key match, not by a general "incomplete is sometimes fine"
   predicate that a future feature could also satisfy.

2. **`tier_feature_permissions_protect_rows()`** — a row-level `BEFORE
   DELETE` trigger on `tier_feature_permissions` that rejects deleting a row
   whose parent feature still exists. `delete_feature_flag` is exempted by
   setting a transaction-local flag (`SET LOCAL
   overhype.feature_flag_deleting = '<key>'`) that the trigger checks — a
   deliberately narrow exemption keyed to the specific feature being removed,
   not a blanket bypass switch.

**Both are documented in `lib/db/src/schema/featureFlags.ts`, not declared
there.** Drizzle's `pgTable` can represent columns, checks, indexes and
foreign keys — not trigger functions or constraint triggers. The repository
already handles this exactly this way: `moderation.ts:301-309` documents the
NCMEC append-only trigger in a comment while migration `0097` owns the SQL.
The raw SQL migration is authoritative.

What actually protects against silent loss is therefore **a catalog-level
regression test**, not a schema declaration: a test queries `pg_trigger` /
`pg_proc` and asserts both trigger functions exist, both triggers exist,
both are enabled (`tgenabled` not `'D'`), and the completeness trigger is
deferrable. A future migration that drops or disables either fails CI
immediately.

### The revision singleton's lifecycle

Plan 1a introduces `entitlement_grid_revision` as a one-row table and relies
on exactly one row existing. That reliance is enforced here:

- **A single-row `CHECK` constraint.** The table carries `id integer PRIMARY
  KEY DEFAULT 1 CHECK (id = 1)`, so a second row is rejected by the primary
  key and a wrong-keyed row by the check. This is a plain constraint, so it
  lives in Plan 1a's schema declaration where Drizzle can model it; this plan
  adds only what Drizzle cannot.
- **Idempotent initialization.** `INSERT ... ON CONFLICT (id) DO NOTHING`
  with `revision = 0`, so a clean install, a re-run, and a database that
  already has the row all converge.
- **Deletion protection.** A `BEFORE DELETE` trigger on the table rejects
  unconditionally. There is no legitimate reason to delete the row, and its
  absence would make the version endpoint fail and grid writes unstamped.
- **The bump is `UPDATE entitlement_grid_revision SET revision = revision + 1
  WHERE id = 1 RETURNING revision`**, issued inside each write function's
  transaction. Being a single-row update, concurrent writers serialize on the
  row lock naturally — two concurrent cell writes cannot produce the same
  revision.

### The ownership-hardening runbook

A new document, `docs/engineering/feature-permissions-boundary-hardening.md`,
mirroring `ncmec-audit-ledger-hardening.md`'s structure: why the migration
cannot do this itself (by reference, not re-derivation), what "hardened"
means, the procedure, verification queries, break-glass, and what happens if
you skip it.

**PostgreSQL triggers are not independently ownable objects**, so the
procedure cannot "transfer the triggers." A trigger's modifiability follows
the *table's* owner, and the trigger *function* is separately ownable. The
procedure therefore transfers, explicitly:

- `ALTER TABLE` → `feature_flags`, `tier_feature_permissions`,
  `tier_feature_permission_audit`, `entitlement_grid_revision`
- `ALTER FUNCTION` → the three write functions and the three trigger
  functions (completeness, row protection, revision deletion protection),
  each named individually
- `ALTER SCHEMA`, only where the application role owns the containing schema
  (the NCMEC doc's same caveat — common on managed Postgres where the app
  owns `public`)

...to `overhype_feature_grid_owner`, with `overhype_feature_grid_maintenance`
as the break-glass role, both created **by the superuser** so the application
role gains no membership. The application role is then re-granted exactly
what it needs and no more: `SELECT` on all four tables, `INSERT` on the audit
table, `EXECUTE` on the three write functions, and sequence usage where
applicable — but **not** `INSERT`/`UPDATE`/`DELETE` on `feature_flags`,
`tier_feature_permissions`, or `entitlement_grid_revision`, and not
`UPDATE`/`DELETE` on the audit table.

### `featurePermissionsBoundaryStatus()`

In `lib/db/src/index.ts`, alongside `ncmecAuditBoundaryStatus()` and
reporting the same shape. `boundaryEnforced: true` only when all hold:

1. The application role owns none of the four tables.
2. The application role owns none of the six functions.
3. The application role cannot effectively assume either new role — covering
   `INHERIT` membership, `SET ROLE` membership, and any admin-option chain
   that would let it grant itself the role (the NCMEC function's existing
   `pg_has_role` triad plus `pg_auth_members` check).
4. All three triggers exist and are enabled.
5. The application role holds no direct `INSERT`/`UPDATE`/`DELETE` on the
   three non-audit tables, and no `UPDATE`/`DELETE` on the audit table.

Unlike NCMEC's, this function's result **gates nothing** (Settled Decision
#2). It is reported at `/admin/health` alongside the existing NCMEC status
so an operator can see which state the deployment is in.

## Data Model and Migration Impact

**No new tables and no new columns.** Every table this plan touches
(`feature_flags`, `tier_feature_permissions`,
`tier_feature_permission_audit`, `entitlement_grid_revision`) either exists
today or is introduced by Plan 1a. This plan adds functions, triggers,
grants, and one documentation file.

**Migration contents**, forward-only and idempotent:

1. The three trigger functions and their triggers
   (`CREATE OR REPLACE FUNCTION`; `DROP TRIGGER IF EXISTS` then `CREATE
   TRIGGER`).
2. The three `SECURITY DEFINER` write functions, with fixed `search_path`,
   `REVOKE EXECUTE ... FROM PUBLIC`, and `GRANT EXECUTE` to the application
   role.
3. `REVOKE INSERT, UPDATE, DELETE ON feature_flags, tier_feature_permissions,
   entitlement_grid_revision FROM <app>` and `REVOKE UPDATE, DELETE ON
   tier_feature_permission_audit FROM <app>` — honestly labelled in a comment
   as ineffective against the owner until the runbook runs.
4. A residual-state `RAISE WARNING` naming the application role and the
   schemas involved, exactly as `0097` does, so the runbook's substitutions
   are discoverable from the migration output.

**Ordering against Plan 1a.** If Plan 1a has merged, this migration finds all
four tables present and installs cleanly. If it has not, this migration's
statements touching `tier_feature_permission_audit` and
`entitlement_grid_revision` have nothing to attach to — so this plan's
migration is written to **require** Plan 1a's migration as a predecessor and
fails fast with a clear error if those two tables are absent, rather than
silently installing half a boundary. That is the dependency named under
*Relationship to Plan 1a*, made mechanical.

**Row-state matrix:** no rows are inserted, updated, or deleted by this
migration. Nothing is destructive; no backup artifact or rollback plan is
needed beyond an ordinary forward fix.

## Runtime Behavior

- Grid reads are completely unaffected — the resolver's queries are
  unchanged, and `SELECT` is re-granted in the hardened state.
- A grid cell edit through the admin console behaves identically to Plan 1a,
  and produces identical rows; only the SQL statement issued differs.
- A direct `UPDATE` against `tier_feature_permissions` from application code
  fails once hardened, and fails the catalog test before then.
- An attempt to create a feature without its tier rows fails at commit, in
  both states.
- An attempt to delete a feature's individual tier row fails, in both states.

## Admin/User UX Impact

**None for users.** For operators: `/admin/health` gains a
feature-grid-boundary line showing enforced/unenforced with the same
presentation as the existing NCMEC boundary line. That is the entire
user-visible surface of this plan.

## Security, Permissions, and Validation

- Every `SECURITY DEFINER` function has a fixed `search_path` and
  schema-qualified references — the standard mitigation for the
  privilege-escalation shape those functions otherwise create.
- No function takes a role name, schema name, or SQL fragment as a parameter;
  there is no dynamic SQL, so there is no injection surface in the write
  path.
- `set_tier_feature`'s `actor_id` is recorded, not trusted for
  authorization — Plan 1a's `requireRole('admin')` remains the only thing
  that decides who may call it, and this plan does not move authorization
  into the database.
- The audit table stays append-only: `INSERT` and `SELECT` re-granted,
  `UPDATE`/`DELETE` withheld, matching the NCMEC ledger's treatment.
- The break-glass role exists so that a genuine correction is a deliberate,
  attributable act outside the application, as documented in the runbook.

## Testing Plan

Runner commands per `docs/tests/testing-guide.md`:
`pnpm --filter @workspace/db test`, `pnpm --filter @workspace/api-server test`.

1. **Completeness is enforced.** A direct `INSERT` into `feature_flags`
   without tier rows is rejected at commit; the same insert via
   `create_feature_flag` succeeds. `engine_experiments`'s existing incomplete
   row-set does not trip the trigger.
2. **Individual row deletion is rejected**, while `delete_feature_flag`
   removes the whole set successfully.
3. **Audit rows survive feature deletion.** A feature with audit history is
   deleted through the sanctioned function; the audit rows remain queryable,
   with their `feature_key` intact.
4. **Cell writes are atomic across all three effects.** `set_tier_feature`
   changes the cell, writes exactly one audit row with correct
   before/after values, and advances the revision — and a failure injected at
   any point leaves none of the three.
5. **The revision singleton's lifecycle.** A clean install has exactly one
   row at `revision = 0`; re-running initialization changes nothing; a second
   row is rejected; deletion is rejected; two concurrent `set_tier_feature`
   calls produce two distinct consecutive revisions.
6. **Catalog assertions.** All three trigger functions and all three triggers
   exist and are enabled; the completeness trigger is deferrable; all three
   write functions are `SECURITY DEFINER` with a non-empty, fixed
   `search_path` and carry no `EXECUTE` grant to `PUBLIC`.
7. **`featurePermissionsBoundaryStatus()` reports honestly.** It returns
   `false` against the ordinary (unhardened) test database, naming which of
   the five conditions failed; and — where a hardened fixture is available in
   CI — `true` after the runbook's transfers. The false case is the one that
   must always run, since it is the state every developer machine is in.
8. **The unhardened state is fully functional.** With no ownership transfer
   performed, every grid operation Plan 1a performs still succeeds — proving
   Settled Decision #2's claim that skipping the runbook breaks nothing.
9. **Migration prerequisite.** Running this migration against a database
   lacking Plan 1a's two tables fails with the explicit error, not a partial
   install.

Manual QA is the UAT doc: an operator confirms grid editing still works
end-to-end and that `/admin/health` reports the boundary state.

## Implementation Steps

One PR.

1. Migration: the three trigger functions and triggers; the revision-deletion
   protection trigger; the prerequisite check for Plan 1a's tables.
2. Migration: the three `SECURITY DEFINER` write functions with fixed
   `search_path`, `REVOKE ... FROM PUBLIC`, and `GRANT EXECUTE` to the
   application role.
3. Migration: the revokes on the four tables, with the honest comment, and
   the residual-state `RAISE WARNING`.
4. Rewrite Plan 1a's `setTierFeature` as a thin wrapper over
   `set_tier_feature`, and its feature creation/deletion callers over
   `create_feature_flag` / `delete_feature_flag`.
5. `featurePermissionsBoundaryStatus()` in `lib/db/src/index.ts`; wire it
   into `/admin/health`.
6. Document all three triggers in `lib/db/src/schema/featureFlags.ts` (as
   comments, per `moderation.ts`'s precedent) and add the
   single-row `CHECK` to the revision table's Drizzle declaration if Plan 1a
   has not already.
7. Write `docs/engineering/feature-permissions-boundary-hardening.md`.
8. Tests 1-9.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| The `SECURITY DEFINER` functions become their own escalation path | Fixed `search_path`, schema-qualified references, no dynamic SQL, no `EXECUTE` to `PUBLIC`, and catalog test 6 asserting all of it |
| Hardening is never run, so the boundary is imagined | `featurePermissionsBoundaryStatus()` reports it, `/admin/health` surfaces it, and this plan states plainly that unhardened is defense-in-depth only |
| Hardening *is* run and breaks grid editing | Exactly what `SECURITY DEFINER` prevents; test 8 covers unhardened, and the runbook's verification section covers hardened |
| The trigger exemption flag becomes a general bypass | It is keyed to the specific feature key being deleted and is transaction-local; a blanket switch was the alternative and was rejected |
| Plan 1a merges after this plan | The migration fails fast on the missing tables rather than installing half a boundary (test 9) |
| This diverges from the NCMEC pattern over time | Both are cited from each other's docs; the divergence that exists today (gating) is stated as a decision, not left implicit |

## Questions for David

None. The one product decision in this area — whether an unhardened
deployment should be allowed to run — is answered by Settled Decision #2 on
the reasoning that a feature-flag corruption is recoverable where an
unprotected legal ledger is not. If David disagrees, that decision inverts
cleanly into a startup gate, and it is the only thing in this plan that would
change.

## Definition of Done

- A feature cannot be created without a complete tier row-set, or deleted
  piecemeal, by any writer — including the table owner.
- A grid cell cannot change without its audit row and revision bump.
- Exactly one revision row exists and cannot be duplicated or deleted.
- The three write functions are the only supported write path, and remain
  callable in the hardened state.
- `featurePermissionsBoundaryStatus()` reports the real state, and
  `/admin/health` shows it.
- `docs/engineering/feature-permissions-boundary-hardening.md` exists and its
  procedure is executable as written, naming trigger *functions* and tables
  rather than triggers.
- An unhardened deployment is fully functional, and this is proven by a test,
  not asserted.
- TEST_RUN + UAT docs shipped in the same PR.

## Findings Inherited From Plan 1a's Review

These arrived as Codex findings on PR #421 and are the seed of this document
— carried across with the material per the plan-review-loop skill's step-10
amendment, rather than restarting this plan's review history at zero. Each is
addressed above.

| Plan 1a finding | Where it is answered here |
|---|---|
| **Make creation callable after hardening** (round 3, P1) — an invoker-rights function runs with the caller's revoked privileges and fails in the hardened state | *Sanctioned write functions* — `SECURITY DEFINER` with fixed `search_path` and explicit grants, with the reasoning stated |
| **Define the feature-deletion function** (round 3, P2) — the counterpart was referenced but never specified | *Sanctioned write functions* #2 — signature, child-then-parent ordering, revision bump, audit retention, and its narrow trigger exemption |
| **Enforce audited cell writes in the database** (round 3, P1) — the audit/revision transaction was specified only in TypeScript, so the app role could still write a cell without it | *Sanctioned write functions* #3, plus the revoke on direct `UPDATE` |
| **Transfer trigger-function ownership** (round 3, P2) — triggers are not independently ownable, so the runbook could not do what it said | *The ownership-hardening runbook* — `ALTER FUNCTION` on each named trigger function plus `ALTER TABLE` on the tables |
| **Enforce the revision singleton lifecycle** (round 3, P2) — "singleton" named no invariant, initialization, or deletion protection | *The revision singleton's lifecycle* — the enforcement half; Plan 1a keeps the table, its `CHECK`, and its bump |
| **Ownership hardening generally** (round 2, P1) — a same-role `REVOKE` is a no-op against the owner | The whole *two halves* framing, and Settled Decision #1/#3 |
