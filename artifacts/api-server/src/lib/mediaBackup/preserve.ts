/**
 * @purpose Preserve-before-change for stored media (Launch Phase 3, increment 5): every delete and every metadata (ACL) change of an existing object first copies the exact state it is about to destroy into the backup bucket, then makes the change conditional on that same generation and metageneration; a change that cannot be preserved is refused with a retryable error.
 * @subsystem storage
 *
 * Plan: docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §4, "The recurring recovery
 * contract". The backup is a separate bucket the application never serves.
 *
 * Backup layout, all written once (`ifGenerationMatch: 0`) and never rewritten:
 *   states/<sourceBucket>/<objectName>@g<generation>.m<metageneration>
 *       the object's bytes at that generation, with the metadata it had at that
 *       metageneration recorded under `backup:*` keys (see `stateMetadata`);
 *       its own custom metadata carries no ACL, so no route could serve it;
 *   tombstones/<sourceBucket>/<objectName>@g<generation>
 *       written after a delete; its creation time is the deletion's time on the
 *       storage clock, which is the clock every comparison here uses.
 *
 * Child-safety evidence (`restricted/`) and the snapshot and rehearsal areas
 * (`_snapshots/`, `_restores/`) are never copied: evidence keeps its own
 * preservation and retention (`legal-safety-moderation.md`), and the other two
 * are themselves copies.
 */
import type { File } from "@google-cloud/storage";
import { logger } from "../logger";
import { storageClient } from "../storageClient";
import { livePrivatePrefix, preservation } from "./config";

/** The change could not be preserved first, so it was not made. Retryable: "try again shortly". */
export class MediaBackupUnavailableError extends Error {
  readonly retryable = true;
  constructor(reason: string) {
    super(`media backup unavailable: ${reason}`);
    this.name = "MediaBackupUnavailableError";
    Object.setPrototypeOf(this, MediaBackupUnavailableError.prototype);
  }
}

/** The object kept changing under the conditional change; nothing was changed. Retryable. */
export class MediaChangeConflictError extends Error {
  readonly retryable = true;
  constructor(objectName: string) {
    super(`media changed concurrently, nothing was changed: ${objectName}`);
    this.name = "MediaChangeConflictError";
    Object.setPrototypeOf(this, MediaChangeConflictError.prototype);
  }
}

export function isRetryableMediaError(err: unknown): boolean {
  return err instanceof MediaBackupUnavailableError || err instanceof MediaChangeConflictError;
}

/**
 * Objects the backup never copies: child-safety evidence and frozen snapshots
 * (`<private dir>/restricted/…`, `<private dir>/_snapshots/…`), and rehearsal
 * restores (`_restores/…` at the bucket's top). Anchored to those places, so a
 * segment of the same name elsewhere in a key opts nothing out.
 */
export function isExcludedFromBackup(objectName: string, privatePrefix: string = livePrivatePrefix()): boolean {
  if (objectName.startsWith("_restores/")) return true;
  const dir = privatePrefix ? `${privatePrefix}/` : "";
  return objectName.startsWith(`${dir}restricted/`) || objectName.startsWith(`${dir}_snapshots/`);
}

/** How many storage copies or deletes run at once in a capture, a restore or an expiry run. */
export const COPY_CONCURRENCY = 8;

/** Run `fn` over `items`, at most `limit` at a time. */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export const STATES_PREFIX = "states/";
export const TOMBSTONES_PREFIX = "tombstones/";

export function stateKey(sourceBucket: string, objectName: string, generation: string, metageneration: string): string {
  return `${STATES_PREFIX}${sourceBucket}/${objectName}@g${generation}.m${metageneration}`;
}

export function tombstoneKey(sourceBucket: string, objectName: string, generation: string): string {
  return `${TOMBSTONES_PREFIX}${sourceBucket}/${objectName}@g${generation}`;
}

/** The parts of a `states/` or `tombstones/` key, or null for anything else. */
export function parseBackupKey(key: string): { kind: "state" | "tombstone"; sourceBucket: string; objectName: string; generation: string; metageneration?: string } | null {
  const kind = key.startsWith(STATES_PREFIX) ? "state" : key.startsWith(TOMBSTONES_PREFIX) ? "tombstone" : null;
  if (!kind) return null;
  const rest = key.slice(kind === "state" ? STATES_PREFIX.length : TOMBSTONES_PREFIX.length);
  const slash = rest.indexOf("/");
  const at = rest.lastIndexOf("@g");
  if (slash <= 0 || at <= slash) return null;
  const version = rest.slice(at + 2);
  const m = kind === "state" ? /^(\d+)\.m(\d+)$/.exec(version) : /^(\d+)$/.exec(version);
  if (!m) return null;
  return { kind, sourceBucket: rest.slice(0, slash), objectName: rest.slice(slash + 1, at), generation: m[1], ...(kind === "state" ? { metageneration: m[2] } : {}) };
}

/** The state of an object as read from the storage service: what identifies it and what restoring it needs. */
export interface ObjectState {
  name: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  contentType: string | null;
  size: number;
  md5Hash: string | null;
  /** Custom metadata, the ACL policy included. */
  metadata: Record<string, string>;
}

type RawMetadata = {
  generation?: string | number;
  metageneration?: string | number;
  timeCreated?: string;
  updated?: string;
  contentType?: string;
  size?: string | number;
  md5Hash?: string;
  metadata?: Record<string, unknown> | null;
};

export function objectState(name: string, raw: RawMetadata): ObjectState {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.metadata ?? {})) if (v !== null && v !== undefined) metadata[k] = String(v);
  return {
    name,
    generation: String(raw.generation ?? ""),
    metageneration: String(raw.metageneration ?? ""),
    timeCreated: String(raw.timeCreated ?? ""),
    updated: String(raw.updated ?? raw.timeCreated ?? ""),
    contentType: raw.contentType ?? null,
    size: Number(raw.size ?? 0),
    md5Hash: raw.md5Hash ?? null,
    metadata,
  };
}

/** The backup copy's own custom metadata: the source state's identity and its metadata, never an ACL key of its own. */
export function stateMetadata(sourceBucket: string, s: ObjectState): Record<string, string> {
  return {
    "backup:sourceBucket": sourceBucket,
    "backup:sourceName": s.name,
    "backup:sourceGeneration": s.generation,
    "backup:sourceMetageneration": s.metageneration,
    "backup:sourceTimeCreated": s.timeCreated,
    "backup:sourceUpdated": s.updated,
    "backup:sourceMetadata": JSON.stringify(s.metadata),
  };
}

/** The source state a backup copy records, from its `backup:*` metadata. */
export function stateFromBackup(raw: RawMetadata): ObjectState | null {
  const m = (raw.metadata ?? {}) as Record<string, string>;
  if (!m["backup:sourceName"]) return null;
  let metadata: Record<string, string> = {};
  try {
    metadata = JSON.parse(m["backup:sourceMetadata"] ?? "{}") as Record<string, string>;
  } catch {
    return null;
  }
  return {
    name: m["backup:sourceName"],
    generation: m["backup:sourceGeneration"],
    metageneration: m["backup:sourceMetageneration"],
    timeCreated: m["backup:sourceTimeCreated"],
    updated: m["backup:sourceUpdated"],
    contentType: raw.contentType ?? null,
    size: Number(raw.size ?? 0),
    md5Hash: raw.md5Hash ?? null,
    metadata,
  };
}

export function errorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : typeof code === "string" && /^\d+$/.test(code) ? Number(code) : undefined;
}

/**
 * Copy one identified state into the backup. The bytes are the pinned
 * generation's (immutable); the metadata is the one passed in, read at the
 * recorded metageneration. A copy that already exists is the same state, so a
 * 412 is success. Returns "copied" or "present"; a source generation that no
 * longer exists is "gone".
 */
export async function preserveState(
  backup: string,
  sourceBucket: string,
  s: ObjectState,
): Promise<"copied" | "present" | "gone"> {
  const client = storageClient();
  const source = client.bucket(sourceBucket).file(s.name, { generation: s.generation });
  const destination = client.bucket(backup).file(stateKey(sourceBucket, s.name, s.generation, s.metageneration));
  try {
    await source.copy(destination, {
      ...(s.contentType ? { contentType: s.contentType } : {}),
      metadata: stateMetadata(sourceBucket, s),
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return "copied";
  } catch (err) {
    const code = errorCode(err);
    if (code === 412) return "present";
    if (code === 404) return "gone";
    throw err;
  }
}

/**
 * Change an existing object, preserving the state the change destroys first.
 *
 * Reads the object's state, copies that state to the backup, then applies
 * `mutate` conditional on the same generation and metageneration. If the
 * object changed in between, the precondition fails and the whole cycle runs
 * again with the new state; after three tries it is a conflict. Nothing is
 * changed unless its prior state is in the backup — except where the backup is
 * off (development and tests with none configured) or the object is excluded
 * from it (child-safety evidence, snapshots), where the change is still made
 * conditionally.
 *
 * Returns "absent" if there was no object to change.
 */
export async function changeObject(
  bucketName: string,
  objectName: string,
  mutate: (file: File, current: ObjectState) => Promise<void>,
): Promise<"changed" | "absent"> {
  const file = storageClient().bucket(bucketName).file(objectName);
  const p = preservation();
  for (let attempt = 0; attempt < 3; attempt++) {
    let current: ObjectState;
    try {
      const [raw] = await file.getMetadata();
      current = objectState(objectName, raw as RawMetadata);
    } catch (err) {
      if (errorCode(err) === 404) return "absent";
      throw err;
    }
    if (!isExcludedFromBackup(objectName)) {
      if (p.mode === "unavailable") throw new MediaBackupUnavailableError(p.reason);
      if (p.mode === "enforced") {
        let outcome: Awaited<ReturnType<typeof preserveState>>;
        try {
          outcome = await preserveState(p.bucket, bucketName, current);
        } catch (err) {
          logger.error({ err, objectName }, "[media-backup] preservation failed; the change is refused");
          throw new MediaBackupUnavailableError("the prior state could not be copied");
        }
        if (outcome === "gone") continue; // replaced or deleted since the read: start over
      }
    }
    try {
      await mutate(file, current);
      return "changed";
    } catch (err) {
      if (errorCode(err) === 412) continue;
      if (errorCode(err) === 404) return "absent";
      throw err;
    }
  }
  throw new MediaChangeConflictError(objectName);
}

/** Delete an object, its state preserved first; records a tombstone so later pairs and the expiry job know when. */
export async function deletePreserved(bucketName: string, objectName: string): Promise<"changed" | "absent"> {
  let deleted: ObjectState | null = null;
  const result = await changeObject(bucketName, objectName, async (file, current) => {
    await file.delete({ ifGenerationMatch: current.generation, ifMetagenerationMatch: current.metageneration });
    deleted = current;
  });
  const p = preservation();
  if (deleted && p.mode === "enforced" && !isExcludedFromBackup(objectName)) {
    const gen = (deleted as ObjectState).generation;
    try {
      await storageClient()
        .bucket(p.bucket)
        .file(tombstoneKey(bucketName, objectName, gen))
        .save(Buffer.alloc(0), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (err) {
      // Safe to lose: with no tombstone, later pairs keep including the
      // preserved state and the expiry job keeps it. Only space is spent.
      if (errorCode(err) !== 412) logger.warn({ err, objectName }, "[media-backup] tombstone not written; the deleted state is kept");
    }
  }
  return result;
}

/** Replace an object's custom metadata entries, its prior state preserved first. */
export async function setMetadataPreserved(
  bucketName: string,
  objectName: string,
  entries: Record<string, string>,
): Promise<"changed" | "absent"> {
  return changeObject(bucketName, objectName, async (file, current) => {
    // Both: a replacement at the same name restarts at metageneration 1, so the
    // metageneration alone could match a state that was never preserved.
    await file.setMetadata({ metadata: entries }, { ifGenerationMatch: current.generation, ifMetagenerationMatch: current.metageneration });
  });
}
