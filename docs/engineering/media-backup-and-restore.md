# Media backup and restore — runbook

How Overhype.me's database and stored photos are backed up together, how a
restore is rehearsed, and what to do in an incident. Built in Launch Phase 3,
increment 5 (#770; plan `docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` §4).
The decision behind it is in
[`decisions.md`](../ai-context/decisions.md), 2026-10-29.

## What is protected, and by what

| What | Primary protection | Portable copy |
|---|---|---|
| The database | Replit's point-in-time restore (7 days) and daily scheduled backups, both switched on by David in the Database tool | A `pg_dump` inside every pair |
| Stored media (photos, meme images, AI images) | The **backup bucket**: every state a pair needs, plus every state destroyed by a delete or an access change | — |
| Child-safety evidence (`restricted/`) | Its own preservation and retention ([`legal-safety-moderation.md`](../ai-context/legal-safety-moderation.md)) | **Never** copied to the backup |

Dev and production share **one** storage bucket, so everything here that writes
does so either into the backup bucket or under a `_restores/` prefix, and
**nothing deletes a live object**. The expiry job deletes only in the backup
bucket, and refuses to run on the live one.

## The recovery contract

Recovery supports **completed pairs** and promises nothing about the instants
between them.

- **A pair** is a window on the storage service's clock — opened by one
  marker object, closed by another written the moment the database snapshot
  is fixed, before the dump runs — a database point inside it (the
  database's own time for point-in-time restore, and a dump of exactly that
  snapshot), and, for every stored object, the state the database point can
  reference. Its
  `manifest.json` lists each object's backup copy and its metadata (the ACL
  policy included).
- **Completed or incomplete.** A pair is `completed` only when every state it
  needs is in the backup and its database point is known. Otherwise it is
  `incomplete`, with the reasons named, and the previous completed pair stays
  the recovery point. A dump that fails is recorded (`dumpError`); the pair
  still completes on the database time, restorable through point-in-time
  restore.
- **A change between the two marks makes the pair incomplete** (`changed
  while the database point was taken: <object>`). The two clocks cannot say
  whether the snapshot saw it, so the pair is not guessed; the next hour's
  pair retries. A change after the closing mark is simply not in the pair.
- **Preserve-before-change.** Every delete and every access (ACL) change of an
  existing object goes through `artifacts/api-server/src/lib/mediaBackup/preserve.ts`: the exact state
  it destroys is copied to the backup first, and the change is conditional on
  that same generation and metageneration. If the copy cannot be made, the
  change is refused with a retryable error ("try again shortly", HTTP 503);
  the photo is untouched. A CI test
  (`artifacts/api-server/src/__tests__/mediaPreservationCallSites.test.ts`) fails on any new
  storage delete or metadata write outside that path.
- **Write-once uploads.** A new object is written with
  `ifGenerationMatch: 0`, its ACL in the same write, so a retry can never
  replace a state the backup has not seen and a first upload never waits on
  the backup. The signed direct-upload URL, which could not carry that
  condition, is retired.
- **The data-loss bound** is measured from the latest completed pair, with
  failures since counted: `media-backup.ts status` prints both. The capture
  runs hourly, so in steady state the bound is about an hour plus a capture's
  duration; each incomplete pair since the last completed one widens it.
- **Expiry.** A preserved state no retained pair needs is erased once it is
  older than 7 days; pairs older than 7 days go too, except the latest
  completed pair of each environment, which is always kept.

### Configuration

- `MEDIA_BACKUP_BUCKET` — the backup bucket's name. Set once as a Replit
  Secret, so dev and the deployment both use it. It must not be the live
  bucket (refused).
- **A published deployment with no backup configured refuses** every photo
  delete and access change, and logs
  `[media-backup] not configured` at boot. Development, tests and CI with no
  backup proceed unpreserved (a lost photo is acceptable before launch).

### Backup bucket layout

```
states/<liveBucket>/<objectName>@g<generation>.m<metageneration>   bytes + backup:* metadata
tombstones/<liveBucket>/<objectName>@g<generation>                  a delete's time
pairs/<environment>/<pairId>/started | snapshot-<n> | ended | database.dump | manifest.json
```

Every object there is written once and never rewritten. A backup copy carries
no ACL of its own; the original ACL is in its `backup:sourceMetadata`.

## Routine

- **The deployment captures hourly** (`artifacts/api-server/src/jobs/mediaBackupJob.ts`): one
  instance at a time under a Postgres advisory lock, skipped while the latest
  completed pair is recent, and the expiry job at most once a day per
  instance. Logs: `[media-backup] pair completed` /
  `[media-backup] pair incomplete…` / `[media-backup] recovery point`.
- **Check it** (on the Repl):

  ```
  pnpm --filter @workspace/api-server exec tsx scripts/media-backup.ts status --environment production
  pnpm --filter @workspace/api-server exec tsx scripts/media-backup.ts list --environment production
  ```

- **An incomplete pair** names why. `unpreserved change: <object>` means
  something changed that object without preserving it first — find the
  writer; the call-site test should have stopped it. `copy failed` and
  `no database point` are usually transient; the next hour's pair retries.

## The isolated restore rehearsal

`scripts/restore-rehearsal.ts` restores one completed pair into targets the
live app never reads — a scratch database `restore_rehearsal_<id>` on
`DATABASE_URL`'s server, and the media under `_restores/rehearsal-<id>/` —
boots the real server over them with **no credential of any kind** (no Stripe,
no email key, the AI double with no recordings, no media backup; the launcher
refuses any other variable), and checks:

- a public object reads, with the bytes the pair recorded;
- a private object reads for its owner, and is refused to another user (403)
  and to no one (401);
- quarantined evidence is neither restored nor served.

It prints the recovery time (restore start to passing checks) and drops the
scratch database (`--keep` keeps it). Restored media stays under
`_restores/`; no tool deletes it.

**The paired capture with writes stopped** (the first rehearsal, plan §4):

1. Stop the Repl's app workflows (Replit connector), so nothing writes.
2. Run, on the Repl:

   ```
   pnpm --filter @workspace/api-server exec tsx scripts/restore-rehearsal.ts \
     --capture --writes-stopped --out /tmp/restore-rehearsal.json
   ```

3. Restart the workflows.
4. Record on #770: the pair id, the verdict, `times` (capture, database,
   media, boot, checks, recovery) and the data-loss bound.

**A recurring pair** (the mechanism the deployment runs): pick a completed
pair from `media-backup.ts list` and run
`restore-rehearsal.ts --pair <pairId> --environment <env>`. The recorded
recovery time and bound must include one such pair, not only the paused
capture.

## In an incident

1. **Stop the damage first** (stop the deployment if it is still destroying
   data).
2. **Choose the pair:** `media-backup.ts list --environment production`; the
   latest `completed` pair before the damage.
3. **The database:** Replit's Database tool, point-in-time restore to the
   pair's `database.at` (from its manifest). Restoring production's database
   is David's action. The pair's dump is the portable alternative.
4. **The media:** `media-backup.ts restore --pair <pairId> --environment
   production --target-bucket <bucket> --target-prefix _restores/<name>`
   restores it beside the live media, never over it, into
   `_restores/<name>/<pairId>/` (the command prints that folder). Each pair
   gets its own folder under the root, so restoring a second pair with the
   same command can never blend into the first; re-running the same pair
   resumes.
5. **Putting restored media back in place is not tooled yet.** The restore
   lands under `_restores/` by design; moving objects back to their live
   names (or repointing the app at the restored prefix) is a decision made at
   the time, with David, and a gap recorded on #770 for a follow-up.

## What the first real run proves

The storage double behaves as Cloud Storage documents its preconditions, and
increment 1 measured one of them on Replit's bucket: a second write with
`ifGenerationMatch: 0` was refused with 412 (#770, comment of 2026-10-27
18:02 UTC). The conditions on a metadata change and a delete
(`ifGenerationMatch` with `ifMetagenerationMatch`) and on a copy's
destination are first exercised on the real bucket by the recurring-recovery
exercise after merge, whose ACL change and delete go through them. If either
is refused for a reason other than a changed object, that is a stop, and the
contract goes back to David as an amendment (plan §4).

## Safety rules, all enforced in code

- The backup bucket is never the live bucket (`backupBucket()` refuses it).
- Restores never overwrite (`ifGenerationMatch: 0`) and never target the live
  bucket outside `_restores/`, or the backup bucket.
- The expiry job deletes only in the backup bucket, and only objects whose
  generation is unchanged since it listed them.
- Child-safety evidence, snapshots and rehearsal restores are never copied
  into the backup.

## Reading production's records from its backup

The workspace holds no connection to production's database, and the plan
keeps production untouched before its reset. So production's excluded-classes
inventory (plan §5 step 1, increment 8) is read from a production pair:

```
pnpm --filter @workspace/api-server exec tsx scripts/inventory-pair.ts --environment production --out /tmp/prod-inventory.json
```

It restores the latest completed production pair's dump into a scratch
database on the Repl's server, checks the dump's sha256 against the manifest,
runs the inventory there, then drops the scratch database and deletes the dump.
Live Stripe is read as usual. Only objects tagged `app: overhype`, or carrying
the `userId` the app has always written, count as this app's obligations.
Anything else in the shared account is listed as "not this app's" and does not
block.
