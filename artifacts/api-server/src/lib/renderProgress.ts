/**
 * Where an in-flight render really is (plan docs/plans/PLAN_JOB_RESUME.md §D,
 * Issue #1000 increment 2): one mapping, read by every tile, from the render's
 * job (its state and lease) and fal's reported progress on its request.
 *
 *   queued    job pending, or held and preparing (planning, submitting), or
 *             fal has the request waiting in its queue
 *   drawing   fal reports the request in progress
 *   resuming  the previous holder stopped: waiting for the reclaim, or checking
 *             an interrupted request
 *   saving    fal finished; the picture is being stored
 *   retrying  a retryable failure waiting for its automatic retry (its next
 *             attempt scheduled ahead), whether or not it was recovered
 *
 * Before this, "Drawing…" meant only that a plan was saved — it stayed on for
 * half an hour behind a server that had stopped (Issue #1000's evidence).
 * A render with no job in flight has no progress: its attempt row says how it
 * ended (done, failed, blocked).
 */

import { and, desc, inArray, sql } from "drizzle-orm";
import { db, asyncJobsTable } from "@workspace/db";
import { IN_FLIGHT_JOB_STATUSES } from "@workspace/db/schema";
import { latestVendorStatusByAttempt } from "./renderRequestRecovery";

export type RenderProgress = "queued" | "drawing" | "resuming" | "saving" | "retrying";

const PLANNER_QUEUE = "image_prompt_generation";
const IMAGE_QUEUE = "image_generation";
const plannerKey = (attemptId: number) => `image_prompt:attempt:${attemptId}`;
const imageKey = (attemptId: number) => `image_generation:attempt:${attemptId}`;

export interface RenderJobState {
  queue: string;
  status: string;
  attempts: number;
  lastError: string | null;
  /** The row's lease has lapsed (judged by the database clock): its holder stopped. */
  leaseLapsed: boolean;
  /** Set once the row was taken back from a stopped holder (sticky until it finishes). */
  recovering: boolean;
  /**
   * Its next attempt is scheduled ahead (database clock). Only a failed attempt
   * moves it ahead: a claim and the reclaim sweep never do, so this — not a last
   * error, which a reclaim keeps from an earlier attempt — says the job is
   * waiting out a retry.
   */
  retryAhead: boolean;
}

/** The pure mapping (plan §D's table), given a render's job in flight and its request's vendor status. */
export function renderProgressOf(job: RenderJobState, vendorStatus: string | null): RenderProgress {
  // Waiting after a failed attempt, recovered or not: "Retrying shortly…".
  // A recovered job stays `recovering` through its retries (plan §A), so the
  // status alone cannot say this (PR #1017 round 1).
  if ((job.status === "pending" || job.status === "recovering") && job.retryAhead && job.lastError) return "retrying";
  if (job.status === "recovering") return "resuming";
  if (job.status === "pending") return "queued";
  // processing
  if (job.leaseLapsed) return "resuming";
  if (job.queue !== IMAGE_QUEUE) return "queued";
  switch (vendorStatus) {
    case "IN_PROGRESS": return "drawing";
    case "COMPLETED": return "saving";
    case "IN_QUEUE": return "queued";
    default:
      // A resumed image job whose last request has no receipt is checking it.
      return job.recovering ? "resuming" : "queued";
  }
}

/** Progress for each attempt that has a render job in flight; attempts without one are absent. */
export async function renderProgressByAttempt(attemptIds: number[]): Promise<Map<number, RenderProgress>> {
  const out = new Map<number, RenderProgress>();
  if (attemptIds.length === 0) return out;
  const keys = attemptIds.flatMap((id) => [plannerKey(id), imageKey(id)]);
  const jobs = await db.select({
    id: asyncJobsTable.id,
    queue: asyncJobsTable.queue,
    dedupeKey: asyncJobsTable.dedupeKey,
    status: asyncJobsTable.status,
    attempts: asyncJobsTable.attempts,
    lastError: asyncJobsTable.lastError,
    leaseLapsed: sql<boolean>`coalesce(${asyncJobsTable.leaseExpiresAt} <= now(), false)`,
    retryAhead: sql<boolean>`${asyncJobsTable.nextAttemptAt} > now()`,
    recoveryProtocol: asyncJobsTable.recoveryProtocol,
  }).from(asyncJobsTable)
    .where(and(
      inArray(asyncJobsTable.queue, [PLANNER_QUEUE, IMAGE_QUEUE]),
      inArray(asyncJobsTable.dedupeKey, keys),
      inArray(asyncJobsTable.status, [...IN_FLIGHT_JOB_STATUSES]),
    ))
    .orderBy(desc(asyncJobsTable.id));
  // The latest in-flight job per attempt (the image job follows the planner's).
  const latest = new Map<number, (typeof jobs)[number]>();
  for (const j of jobs) {
    const id = Number(j.dedupeKey?.split(":").pop());
    if (Number.isFinite(id) && !latest.has(id)) latest.set(id, j);
  }
  if (latest.size === 0) return out;
  // fal's progress matters only to an image job; a planner job never reads it.
  const vendor = await latestVendorStatusByAttempt([...latest].filter(([, j]) => j.queue === IMAGE_QUEUE).map(([id]) => id));
  for (const [attemptId, j] of latest) {
    out.set(attemptId, renderProgressOf({
      queue: j.queue,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError,
      leaseLapsed: Boolean(j.leaseLapsed),
      recovering: j.recoveryProtocol != null,
      retryAhead: Boolean(j.retryAhead),
    }, vendor.get(attemptId) ?? null));
  }
  return out;
}
