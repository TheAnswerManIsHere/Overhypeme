/**
 * The media backup, by hand (Launch Phase 3, increment 5; runbook:
 * docs/engineering/media-backup-and-restore.md). The deployed app runs the
 * same capture and expiry hourly (src/jobs/mediaBackupJob.ts); this is for
 * the rehearsal, an incident and a check.
 *
 *   status  [--environment production]
 *       the latest completed pair, the data-loss bound and failures since
 *   capture [--environment development] [--no-dump]
 *       one pair now, with DATABASE_URL's dump unless --no-dump
 *   list    [--environment production]
 *       every pair's id, status and window
 *   expire  [--dry-run]
 *       the expiry job (deletes only in the backup bucket)
 *   restore --pair <pairId> [--environment production] --target-bucket <b> --target-prefix _restores/<name>
 *       the pair's media into an isolated target; never overwrites, never deletes
 *
 * Reads MEDIA_BACKUP_BUCKET and PRIVATE_OBJECT_DIR. Run on the Repl:
 *   pnpm --filter @workspace/api-server exec tsx scripts/media-backup.ts <command> [options]
 */
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

const { backupBucket, liveBucket } = await import("../src/lib/mediaBackup/config.js");
const { backupStatus, capturePair, listPairs, readManifest } = await import("../src/lib/mediaBackup/capture.js");
const { runBackupExpiry } = await import("../src/lib/mediaBackup/expiry.js");
const { restorePairMedia } = await import("../src/lib/mediaBackup/restore.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const command = process.argv[2];
const backup = backupBucket();
if (!backup) {
  console.error("MEDIA_BACKUP_BUCKET is not set");
  process.exit(2);
}
const environment = arg("environment") ?? (process.env.REPLIT_DEPLOYMENT === "1" ? "production" : "development");

switch (command) {
  case "status": {
    const s = await backupStatus(backup, environment);
    print({ ...s, dataLossBoundMinutes: s.dataLossBoundMs === null ? null : Math.round(s.dataLossBoundMs / 60_000) });
    break;
  }
  case "capture": {
    const source = liveBucket();
    if (!source) {
      console.error("PRIVATE_OBJECT_DIR is not set");
      process.exit(2);
    }
    const m = await capturePair({ backupBucket: backup, sourceBucket: source, environment, databaseUrl: process.env.DATABASE_URL, dump: !flag("no-dump") });
    print({ ...m, objects: m.objects.length });
    if (m.status !== "completed") process.exit(1);
    break;
  }
  case "list":
    print(await listPairs(backup, environment));
    break;
  case "expire":
    print(await runBackupExpiry({ backupBucket: backup, dryRun: flag("dry-run") }));
    break;
  case "restore": {
    const pairId = arg("pair");
    const bucket = arg("target-bucket");
    const prefix = arg("target-prefix");
    if (!pairId || !bucket || !prefix) {
      console.error("restore needs --pair, --target-bucket and --target-prefix");
      process.exit(2);
    }
    print(await restorePairMedia(backup, await readManifest(backup, environment, pairId), { bucket, prefix }));
    break;
  }
  default:
    console.error("usage: media-backup.ts status|capture|list|expire|restore [options] (see the file's header)");
    process.exit(2);
}
process.exit(0);
