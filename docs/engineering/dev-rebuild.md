# Rebuilding dev from code — runbook

How the Repl's dev database is replaced by one built from code, keeping its
content. Built in Launch Phase 3, increment 7 (#770; plan
`docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` §5 and §7). David chose that
dev keeps its content, from a fresh capture taken immediately before the
rebuild (2026-10-28, Question 1).

The mechanism is `artifacts/api-server/src/lib/devRebuild.ts`; the command is
`artifacts/api-server/scripts/rebuild-dev.ts`; the test is
`artifacts/api-server/src/__tests__/phase3.devRebuild.test.ts`.

## What it does

1. **Capture and inventory.** It refuses while any job is still pending or
   processing, and lists each one. Queued jobs are drained by the worker
   rather than cancelled by the rebuild. Marking a job failed by hand would
   skip its handler, and some handlers own a status elsewhere that only the
   worker sets (a fact's visual-concept status, for one). The review that job
   served would then be stuck. It runs the excluded-classes inventory,
   fingerprints every row of every public table in the live dev database
   (hashed, independent of column order), and dumps it with `pg_dump`.
2. **Build from code.** It creates `<dev>_rebuild_<id>` on the same server and
   boots it by the bootstrap path (`artifacts/api-server/scripts/boot-database.ts`: the baseline,
   the migrations, the seeds, the engine catalogue).
3. **Load.** It loads the dump's rows into the built schema
   (`pg_restore --data-only`), except sessions and auth state. The load runs
   in a replica session, not with `--disable-triggers`. That flag ends by
   re-enabling every trigger as an ordinary one, which would quietly weaken the
   child-safety audit log's always-on append-only guards. Then it boots again,
   as the server will.
   A schema the code does not build is carried whole, objects and rows. Today
   that is the `stripe` mirror stripe-replit-sync creates at server start
   (`artifacts/api-server/src/lib/stripeInit.ts`). Without this, the mirror
   would vanish from dev unnoticed. The library also creates the functions its
   triggers call (`set_updated_at()`, `set_updated_at_metadata()`) in `public`,
   where the code does not build them. Those, and only the functions a carried
   schema's triggers call, are carried first and listed in the report's
   `functionsCarried`.
4. **Verify, while dev still serves.**
   - Every product, child-safety and payment row, and every row of a carried
     schema, arrives unchanged.
   - Configuration and runtime tables keep every row; a boot may add seeds.
   - Every operator setting reads as it did.
   - No foreign key has an orphan, and no sequence would collide.
   - Every trigger keeps the firing mode the fresh build gave it.
   - Sessions are empty.
   - The audit-boundary status is recorded.
   - Finally, the live database must not have moved since the capture.
5. **Swap**, on its own command. The live database is renamed to
   `<dev>_pre_rebuild_<id>` and the build into dev's name. Nothing is dropped.

Any difference fails the rebuild, and the failed build is dropped. That
includes a table or a column dev has that the code does not build: that is
drift, and it is fixed in a migration, never by the rebuild.

**Payment rows and Stripe.** The plan's Stripe block (§5, step 3) protects
obligations a replacement would discard. This replacement discards none: every
payment-class row is carried and checked unchanged. So live Stripe is not
read, and the inventory's `BLOCKS: live-mode Stripe inventory incomplete` is
expected here. It is not expected on production's reset (increment 8).

## Running it (on the Repl, through the connector)

1. With the workflows still running, let the job queue drain: the inventory's
   `nonTerminalJobs` reads 0. Then stop the Repl's app workflows, so nothing
   writes to dev. A job that will not drain is decided with David, not cleared
   by the rebuild.
2. Prepare:

   ```
   pnpm --filter @workspace/api-server exec tsx scripts/rebuild-dev.ts prepare --out /tmp/rebuild-dev.json
   ```

   Exit 0 means `verdict: pass` and the build is kept. Record the report on
   #770: inventory, dispositions, counts, times, audit boundary.
3. **Swap, with David's go** (a write to the shared dev database is on the
   irreversible list):

   ```
   pnpm --filter @workspace/api-server exec tsx scripts/rebuild-dev.ts swap --report /tmp/rebuild-dev.json --confirm
   ```

   It refuses if dev has changed since the prepare; prepare again. If its
   second rename fails, it renames dev back and says so. If even that fails,
   its error names the one statement that restores dev's name.
4. Restart the workflows. Check that the app boots, David's content is there,
   and he can sign in again (every session was cleared).

## Undoing it

```
pnpm --filter @workspace/api-server exec tsx scripts/rebuild-dev.ts undo --previous <dev>_pre_rebuild_<id> --confirm
```

This renames the old database back into dev's name and keeps the rebuild as
`<dev>_rebuilt_<id>`. A failed second rename is put back the same way as in
`swap`. Anything written to dev after the swap stays in the
rebuild, not in the restored database.

The set-aside databases are kept until David says to drop them. No tool here
drops a database it did not create.
