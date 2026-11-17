/**
 * Draw a render's picture, or collect the one an earlier run already paid for
 * (plan docs/plans/PLAN_JOB_RESUME.md §C, Issue #1000 increment 2).
 *
 * Every image request is recorded before it is submitted
 * (`image_generation_requests`), and fal's request id is written the moment
 * fal accepts it. A run of the image job reads the attempt's latest request on
 * its engine before it submits anything:
 *
 *   - **request id on record:** ask fal. Completed: collect it. Still queued
 *     or running: wait for it. Failed (a refusal included): the row is marked
 *     FAILED and the failure goes to the existing retry rules, so a known
 *     failure is never collected again; the next run submits anew.
 *   - **recorded, no request id** (the server stopped between fal accepting
 *     the request and the id being written): once the render could have
 *     finished, fal's request history is read from just before the row was
 *     written. The request is collected only when the match is unambiguous:
 *     exactly one history entry with this row's recorded input, not already
 *     held by another of our rows, and no other row of ours without a request
 *     id with the same endpoint and input. The association is written under a
 *     lock on that vendor id, so two recoveries cannot take the same picture.
 *     Anything else is ambiguous: the row is marked LOST and the picture is
 *     drawn again, logged (David, Q13: 1).
 *   - **nothing on record, or the last request FAILED or LOST:** submit.
 *
 * fal's history shows a request only once it has finished (probe, Issue #1000,
 * 2026-11-17: 0 of 2 polls while running, 14 of 14 after), so the lookup waits
 * until the row is `LOST_RECEIPT_HORIZON_MS` old: a search that ran earlier
 * could miss a request still being drawn and pay for it twice.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, imageGenerationRequestsTable, type ImageGenerationRequest, type VendorRequestStatus } from "@workspace/db";
import { fencedTransaction, jobAbortSignal, rethrowIfOwnershipLost } from "./jobFence";
import { FAL_PENDING_STATUSES, renderFal } from "./renderFalTransport";
import { stableStringify } from "./factRenderScenarios";
import { logger } from "./logger";

/** How old a receipt-less request row must be before fal's history is searched for it. */
export const LOST_RECEIPT_HORIZON_MS = 6 * 60_000;
/** The history is read from this long before the row was written (clock skew between us and fal). */
const HISTORY_LEAD_MS = 60_000;
/** Between status reads while a request is queued or drawing. */
export const STATUS_POLL_MS = 2_000;
/** A collect that has not finished in this long hands back for a retry, which collects again. */
export const COLLECT_TIMEOUT_MS = 8 * 60_000;

export type DrawOutcome =
  | { ok: true; data: unknown; generationRequestId: number; vendorRequestId: string }
  | { ok: false; err: unknown; generationRequestId: number | null; vendorRequestId: string | null };

export interface DrawRequest {
  attemptId: number;
  endpointId: string;
  /** The input this run would submit. A collected request keeps the input it was recorded with. */
  input: Record<string, unknown>;
  /** Records the request before it is submitted (fenced); returns the row id. */
  record: () => Promise<number>;
}

const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(t);
    reject(signal!.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** Test seams: the clock and the sleep the waits use. */
let now = () => Date.now();
let sleep = realSleep;
export function __setRecoveryClockForTest(clock: { now?: () => number; sleep?: typeof realSleep } | null): void {
  now = clock?.now ?? (() => Date.now());
  sleep = clock?.sleep ?? realSleep;
}

/** Write what we learned about a request. Fenced: a run that lost its job writes nothing. */
async function setStatus(rowId: number, status: VendorRequestStatus, vendorRequestId?: string): Promise<void> {
  await fencedTransaction(db, (tx) => tx.update(imageGenerationRequestsTable)
    .set({ vendorStatus: status, vendorStatusAt: new Date(), ...(vendorRequestId ? { vendorRequestId } : {}) })
    .where(eq(imageGenerationRequestsTable.id, rowId)));
}

/** The attempt's latest request on this endpoint, if any. */
async function latestRequest(attemptId: number, endpointId: string): Promise<ImageGenerationRequest | null> {
  const [row] = await db.select().from(imageGenerationRequestsTable)
    .where(and(eq(imageGenerationRequestsTable.attemptId, attemptId), eq(imageGenerationRequestsTable.endpointId, endpointId)))
    .orderBy(desc(imageGenerationRequestsTable.id))
    .limit(1);
  return row ?? null;
}

/** An error carrying an HTTP status: fal answered, rather than the read itself failing. */
function httpStatusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * A status read that failed with a definite answer about the request (a 4xx
 * other than a timeout or a rate limit: the request is unknown or gone).
 * Anything else about a status read leaves the request open.
 */
function isDefiniteStatusAnswer(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status != null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Wait for a submitted request and return its output. Each status change is
 * written to the row, which is what the tile reads.
 *
 * Once fal says COMPLETED, the request is finished: fal reports a failed
 * request as COMPLETED too, and its result read replays the model's own error
 * (a content refusal's 422, a model 500 or 504). Any HTTP answer to that read
 * is therefore the request's outcome, and a failure marks the row FAILED so
 * the retry submits anew, as before this resume existed (plan §C: "a known
 * failure is never collected repeatedly"; PR #1017 round 2). The row stays
 * open only when nothing was learned about the request: a read with no HTTP
 * answer, a status read that was refused or timed out, a wait that ran out.
 */
async function collect(row: { id: number; endpointId: string }, vendorRequestId: string, written: VendorRequestStatus | null): Promise<DrawOutcome> {
  const transport = renderFal();
  const signal = jobAbortSignal();
  const deadline = now() + COLLECT_TIMEOUT_MS;
  const fail = (err: unknown): DrawOutcome => ({ ok: false, err, generationRequestId: row.id, vendorRequestId });
  for (;;) {
    let status: string;
    try {
      status = await transport.status(row.endpointId, vendorRequestId);
    } catch (err) {
      rethrowIfOwnershipLost(err); // a run that lost its job stops here; the next run collects
      if (isDefiniteStatusAnswer(err)) await setStatus(row.id, "FAILED");
      return fail(err);
    }
    if (FAL_PENDING_STATUSES.has(status)) {
      if (status !== written) {
        await setStatus(row.id, status as VendorRequestStatus);
        written = status as VendorRequestStatus;
      }
      if (now() >= deadline) {
        return fail(new Error(`fal request ${vendorRequestId} had not finished after ${COLLECT_TIMEOUT_MS / 60_000} minutes; it will be collected on retry`));
      }
      await sleep(STATUS_POLL_MS, signal);
      continue;
    }
    if (status !== "COMPLETED") {
      // A word fal does not document: nothing is learned, so nothing is closed.
      return fail(new Error(`fal request ${vendorRequestId} reported status ${status}; it will be read again on retry`));
    }
    try {
      const data = await transport.result(row.endpointId, vendorRequestId);
      await setStatus(row.id, "COMPLETED");
      return { ok: true, data, generationRequestId: row.id, vendorRequestId };
    } catch (err) {
      rethrowIfOwnershipLost(err);
      // Finished: an HTTP answer here is the model's own outcome. No answer at
      // all (a dropped connection) says nothing, and the retry reads it again.
      if (httpStatusOf(err) != null) await setStatus(row.id, "FAILED");
      return fail(err);
    }
  }
}

/** Submit a new request: record it, POST once, store the receipt at once, then wait. */
async function submitAndCollect(req: DrawRequest): Promise<DrawOutcome> {
  const rowId = await req.record();
  let vendorRequestId: string;
  try {
    vendorRequestId = await renderFal().submit(req.endpointId, req.input, jobAbortSignal());
  } catch (err) {
    rethrowIfOwnershipLost(err);
    // fal answered with an error, so it did not accept the request: nothing to
    // collect later. A transport failure leaves the row open: whether fal took
    // the request is unknown, and the history decides on the next run.
    if (typeof (err as { status?: unknown } | null)?.status === "number") await setStatus(rowId, "FAILED");
    return { ok: false, err, generationRequestId: rowId, vendorRequestId: null };
  }
  await setStatus(rowId, "IN_QUEUE", vendorRequestId);
  return collect({ id: rowId, endpointId: req.endpointId }, vendorRequestId, "IN_QUEUE");
}

/**
 * Find the request a receipt-less row submitted, or decide it cannot be found
 * unambiguously. Returns the vendor id it associated, or null (row now LOST).
 */
export async function recoverLostReceipt(row: ImageGenerationRequest): Promise<string | null> {
  const ageMs = now() - row.createdAt.getTime();
  if (ageMs < LOST_RECEIPT_HORIZON_MS) {
    logger.info({ generationRequestId: row.id, waitMs: LOST_RECEIPT_HORIZON_MS - ageMs }, "[renderRecovery] receipt lost; waiting until the request could have finished before searching fal's history");
    await sleep(LOST_RECEIPT_HORIZON_MS - ageMs, jobAbortSignal());
  }
  const ambiguous = async (why: string): Promise<null> => {
    await setStatus(row.id, "LOST");
    logger.warn({ generationRequestId: row.id, attemptId: row.attemptId, why }, "[renderRecovery] lost receipt could not be matched unambiguously; drawing again (Q13: 1)");
    return null;
  };

  // Another row of ours with no request id and the same endpoint and input,
  // whenever it was recorded, could own the same history entry.
  const ownInput = stableStringify(row.request);
  const competitors = await db.select({ id: imageGenerationRequestsTable.id })
    .from(imageGenerationRequestsTable)
    .where(and(
      ne(imageGenerationRequestsTable.id, row.id),
      eq(imageGenerationRequestsTable.endpointId, row.endpointId),
      isNull(imageGenerationRequestsTable.vendorRequestId),
      or(isNull(imageGenerationRequestsTable.vendorStatus), eq(imageGenerationRequestsTable.vendorStatus, "LOST")),
      sql`${imageGenerationRequestsTable.request} = ${JSON.stringify(row.request)}::jsonb`,
    ));
  if (competitors.length > 0) return ambiguous("another unresolved request of ours has the same input");

  let entries;
  try {
    entries = await renderFal().history(row.endpointId, new Date(row.createdAt.getTime() - HISTORY_LEAD_MS));
  } catch (err) {
    return ambiguous(`fal's request history could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const matches = [...new Set(entries.filter((e) => stableStringify(e.input) === ownInput).map((e) => e.requestId))];
  if (matches.length === 0) return ambiguous("no request with this input in fal's history");
  if (matches.length > 1) return ambiguous(`${matches.length} requests with this input in fal's history`);
  const candidate = matches[0]!;

  // Associate under a lock on the vendor id, so a concurrent recovery that
  // found the same entry cannot also take it.
  const taken = await fencedTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fal-request:${candidate}`}))`);
    const [held] = await tx.select({ id: imageGenerationRequestsTable.id }).from(imageGenerationRequestsTable)
      .where(eq(imageGenerationRequestsTable.vendorRequestId, candidate)).limit(1);
    if (held) return false;
    const updated = await tx.update(imageGenerationRequestsTable)
      .set({ vendorRequestId: candidate, vendorStatusAt: new Date() })
      .where(and(eq(imageGenerationRequestsTable.id, row.id), isNull(imageGenerationRequestsTable.vendorRequestId)))
      .returning({ id: imageGenerationRequestsTable.id });
    return updated.length === 1;
  });
  if (!taken) return ambiguous("the matching request is already held by another of our rows");
  logger.info({ generationRequestId: row.id, attemptId: row.attemptId, vendorRequestId: candidate }, "[renderRecovery] lost receipt found in fal's history; collecting it");
  return candidate;
}

/**
 * Draw the picture, or collect the one already submitted for this attempt.
 * Never throws for a vendor failure: the outcome carries it, with the request
 * row and fal id it belongs to. A run that loses its job throws
 * `JobOwnershipLostError` from its fenced writes, as everywhere else.
 */
export async function drawOrCollect(req: DrawRequest): Promise<DrawOutcome> {
  const prior = await latestRequest(req.attemptId, req.endpointId);
  if (prior && prior.vendorStatus !== "FAILED" && prior.vendorStatus !== "LOST") {
    let vendorRequestId = prior.vendorRequestId;
    if (!vendorRequestId) vendorRequestId = await recoverLostReceipt(prior);
    if (vendorRequestId) {
      logger.info({ attemptId: req.attemptId, generationRequestId: prior.id, vendorRequestId }, "[renderRecovery] resuming a request already submitted; nothing new is paid for");
      return collect(prior, vendorRequestId, prior.vendorStatus ?? null);
    }
  }
  return submitAndCollect(req);
}

/** The request rows' latest vendor status per attempt, for the tile (plan §D). */
export async function latestVendorStatusByAttempt(attemptIds: number[]): Promise<Map<number, VendorRequestStatus | null>> {
  const out = new Map<number, VendorRequestStatus | null>();
  if (attemptIds.length === 0) return out;
  const rows = await db.selectDistinctOn([imageGenerationRequestsTable.attemptId], {
    attemptId: imageGenerationRequestsTable.attemptId,
    vendorStatus: imageGenerationRequestsTable.vendorStatus,
  }).from(imageGenerationRequestsTable)
    .where(inArray(imageGenerationRequestsTable.attemptId, attemptIds))
    .orderBy(imageGenerationRequestsTable.attemptId, desc(imageGenerationRequestsTable.id));
  for (const r of rows) if (r.attemptId != null) out.set(r.attemptId, r.vendorStatus ?? null);
  return out;
}
