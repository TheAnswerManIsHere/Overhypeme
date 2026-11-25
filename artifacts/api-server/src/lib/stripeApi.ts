/**
 * The bounded Stripe contracts the application is allowed to call (#566,
 * plan decision 10).
 *
 * Built over Stripe's own types, one method at a time — nested resources
 * included — never a whole SDK resource class. Both application-facing
 * factories return these and nothing wider:
 *
 *   - `getVerifiedStripeClient()` / `getUncachableStripeClient()` → `StripeApi`
 *   - `getStripeSync()` → `StripeSyncApi`, which omits the library's own
 *     `stripe: Stripe` field so the full SDK cannot be reached through it.
 *
 * So a new production call is a type error until it is added here, and adding
 * it here is a type error in the fake driver until the fake implements it. That
 * is the drift guard: the compiler, not a reviewer, notices when the fake falls
 * behind.
 *
 * Calls the `stripe-replit-sync` library makes internally are outside this
 * contract and outside the compiler's reach; the fake refuses any member it
 * does not implement, by name, at runtime (see `stripeFakeDriver.ts`).
 */
import type Stripe from "stripe";

/** Stripe's "no such object": `resource_missing`, or a 404 from any resource. */
export function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return !!e && (e.code === "resource_missing" || e.statusCode === 404);
}

/** The `StripeSync` instance type, without importing the library at module load. */
export type StripeSyncInstance = InstanceType<typeof import("stripe-replit-sync").StripeSync>;

export interface StripeApi {
  accounts: Pick<Stripe["accounts"], "retrieve">;
  billingPortal: { sessions: Pick<Stripe["billingPortal"]["sessions"], "create"> };
  charges: Pick<Stripe["charges"], "list" | "retrieve">;
  checkout: { sessions: Pick<Stripe["checkout"]["sessions"], "create" | "list" | "listLineItems" | "retrieve"> };
  customers: Pick<Stripe["customers"], "create" | "retrieve">;
  disputes: Pick<Stripe["disputes"], "retrieve">;
  /**
   * `list`: the payments health check (launch Phase 16), events the webhook
   * should have processed. `retrieve`: the admin replay of one of them (Issue #1244).
   */
  events: Pick<Stripe["events"], "list" | "retrieve">;
  invoicePayments: Pick<Stripe["invoicePayments"], "list">;
  invoices: Pick<Stripe["invoices"], "createPreview" | "list" | "retrieve">;
  paymentIntents: Pick<Stripe["paymentIntents"], "retrieve">;
  prices: Pick<Stripe["prices"], "retrieve">;
  products: Pick<Stripe["products"], "retrieve">;
  subscriptionItems: Pick<Stripe["subscriptionItems"], "list">;
  subscriptions: Pick<Stripe["subscriptions"], "cancel" | "retrieve" | "update">;
  /**
   * `retrieve` only: start-up READS the operator-provisioned endpoint to check
   * it (launch Phase 15, increment 4). Nothing here creates, enables or deletes
   * one — the operator owns endpoints, in Stripe's dashboard.
   */
  webhookEndpoints: Pick<Stripe["webhookEndpoints"], "retrieve">;
}

/**
 * What the application may call on a published sync. No `stripe` field, and no
 * `findOrCreateManagedWebhook`: start-up never creates, re-enables or replaces a
 * webhook endpoint (launch Phase 15, increment 4), and leaving the method out of
 * this type makes a call to it a compile error rather than a review finding.
 */
export type StripeSyncApi = Pick<
  StripeSyncInstance,
  | "getAccountId"
  | "getSupportedEventTypes"
  | "syncBackfill"
  | "processWebhook"
  | "processEvent"
  | "syncProducts"
  | "syncPrices"
  | "syncPlans"
  | "syncCustomers"
  | "syncSubscriptions"
  | "syncInvoices"
  | "syncCharges"
  | "syncPaymentMethods"
>;
