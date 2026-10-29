/**
 * @purpose The paired capture: one database restore point and the media states it needs, recorded in a write-once manifest that is "completed" only when every needed state is in the backup; a failed or partial capture leaves the previous completed pair as the recovery point.
 * @subsystem storage
 *
 * Plan: docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §4. A pair is:
 *   - a window [start, end] on the storage service's clock, opened and closed
 *     by two marker objects written into the backup bucket;
 *   - a database point inside it: the database's own time, for the
 *     platform's point-in-time restore, and a pg_dump taken from a snapshot
 *     exported inside the window (portable, restorable anywhere). A dump that
 *     fails is recorded as `dumpError` and the pair still completes on the
 *     time alone; a pair with no database point at all is incomplete;
 *   - for every object name, the state the database point can reference: the
 *     state current at `start` (preserved before any later change by
 *     preserve.ts), or, for an object created inside the window, its first
 *     state. An object whose state at `start` was changed without being
 *     preserved makes the pair incomplete, by name.
 *
 * Backup layout (beside preserve.ts's states/ and tombstones/):
 *   pairs/<environment>/<pairId>/started   the window's opening marker
 *   pairs/<environment>/<pairId>/ended     the window's closing marker
 *   pairs/<environment>/<pairId>/database.dump
 *   pairs/<environment>/<pairId>/manifest.json   last; its custom metadata
 *       carries `backup:status` and `backup:windowStart`, so a listing finds
 *       the latest completed pair without reading every manifest.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import type { File } from "@google-cloud/storage";
import { storageClient } from "../storageClient";
import { DELETION_GRACE_MS } from "./config";
import {
  COPY_CONCURRENCY,
  STATES_PREFIX,
  TOMBSTONES_PREFIX,
  errorCode,
  forEachLimit,
  isExcludedFromBackup,
  objectState,
  parseBackupKey,
  preserveState,
  stateFromBackup,
  stateKey,
  type ObjectState,
} from "./preserve";

const execFileAsync = promisify(execFile);

export const PAIRS_PREFIX = "pairs/";

export interface ManifestObject {
  name: string;
  generation: string;
  metageneration: string;
  /** Where the state's copy is, in the backup bucket. */
  backupKey: string;
  contentType: string | null;
  size: number;
  md5Hash: string | null;
  /** The custom metadata to restore (the ACL policy included). */
  metadata: Record<string, string>;
}

export interface PairManifest {
  pairId: string;
  environment: string;
  sourceBucket: string;
  status: "completed" | "incomplete";
  /** Why an incomplete pair is incomplete; empty when completed. */
  reasons: string[];
  window: { start: string; end: string };
  database: {
    /** The database's own clock at the exported snapshot: the point-in-time restore target. */
    at: string | null;
    ledgerEntries: number | null;
    dump: { key: string; sha256: string; bytes: number } | null;
    dumpError?: string;
  };
  objects: ManifestObject[];
  counts: { objects: number; copied: number; alreadyPreserved: number; excluded: number };
  previousCompleted: { pairId: string; windowStart: string } | null;
  completedAt: string;
  durationMs: number;
}

export interface CaptureOptions {
  backupBucket: string;
  sourceBucket: string;
  /** "production" or "development": pairs of one environment's database never mix with another's. */
  environment: string;
  /** The database this pair's point is taken from. A pair without one is incomplete. */
  databaseUrl: string | undefined;
  /** Take the logical dump (default). Without it the pair's database side is the platform restore point alone. */
  dump?: boolean;
  /** Test seam: called between the two window markers, to make changes inside the window. */
  insideWindow?: () => Promise<void>;
  /** Defaults to DELETION_GRACE_MS. */
  deletionGraceMs?: number;
}

function pairPrefix(environment: string, pairId: string): string {
  return `${PAIRS_PREFIX}${environment}/${pairId}/`;
}

async function writeOnce(file: File, body: Buffer, contentType: string, metadata?: Record<string, string>): Promise<File> {
  await file.save(body, {
    contentType,
    resumable: false,
    ...(metadata ? { metadata: { metadata } } : {}),
    preconditionOpts: { ifGenerationMatch: 0 },
  });
  return file;
}

/** Write a marker and read back its creation time: a timestamp on the storage service's clock. */
async function marker(backup: string, key: string): Promise<string> {
  const file = storageClient().bucket(backup).file(key);
  await writeOnce(file, Buffer.alloc(0), "application/octet-stream");
  const [meta] = await file.getMetadata();
  return String((meta as { timeCreated?: string }).timeCreated);
}

const ms = (iso: string): number => Date.parse(iso);

export interface PairEntry {
  pairId: string;
  status: string | undefined;
  windowStart: string | undefined;
}

/** Every pair of an environment that wrote a manifest, from the listing's metadata alone (no manifest is read). */
export async function listPairs(backup: string, environment: string): Promise<PairEntry[]> {
  const [files] = await storageClient().bucket(backup).getFiles({ prefix: `${PAIRS_PREFIX}${environment}/` });
  return files
    .filter((f) => f.name.endsWith("/manifest.json"))
    .map((f) => {
      const m = ((f.metadata ?? {}) as { metadata?: Record<string, string> }).metadata ?? {};
      return { pairId: f.name.split("/").slice(-2, -1)[0], status: m["backup:status"], windowStart: m["backup:windowStart"] };
    });
}

function latestCompletedOf(pairs: PairEntry[]): { pairId: string; windowStart: string } | null {
  let best: { pairId: string; windowStart: string } | null = null;
  for (const p of pairs) {
    if (p.status !== "completed" || !p.windowStart) continue;
    if (!best || ms(p.windowStart) > ms(best.windowStart)) best = { pairId: p.pairId, windowStart: p.windowStart };
  }
  return best;
}

/** The latest completed pair's id and window start for an environment. */
export async function latestCompletedPair(backup: string, environment: string): Promise<{ pairId: string; windowStart: string } | null> {
  return latestCompletedOf(await listPairs(backup, environment));
}

/**
 * Choose, for one object name, the state a database point inside
 * [start, end] can reference. `states` holds every known state of the name:
 * its preserved copies and its current state, if it exists.
 *
 *   - A generation tombstoned more than DELETION_GRACE_MS before `start` was
 *     gone before the window: its states are not candidates.
 *   - The state current at `start` is the latest whose `updated` ≤ start.
 *   - If none, but a candidate was created at or before `start`, the state
 *     current then was changed without being preserved: "unpreserved".
 *   - Otherwise an object created inside the window contributes its first
 *     state; one created after `end` contributes nothing.
 */
export function pickState(
  states: ObjectState[],
  tombstonedAt: Map<string, string>,
  start: string,
  end: string,
  deletionGraceMs: number = DELETION_GRACE_MS,
): { pick: ObjectState } | { unpreserved: true } | null {
  const cutoff = ms(start) - deletionGraceMs;
  const live = states.filter((s) => {
    const deletedAt = tombstonedAt.get(s.generation);
    return deletedAt === undefined || ms(deletedAt) > cutoff;
  });
  const byUpdated = (a: ObjectState, b: ObjectState) => ms(a.updated) - ms(b.updated) || Number(a.metageneration) - Number(b.metageneration);
  const atStart = live.filter((s) => ms(s.updated) <= ms(start)).sort(byUpdated);
  if (atStart.length > 0) return { pick: atStart[atStart.length - 1] };
  if (live.some((s) => ms(s.timeCreated) <= ms(start))) return { unpreserved: true };
  const inWindow = live.filter((s) => ms(s.timeCreated) <= ms(end)).sort(byUpdated);
  return inWindow.length > 0 ? { pick: inWindow[0] } : null;
}

/**
 * The database point: the database's clock and its ledger size, read in one
 * transaction. With `dumpInto`, that transaction exports its snapshot and
 * pg_dump writes exactly that snapshot there, so the dump and the time agree.
 */
async function databasePoint(databaseUrl: string, dumpInto?: string): Promise<{ at: string; ledgerEntries: number | null }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query<{ snapshot: string | null; at: Date }>(
      `SELECT ${dumpInto ? "pg_export_snapshot()" : "NULL"} AS snapshot, now() AS at`,
    );
    const ledgerEntries = await client
      .query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")
      .then((r) => Number(r.rows[0].n))
      .catch(() => null);
    if (dumpInto) {
      // The exported snapshot lives while this transaction does.
      await execFileAsync("pg_dump", ["-Fc", "--no-owner", "--no-acl", `--snapshot=${rows[0].snapshot}`, "-f", dumpInto, databaseUrl], {
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    return { at: rows[0].at.toISOString(), ledgerEntries };
  } finally {
    await client.query("COMMIT").catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * Capture one pair. Never throws for a capture that merely failed: it writes
 * an "incomplete" manifest naming why, so a failure is counted, and returns
 * it. It throws only when it cannot write to the backup bucket at all.
 */
export async function capturePair(opts: CaptureOptions): Promise<PairManifest> {
  const t0 = Date.now();
  const client = storageClient();
  const backup = client.bucket(opts.backupBucket);
  const pairId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const prefix = pairPrefix(opts.environment, pairId);
  const reasons: string[] = [];
  const previousCompleted = await latestCompletedPair(opts.backupBucket, opts.environment);

  const start = await marker(opts.backupBucket, `${prefix}started`);

  // The database point, inside the window.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "media-pair-"));
  const database: PairManifest["database"] = { at: null, ledgerEntries: null, dump: null };
  let dumpFile: string | null = null;
  try {
    if (!opts.databaseUrl) {
      reasons.push("no database point: no database was given");
    } else {
      if (opts.dump !== false) {
        dumpFile = path.join(work, "database.dump");
        try {
          Object.assign(database, await databasePoint(opts.databaseUrl, dumpFile));
        } catch (err) {
          // The dump is the portable copy; the platform's point-in-time restore
          // to the database's own time is the primary one, so a pair without a
          // dump still completes when that time is known. It is recorded.
          database.dumpError = String((err as Error).message ?? err).slice(0, 500);
          dumpFile = null;
        }
      }
      if (!database.at) {
        try {
          Object.assign(database, await databasePoint(opts.databaseUrl));
        } catch (err) {
          reasons.push(
            `no database point: ${database.dumpError ? `the dump failed (${database.dumpError}) and ` : ""}the database could not be read (${(err as Error).message})`,
          );
        }
      }
    }
    if (opts.insideWindow) await opts.insideWindow();
    const end = await marker(opts.backupBucket, `${prefix}ended`);

    if (dumpFile) {
      const bytes = fs.readFileSync(dumpFile);
      const key = `${prefix}database.dump`;
      try {
        await writeOnce(backup.file(key), bytes, "application/octet-stream");
        database.dump = { key, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
      } catch (err) {
        reasons.push(`database dump not stored: ${(err as Error).message}`);
      }
    }

    // Every known state, by name: current objects, preserved copies, tombstones.
    const states = new Map<string, ObjectState[]>();
    const add = (s: ObjectState) => {
      const list = states.get(s.name) ?? [];
      if (!list.some((x) => x.generation === s.generation && x.metageneration === s.metageneration)) list.push(s);
      states.set(s.name, list);
    };
    let excluded = 0;
    const [live] = await client.bucket(opts.sourceBucket).getFiles();
    for (const f of live) {
      if (isExcludedFromBackup(f.name)) {
        excluded++;
        continue;
      }
      add(objectState(f.name, (f.metadata ?? {}) as Parameters<typeof objectState>[1]));
    }
    const preserved = new Set<string>();
    const [copies] = await backup.getFiles({ prefix: `${STATES_PREFIX}${opts.sourceBucket}/` });
    for (const f of copies) {
      const s = stateFromBackup((f.metadata ?? {}) as Parameters<typeof stateFromBackup>[0]);
      if (!s) continue;
      preserved.add(f.name);
      add(s);
    }
    const tombstones = new Map<string, Map<string, string>>();
    const [stones] = await backup.getFiles({ prefix: `${TOMBSTONES_PREFIX}${opts.sourceBucket}/` });
    for (const f of stones) {
      const parsed = parseBackupKey(f.name);
      const at = ((f.metadata ?? {}) as { timeCreated?: string }).timeCreated;
      if (!parsed || !at) continue;
      const byGen = tombstones.get(parsed.objectName) ?? new Map<string, string>();
      byGen.set(parsed.generation, at);
      tombstones.set(parsed.objectName, byGen);
    }

    const picks: ObjectState[] = [];
    for (const [name, list] of [...states.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const choice = pickState(list, tombstones.get(name) ?? new Map(), start, end, opts.deletionGraceMs);
      if (!choice) continue;
      if ("unpreserved" in choice) reasons.push(`unpreserved change: ${name}`);
      else picks.push(choice.pick);
    }

    // Copy what the backup lacks, a few at a time; a first capture copies every object.
    const keyOf = (s: ObjectState) => stateKey(opts.sourceBucket, s.name, s.generation, s.metageneration);
    let copied = 0;
    const missing = new Set<string>();
    await forEachLimit(
      picks.filter((s) => !preserved.has(keyOf(s))),
      COPY_CONCURRENCY,
      async (s) => {
        try {
          const outcome = await preserveState(opts.backupBucket, opts.sourceBucket, s);
          if (outcome === "copied") copied++;
          // Gone since the listing: present only if the change that replaced it preserved it.
          else if (outcome === "gone" && !(await backup.file(keyOf(s)).exists())[0]) {
            reasons.push(`state vanished before it was copied: ${s.name}`);
            missing.add(s.name);
          }
        } catch (err) {
          reasons.push(`copy failed for ${s.name}: ${(err as Error).message}`);
          missing.add(s.name);
        }
      },
    );
    const objects: ManifestObject[] = picks
      .filter((s) => !missing.has(s.name))
      .map((s) => ({
        name: s.name,
        generation: s.generation,
        metageneration: s.metageneration,
        backupKey: keyOf(s),
        contentType: s.contentType,
        size: s.size,
        md5Hash: s.md5Hash,
        metadata: s.metadata,
      }));

    const manifest: PairManifest = {
      pairId,
      environment: opts.environment,
      sourceBucket: opts.sourceBucket,
      status: reasons.length === 0 ? "completed" : "incomplete",
      reasons,
      window: { start, end },
      database,
      objects,
      counts: { objects: objects.length, copied, alreadyPreserved: objects.length - copied, excluded },
      previousCompleted,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
    // Compact: the expiry job reads every retained manifest.
    await writeOnce(backup.file(`${prefix}manifest.json`), Buffer.from(JSON.stringify(manifest)), "application/json", {
      "backup:status": manifest.status,
      "backup:windowStart": start,
    });
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Read a pair's manifest. */
export async function readManifest(backupBucket: string, environment: string, pairId: string): Promise<PairManifest> {
  const file = storageClient().bucket(backupBucket).file(`${pairPrefix(environment, pairId)}manifest.json`);
  try {
    const [bytes] = await file.download();
    return JSON.parse(bytes.toString("utf8")) as PairManifest;
  } catch (err) {
    if (errorCode(err) === 404) throw new Error(`no manifest for pair ${environment}/${pairId}`);
    throw err;
  }
}

export interface BackupStatus {
  environment: string;
  latestCompleted: { pairId: string; windowStart: string } | null;
  /** How far back a restore would reach now: the age of the latest completed pair's window. */
  dataLossBoundMs: number | null;
  /** Pairs attempted since the latest completed one that did not complete. */
  failuresSince: number;
}

/** The recovery point and the data-loss bound, measured from the latest completed pair, failures counted. */
export async function backupStatus(backup: string, environment: string, now: Date = new Date()): Promise<BackupStatus> {
  const pairs = await listPairs(backup, environment);
  const latest = latestCompletedOf(pairs);
  const since = latest ? ms(latest.windowStart) : -Infinity;
  return {
    environment,
    latestCompleted: latest,
    dataLossBoundMs: latest ? now.getTime() - ms(latest.windowStart) : null,
    failuresSince: pairs.filter((p) => p.status !== "completed" && ms(p.windowStart ?? "") > since).length,
  };
}
