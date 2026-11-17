/**
 * Job fence (plan docs/plans/PLAN_JOB_RESUME.md §A, Issue #1000): the
 * per-invocation ownership context a running job carries, and the fenced
 * transaction every effect a second run would also make goes through.
 *
 * Kept apart from `asyncJobs.ts` so domain helpers (provenance records, the
 * image worker, enrichment) can fence their writes without importing the whole
 * worker. Outside a job every helper here is a plain transaction or a no-op, so
 * shared code calls it from routes and scripts unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * The ownership predicate every fenced write repeats (plan §A): this
 * invocation's token, the row still `processing`, and an unexpired lease, all
 * judged by the database's clock.
 */
export function ownedBy(jobId: number, leaseToken: string) {
  return and(
    eq(asyncJobsTable.id, jobId),
    eq(asyncJobsTable.leaseToken, leaseToken),
    eq(asyncJobsTable.status, "processing"),
    sql`${asyncJobsTable.leaseExpiresAt} > now()`,
  );
}

/** A claim's lease: renewed by a live holder well before it lapses. */
export const LEASE_DURATION_MS = 90_000;
/** The lease as a Postgres interval, for `now() + LEASE_INTERVAL`. */
export const LEASE_INTERVAL = sql.raw(`interval '${LEASE_DURATION_MS} milliseconds'`);

/** Thrown when a run that no longer owns its job tries to make an effect. */
export class JobOwnershipLostError extends Error {
  constructor(readonly jobId: number, readonly reason: string) {
    super(`job ${jobId} is no longer owned by this run (${reason}) — effect refused`);
    this.name = "JobOwnershipLostError";
  }
}

/**
 * One invocation of one claimed job: its lease token, and an effect context
 * that can be stopped permanently — by the execution limit, by a renewal that
 * finds the lease lost, or by the run's own end. Once stopped, every fenced
 * effect it attempts is refused at once, and its abort signal has fired so a
 * handler waiting locally can give up.
 */
export class JobInvocation {
  private readonly controller = new AbortController();
  private stopReason: string | null = null;

  constructor(readonly jobId: number, readonly queue: string, readonly leaseToken: string) {}

  get stopped(): boolean {
    return this.stopReason !== null;
  }

  get reason(): string | null {
    return this.stopReason;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Stop this invocation's effects for good. Idempotent; the first reason wins. */
  stop(reason: string): void {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.controller.abort(new JobOwnershipLostError(this.jobId, reason));
  }
}

/** The invocation the current async context belongs to, if any. */
const INVOCATION = new AsyncLocalStorage<JobInvocation>();
/** Set while a fenced transaction of that invocation holds its job row. */
const FENCE_HELD = new AsyncLocalStorage<JobInvocation>();

/**
 * The running job's abort signal, for a handler's local waits (a vendor poll,
 * a fetch). Fires when the run's effect context is stopped. Undefined outside
 * a job.
 */
export function jobAbortSignal(): AbortSignal | undefined {
  return INVOCATION.getStore()?.signal;
}

type FencedTx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

/**
 * Run `fn` in a transaction that first locks this job's row and checks it is
 * still owned by the running invocation (plan §A: token, `processing`, lease
 * unexpired). A reclaim cannot slip between that check and `fn`'s writes,
 * because it would need the lock. If the claim is gone — or the invocation was
 * stopped — nothing in `fn` runs and `JobOwnershipLostError` is thrown.
 *
 * Use it for every effect a second run of the same job would also make: a
 * domain write, a child-job enqueue (pass the `tx` to `enqueueJob`), an
 * abandonment write. Outside a job (a route, a script) it is a plain
 * transaction, so shared code can call it from both.
 */
export async function fencedTransaction<T>(
  dbInstance: Pick<typeof defaultDb, "transaction">,
  fn: (tx: FencedTx) => Promise<T>,
): Promise<T> {
  const invocation = INVOCATION.getStore();
  if (!invocation) return dbInstance.transaction(fn);
  const refuse = (reason: string): never => {
    invocation.stop(reason);
    logger.warn(
      { id: invocation.jobId, queue: invocation.queue, reason },
      "[asyncJobs] effect refused — this run no longer owns its job",
    );
    throw new JobOwnershipLostError(invocation.jobId, reason);
  };
  if (invocation.stopped) refuse(invocation.reason!);
  // Nested inside a fenced transaction of this run: the outer one already holds
  // the job row, so no reclaim can land until it commits. Locking the row again
  // from this second connection would wait on our own lock forever.
  if (FENCE_HELD.getStore() === invocation) {
    return dbInstance.transaction(async (tx) => {
      const result = await fn(tx);
      if (invocation.stopped) refuse(invocation.reason!); // before this commit (PR #1009)
      return result;
    });
  }
  return dbInstance.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: asyncJobsTable.id })
      .from(asyncJobsTable)
      .where(ownedBy(invocation.jobId, invocation.leaseToken))
      .for("update");
    if (!owned) refuse("lease lost — the claim changed or expired");
    // Re-checked after the lock wait: the execution limit may have fired meanwhile.
    if (invocation.stopped) refuse(invocation.reason!);
    // While this transaction holds the row, the renewal timer steps around it
    // (it skips locked rows), so the lease is renewed here instead: a row under
    // frequent short fenced writes keeps its lease (PR #1009 round 1).
    await tx
      .update(asyncJobsTable)
      .set({ leaseExpiresAt: sql`now() + ${LEASE_INTERVAL}` })
      .where(eq(asyncJobsTable.id, invocation.jobId));
    const result = await FENCE_HELD.run(invocation, () => fn(tx));
    // Re-checked before commit: a run stopped while its callback was waiting
    // (say, at its execution limit) commits nothing (plan §B; PR #1009 round 1).
    // A stop landing during the commit round trip itself still commits.
    if (invocation.stopped) refuse(invocation.reason!);
    return result;
  });
}

/**
 * Check, now, that the running job is still owned — before a costly step such
 * as a paid vendor call (plan §A). Throws `JobOwnershipLostError` when it is
 * not. A no-op outside a job.
 */
export async function assertJobOwnership(
  dbInstance: Pick<typeof defaultDb, "select"> = defaultDb,
): Promise<void> {
  const invocation = INVOCATION.getStore();
  if (!invocation) return;
  // A read, not a lock: nothing is written here, and the paid call it guards
  // happens after any lock would have been released anyway.
  const refuse = (reason: string): never => {
    invocation.stop(reason);
    logger.warn({ id: invocation.jobId, queue: invocation.queue, reason }, "[asyncJobs] paid call refused — this run no longer owns its job");
    throw new JobOwnershipLostError(invocation.jobId, reason);
  };
  if (invocation.stopped) refuse(invocation.reason!);
  const [owned] = await dbInstance
    .select({ id: asyncJobsTable.id })
    .from(asyncJobsTable)
    .where(ownedBy(invocation.jobId, invocation.leaseToken));
  if (!owned) refuse("lease lost — the claim changed or expired");
}

/** Run `fn` as the given invocation: its fenced effects are checked against it. */
export function runAsInvocation<T>(invocation: JobInvocation, fn: () => Promise<T>): Promise<T> {
  return INVOCATION.run(invocation, fn);
}

/**
 * Run `fn` while this run's ownership is held: the job row stays locked (so no
 * reclaim can land) for as long as `fn` runs, even when `fn` writes through the
 * module database rather than a transaction it is handed. Use it around a
 * shared helper a job calls whose writes a second run would also make. Outside
 * a job it simply runs `fn`. Keep `fn` short: it holds the job row, and a
 * second connection while `fn` writes. Prefer `fencedTransaction` with the
 * transaction passed in wherever the writes can take it.
 */
export async function whileOwned<T>(fn: () => Promise<T>): Promise<T> {
  if (!INVOCATION.getStore()) return fn();
  return fencedTransaction(defaultDb, () => fn());
}

/**
 * Let an ownership refusal pass a catch untouched (Issue #1010): a helper that
 * converts or absorbs its own failures calls this first, so a run that lost
 * its job stops instead of carrying on as though its call had merely failed.
 */
export function rethrowIfOwnershipLost(err: unknown): void {
  if (err instanceof JobOwnershipLostError) throw err;
}
