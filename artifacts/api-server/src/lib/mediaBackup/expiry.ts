/**
 * @purpose The backup's expiry job: removes, from the backup bucket only, preserved media states, tombstones and pairs that no retained pair needs and that are older than the 7-day window; the latest completed pair of each environment is always kept.
 * @subsystem storage
 *
 * Replit's App Storage has no lifecycle policy, so this job owns the window
 * (plan §4; David, 2026-10-28: deleted photos stay 7 days, matching
 * point-in-time restore). It deletes only in the backup bucket, which
 * `backupBucket()` refuses to equal the live one, and it re-checks that here
 * before deleting anything. Child-safety evidence is never in the backup, so
 * this job can never touch it.
 *
 * What is kept:
 *   - every pair whose window opened within the retention window, and the
 *     latest completed pair of each environment whatever its age;
 *   - every state such a pair's manifest names;
 *   - every state copied within the retention window (a pair being captured
 *     may need it; one copied earlier and named by no retained pair can be
 *     needed by no future pair, because a current state is re-copied from the
 *     live object whenever a pair needs it);
 *   - a tombstone while its generation still has a state, or while it is young.
 */
import { storageClient } from "../storageClient";
import { BACKUP_RETENTION_DAYS, liveBucket } from "./config";
import { PAIRS_PREFIX, type PairManifest } from "./capture";
import { COPY_CONCURRENCY, STATES_PREFIX, TOMBSTONES_PREFIX, errorCode, forEachLimit, parseBackupKey } from "./preserve";

export interface ExpiryResult {
  retentionDays: number;
  pairsKept: number;
  pairsRemoved: number;
  statesKept: number;
  statesRemoved: number;
  tombstonesRemoved: number;
  dryRun: boolean;
}

type Listed = { name: string; metadata?: { timeCreated?: string; generation?: string | number; metadata?: Record<string, string> } };

export async function runBackupExpiry(opts: { backupBucket: string; now?: Date; dryRun?: boolean }): Promise<ExpiryResult> {
  if (opts.backupBucket === liveBucket()) throw new Error("refusing to expire objects in the live bucket");
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const bucket = storageClient().bucket(opts.backupBucket);
  const born = (f: Listed) => Date.parse(String(f.metadata?.timeCreated ?? ""));

  // Pairs: group every object under pairs/<env>/<pairId>/.
  const [pairFiles] = (await bucket.getFiles({ prefix: PAIRS_PREFIX })) as unknown as [Listed[]];
  const pairs = new Map<string, { env: string; files: Listed[]; manifest?: Listed }>();
  for (const f of pairFiles) {
    const [, env, pairId] = f.name.split("/");
    if (!env || !pairId) continue;
    const id = `${env}/${pairId}`;
    const entry = pairs.get(id) ?? { env, files: [] };
    entry.files.push(f);
    if (f.name.endsWith("/manifest.json")) entry.manifest = f;
    pairs.set(id, entry);
  }
  const windowStart = (p: { files: Listed[]; manifest?: Listed }) =>
    Date.parse(p.manifest?.metadata?.metadata?.["backup:windowStart"] ?? "") || Math.min(...p.files.map(born));
  const latestCompleted = new Map<string, string>();
  for (const [id, p] of pairs) {
    if (p.manifest?.metadata?.metadata?.["backup:status"] !== "completed") continue;
    const best = latestCompleted.get(p.env);
    if (!best || windowStart(p) > windowStart(pairs.get(best)!)) latestCompleted.set(p.env, id);
  }
  const keepPair = (id: string, p: { env: string; files: Listed[]; manifest?: Listed }) =>
    latestCompleted.get(p.env) === id || windowStart(p) >= cutoff;

  const needed = new Set<string>();
  const pairsToRemove: Listed[][] = [];
  const keptManifests: Listed[] = [];
  let pairsKept = 0;
  for (const [id, p] of pairs) {
    if (!keepPair(id, p)) {
      pairsToRemove.push(p.files);
      continue;
    }
    pairsKept++;
    if (p.manifest) keptManifests.push(p.manifest); // none: a capture in progress, or one that died first
  }
  await forEachLimit(keptManifests, COPY_CONCURRENCY, async (m) => {
    const [bytes] = await bucket.file(m.name).download();
    for (const o of (JSON.parse(bytes.toString("utf8")) as PairManifest).objects) needed.add(o.backupKey);
  });

  const [stateFiles] = (await bucket.getFiles({ prefix: STATES_PREFIX })) as unknown as [Listed[]];
  const statesToRemove = stateFiles.filter((f) => !needed.has(f.name) && born(f) < cutoff);
  const removing = new Set(statesToRemove.map((f) => f.name));
  const remainingGenerations = new Set(
    stateFiles
      .filter((f) => !removing.has(f.name))
      .map((f) => parseBackupKey(f.name))
      .filter((k) => k !== null)
      .map((k) => `${k!.sourceBucket}/${k!.objectName}@g${k!.generation}`),
  );
  const [stoneFiles] = (await bucket.getFiles({ prefix: TOMBSTONES_PREFIX })) as unknown as [Listed[]];
  const stonesToRemove = stoneFiles.filter((f) => {
    const k = parseBackupKey(f.name);
    return k !== null && born(f) < cutoff && !remainingGenerations.has(`${k.sourceBucket}/${k.objectName}@g${k.generation}`);
  });

  if (!opts.dryRun) {
    // Conditional on the listed generation: an object rewritten since the
    // listing (none should be; everything here is write-once) is left alone.
    const remove = async (f: Listed) => {
      try {
        await bucket.file(f.name).delete({ ifGenerationMatch: String(f.metadata?.generation ?? "") });
      } catch (err) {
        if (errorCode(err) !== 404 && errorCode(err) !== 412) throw err;
      }
    };
    await forEachLimit([...pairsToRemove.flat(), ...statesToRemove, ...stonesToRemove], COPY_CONCURRENCY, remove);
  }

  return {
    retentionDays: BACKUP_RETENTION_DAYS,
    pairsKept,
    pairsRemoved: pairsToRemove.length,
    statesKept: stateFiles.length - statesToRemove.length,
    statesRemoved: statesToRemove.length,
    tombstonesRemoved: stonesToRemove.length,
    dryRun: Boolean(opts.dryRun),
  };
}
