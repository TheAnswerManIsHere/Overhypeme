/**
 * @purpose Where the media backup lives and whether preservation is in force: the MEDIA_BACKUP_BUCKET setting, the live bucket it must differ from, the 7-day retention, and the rule for an unconfigured backup (a production boot refuses changes it cannot preserve).
 * @subsystem storage
 */
import { isProductionEnv } from "../env";

/** Deleted and replaced photo states stay in the backup this long (David, 2026-10-28: matching point-in-time restore). */
export const BACKUP_RETENTION_DAYS = 7;

/**
 * A deletion is treated as not yet happened for this long before a pair's
 * window opens, so a row the database still holds at the window can find its
 * bytes; including an object a pair did not need costs nothing.
 */
export const DELETION_GRACE_MS = 5 * 60 * 1000;

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/** The bucket the app serves from: the first segment of PRIVATE_OBJECT_DIR. */
export function liveBucket(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = (env.PRIVATE_OBJECT_DIR ?? "").replace(/^\/+/, "");
  return dir.split("/")[0] || null;
}

/** The private directory's object-name prefix inside the live bucket (no leading or trailing slash). */
export function livePrivatePrefix(env: NodeJS.ProcessEnv = process.env): string {
  const dir = (env.PRIVATE_OBJECT_DIR ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  const bucket = dir.split("/")[0] ?? "";
  return dir.slice(bucket.length + 1);
}

/**
 * The backup bucket named by MEDIA_BACKUP_BUCKET, or null when unset. A
 * malformed name, or the live bucket itself, is refused: a backup in the bucket
 * it protects protects nothing, and the expiry job would be deleting there.
 */
export function backupBucket(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.MEDIA_BACKUP_BUCKET ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!raw) return null;
  if (!BUCKET_NAME.test(raw)) throw new Error(`MEDIA_BACKUP_BUCKET is not a bucket name: ${JSON.stringify(raw)}`);
  if (raw === liveBucket(env)) throw new Error("MEDIA_BACKUP_BUCKET names the live bucket; the backup must be a separate bucket");
  return raw;
}

export type Preservation =
  | { mode: "enforced"; bucket: string }
  /** A production boot with no backup configured: every change that would destroy a state is refused. */
  | { mode: "unavailable"; reason: string }
  /** Development, tests and CI with no backup configured: changes proceed unpreserved (a lost photo is acceptable before launch). */
  | { mode: "off" };

export function preservation(env: NodeJS.ProcessEnv = process.env): Preservation {
  const bucket = backupBucket(env);
  if (bucket) return { mode: "enforced", bucket };
  if (isProductionEnv(env)) return { mode: "unavailable", reason: "the media backup is not configured (MEDIA_BACKUP_BUCKET)" };
  return { mode: "off" };
}
