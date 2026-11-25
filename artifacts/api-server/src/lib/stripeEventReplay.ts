/**
 * @purpose Replay one Stripe event that never reached the webhook, by its id, from the admin Billing page (Issue #1244).
 * @subsystem payments
 *
 * The event is read from Stripe with the verified client for the active mode,
 * never taken from the request, so it is genuine without a webhook signature;
 * then it goes through exactly what a delivered event goes through: the
 * library's mirror (with the preview-invoice adaptation) and
 * `processAuthenticEvent`, whose transactional claim is the once-only
 * guarantee (PLAN_REPLAY_MISSED_STRIPE_EVENT.md, design items 3 and 4).
 *
 * Order, and why:
 *   1. the id's shape, before anything else touches Stripe or the database;
 *   2. an ATTEMPT row naming the admin, before any mirror or domain write — a
 *      replay whose domain commit outlives its process still says who started
 *      it; if this row cannot be written, nothing is processed (ledger C8);
 *   3. one verified client and the mode it was verified for, used for the whole
 *      replay; refusals for another mode, a sync built for another mode, and a
 *      type the webhook is not subscribed to;
 *   4. an event already claimed is reported as such before any mirror or
 *      prepare work, so a retrieval failure cannot mask it (ledger C7) — the
 *      claim inside the transaction stays the concurrency guarantee;
 *   5. mirror, then process; an OUTCOME row; the payments verdict forgotten so
 *      the alert re-reads.
 */
import type Stripe from "stripe";
import { db, adminActionsTable } from "@workspace/db";
import type { AdminAction } from "@workspace/api-zod";
import { logger } from "./logger";
import { isStripeResourceMissing, type StripeApi, type StripeSyncApi } from "./stripeApi.js";
import { getVerifiedStripeClient, getStripeSync, liveModeOfPublishedStripeSync } from "./stripeClient";
import { eventAlreadyProcessed, processAuthenticEvent } from "./webhookHandlers";
import { forgetPaymentsVerdict } from "./operationalHealth";

export const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9]{1,250}$/;

export type ReplayRefusal =
  | "malformed_id"
  | "audit_unavailable"
  | "not_found"
  | "wrong_mode"
  | "mode_changed"
  | "unsupported_type";

export type ReplayResult =
  | { outcome: "processed" | "already_processed"; eventId: string; eventType: string; liveMode: boolean }
  | { outcome: "refused"; reason: ReplayRefusal; eventId: string; eventType?: string; liveMode?: boolean }
  | { outcome: "failed"; reason: string; eventId: string; eventType?: string; liveMode?: boolean };

export interface ReplayDeps {
  verifiedClient: () => Promise<{ client: StripeApi; liveMode: boolean }>;
  sync: () => Promise<StripeSyncApi>;
  /** The mode the sync instance was built for; null when it cannot be told. */
  syncMode: (sync: StripeSyncApi) => boolean | null;
  /** Writes one admin_actions row for this replay (a seam so a failed write can be tested). */
  record: (actorId: string, detail: Record<string, unknown>) => Promise<void>;
}

const ACTION: AdminAction = "stripe_event_replayed";

async function record(actorId: string, detail: Record<string, unknown>): Promise<void> {
  await db.insert(adminActionsTable).values({ actorId, action: ACTION, detail });
}

const realDeps: ReplayDeps = {
  verifiedClient: getVerifiedStripeClient,
  sync: getStripeSync,
  syncMode: liveModeOfPublishedStripeSync,
  record,
};

export async function replayStripeEvent(eventId: string, actorId: string, overrides: Partial<ReplayDeps> = {}): Promise<ReplayResult> {
  if (!STRIPE_EVENT_ID.test(eventId)) return { outcome: "refused", reason: "malformed_id", eventId };
  const deps: ReplayDeps = { ...realDeps, ...overrides };

  try {
    await deps.record(actorId, { phase: "attempt", eventId });
  } catch (err) {
    logger.error({ err, eventId }, "Stripe replay: the attempt could not be recorded, so nothing was processed");
    return { outcome: "refused", reason: "audit_unavailable", eventId };
  }

  let result: ReplayResult;
  try {
    result = await run(eventId, deps);
  } catch (err) {
    // Stripe or the database could not be reached before processing began.
    logger.error({ err, eventId }, "Stripe replay could not reach Stripe or the database");
    result = { outcome: "failed", reason: err instanceof Error ? err.message.slice(0, 400) : String(err), eventId };
  }
  try {
    await deps.record(actorId, { phase: "outcome", ...result });
  } catch (err) {
    // The attempt row already names the admin and the event; the outcome is in
    // the webhook audit log. Not worth failing a replay that has happened.
    logger.error({ err, eventId, outcome: result.outcome }, "Stripe replay: the outcome could not be recorded");
  }
  if (result.outcome === "processed" || result.outcome === "already_processed") forgetPaymentsVerdict();
  return result;
}

async function run(eventId: string, deps: ReplayDeps): Promise<ReplayResult> {
  const { client, liveMode } = await deps.verifiedClient();

  let event: Stripe.Event;
  try {
    event = await client.events.retrieve(eventId);
  } catch (err) {
    if (isStripeResourceMissing(err)) return { outcome: "refused", reason: "not_found", eventId, liveMode };
    throw err;
  }
  const base = { eventId, eventType: event.type, liveMode };
  if (event.livemode !== liveMode) return { outcome: "refused", reason: "wrong_mode", ...base };

  const sync = await deps.sync();
  if (deps.syncMode(sync) !== liveMode) return { outcome: "refused", reason: "mode_changed", ...base };
  if (!sync.getSupportedEventTypes().includes(event.type as never)) {
    return { outcome: "refused", reason: "unsupported_type", ...base };
  }

  if (await eventAlreadyProcessed(eventId)) return { outcome: "already_processed", ...base };

  try {
    await sync.processEvent(event);
    const outcome = await processAuthenticEvent(client, event, "replay");
    return { outcome, ...base };
  } catch (err) {
    logger.error({ err, eventId, eventType: event.type }, "Stripe replay failed");
    return { outcome: "failed", reason: err instanceof Error ? err.message.slice(0, 400) : String(err), ...base };
  }
}
