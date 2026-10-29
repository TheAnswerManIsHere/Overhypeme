/**
 * The scheduled media-backup capture (Launch Phase 3, increment 5; plan §4):
 * hourly, in the published deployment only, one pair of the database point
 * and the media states it needs, then — at most once a day per instance — the
 * expiry job. Scheduled from `src/index.ts`.
 *
 * Autoscale runs several instances on one database, so a session-level
 * advisory lock lets exactly one of them capture at a time, and a capture is
 * skipped while the latest completed pair is younger than the interval, so a
 * freshly started instance does not take a redundant one. An instance scaled
 * to zero takes no pair, and while it is down nothing is uploaded either.
 *
 * Failures are logged, never thrown: a failed capture leaves an "incomplete"
 * manifest and the previous completed pair as the recovery point.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { backupStatus, capturePair, latestCompletedPair } from "../lib/mediaBackup/capture";
import { liveBucket, preservation } from "../lib/mediaBackup/config";
import { runBackupExpiry } from "../lib/mediaBackup/expiry";

const CAPTURE_INTERVAL_MS = 60 * 60 * 1000;
const EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Distinct from the migration runner's key (7654321). */
const ADVISORY_LOCK_KEY = 7654322;

let lastExpiryAt = 0;

export async function runScheduledMediaBackup(environment = "production"): Promise<string> {
  const p = preservation();
  if (p.mode !== "enforced") return "skipped: the media backup is not configured";
  const source = liveBucket();
  if (!source) return "skipped: PRIVATE_OBJECT_DIR is not set";

  const lockClient = await pool.connect();
  try {
    const got = (await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK_KEY])).rows[0]?.ok;
    if (!got) return "skipped: another instance is capturing";
    try {
      const latest = await latestCompletedPair(p.bucket, environment);
      if (latest && Date.now() - Date.parse(latest.windowStart) < CAPTURE_INTERVAL_MS - 5 * 60 * 1000) {
        return `skipped: pair ${latest.pairId} is recent`;
      }
      const manifest = await capturePair({
        backupBucket: p.bucket,
        sourceBucket: source,
        environment,
        databaseUrl: process.env.DATABASE_URL,
      });
      const log = {
        pairId: manifest.pairId,
        status: manifest.status,
        objects: manifest.counts.objects,
        copied: manifest.counts.copied,
        dump: manifest.database.dump ? manifest.database.dump.bytes : null,
        dumpError: manifest.database.dumpError,
        durationMs: manifest.durationMs,
        reasons: manifest.reasons.slice(0, 10),
      };
      if (manifest.status === "completed") logger.info(log, "[media-backup] pair completed");
      else logger.error(log, "[media-backup] pair incomplete; the previous completed pair stays the recovery point");

      if (Date.now() - lastExpiryAt > EXPIRY_INTERVAL_MS) {
        lastExpiryAt = Date.now();
        logger.info(await runBackupExpiry({ backupBucket: p.bucket }), "[media-backup] expiry run");
      }
      const status = await backupStatus(p.bucket, environment);
      logger.info(status, "[media-backup] recovery point");
      return manifest.status;
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}
