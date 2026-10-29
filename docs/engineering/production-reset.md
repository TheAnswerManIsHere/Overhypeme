# Resetting production from code — runbook

This runbook covers how production's database is replaced by an empty one
that the code builds, without losing anything that must be kept. It belongs
to Launch Phase 3, increment 8 (#770). It follows the parent plan
`docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` §5 and §7, as amended by
`docs/plans/PLAN_PHASE3_AMENDMENT_1.md` (approved by David 2026-10-29).

- The mechanism is `artifacts/api-server/src/lib/productionReset.ts`.
- The command is `artifacts/api-server/scripts/production-reset.ts`.
- The test is `artifacts/api-server/src/__tests__/phase3.productionReset.test.ts`.

## What David decided

- **D2:** production's child-safety rows are left behind. There are 2 pending
  NCMEC reports and 3 quarantines, all byte-identical copies of dev's. Dev's
  rows are the authoritative handling copy, and David is the operator. A
  permanent case record is still written.
- **D3:** for the reset window only, David creates a temporary workspace
  secret, `RESET_PRODUCTION_DATABASE_URL`, holding production's connection
  string. He deletes it afterwards. Creating and deleting it are his actions,
  on the irreversible list.

## What `prepare` does

Production is only read.

1. **No other writer.** The command refuses while any other session is
   connected to production (`pg_stat_activity`) and lists the sessions it
   found. Pause or shut down the deployment first.
2. **The final capture.** It runs `pg_dump` on production, then proves the
   dump restores, into a scratch database on dev's server.
3. **The full inventory.** It runs the excluded-classes inventory on the
   restored capture. A blocking payment inventory fails the run.
4. **The case record.** Under `cases/production-reset-<id>/` in the backup
   bucket, which backup expiry never deletes, it writes two files:
   - `final-capture.dump`;
   - `record.json`.

   The record holds:
   - every child-safety row, complete and hashed (NCMEC reports, quarantined
     memes, the safety audit log);
   - every row those rows reference, following foreign keys transitively;
   - an evidence manifest: each evidence object's path, size, md5 where the
     store reports one, and generation;
   - the inventory;
   - the D2 handling note.

   Both files are written once and read back. A sha256 over the record's body
   is stored beside it. Evidence bytes are never read or copied.
5. **The equality check.** If any child-safety row in the capture differs from
   dev's, the reset **stops**. That covers a new case, or a handling status
   that moved on one side. The record is kept, and the differences go to
   David. A missing evidence object also stops it.

The command exits 0 only on `verdict: pass`. A reset id is used once. The case
directory is write-once, so a second run of `prepare` takes a new id.

## The sequence

1. **David:** pause or shut down the production deployment. Then create the
   workspace secret `RESET_PRODUCTION_DATABASE_URL`, using the connection
   string from Replit's Database pane for production.
2. **Through the connector, on the Repl:**

   ```
   pnpm --filter @workspace/api-server exec tsx scripts/production-reset.ts check-connection
   pnpm --filter @workspace/api-server exec tsx scripts/production-reset.ts prepare --reset-id <yyyy-mm-dd> --out /tmp/production-reset.json
   ```

   Record the report on #770: the capture, the counts, the evidence manifest,
   the record's key and sha256, and any differences. **Anything but `pass`
   stops here and goes to David.**
3. **David:** remove production's database in Replit's Database tool, then
   publish. The empty database builds itself from code at boot, by the
   bootstrap path.
4. **The admin proof.** David signs in, and a script checks that his session
   reaches an admin endpoint.
5. **The audit-boundary status** (`ncmecAuditBoundaryStatus()`) is recorded on
   #770.
6. **The platform restore drill** runs.
7. **David:** delete `RESET_PRODUCTION_DATABASE_URL`.

## If something goes wrong

- **Another session is connected:** the deployment is still running.
  Pause it, then run `check-connection` again.
- **The capture fails or will not restore:** nothing has been written.
  Fix the cause and run again with the same id. A version mismatch between
  `pg_dump` and production's server is the likeliest cause.
- **The rows differ from dev's, or evidence is missing:** the reset does not
  go ahead. The record is in the bucket. David settles the handling
  disposition before any new `prepare`, which takes a new id.
