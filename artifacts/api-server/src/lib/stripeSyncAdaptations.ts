/**
 * @purpose Adapt the stripe-replit-sync library where its mirror cannot take an event Stripe sends (Issue #1244, increment 1).
 * @subsystem payments
 *
 * Stripe's `invoice.upcoming` carries a PREVIEW invoice with no `id`: it is not a
 * persistent object, so there is nothing to mirror. The library routes it to its
 * invoice handler anyway, which upserts into `stripe.invoices`, whose primary key
 * is generated from `_raw_data->>'id'`; the insert fails on a null key. Because
 * the library mirrors inside `processWebhook`, after it verifies the signature
 * and before the app sees the event, every renewal reminder was rejected: Stripe
 * retried for three days and gave up, no reminder was sent, and the payment alert
 * counted each one.
 *
 * The adaptation skips the mirror for exactly that shape — an `invoice.upcoming`
 * whose invoice has no id — and nothing else. Signature verification stays in the
 * library, untouched (`processWebhook` verifies, then calls `processEvent`, which
 * reads the handler map at call time). Every other handler keeps the library's
 * processing, including events whose object has no top-level id but whose
 * handler mirrors nested objects (`entitlements.active_entitlement_summary.updated`).
 *
 * Applied where every sync instance is built (`stripeClient.ts`), so live
 * delivery and admin replay share it. David approved this change to live
 * webhook processing as Q40: 1 (2026-11-24, PLAN_REPLAY_MISSED_STRIPE_EVENT.md).
 */
import { logger } from "./logger";

type Handler = (event: unknown, accountId: string) => Promise<void>;

export const UPCOMING_INVOICE_EVENT = "invoice.upcoming";

const adapted = new WeakSet<object>();

/** Whether `adaptStripeSync` wrapped this instance (the construction-boundary test reads it). */
export function isAdaptedStripeSync(sync: unknown): boolean {
  return typeof sync === "object" && sync !== null && adapted.has(sync);
}

/** True for an `invoice.upcoming` whose invoice carries no id: a preview, with nothing to mirror. */
export function isIdlessUpcomingInvoice(event: unknown): boolean {
  const e = event as { type?: unknown; data?: { object?: unknown } } | null;
  if (!e || e.type !== UPCOMING_INVOICE_EVENT) return false;
  const obj = e.data?.object as { id?: unknown } | null | undefined;
  return !!obj && typeof obj === "object" && (typeof obj.id !== "string" || obj.id.length === 0);
}

/**
 * Wrap the library's `invoice.upcoming` handler on this instance. Returns true
 * when the handler was present and wrapped; false when the library no longer
 * handles the event at all (then there is nothing to skip).
 */
export function adaptStripeSync(sync: unknown): boolean {
  const handlers = (sync as { eventHandlers?: Record<string, Handler> }).eventHandlers;
  const original = handlers?.[UPCOMING_INVOICE_EVENT];
  if (!handlers || typeof original !== "function") return false;
  handlers[UPCOMING_INVOICE_EVENT] = async (event, accountId) => {
    if (isIdlessUpcomingInvoice(event)) {
      logger.info(
        { eventId: (event as { id?: unknown }).id },
        "Stripe mirror: skipping a preview invoice with no id (invoice.upcoming); the event is still processed",
      );
      return;
    }
    return original(event, accountId);
  };
  adapted.add(sync as object);
  return true;
}
