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
| Effective against | Mistakes | Intent |
| Effective on day one | Yes | Only once run |
| If skipped | n/a — always installed | Nothing breaks; the grid's write invariants stay a convention (Settled Decision #2) |

**Only the runbook creates a boundary. The migration creates a guard rail.**
This is the plan's governing distinction and it is stated first because an
earlier revision of this document got it wrong in a way that generated a whole
class of review findings.

The mistake was claiming the migration half "is not theatre even before the
runbook runs" on the grounds that a trigger is not an ACL and so fires for the
owner too. That sentence is true and irrelevant, and the sentence immediately
after it contained the refutation: what the runbook adds is that the owner can
no longer *disable* those triggers.
[`ncmec-audit-ledger-hardening.md`](../engineering/ncmec-audit-ledger-hardening.md)
states the mechanism plainly — **`ALTER TABLE ... DISABLE TRIGGER` requires
only ownership**, and before the runbook the application role owns everything
this migration creates. A writer determined to bypass a trigger switches it
off in one statement.

So the pre-runbook state cannot be made safe against a determined writer by
*any* amount of trigger coverage, and attempting it is unwinnable by
construction: each new guard the application role can also disable adds a
speed bump described as a wall. That is the same category as Plan 1a's honest
admission that its grid invariants hold "because this plan's code is the only
writer — a convention, not a boundary." This plan does not upgrade that
convention. **It ships the mechanism that lets a superuser upgrade it, and it
reports truthfully whether they have.**

**What the migration half is genuinely worth**, stated without inflation:

1. **It catches mistakes, which are the realistic failure.** A migration
   written in a hurry, a psql session, a future feature that forgets the audit
   row — none of these disables a trigger first, because none of them is
   trying to get around anything. The guard rails stop the accident even
   though they cannot stop the adversary.
2. **It is what makes the hardened state work at all.** The `SECURITY DEFINER`
   functions are not a pre-hardening nicety; they are the only reason the grid
   remains editable *after* ownership moves and direct DML is revoked. Ship
   the runbook without them and the database hardens into one where nobody can
   change a feature flag.
3. **Post-hardening, the triggers stop being advisory.** The application role
   no longer owns the tables, so it can no longer disable them. Everything the
   triggers assert becomes true against every caller except the break-glass
   role. This is the state the guards are actually designed for.

**The consequence for this plan's scope, and for its review.** A gap in
trigger coverage matters exactly as much as it persists into the *hardened*
state:

| Gap | Treatment |
|---|---|
| Persists after hardening (a wiring error, a forgeable exemption baked in before the transfer, a privilege left effective) | **A real defect.** Fix it. |
| Exists only before hardening, and is closable only by another guard the owner could equally disable | **Accepted, by construction.** Recorded in *Accepted by construction* below, not fixed. |

This is not a lowering of the bar. It is the bar the NCMEC precedent already
set for the same problem, applied honestly here instead of being cited and
then contradicted.

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

   **It raises `no_data_found` when the target cell does not exist, before
   writing anything.** The obvious PL/pgSQL shape — `UPDATE`, then `INSERT`
   the audit row, then bump — records a change that never happened and
   advances the revision when the `UPDATE` matches zero rows, which is
   reachable from a stale caller or from any tier/key pair that is legitimately
   absent (`engine_experiments` is deliberately incomplete). A phantom audit
   row is worse than a missing one in a ledger designed to be hard to correct,
   and a spurious revision bump makes every connected client refetch for
   nothing. So the function checks `FOUND` — or equivalently locks the row with
   `SELECT ... FOR UPDATE` first and errors on no row — and both side effects
   are downstream of that check.

Plan 1a's TypeScript `setTierFeature` becomes a thin wrapper over function 3
rather than issuing its own `UPDATE`. That is the only change this plan makes
to Plan 1a's application code, and it is behaviour-preserving.

### Triggers

**The triggers are the guard rail described above: decisive after hardening,
advisory before it.** Their event coverage is therefore load-bearing for the
*hardened* state, where the application role cannot disable them — not as a
pre-hardening bypass-proofing exercise, which *The two halves* explains cannot
succeed. The first draft got the coverage wrong in three ways migration `0097`
had already solved, and what follows carries `0097`'s actual mechanics forward
rather than its shape.

**Coverage is specified for the events that matter, not maximised.** Each
trigger below states what it protects and in which state that protection is
real. Where a pre-hardening hole is closable only by a guard the owner could
equally switch off, it is listed under *Accepted by construction* instead of
generating another trigger.

**Every trigger below is `ENABLE ALWAYS`, not the PostgreSQL default.**
`0097:881-889` records a verified reproduction against this repository's
PostgreSQL 16 target: a role holding `GRANT SET ON PARAMETER
session_replication_role` — a real, grantable privilege independent of table
or function ownership — can `SET session_replication_role = replica` in its
own session and an origin-enabled (`'O'`) trigger simply does not fire.
UPDATE, DELETE and TRUNCATE all went through uncaught in that reproduction.
`ALWAYS` triggers fire regardless. The one trade-off `0097` names and this
plan inherits: an `ALWAYS` trigger also fires during logical-replication
apply, which this database's setup does not exercise today.

Four trigger functions:

1. **`feature_flags_require_complete_rowset()`** — a **deferred constraint
   trigger** (`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`) on
   `feature_flags`, checked at commit. Asserts every `feature_flags` row has
   a `tier_feature_permissions` row for each of the four tiers. Deferral is
   what makes `create_feature_flag`'s multi-statement insert legal — the
   parent exists alone momentarily, which an immediate trigger would reject.
   `engine_experiments` is excluded by explicit key match, not by a general
   "incomplete is sometimes fine" predicate a future feature could satisfy.

2. **`tier_feature_permissions_guard_rows()`** — a row-level `BEFORE DELETE
   OR UPDATE` trigger on `tier_feature_permissions`. `UPDATE` coverage is
   included because the deferred completeness trigger cannot substitute for
   it: that trigger is attached to `feature_flags`, and a child-row update
   never schedules it. Two distinct events:

   - **`UPDATE ... SET tier = ...` or `SET feature_key = ...` is rejected
     outright.** Those columns are identity — a row needing a different
     identity is a different row — and `tier` is an unconstrained `varchar`
     in `featureFlags.ts`, so moving a required row to an unknown tier would
     otherwise produce exactly the incomplete state the resolver cannot
     handle. This rejection is unconditional and needs no exemption, because
     no sanctioned path ever changes either column.
   - **`UPDATE ... SET enabled = ...` is rejected unless the caller is the
     function's owner** — i.e. unless the statement is executing inside a
     `SECURITY DEFINER` function running as `overhype_feature_grid_owner`.
     After hardening that is a genuine authentication of the sanctioned path,
     because the application role cannot become that owner. Before hardening
     the application role *is* the owner and the check passes for direct
     statements too; that is the accepted pre-hardening convention, not a
     hole to plug.

   **This deliberately replaces the transaction-local GUC exemption an
   earlier revision specified** (`SET LOCAL overhype.feature_flag_deleting`).
   Keying the flag to a specific feature limited its scope but did not
   authenticate anything: any application-role session could issue the same
   `SET LOCAL` before a direct `UPDATE` or `DELETE`. It was a mechanism I
   introduced while fixing a different finding, and it made the guard weaker
   than having no exemption at all, since it advertised its own bypass. The
   owner check is not forgeable, requires no new mechanism, and is exactly as
   strong as the ownership boundary the runbook establishes — which is the
   correct amount of strength for it to have.

   Deletion of an individual row for a feature that still exists is rejected
   on the same basis, which is what permits `delete_feature_flag`'s
   children-then-parent ordering.

3. **`tier_feature_permissions_no_truncate()`**,
   **`feature_flags_no_truncate()`**, and
   **`tier_feature_permission_audit_no_truncate()`** — three
   **statement-level** `BEFORE TRUNCATE` trigger functions, one per table.
   **A row-level trigger does not fire on `TRUNCATE` at all** (`0097:891-894`
   says exactly this, and covers its ledger with a dedicated statement trigger
   for the same reason). Post-hardening these are what stop a `TRUNCATE`
   privilege granted by any route from erasing a table wholesale.

   **The audit table's guard is listed explicitly because an earlier revision
   asserted four tables were protected while specifying triggers for three.**
   The audit ledger is the one table where erasure is unrecoverable — the grid
   itself can be rebuilt from a migration, its history cannot — so omitting it
   was the worst of the four to omit.

4. **`entitlement_grid_revision_protect()`** — `BEFORE DELETE` (row) plus
   **`entitlement_grid_revision_no_truncate()`** `BEFORE TRUNCATE`
   (statement) on the revision table, both rejecting unconditionally except
   for the break-glass role. See *The revision singleton's lifecycle*.

**That is six trigger functions, and the count is stated once here and
referenced everywhere else** — completeness, row guard, three per-table
truncate guards, and the revision pair (whose truncate half is the sixth,
`entitlement_grid_revision_no_truncate()`). An earlier revision said "four"
while naming five, and the runbook repeated the wrong count without
individually naming them. That matters beyond tidiness: **the ownership
transfer is a list of object names**, and a function omitted from it stays
application-owned and therefore replaceable after the tables move — a
permissive body swapped in under a trigger that still reports correct wiring.
Every function signature is enumerated individually in creation, ownership
transfer, verification, and tests. No step anywhere in this plan says "the
trigger functions" and leaves the set to be inferred.

**All are documented in `lib/db/src/schema/featureFlags.ts`, not declared
there.** Drizzle's `pgTable` models columns, checks, indexes and foreign keys
— not trigger functions or constraint triggers. `moderation.ts:301-309`
documents the NCMEC trigger the same way while `0097` owns the SQL.

**The catalog regression test verifies exact wiring, not existence.**
Existence plus `tgenabled != 'D'` is insufficient, and `0097:900-925` spells
out why: a same-named trigger recreated with the wrong function, the wrong
events, or left origin-only satisfies a name-and-enabled check while leaving
the table genuinely unguarded. Worse, an *extra* event silently breaks
ordinary writes while still reporting correctly wired. So the test asserts,
per trigger:

- `tgenabled = 'A'` — `ALWAYS`, never `'O'`
- `tgfoid = to_regprocedure('<the exact expected function>()')`
- **`tgtype` by exact equality, not a subset check** — using `0097`'s
  documented bit meanings (1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE,
  16 = UPDATE, 32 = TRUNCATE), so the row guard is
  `1+2+8+16 = 27` and each truncate guard is `2+32 = 34`
- the completeness trigger is deferrable and initially deferred

**Wiring is necessary and not sufficient — the function body is verified
too.** `CREATE OR REPLACE FUNCTION` preserves the function's OID, so a
permissive body installed over a correct one satisfies `tgfoid`, `tgtype` and
`tgenabled` forever. That is not hypothetical here: before the runbook the
application role owns these functions and can replace any of them, and the
replacement survives the ownership transfer that follows. A boundary
established over an already-gutted guard reports `true` and enforces nothing.
`lib/db/src/index.ts:198-216` and `0097` both inspect guard source and
security mode for exactly this reason, and this plan does the same:

- `prosecdef` is true for the three write functions and false for the trigger
  functions (a trigger function has no reason to be `SECURITY DEFINER`, and
  one that has become so is a finding in itself)
- `proconfig` contains the expected `search_path` setting on every
  `SECURITY DEFINER` function
- `prosrc` matches a checked-in expected digest per function — a SHA-256 of
  the canonical body, stored beside the migration, so drift is detected
  without the verification query needing to embed the whole source

**Every role reference is existence-checked before use.**
`pg_has_role(name, ...)` raises an error for a role that does not exist rather
than returning false, and `overhype_feature_grid_maintenance` does not exist
until the runbook creates it. A guard calling it unguarded would therefore
make *ordinary sanctioned writes* fail on every unhardened database —
including every developer machine and every fresh install, which is the exact
state this plan promises stays fully functional. So each guard checks
`pg_catalog.pg_roles` for the role first and treats absent as "no exemption
applies," mirroring `0097` and `lib/db/src/index.ts:242-244`. The mandatory
no-such-role fixture in the testing plan exists to keep this from regressing,
because it is invisible on any database where the runbook has been run.

`featurePermissionsBoundaryStatus()` applies the identical predicate, so CI
and the runtime reporter cannot disagree about whether the wiring is real.

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
- **Deletion protection, covering `TRUNCATE` as well as `DELETE`.** A
  `BEFORE DELETE` row trigger *and* a `BEFORE TRUNCATE` statement trigger,
  both `ENABLE ALWAYS`, both rejecting except for the break-glass role. The
  `TRUNCATE` half is not redundant: a row trigger does not fire on
  `TRUNCATE`, so a `DELETE`-only guard would let the owner drop the singleton
  with one statement — after which the version endpoint fails and grid writes
  go unstamped.
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
- `ALTER FUNCTION` → **nine functions, each named individually** — the three
  write functions (`create_feature_flag`, `delete_feature_flag`,
  `set_tier_feature`) and all **six** trigger functions enumerated in
  *Triggers* above. The runbook lists every signature; it never says "the
  trigger functions." A function left behind stays application-owned and
  replaceable after the tables move, which is the one way a hardened database
  can still be running a gutted guard.
- `ALTER SCHEMA`, only where the application role owns the containing schema
  (the NCMEC doc's same caveat — common on managed Postgres where the app
  owns `public`)

**Moving the schema takes the migration role's `CREATE` with it, and the
re-grants must put it back.** On the managed-Postgres case this procedure
exists to handle, the application role's ability to create objects in `public`
comes *from owning it*. Transferring the schema therefore silently removes
`CREATE`, and the next ordinary migration — Plan 1a's remaining work, or any
unrelated feature — fails to create a table. The re-grant list restores
`GRANT USAGE, CREATE ON SCHEMA <schema> TO <app>` explicitly. That is
deliberately *not* a partial restoration of ownership: `CREATE` lets the role
add objects, while `DROP` on existing objects stays with the owner, which is
the whole point of moving it. The alternative — isolating these four tables in
a dedicated schema the application never owns — is cleaner and is noted as the
better shape for a greenfield deployment, but it would require relocating Plan
1a's tables and is out of scope here.

...to `overhype_feature_grid_owner`, with `overhype_feature_grid_maintenance`
as the break-glass role, both created **by the superuser** so the application
role gains no membership. The application role is then re-granted exactly
what it needs and no more: `SELECT` on all four tables, `EXECUTE` on the
three write functions, and sequence usage where applicable — but **not**
`INSERT`/`UPDATE`/`DELETE` on `feature_flags`, `tier_feature_permissions`, or
`entitlement_grid_revision`, and **not `INSERT` on the audit table either.**

**Withholding audit `INSERT` is deliberate, and a correction to an earlier
draft** that re-granted it reflexively by analogy with the NCMEC ledger. That
ledger's application code appends to it directly; here it does not.
`set_tier_feature` is `SECURITY DEFINER` owned by the grid-owner role, so it
writes the audit row under *its* privileges and the application never needs
the grant. Leaving it would let any code path or session holding the app's
credentials append a **phantom audit row** — a recorded change that never
happened — into a table this same design deliberately makes hard to correct.
The app role's grant on the audit table is `SELECT` only.

**`overhype_feature_grid_maintenance` gets real grants, or it is
decoration.** A `NOLOGIN` role with no privileges cannot perform the
correction the runbook promises it exists for. It receives `SELECT, INSERT,
UPDATE, DELETE` on all four tables, and **every trigger guard tests for it
explicitly** — each rejection is skipped when `pg_has_role(current_user,
'overhype_feature_grid_maintenance', 'usage')`, which is what makes even the
unconditional revision-deletion guard survivable during a real correction.
Granting the role is the audit trail, exactly as in
`ncmec-audit-ledger-hardening.md`'s break-glass section: grant to a named
human role for the duration, revoke afterwards, never to `<app>` — and
`featurePermissionsBoundaryStatus()` reports a grant to `<app>` as
unenforced.

**The procedure is one transaction, and it is re-runnable.** This is the
difference between a runbook and a list of statements, and it matters more
here than in the NCMEC precedent because of *what* is between the steps: an
operator who runs the `ALTER TABLE ... OWNER TO` and then stops — a dropped
connection, a typo, a phone call — has removed the application's
**owner-derived `SELECT`** and not yet issued the re-grant that replaces it.
The grid becomes unreadable and the resolver fails. That is not "unhardened,"
which is a safe state this plan guarantees; it is **broken**, and it is
reachable from a half-executed copy-paste.

So the document presents the transfers and re-grants as a single
`BEGIN`/`COMMIT` block, with the consequence stated in the text rather than
left to the operator to infer: **run it whole or the application loses read
access to the grid.** `ALTER TABLE`, `ALTER FUNCTION`, `ALTER SCHEMA` and
`GRANT` are all transactional in PostgreSQL, so an error rolls the whole
thing back to the unhardened state, which is exactly the fallback that is
safe.

Re-running after a partial application is likewise a supported path, not an
undefined one:

- **Role creation is guarded** — `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM
  pg_catalog.pg_roles WHERE rolname = '…') THEN CREATE ROLE … END IF; END
  $$;` — so a retry does not fail on the roles the first attempt created.
  (Roles are cluster-level and survive a rolled-back transaction on some
  paths, which is precisely why this guard is needed rather than merely
  tidy.)
- **Ownership transfers and grants are naturally idempotent** — re-assigning
  the owner a table already has, or re-granting a privilege already held, is a
  no-op.
- **Diagnosis before re-running:** the verification queries below are written
  to be run *first* on a database in an unknown state. They report which
  objects have moved and which have not, so the operator confirms where they
  are rather than guessing.
- **`featurePermissionsBoundaryStatus()` names the failing condition**, not
  just `false` — so a partial state is legible from the application side too.
  A status that reports only a boolean tells an operator nothing about how far
  they got.

### `featurePermissionsBoundaryStatus()`

In `lib/db/src/index.ts`, alongside `ncmecAuditBoundaryStatus()` and
reporting the same shape. `boundaryEnforced: true` only when all hold:

1. The application role owns none of the four tables.
2. The application role owns none of the trigger or write functions.
3. **The application role owns — and cannot effectively assume the owner of —
   every distinct schema those tables and functions live in.** Table and
   function ownership alone is not sufficient: a role owning the *containing
   schema* can `DROP SCHEMA ... CASCADE` and remove the protected objects
   despite owning none of them individually. `lib/db/src/index.ts:163-190`
   documents this as a **reproduction, not a theory** — a role holding only
   schema ownership successfully dropped the target — and
   `ncmecAuditBoundaryStatus()` accordingly checks the table schema and the
   function schema independently. This function does the same, over every
   distinct schema in use, since the tables and functions need not share one.
4. The application role cannot effectively assume either new role — covering
   `INHERIT` membership, `SET ROLE` membership, and any admin-option chain
   that would let it grant itself the role (the NCMEC function's `pg_has_role`
   triad plus its `pg_auth_members` check).
5. All triggers exist with **exactly** the wiring specified above —
   `tgenabled = 'A'`, the expected `tgfoid`, and exact `tgtype` equality — not
   merely present and not-disabled.
6. **The application role holds no *effective* write privilege on the four
   tables**, checked as the role rather than by reading direct grants.
   Revoking from `<app>` does not remove a privilege inherited from another
   role, granted to `PUBLIC`, or granted at **column level** — and a
   column-level `UPDATE` on `tier_feature_permissions.enabled` alone is
   sufficient to change a cell without the function, the audit row, or the
   revision bump. So the check uses `has_table_privilege` **and**
   `has_any_column_privilege`, with inherited-grant, `PUBLIC`-grant and
   column-grant negative fixtures in the test.

   **The two functions cover different privilege sets and must not be applied
   uniformly.** PostgreSQL column privileges exist only for `SELECT`,
   `INSERT`, `UPDATE` and `REFERENCES`; `has_any_column_privilege(...,
   'DELETE')` **raises** rather than returning false. An earlier revision
   specified the column check across `INSERT`/`UPDATE`/`DELETE` uniformly,
   which would have made this function — and `/admin/health` with it — error
   out instead of reporting either state, on every deployment. The split is:

   | Privilege | Checked with |
   |---|---|
   | `INSERT`, `UPDATE` | `has_table_privilege` **and** `has_any_column_privilege` |
   | `DELETE`, `TRUNCATE` | `has_table_privilege` only — table-level by definition |
   | `SELECT` (audit table: must be present; write privileges must not) | `has_table_privilege` |

   `TRUNCATE` is in the set deliberately: effective-privilege checking is what
   stops a `TRUNCATE` granted later by any route from leaving `/admin/health`
   reporting enforcement over a live bypass.

Unlike NCMEC's, this function's result **gates nothing** (Settled Decision
#2). It is reported at `/admin/health` alongside the existing NCMEC status
so an operator can see which state the deployment is in.

## Data Model and Migration Impact

**No new tables and no new columns.** Every table this plan touches
(`feature_flags`, `tier_feature_permissions`,
`tier_feature_permission_audit`, `entitlement_grid_revision`) either exists
today or is introduced by Plan 1a. This plan adds functions, triggers,
grants, and one documentation file.

**The migration must stay replayable in the hardened state, which
unconditional `CREATE OR REPLACE` is not.** Once the runbook transfers
ownership, the application's migration role can no longer `CREATE OR REPLACE
FUNCTION` a function it does not own, nor `DROP TRIGGER` on a table it does
not own — so a replay against a hardened database would fail on its own
supported configuration. `0097:875-925` already solves this with an
ownership-aware branch, and this migration takes the same shape:

- **If the application role still owns the objects** (the unhardened state,
  and every fresh install) → create/replace them normally.
- **If it does not** (the hardened state) → **verify instead of alter.** Assert
  each function and trigger exists with exactly the expected wiring — the same
  `tgenabled`/`tgfoid`/`tgtype` predicate the catalog test and
  `featurePermissionsBoundaryStatus()` use — and succeed silently when it
  matches. On drift, fail with an actionable message naming the object and
  the DBA action required, rather than attempting an alteration that cannot
  succeed.

This is also why the verification predicate is defined once and shared three
ways: the migration's verify branch, the CI catalog test, and the runtime
status reporter must not be able to disagree.

**Migration contents**, forward-only and idempotent in both boundary states:

1. The **six** trigger functions enumerated in *Triggers* and their triggers,
   `ENABLE ALWAYS`, each named individually rather than as a set, via the
   ownership-aware branch above.
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

**Ordering against Plan 1a — checked against the journal, not against table
existence.** Plan 1a must merge *and deploy* before this migration runs. An
earlier revision enforced that by testing whether Plan 1a's two tables exist,
which is the wrong predicate in a way that fails quietly:

- **Tables can exist without Plan 1a's migration having completed.**
  `drizzle-kit push` creates schema directly, and manual/dev setup does the
  same; either leaves the tables present while the row-creating and backfill
  work has never run. The existence check passes, this migration installs the
  boundary, and the runbook can then revoke the migration role's writes
  **before Plan 1a has finished populating the grid** — after which it cannot.
- **It also contradicted this plan's own claim** that the two ship in either
  order. They do not. That claim is now corrected in both plans; see
  *Relationship to Plan 1a*.

So the prerequisite is Plan 1a's **concrete journal entry**, checked in
`drizzle.__drizzle_migrations` by the hash the runner records
(`lib/db/src/migrate.ts` tracks by SHA-256 of the SQL file, which is what makes
this checkable at all). Absent that entry, this migration aborts with an error
naming the required migration rather than installing half a boundary.

**And the runbook is gated separately, later.** The migration's prerequisite
is Plan 1a's migration; the *runbook's* prerequisite is all of Plan 1a
deployed — migrations **and** the application code that writes through
`setTierFeature`. Hardening a database whose running code still issues direct
`UPDATE`s would break grid editing. The runbook states this as its first
precondition, with `featurePermissionsBoundaryStatus()` and the deployed
commit as the two things to confirm before starting.

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
- The audit table stays append-only **and unforgeable**: the app role gets
  `SELECT` only, with `INSERT` reaching it solely through `set_tier_feature`'s
  definer rights, so the ledger cannot contain a change that never happened.
  This is deliberately stricter than the NCMEC ledger, whose application code
  does append directly.
- The break-glass role exists so that a genuine correction is a deliberate,
  attributable act outside the application, as documented in the runbook.

## Testing Plan

Runner commands per `docs/tests/testing-guide.md`:
`pnpm --filter @workspace/db test`, `pnpm --filter @workspace/api-server test`.

**The existing `tierFeatures.integration.test.ts` suite must be rewritten in
this PR, not merely left alone.** Its fixtures write the grid the way every
caller does today — directly, as the application role — which is exactly what
this migration starts rejecting: `:35-41` deletes child rows while their
parents still exist, and `:99`/`:115` delete the permission table's rows
outright to exercise cache invalidation. All three are rejected by the new row
guard the moment the migration installs, so the second of the two runner
commands above **cannot pass** without this work. A plan that adds ten new
tests while silently breaking an existing suite has not been implemented; it
has been half-implemented and shipped red.

The rewrite keeps every existing assertion — the cache-invalidation coverage
is the point of that suite and is not being weakened — and changes only how
the fixtures reach their state:

- Setup that creates or removes a feature goes through `create_feature_flag` /
  `delete_feature_flag`.
- Setup that flips a cell goes through `set_tier_feature`, which additionally
  makes the cache tests exercise the *real* write path rather than a
  hand-rolled `UPDATE` — a small improvement in what they actually prove.
- Any fixture that genuinely needs to reach a state no sanctioned path
  produces (deliberately incomplete row-sets, for negative tests) runs as the
  break-glass maintenance role on an isolated fixture database, the same shape
  `ncmecAuditBoundaryStatus.test.ts` already uses for restricted roles.

Tests below are numbered continuing from that rewrite, which is item 0 and is
a completion criterion, not an optional cleanup.

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
6. **Every unsanctioned write is rejected in the *unhardened* state.** This
   is the set the triggers must carry alone, since the revokes are
   ineffective against the owner until the runbook runs — so each of these
   runs as the owning application role:
   - `UPDATE tier_feature_permissions SET enabled = ...` directly → rejected,
     and the cell, audit table and revision are all unchanged.
   - `UPDATE tier_feature_permissions SET tier = 'bogus'` → rejected (the
     incomplete-row-set path the `feature_flags`-attached completeness
     trigger cannot see).
   - `UPDATE tier_feature_permissions SET feature_key = ...` → rejected.
   - `TRUNCATE tier_feature_permissions`, `TRUNCATE feature_flags`,
     `TRUNCATE entitlement_grid_revision` → each rejected, proving the
     statement-level triggers cover what row triggers cannot.
   - `DELETE FROM entitlement_grid_revision` → rejected.
7. **Catalog assertions, by exact wiring.** For every trigger: `tgenabled =
   'A'` (not merely `!= 'D'`), the expected `tgfoid`, and `tgtype` by exact
   equality against the documented bit values — with a negative fixture that
   recreates a same-named trigger with an *extra* event and asserts the check
   fails, since that is the false-positive the exact match exists to catch.
   Plus: the completeness trigger is deferrable and initially deferred, and
   all three write functions are `SECURITY DEFINER` with a non-empty fixed
   `search_path` and no `EXECUTE` grant to `PUBLIC`.
8. **`featurePermissionsBoundaryStatus()` reports honestly, in both states —
   and the hardened case is mandatory, not conditional.** The repository
   already demonstrates the fixture this needs:
   `lib/db/src/ncmecAuditBoundaryStatus.test.ts:36-37,95,121,187` creates
   `LOGIN`/`NOLOGIN` roles and queries status through a restricted pool. The
   hardened state is exactly where the `SECURITY DEFINER` and
   ownership-transfer claims can fail, so leaving its test optional would
   mean CI never proves them. An isolated hardened fixture therefore asserts:
   all three write functions remain callable, direct writes are denied, and
   the status reports `true`. The unhardened case asserts `false` and names
   which condition failed — it is the state every developer machine is in.
9. **Effective-privilege negatives.** With ownership transferred, the status
   still reports `false` when the app role reaches a write through (a) an
   inherited grant from another role, (b) a grant to `PUBLIC`, or (c) a
   column-level `UPDATE` on `tier_feature_permissions.enabled` — three
   fixtures, because a direct-grant check passes all three while the cell is
   still writable.
10. **Break-glass works as documented.** A session holding
    `overhype_feature_grid_maintenance` can perform the correction the
    runbook describes — including deleting and restoring the revision row —
    while the same statements from the app role are rejected.
11. **The unhardened state is fully functional.** With no ownership transfer,
    every grid operation Plan 1a performs still succeeds — proving Settled
    Decision #2's claim that skipping the runbook breaks nothing.
12. **The migration replays in both states.** Re-running it against an
    unhardened database is a no-op; re-running against a *hardened* one takes
    the verify branch, succeeds without attempting an alteration it cannot
    perform, and fails with the actionable message when a trigger has drifted.
13. **Migration prerequisite.** Running against a database lacking Plan 1a's
    two tables fails with the explicit error, not a partial install.

Manual QA is the UAT doc: an operator confirms grid editing still works
end-to-end and that `/admin/health` reports the boundary state.

## Implementation Steps

One PR.

1. **Define the trigger-wiring predicate once**, in a form the migration's
   verify branch, the catalog test, and `featurePermissionsBoundaryStatus()`
   all consume — so the three cannot disagree about whether the wiring is
   real.
2. Migration: the **six** trigger functions and their triggers — the deferred
   completeness trigger, the `DELETE OR UPDATE` row guard, the three
   per-table statement-level `TRUNCATE` guards (`tier_feature_permissions`,
   `feature_flags`, `tier_feature_permission_audit`), and the revision
   table's `DELETE` guard plus its own `TRUNCATE` guard — all `ENABLE
   ALWAYS`, installed through the ownership-aware create-or-verify branch.
   Plus the prerequisite check against Plan 1a's journal entry.
3. Migration: the three `SECURITY DEFINER` write functions with fixed
   `search_path` and schema-qualified references, `REVOKE EXECUTE ... FROM
   PUBLIC`, and `GRANT EXECUTE` to the application role.
4. Migration: the revokes on the four tables, with the honest comment that
   they bind nobody until the runbook runs, and the residual-state
   `RAISE WARNING` naming the role and schemas.
5. Rewrite Plan 1a's `setTierFeature` as a thin wrapper over
   `set_tier_feature`, and its feature creation/deletion callers over
   `create_feature_flag` / `delete_feature_flag`.
6. `featurePermissionsBoundaryStatus()` in `lib/db/src/index.ts`, covering
   all six conditions including per-schema ownership and effective/
   column-level privileges; wire it into `/admin/health`.
7. Document all triggers in `lib/db/src/schema/featureFlags.ts` (as comments,
   per `moderation.ts`'s precedent) and add the single-row `CHECK` to the
   revision table's Drizzle declaration if Plan 1a has not already.
8. Write `docs/engineering/feature-permissions-boundary-hardening.md`,
   including the maintenance role's grants and the break-glass procedure.
9. Tests 1-13, including the hardened-state fixture modelled on
   `ncmecAuditBoundaryStatus.test.ts`.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| The `SECURITY DEFINER` functions become their own escalation path | Fixed `search_path`, schema-qualified references, no dynamic SQL, no `EXECUTE` to `PUBLIC`, and catalog test 6 asserting all of it |
| Hardening is never run, so the boundary is imagined | `featurePermissionsBoundaryStatus()` reports it, `/admin/health` surfaces it, and this plan states plainly that unhardened is defense-in-depth only |
| Hardening *is* run and breaks grid editing | Exactly what `SECURITY DEFINER` prevents; test 8 covers unhardened, and the runbook's verification section covers hardened |
| The trigger exemption becomes a general bypass | The exemption is function-owner identity, which the application role cannot assume after hardening. The forgeable `SET LOCAL` GUC an earlier revision specified is removed — see *Triggers* |
| Plan 1a ships or deploys after this plan | The migration aborts on Plan 1a's absent journal entry; the runbook additionally requires Plan 1a's code deployed (see *Data Model*) |
| This diverges from the NCMEC pattern over time | Both are cited from each other's docs; the divergence that exists today (gating) is stated as a decision, not left implicit |
| The pre-hardening guards are mistaken for a boundary | *The two halves* states the limit in the plan's own voice, and *Accepted by construction* below enumerates what is deliberately not closed |

## Accepted by construction

Per *The two halves*, a gap that exists **only before hardening** and is
closable only by another guard the table owner could equally disable is not a
defect this plan can fix — it is the pre-hardening state's definition. These
were raised in review, verified as accurate, and are accepted rather than
patched. Each is closed by running the runbook, which is the only thing that
closes any of them.

| Accepted | Why it is not fixed |
|---|---|
| **Direct `INSERT` into `tier_feature_permissions`** as the owning application role, adding a cell for an unknown fifth tier or filling one without the sanctioned path. `tier` is an unconstrained `varchar` (`featureFlags.ts:14`). | An `INSERT` guard is a trigger, and the owner disabling it is one statement. After hardening, `INSERT` is revoked and effective-privilege condition 6 verifies it. The resolver reads by known tier, so an unknown-tier row is inert rather than dangerous. |
| **Direct `DELETE FROM feature_flags`**, whose `ON DELETE CASCADE` (`featureFlags.ts:15`) removes the children without `delete_feature_flag` or a revision bump. | Same shape: a parent guard is a trigger the owner can disable. After hardening, `DELETE` on the parent is revoked. The recovery is a forward re-create through `create_feature_flag`, and a feature's audit history survives its deletion by design. |

**What is *not* on this list:** anything that survives into the hardened
state. A wiring error, a permissive function body installed before the
transfer, a privilege left effective by an unchecked route, or a guard that
errors on an absent role are all real defects and are fixed above — the
distinction is drawn in *The two halves* and applied case by case, not used as
a general excuse.

### Declined: staging enforcement across a rolling deploy

Raised in review: during a rolling deploy the first new instance applies this
migration while older Plan 1a instances still issue direct cell-write SQL,
which the new row guard rejects.

Declined for the same reason as the identical finding on Plan 1a, and stated
here so the two plans stay consistent. The evidence cited —
`lib/db/src/migrate.ts:25-28` — documents advisory-lock contention between
instances **racing to run migrations**, not old and new binaries **serving
traffic** simultaneously; the comment is fully compatible with a
restart-and-replace deploy where one instance serves at a time. Our own
[`replit-environment.md`](../ai-context/replit-environment.md) describes
container restart and workspace-snapshot publishing rather than rolling
instances.

Designing a two-phase compatible rollout against a deployment topology we
have not confirmed we have is speculative work; confirming the topology with
Replit is an ops question, not a plan revision. **If the answer is "rolling,"
this reopens in both plans** — and the staged version is cheap to add at that
point.

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
