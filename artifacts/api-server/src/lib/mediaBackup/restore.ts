/**
 * @purpose Restore a completed pair's media into an isolated target — another bucket, or a `_restores/` prefix of the live one — with each object's bytes and its recorded metadata (the ACL policy included); it never overwrites and never deletes, so it cannot touch the live media.
 * @subsystem storage
 *
 * Dev and production share one bucket (#770, increment 1), so a restore must
 * never land where the app serves from: the target is a different bucket, or
 * a prefix under `_restores/` that no live object name starts with, and every
 * write is `ifGenerationMatch: 0`.
 */
import { storageClient } from "../storageClient";
import { backupBucket, liveBucket } from "./config";
import type { PairManifest } from "./capture";
import { COPY_CONCURRENCY, errorCode, forEachLimit } from "./preserve";

export interface RestoreTarget {
  bucket: string;
  /** Object-name prefix the pair's names are restored under; required, and `_restores/...` in the live bucket. */
  prefix: string;
}

export function restoreTargetRefusal(target: RestoreTarget, env: NodeJS.ProcessEnv = process.env): string | null {
  const prefix = target.prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!target.bucket) return "a target bucket is required";
  if (!prefix || prefix.split("/").some((s) => s === "" || s === "." || s === "..")) return "a target prefix is required, with no empty, '.' or '..' segment";
  if (target.bucket === backupBucket(env)) return "the target must not be the backup bucket";
  if (target.bucket === liveBucket(env) && !prefix.startsWith("_restores/")) {
    return "in the live bucket the target prefix must start with _restores/, so a restored object can never take a live object's name";
  }
  return null;
}

export interface RestoreResult {
  pairId: string;
  target: string;
  restored: number;
  alreadyPresent: number;
  ms: number;
}

/**
 * Copy every object the manifest names from the backup to
 * `<target.prefix>/<original name>`, with its recorded content type and custom
 * metadata. Re-running finds its earlier work present and carries on.
 */
export async function restorePairMedia(backup: string, manifest: PairManifest, target: RestoreTarget): Promise<RestoreResult> {
  const refusal = restoreTargetRefusal(target);
  if (refusal) throw new Error(`restore refused: ${refusal}`);
  if (manifest.status !== "completed") throw new Error(`restore refused: pair ${manifest.pairId} is ${manifest.status}`);
  const t0 = Date.now();
  const prefix = target.prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const client = storageClient();
  let restored = 0;
  let alreadyPresent = 0;
  await forEachLimit(manifest.objects, COPY_CONCURRENCY, async (o) => {
    const destination = client.bucket(target.bucket).file(`${prefix}/${o.name}`);
    try {
      await client.bucket(backup).file(o.backupKey).copy(destination, {
        ...(o.contentType ? { contentType: o.contentType } : {}),
        metadata: o.metadata,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      restored++;
    } catch (err) {
      if (errorCode(err) !== 412) throw new Error(`restore of ${o.name} failed: ${(err as Error).message}`);
      alreadyPresent++;
    }
  });
  return { pairId: manifest.pairId, target: `/${target.bucket}/${prefix}`, restored, alreadyPresent, ms: Date.now() - t0 };
}
