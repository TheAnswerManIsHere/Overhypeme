/**
 * @purpose The durable list of stored files still to delete: queued in the transaction that leaves a file unreferenced, removed after the commit, retried hourly until gone.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_RENDER_HISTORY.md D6 and D7 (Issue #1304; Astra C4).
 * A database delete that leaves a picture file unreferenced writes the file's
 * path here in its own transaction, so the row and the obligation to remove
 * the file commit or roll back together. The caller then runs the cleanup for
 * the paths it queued, at once; the hourly sweep retries anything left. An
 * object already missing counts as removed (`deleteObject` treats it so).
 * Each path keeps its reason, attempts and last error until done, and the
 * outstanding count shows on Queue Health: nothing is abandoned silently.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, storedFileDeletionsTable, imagePromptAttemptsTable, imageProvenanceTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";
import type { Executor } from "./visualConceptOwner";

/** Why a file is to go. */
export type StoredFileDeletionReason = "rejected_submission_purge" | "render_delete";

/** What removes one stored object: `ObjectStorageService.deleteObject`, or a test fake. */
export interface FileRemover {
  deleteObject(objectPath: string): Promise<void>;
}

/** How many rows one sweep takes on, oldest first. */
const SWEEP_BATCH = 200;

/**
 * Every stored file a set of renders (image_prompt_attempts rows) owns: each
 * render's own picture, and every path its provenance records name for it,
 * which includes a picture uploaded but never linked because its worker
 * stopped (D7, interruption). Read inside the deleting transaction, after it
 * holds the fact lock the render worker takes before it records and stores a
 * picture, so a picture committed by a worker is always seen here.
 */
export async function renderFilePaths(tx: Executor, attemptIds: number[]): Promise<string[]> {
  if (attemptIds.length === 0) return [];
  const [own, recorded] = await Promise.all([
    tx.select({ path: imagePromptAttemptsTable.generatedImageObjectPath })
      .from(imagePromptAttemptsTable)
      .where(inArray(imagePromptAttemptsTable.id, attemptIds)),
    tx.select({ path: imageProvenanceTable.objectPath })
      .from(imageProvenanceTable)
      .where(and(inArray(imageProvenanceTable.attemptId, attemptIds), sql`${imageProvenanceTable.kind} = 'ai_render'`)),
  ]);
  const paths = new Set<string>();
  for (const r of [...own, ...recorded]) if (r.path) paths.add(r.path);
  return [...paths].sort();
}

/**
 * Queue paths for deletion inside the caller's transaction. A path already
 * waiting is left as it is (one open row per path). Returns the paths queued
 * or already waiting, for the caller to clean up once it has committed.
 */
export async function queueStoredFileDeletions(
  tx: Executor,
  paths: string[],
  reason: StoredFileDeletionReason,
): Promise<string[]> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return [];
  await tx.insert(storedFileDeletionsTable)
    .values(unique.map((path) => ({ path, reason })))
    .onConflictDoNothing({ target: storedFileDeletionsTable.path, where: sql`done_at IS NULL` });
  return unique;
}

export interface CleanupResult {
  /** Files removed now (or already missing). */
  deleted: number;
  /** Files whose removal failed this time; still outstanding. */
  failed: number;
}

let removerOverride: FileRemover | null = null;
/** Test seam: remove files through a fake instead of the store. */
export function __setFileRemoverForTest(remover: FileRemover | null): void {
  removerOverride = remover;
}

function remover(): FileRemover {
  return removerOverride ?? new ObjectStorageService();
}

/** How long a claimed row is left to the run that claimed it before another run may take it. */
const CLAIM_LEASE = "10 minutes";
/** Files removed at once. */
const REMOVE_CONCURRENCY = 8;

/**
 * Remove outstanding files: the paths named, or (with none named) a batch of
 * the outstanding ones, never-tried first. The batch is claimed in one short
 * statement, which stamps `last_attempt_at` and counts the attempt, skipping
 * rows another run holds or claimed within the lease; the files are then
 * removed outside any transaction, a few at a time, and each result written
 * on its own row only while it is still outstanding. Removing a file twice is
 * harmless (an object already gone counts as removed), so a run that dies
 * mid-batch leaves its rows to the next run after the lease.
 */
export async function runStoredFileCleanup(opts: { paths?: string[] } = {}): Promise<CleanupResult> {
  const t = storedFileDeletionsTable;
  const result: CleanupResult = { deleted: 0, failed: 0 };
  if (opts.paths && opts.paths.length === 0) return result;
  const limit = opts.paths ? opts.paths.length : SWEEP_BATCH;
  const scope = opts.paths ? sql`AND path IN (${sql.join(opts.paths.map((path) => sql`${path}`), sql`, `)})` : sql``;
  // Never tried first, then the least recently tried, so a file that keeps
  // failing never holds up the rest.
  const claimed = await db.execute<{ id: string; path: string }>(sql`
    UPDATE stored_file_deletions SET last_attempt_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM stored_file_deletions
      WHERE done_at IS NULL ${scope}
        AND (last_attempt_at IS NULL OR last_attempt_at < now() - ${CLAIM_LEASE}::interval OR ${opts.paths != null})
      ORDER BY last_attempt_at ASC NULLS FIRST, created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, path`);
  const rows = claimed.rows.map((r) => ({ id: Number(r.id), path: r.path }));
  const store = remover();
  for (let i = 0; i < rows.length; i += REMOVE_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + REMOVE_CONCURRENCY).map(async (row) => {
      try {
        await store.deleteObject(row.path);
        await db.update(t).set({ doneAt: new Date(), lastError: null }).where(and(eq(t.id, row.id), isNull(t.doneAt)));
        result.deleted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.update(t).set({ lastError: message.slice(0, 2000) }).where(and(eq(t.id, row.id), isNull(t.doneAt)));
        result.failed++;
        logger.warn({ path: row.path, err: message }, "[stored-file-deletions] a file could not be removed; the hourly sweep retries it");
      }
    }));
  }
  if (result.deleted > 0 || result.failed > 0) logger.info(result, "[stored-file-deletions] cleanup run");
  return result;
}

/**
 * Clean up the paths a committed delete queued. Never throws: the rows stay
 * outstanding for the sweep, and the caller reports what is still waiting.
 * Returns how many of them are still outstanding.
 */
export async function cleanUpQueuedFiles(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  try {
    const { failed } = await runStoredFileCleanup({ paths });
    return failed;
  } catch (err) {
    logger.warn({ err, count: paths.length }, "[stored-file-deletions] cleanup after a delete failed; the hourly sweep retries it");
    return paths.length;
  }
}

/** Queue Health's line: how many files are still waiting, the oldest, and how many have failed at least once. */
export interface StoredFileDeletionHealth {
  outstanding: number;
  failing: number;
  oldestQueuedAt: string | null;
}

export async function storedFileDeletionHealth(executor: Executor = db): Promise<StoredFileDeletionHealth> {
  const t = storedFileDeletionsTable;
  const [row] = await executor.select({
    outstanding: sql<number>`count(*)::int`,
    failing: sql<number>`count(*) FILTER (WHERE ${t.attempts} > 0)::int`,
    oldest: sql<Date | null>`min(${t.createdAt})`,
  }).from(t).where(isNull(t.doneAt));
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return { outstanding: row?.outstanding ?? 0, failing: row?.failing ?? 0, oldestQueuedAt: oldest ? oldest.toISOString() : null };
}
