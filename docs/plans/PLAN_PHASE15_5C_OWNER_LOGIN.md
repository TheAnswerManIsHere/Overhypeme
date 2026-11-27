# Plan amendment — Launch Phase 15, 5c: production's app goes back to Replit's database login (Issue #1306)

Amends `docs/plans/PLAN_PHASE15_SECURITY_HARDENING.md` (v3) and supersedes `docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md` (v3) for production's database login.

## Summary for David

**Why now.** Production can't be published at all at the moment. Tonight's second republish refused to start 27 times (Sentry `SENTRY_PROJECT_BACKEND-1F`): `APP_DATABASE_URL` no longer names the same database address as the login Replit supplies. Replit kept the previous release serving, so the site is up, but nothing new can go live until this lands.

**What changes for you.** Publishing works the way Replit expects again. A publish that adds a database table goes live on its own: no repair batch, no second publish. The admin-action log keeps its triggers, so the app still can't edit or delete an entry by accident or through a bug. What you accepted with Q20 is now written down: the app's own login could switch those triggers off. That closes Phase 15's audit-boundary item.

**What gets built (one PR):**
- **One login.** A published app connects with the login Replit supplies and ignores `APP_DATABASE_URL` if it's still set, so the first publish works before anything is cleaned up.
- **The 5b repair machinery is removed:** the ownership check and its repair instructions, the start-up refusal, and the three setup runbooks.
- **Alerts:**
  - Every start still writes the `[audit-boundary]` line, stating the truth.
  - Your phone is alerted only when the log's protection itself is damaged (a trigger removed or switched off, or the guard function changed), or when the check can't run.
  - The accepted state alerts nothing.
- **A one-time retirement batch** for the old `overhype_app` login, built from PostgreSQL's standard role-removal statements and rehearsed on a database set up like production's.

**The order matters, and you do two steps:**
1. **The PR merges, then you publish.** On the same visit, delete `APP_DATABASE_URL` from *Production app secrets* just before clicking **Republish**. Replit saves a secret change only when that publish succeeds; if it fails, the release that's serving keeps its own settings. I confirm production started cleanly with the Replit login and that the secret is gone.
2. **Only after I've confirmed the old release has fully stopped** (Replit's deployment status, not just a quiet moment), you run the retirement batch in the production SQL console. The batch also checks for itself that nothing is still connected as the old login, and that nothing outside this database depends on it. If either check fails, or the batch would have to wait on a busy table, it stops and changes nothing.

**What it closes:**
- Q16 (the exposed `overhype_app` password): the login no longer exists.
- Increment 6's row for rotating that password and `APP_DATABASE_URL`: removed.

**Next, not built now:** a copy of each log entry kept outside the database, which would resist even a full server compromise (the split never did). To be weighed before Full US.

**Accepted trade-off (Q20 → 1, yours):** someone who can run SQL as the app, through a SQL-injection bug for example, could disable the log's triggers and edit it. With that access they could already read and change every other table.

**Questions for you:** none. Q20 settled the direction, and everything else here is technical.

## Problem

5b moved production's app onto its own login, `overhype_app`, so that the app's login wouldn't own the NCMEC audit ledger. Replit's publish applies schema changes as the database owner, `neondb_owner`. Tables it creates belong to the owner, and the app's own migration then can't alter them. The first table-adding publish after 5b failed exactly this way. Sentry `SENTRY_PROJECT_BACKEND-1E`: `Failed to apply migration 0176_gag_descriptions: error: must be owner of table fact_gag_descriptions`, first seen 2026-11-27T01:07:01Z. It took a manual repair batch and a second publish to recover. Every future table-adding publish would repeat this.

The protection the split bought is narrow. The ledger's triggers refuse UPDATE, DELETE and TRUNCATE with or without it. The split only stops an attacker who can run SQL as the app from disabling those triggers first. Code execution on the server already reaches the owner's credential (Q14), and that attacker can already read and change every other table. David weighed this and chose to roll back (Q20 → 1, 2026-11-27): *"I think you're overbuilding and it will result in making supporting the application going forward much more difficult and fragile. You're building against the way that Replit expects."*

## Direction

`docs/plans/PLAN_PHASE15_SECURITY_HARDENING.md`, Product intent item 7: "the Phase 3 audit boundary enforced on production or its non-enforcement accepted in words by David". This increment takes the second branch.

## Product Intent

1. A published deployment connects with the database login Replit supplies (`DATABASE_URL`, the owner), as the platform expects, and needs no separate application login to start.
2. A publish that adds a table succeeds with no manual database step and no second publish.
3. The NCMEC audit ledger's append-only triggers and guard function stay exactly as they are: UPDATE, DELETE and TRUNCATE still raise for any session that does not hold the maintenance role.
4. David accepts, in words, that the ledger's guard is not enforced against the application's own login. That acceptance is recorded in `decisions.md`, superseding the 2026-11-26 entry, and closes plan item 7.
5. The accepted state rings no alert. The start-up line still reports the true state. An alert still fires when the guard itself is missing or altered (a trigger gone or disabled, the guard function's body changed).
6. Production is left tidy: the `APP_DATABASE_URL` secret is no longer needed; nothing is left owned by, or reachable through, a login nothing uses; the exposed `overhype_app` password (Q16) stops mattering.

## Must Not Change

- The ledger table, its two triggers and its guard function.
- Development, tests, CI and operator scripts (they already use `DATABASE_URL`).
- No production row is changed. No downtime: a failed start keeps the previous release serving.
- The media backup's dump and restore keep working.
- No other live lane is touched (Phase 7, Issue #1018's migration slot).

## Settled Decisions

- Q20 → 1 (David, 2026-11-27): roll back to Replit's model; the triggers stay; non-enforcement against the app's login is accepted.
- Q19 (automating the ownership repair at start-up) is withdrawn.
- Q14 and Q15 (5b's residuals) are superseded with 5b's login model. Q15's operational-alert source `audit_boundary` stays, narrowed to guard integrity.
- Pre-launch: no disclosure gating of security details (David, 2026-10-12).

## Source-of-Truth Analysis

- **Which login the app uses:** the environment, read once at start by `@workspace/db`. After this change it is `DATABASE_URL` everywhere. `APP_DATABASE_URL` is read by nothing.
- **Whether the ledger is protected:** the database catalog, read by `ncmecAuditBoundaryStatus()` (`lib/db/src/index.ts`). It already reports `triggersEnabled` and `guardFunctionIntact` separately from ownership and `boundaryEnforced`. Nothing about how it's computed changes; only which outcomes alert.
- **Who owns production's objects:** the catalog. After the retirement batch, everything `overhype_app` owned belongs to `neondb_owner`, and the role is gone.

## Proposed Design

**D1. One login.** In every environment the application's connection is `DATABASE_URL`. A published deployment no longer requires `APP_DATABASE_URL` and ignores it when present, so the first publish works while the secret is still set (C1). The owner-credential scrub is removed, since there is nothing to hide the owner's credential from. Every consumer of the old resolver uses the same single source: the pool, Stripe start-up and both Stripe drivers, the media backup job, and `scripts/boot-database.ts`. A missing `DATABASE_URL` still refuses with the existing message.

**D2. Start-up report and alerts (C2).** The `[audit-boundary]` line is still written on every start, with the full `ncmecAuditBoundaryStatus()` object, so the accepted state is visible as it is (`boundaryEnforced: false`). In a published deployment the `audit_boundary` alert fires only when:
- `triggersEnabled` is false;
- `guardFunctionIntact` is false; or
- the status query fails ("unable to establish").

A guard that is intact under the owner login logs at info and alerts nothing. Nothing stops a start (Q15's reason holds). Ownership drift is removed entirely: `ownershipDrift()`, the pre-migration diagnostic, the migration-failure alert and the "repair ownership, then publish again" instructions. A migration failure goes back to failing the start with its own error, as before 5b.

**D3. Retiring `overhype_app` (C1).** A new runbook, `lib/db/runbooks/app-role-retire.sql`, run once as `neondb_owner` in the production SQL console as one selected batch, **only after D1 is published and verified**:
- `REASSIGN OWNED BY overhype_app TO neondb_owner`;
- `DROP OWNED BY overhype_app` (revokes its grants and the default privileges S1 added);
- `DROP ROLE overhype_app`;
- a read-back proving that no role named `overhype_app` remains, and that the ledger, its triggers and its guard function are unchanged.

The batch guards itself before it changes anything (C1, C4):
- **Time limits.** It sets transaction-local `lock_timeout` and `statement_timeout`. Ownership changes take exclusive locks, so contention (for example the media backup's dump) aborts and rolls back the whole batch rather than stalling the app's queries. The owner-login release keeps serving, and the batch is run again later.
- **Nothing still connected.** It aborts if any session is still connected as `overhype_app`, meaning an old instance hasn't drained yet.
- **Nothing outside this database.** It aborts if `overhype_app` owns or holds privileges on anything in another database of the cluster. `REASSIGN OWNED` and `DROP OWNED` act only on the current database, so such a dependency would be a surprise to investigate.
- **Read-only inventory first.** It lists the role's memberships, owned-object counts, grants and default privileges, so the read-back shows what was retired.

It names no object, so it can't miss one. It drops nothing that holds data, because ownership moves before `DROP OWNED` runs. If any statement fails, the whole batch rolls back and the failure is investigated; no `CASCADE` is used. The 5b runbooks (`app-role-split.sql`, `app-role-default-privileges.sql`, `app-role-ownership-repair.sql`) are deleted. The `overhype_audit_maintenance` role stays: it is the break-glass role for correcting the ledger and has nothing to do with the split.

**D4. Order of operations in production (C1):**
1. The PR merges; the Repl syncs.
2. David deletes `APP_DATABASE_URL` from *Production app secrets* and publishes in the same visit. Replit saves a secret change only when the publish succeeds (`replit-platform.md`, *Secrets and environment*); a failed publish leaves the serving release and its settings as they were. Claude confirms that:
   - the deployment log shows the start ran migrations as `neondb_owner`;
   - it wrote `[audit-boundary]` with `triggersEnabled: true` and `guardFunctionIntact: true`;
   - `https://overhype.me/api/healthz` answers 200;
   - David's screenshot of the secrets page shows `APP_DATABASE_URL` gone.
3. Claude confirms that Replit has completed the replacement and the previous deployment's instances have stopped. An empty session list alone doesn't prove that: the pool closes idle connections after 60 seconds (`lib/db/src/index.ts:84`), so a running old instance can show no session and open one later. `unable to verify: which field of Replit's deployment status (the connector's get_publish_status, or the deployment's lifecycle log) shows that the previous release has stopped; reading it during D4 step 2 settles it, and the step waits until it does.` Only then does David run D3's batch and send its read-back. The batch's own session check is a second guard: any remaining `overhype_app` connection makes it refuse, and that connection is investigated, never terminated.
4. Before D3's batch is offered, Claude records the role's dependency inventory as it actually is in production, read-only, on #1306. A materially different inventory sends the batch back for revision.

If step 2 fails to start, the previous release keeps serving, unchanged. Recovery is a fix-forward, never a revert to 5b's code: after step 3 that code would refuse to start, because `overhype_app` no longer exists.

**D5. Docs.**
- `decisions.md`: a 2026-11-27 entry supersedes the 2026-11-26 one, recording Q20 with its reasoning and the accepted residual.
- `docs/engineering/ncmec-audit-ledger-hardening.md`: describes the production login model as it now is, with the retirement batch, and keeps the break-glass section.
- `replit-environment.md`: drops the `APP_DATABASE_URL` section.
- `migrations-and-backfills.md`: drops the post-publish ownership rule.
- Issue #1306's State of Play: increment 6 loses the `overhype_app` row, and the external-copy idea is recorded under *Next*.

## Data Model and Migration Impact

No migration and no schema change, so #1018's slot is not claimed. D3 is an operator runbook that changes role ownership only; no row is touched.

## Admin/User UX Impact

None visible. The only surface is the deployment log line and the alert.

## Security, Permissions, and Validation

- Accepted (Q20): the app's login owns the ledger and could disable its triggers.
- Unchanged: the triggers refuse row changes from every session without `overhype_audit_maintenance`, including the app's.
- An attack on the ledger's protection (triggers dropped or disabled, guard function replaced) still alerts on the next start.
- D3 runs as the owner, the identity that already owns the database. `DROP ROLE` needs the admin option the owner holds on `overhype_app` (read back in the 5b repair's screenshot, 2026-11-27: `admin_option TRUE`).
- `unable to verify: that REASSIGN OWNED, DROP OWNED and DROP ROLE all succeed for neondb_owner on Neon without superuser; the rehearsal on a database split like production's, with a non-superuser owner, settles it before the runbook is offered.`

## Testing Plan

- **Connection:** a published deployment with `DATABASE_URL` alone starts. With `APP_DATABASE_URL` also set, it still connects as `DATABASE_URL`'s user. Without `DATABASE_URL`, it refuses. Development is unchanged.
- **Owner-created table:** on a database where a table was created by the owner login, the app's migration that adds an index to it succeeds when the app connects as the owner (the case that crash-looped).
- **Alerts:**
  - intact guard under the owner login → info line, no alert;
  - a trigger disabled → alert;
  - the guard function's body changed → alert;
  - the status query failing → "unable to establish" alert, never classified as accepted;
  - outside a deployment → no alert in any case.
- **Ledger:** with the app connected as the owner, UPDATE, DELETE and TRUNCATE on the ledger still raise (the existing 0097 tests, run as the owner).
- **Retirement guards:** with a session held open as `overhype_app`, the batch aborts and changes nothing. With a conflicting lock held on an app table, it times out, rolls back, and leaves ownership, grants and the role unchanged.
- **Retirement rehearsal:** on a disposable database set up like production after 5b (owner non-superuser, `overhype_app` owning the app's objects, S1's default privileges, the owner's INHERIT and admin membership), run D3's batch as the owner. Then:
  - every row is still present;
  - no object is owned by `overhype_app`, and the role is gone;
  - the ledger, its triggers and its guard function are unchanged;
  - the new code starts as the owner **both before and after** the batch: before, while the app's objects still belong to `overhype_app`; after, once they belong to the owner. In each case a migration on an owner-created table and a dump-and-restore succeed.
- **Stripe:** start-up through the owner connection completes on the fake driver (`E2E Smoke`'s `adminBillingSync`).
- **Backup:** the capture still excludes `_system`, ownership and ACLs, and its restore rehearsal passes.

## Implementation Steps

1. D1 and D2 in code, with their tests; remove the 5b-only tests and helpers.
2. D3's runbook and the rehearsal test; delete the three 5b runbooks.
3. D5's docs.
4. PR (sensitive tier, standard review loop). After merge: D4.

## Risks and Mitigations

- **The batch stalls the live app.** Mitigation: its transaction-local time limits abort it on contention; it is all-or-nothing and simply runs again later.
- **Retirement batch fails on Neon.** Mitigation: the rehearsal runs with a non-superuser owner. The batch is all-or-nothing, so a failure changes nothing and is investigated before production.
- **The first publish fails to start.** Mitigation: the previous release keeps serving. Nothing is removed before D4 step 2 is verified.
- **A later reader re-creates the split from old notes.** Mitigation: D5 rewrites every doc that describes it, and `decisions.md` records why it was rolled back.

## Questions for David

None. Q20 → 1 settled the direction. C1's order and C2's alert policy are technical, agreed with Astra at scope.

## Definition of Done

- The PR is merged and published, and production's log shows `[audit-boundary]` with `triggersEnabled: true` and `guardFunctionIntact: true`, connected as `neondb_owner`, with no alert.
- D3 has run in production and its read-back is quoted on #1306. The `APP_DATABASE_URL` secret is deleted.
- `decisions.md` records Q20, and plan item 7 is marked closed by acceptance.
- The next table-adding publish goes live with no manual step. This is confirmed when it happens and recorded on #1306.
