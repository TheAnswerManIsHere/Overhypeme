/**
 * The trust boundary. Identifiers in, verified provider state out.
 *
 * > **W1a — paid entitlement provenance.** A durable *paid* entitlement may be
 * > created only from provider state retrieved **inside** the trusted boundary.
 * > The boundary accepts **identifiers only**.
 *
 * An earlier revision claimed a branded TypeScript type made payment proof
 * "un-forgeable at the type level". That was wrong and is withdrawn: a type
 * assertion defeats any brand, and a validator taking caller-supplied
 * Stripe-shaped objects proves only that its arguments agree with each other.
 * The defect was never the missing check — it was a signature that ACCEPTED a
 * structurally-valid lie. So these functions take a string id and retrieve
 * everything themselves. A brand remains only as an accidental-misuse guardrail.
 *
 * There are **two** verifiers because there are two paid source types. The
 * one-time verifier requires `mode = payment` and a PaymentIntent, so it cannot
 * create or refresh a `stripe_subscription` source at all — and those arrive
 * through subscription webhooks, the Stripe-mutating routes, and reconciliation.
 * W1a says *every* paid entitlement.
 *
 * ## Negative conclusions need complete collections
 *
 * "This purchase is not a membership product" is a NEGATIVE conclusion over a
 * paginated list, so it is only sound if the whole list was seen. A pagination
 * failure therefore yields `incomplete_enumeration` — not `false`. Concluding
 * "not a member" from a truncated list would silently deny a paying customer.
 */

import type Stripe from "stripe";
import {
  checkoutLineItemsGrantMembership,
  priceGrantsMembership,
  type ProductResolver,
} from "./membershipPricing.js";

// ---------------------------------------------------------------------------
// The retriever the boundary is allowed to use.
// ---------------------------------------------------------------------------

/**
 * Deliberately narrow: exactly the calls the two verifiers make, nothing more.
 * Injectable so tests exercise the binding rules without live Stripe calls —
 * but note that a test fake substitutes the *provider*, never the caller's
 * ability to hand in a fabricated object, which is the property W1a is about.
 */
export interface EntitlementRetriever extends ProductResolver {
  retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session>;
  listCheckoutLineItems(
    sessionId: string,
    params: { limit: number; starting_after?: string },
  ): Promise<Stripe.ApiList<Stripe.LineItem>>;
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  listSubscriptionItems(
    subscriptionId: string,
    params: { limit: number; starting_after?: string },
  ): Promise<Stripe.ApiList<Stripe.SubscriptionItem>>;
}

/** Resolves the local user a Stripe customer belongs to. */
export interface UserBinding {
  /** The user whose `stripeCustomerId` equals this customer, or null. */
  findUserIdByCustomerId(customerId: string): Promise<string | null>;
  /**
   * Link a customer to a user that has none yet, returning whether it linked.
   * Never re-points a customer that is already bound elsewhere.
   */
  linkCustomerToUser(userId: string, customerId: string): Promise<boolean>;
}

export interface VerificationDeps {
  retriever: EntitlementRetriever;
  binding: UserBinding;
}

// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

export type VerificationFailureCode =
  | "wrong_mode"
  | "no_customer"
  | "user_unresolvable"
  | "user_mismatch"
  | "payment_not_complete"
  | "payment_intent_missing"
  | "payment_intent_mismatch"
  | "subscription_mismatch"
  | "incomplete_enumeration"
  | "retrieval_failed";

export interface VerificationFailure {
  ok: false;
  code: VerificationFailureCode;
  detail: string;
}

export interface VerifiedLifetimePurchase {
  ok: true;
  sourceType: "stripe_lifetime_payment";
  userId: string;
  /** The PaymentIntent id — the source's frozen identity. */
  providerRef: string;
  /** Frozen at creation: it describes what was bought, which later metadata edits cannot alter. */
  isMembershipProduct: boolean;
  lifecycleStatus: "active";
  /** From the authoritative PaymentIntent, never from the session or a caller. */
  amount: number;
  currency: string;
}

export interface VerifiedSubscription {
  ok: true;
  sourceType: "stripe_subscription";
  userId: string;
  providerRef: string;
  /** Re-evaluated on every refresh: it describes what the user is subscribed to NOW. */
  isMembershipProduct: boolean;
  lifecycleStatus: Stripe.Subscription.Status;
  plan: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export type OneTimeVerification = VerifiedLifetimePurchase | VerificationFailure;
export type SubscriptionVerification = VerifiedSubscription | VerificationFailure;

const fail = (code: VerificationFailureCode, detail: string): VerificationFailure => ({
  ok: false,
  code,
  detail,
});

// ---------------------------------------------------------------------------
// Pagination — bounded, and complete or explicitly not.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;
/** Bounds a runaway loop. Hitting it is an incomplete enumeration, not a result. */
const MAX_PAGES = 20;

export type PagedResult<T> =
  | { complete: true; items: T[] }
  | { complete: false; reason: string };

/**
 * Walk a Stripe list to the end, or say why it could not.
 *
 * Exported because the rule — a NEGATIVE conclusion over a paginated list is
 * only sound if the whole list was seen — applies wherever this codebase draws
 * one, not only inside the verifiers. Two copies of a bounded loop are two
 * places for the bound to drift.
 */
export async function listAllPages<T extends { id: string }>(
  fetchPage: (params: { limit: number; starting_after?: string }) => Promise<Stripe.ApiList<T>>,
): Promise<PagedResult<T>> {
  const items: T[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Stripe.ApiList<T>;
    try {
      response = await fetchPage({ limit: PAGE_SIZE, starting_after: startingAfter });
    } catch (error) {
      return { complete: false, reason: `page ${page} failed: ${(error as Error).message}` };
    }

    items.push(...response.data);
    if (!response.has_more) return { complete: true, items };

    const last = response.data[response.data.length - 1];
    // has_more with an empty page would loop forever on the same cursor.
    if (!last) return { complete: false, reason: "has_more with no cursor to advance" };
    startingAfter = last.id;
  }

  return { complete: false, reason: `exceeded ${MAX_PAGES} pages` };
}

const asId = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === "string" ? value : (value?.id ?? null);

// ---------------------------------------------------------------------------
// Shared: bind a retrieved customer to a local user.
// ---------------------------------------------------------------------------

async function bindUser(
  customerId: string | null,
  expectedUserId: string | undefined,
  linkHintUserId: string | undefined,
  binding: UserBinding,
): Promise<{ ok: true; userId: string } | VerificationFailure> {
  if (!customerId) return fail("no_customer", "the retrieved object carries no customer");

  let userId = await binding.findUserIdByCustomerId(customerId);

  // Safety net for a first purchase, where the customer is not yet linked. The
  // hint only ever links a customer to a user that has NONE — it can never
  // re-point a customer that already belongs to someone else, which is what
  // would otherwise let a hint reassign another user's entitlement.
  if (!userId && linkHintUserId) {
    if (await binding.linkCustomerToUser(linkHintUserId, customerId)) {
      userId = linkHintUserId;
    }
  }

  if (!userId) {
    return fail("user_unresolvable", `no user is bound to customer ${customerId}`);
  }

  // The acceptance case: a valid object belonging to ANOTHER customer must not
  // be applicable to the requested user.
  if (expectedUserId && userId !== expectedUserId) {
    return fail(
      "user_mismatch",
      `customer ${customerId} belongs to a different user than the one requested`,
    );
  }

  return { ok: true, userId };
}

// ---------------------------------------------------------------------------
// W1a — the one-time-payment verifier.
// ---------------------------------------------------------------------------

/**
 * Verify a completed one-time membership purchase from a Checkout Session id.
 *
 * Binds, in this order: session -> customer -> user; `mode = payment`; session
 * -> PaymentIntent identity; `payment_status = "paid"` AND `pi.status =
 * "succeeded"`; line items contain an allowlisted membership product, fully
 * paginated; amount and currency taken from the PaymentIntent.
 *
 * Requiring BOTH payment states is deliberate. `payment_status` describes the
 * session and `status` describes the intent; a delayed-notification method can
 * leave those disagreeing, and a fabricated `{ status: "succeeded" }` literal
 * passed in by a caller is exactly the shape of the defect this replaces.
 */
export async function verifyOneTimeMembershipPurchase(
  sessionId: string,
  deps: VerificationDeps,
  opts: { expectedUserId?: string } = {},
): Promise<OneTimeVerification> {
  let session: Stripe.Checkout.Session;
  try {
    session = await deps.retriever.retrieveCheckoutSession(sessionId);
  } catch (error) {
    return fail("retrieval_failed", `session ${sessionId}: ${(error as Error).message}`);
  }

  if (session.mode !== "payment") {
    return fail("wrong_mode", `session ${sessionId} has mode ${session.mode}`);
  }

  const bound = await bindUser(
    asId(session.customer),
    opts.expectedUserId,
    session.metadata?.userId,
    deps.binding,
  );
  if (!bound.ok) return bound;

  if (session.payment_status !== "paid") {
    return fail(
      "payment_not_complete",
      `session ${sessionId} payment_status is ${session.payment_status}`,
    );
  }

  const paymentIntentId = asId(session.payment_intent);
  if (!paymentIntentId) {
    return fail("payment_intent_missing", `session ${sessionId} carries no payment intent`);
  }

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await deps.retriever.retrievePaymentIntent(paymentIntentId);
  } catch (error) {
    return fail("retrieval_failed", `payment intent ${paymentIntentId}: ${(error as Error).message}`);
  }

  // Identity, not just existence: the retrieved intent must be the one the
  // session names.
  if (paymentIntent.id !== paymentIntentId) {
    return fail(
      "payment_intent_mismatch",
      `retrieved ${paymentIntent.id} for ${paymentIntentId}`,
    );
  }
  if (paymentIntent.status !== "succeeded") {
    return fail(
      "payment_not_complete",
      `payment intent ${paymentIntentId} status is ${paymentIntent.status}`,
    );
  }

  const lineItems = await listAllPages<Stripe.LineItem>((params) =>
    deps.retriever.listCheckoutLineItems(sessionId, params),
  );
  if (!lineItems.complete) {
    return fail(
      "incomplete_enumeration",
      `line items for ${sessionId} could not be fully listed (${lineItems.reason})`,
    );
  }

  const isMembershipProduct = await checkoutLineItemsGrantMembership(
    lineItems.items,
    deps.retriever,
  );

  return {
    ok: true,
    sourceType: "stripe_lifetime_payment",
    userId: bound.userId,
    providerRef: paymentIntent.id,
    isMembershipProduct,
    lifecycleStatus: "active",
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
  };
}

// ---------------------------------------------------------------------------
// W1a — the subscription verifier.
// ---------------------------------------------------------------------------

/**
 * Verify a subscription from its id, for creation OR for an authoritative
 * refresh — the same boundary either way.
 *
 * Every value written to the source row comes from the retrieved subscription
 * rather than from any caller-supplied one, which is what makes a refresh
 * trustworthy: a portal plan-switch to a non-membership price flips
 * `isMembershipProduct` to false here, and access drops on the next derivation.
 */
export async function verifyMembershipSubscription(
  subscriptionId: string,
  deps: VerificationDeps,
  opts: { expectedUserId?: string; linkHintUserId?: string } = {},
): Promise<SubscriptionVerification> {
  let subscription: Stripe.Subscription;
  try {
    subscription = await deps.retriever.retrieveSubscription(subscriptionId);
  } catch (error) {
    return fail("retrieval_failed", `subscription ${subscriptionId}: ${(error as Error).message}`);
  }

  if (subscription.id !== subscriptionId) {
    return fail(
      "subscription_mismatch",
      `retrieved ${subscription.id} for ${subscriptionId}`,
    );
  }

  const bound = await bindUser(
    asId(subscription.customer),
    opts.expectedUserId,
    opts.linkHintUserId,
    deps.binding,
  );
  if (!bound.ok) return bound;

  // `subscription.items` is only the FIRST page. A subscription with more items
  // than fit on one page would have the rest silently unexamined, and "no
  // membership item" over a truncated list is exactly the unsound negative
  // conclusion this boundary must not draw.
  const items = await listAllPages<Stripe.SubscriptionItem>((params) =>
    deps.retriever.listSubscriptionItems(subscriptionId, params),
  );
  if (!items.complete) {
    return fail(
      "incomplete_enumeration",
      `items for ${subscriptionId} could not be fully listed (${items.reason})`,
    );
  }

  // Reuses membershipPricing rather than re-deciding what a membership product
  // is — a second copy of the allowlist rule is a second thing that can drift
  // from the one the checkout path enforces.
  let isMembershipProduct = false;
  // The item that actually grants membership, not just the first line item —
  // a subscription can carry a non-membership add-on ahead of (or instead of)
  // the membership item, and the billing-cycle label has to describe THAT
  // item's price, not whichever happened to be listed first.
  let membershipItem: Stripe.SubscriptionItem | undefined;
  for (const item of items.items) {
    if (!item.price) continue;
    try {
      if (await priceGrantsMembership(item.price, deps.retriever)) {
        isMembershipProduct = true;
        membershipItem = item;
        break;
      }
    } catch (error) {
      // Same rule as pagination: an unresolvable product cannot support "this is
      // not a membership subscription".
      return fail(
        "incomplete_enumeration",
        `product for price ${item.price.id} could not be retrieved: ${(error as Error).message}`,
      );
    }
  }

  // The period end lives on the SUBSCRIPTION ITEM in this API version, not on
  // the subscription. Reading it off `subscription` through a widening cast
  // compiled fine and silently produced `undefined` on every refresh, so every
  // source stored `currentPeriodEnd: null` — the panel's renewal/cancellation
  // date then depended entirely on the Stripe-sync fallback being present and
  // current. Take it from the membership item, which is the item whose billing
  // cycle the date is actually describing; fall back to the first item only so a
  // non-membership subscription still reports something.
  const periodEnd = membershipItem?.current_period_end ?? items.items[0]?.current_period_end;

  return {
    ok: true,
    sourceType: "stripe_subscription",
    userId: bound.userId,
    providerRef: subscription.id,
    isMembershipProduct,
    lifecycleStatus: subscription.status,
    plan: planLabelFromInterval(membershipItem?.price?.recurring?.interval),
    currentPeriodEnd: typeof periodEnd === "number" ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  };
}

// SubscriptionPanel.tsx compares `plan` against "monthly"/"annual" for the
// billing-cycle label and the monthly→annual switch UI — the raw Stripe price
// id it used to carry meant every new price rotation silently broke that
// comparison.
function planLabelFromInterval(interval: Stripe.Price.Recurring.Interval | undefined): string | null {
  if (interval === "month") return "monthly";
  if (interval === "year") return "annual";
  return null;
}

// ---------------------------------------------------------------------------
// W1b — non-payment entitlement authorization.
// ---------------------------------------------------------------------------

/**
 * > **W1b — non-payment entitlement authorization.** A durable *non-payment*
 * > entitlement may be created only through an authorized source type recording
 * > actor, reason, timestamp and revocation semantics, and must never masquerade
 * > as a payment.
 *
 * The "must never masquerade as a payment" clause is what this replaces: admin
 * comps were previously written as a `lifetime_entitlements` row with a
 * synthesized payment-intent id, `stripeCustomerId: "admin_grant"` and
 * `amount: 0` — a fake payment, indistinguishable at a glance from a real one in
 * any payment audit.
 *
 * An `admin_grant` source carries no `provider_ref`, no amount and no currency,
 * enforced by CHECK constraints; the provenance columns are what authorize it.
 */
export interface AdminGrantAuthorization {
  sourceType: "admin_grant";
  userId: string;
  /** Nullable in the schema (the grantor can be purged); required here at authoring time. */
  grantedByAdminId: string;
  /** The durable half of the provenance — this is what the CHECK requires, not the id. */
  grantedByAdminLabel: string;
  grantReason: string;
  lifecycleStatus: "active";
}

export class UnauthorizedGrantError extends Error {
  constructor(detail: string) {
    super(`admin grant is not authorized: ${detail}`);
    this.name = "UnauthorizedGrantError";
  }
}

/**
 * The only constructor for an admin grant. Throws rather than returning a
 * partial record, so a caller cannot end up writing a grant with a blank actor
 * or reason and discover it at the database constraint — or, worse, not at all
 * if a future writer bypasses the constraint's shape.
 */
export function authorizeAdminGrant(input: {
  userId: string;
  grantedByAdminId: string;
  grantedByAdminLabel: string;
  grantReason: string;
}): AdminGrantAuthorization {
  const userId = input.userId?.trim();
  const grantedByAdminId = input.grantedByAdminId?.trim();
  const grantedByAdminLabel = input.grantedByAdminLabel?.trim();
  const grantReason = input.grantReason?.trim();

  if (!userId) throw new UnauthorizedGrantError("no recipient");
  if (!grantedByAdminId) throw new UnauthorizedGrantError("no granting actor");
  if (!grantedByAdminLabel) throw new UnauthorizedGrantError("no actor label to attribute it to");
  if (!grantReason) throw new UnauthorizedGrantError("no reason");

  return {
    sourceType: "admin_grant",
    userId,
    grantedByAdminId,
    grantedByAdminLabel,
    grantReason,
    lifecycleStatus: "active",
  };
}

export interface AdminRevocationAuthorization {
  revokedByAdminId: string;
  revokedByAdminLabel: string;
  revokedReason: string;
  revokedAt: Date;
  lifecycleStatus: "revoked";
}

/**
 * W1b's revocation clause, which the grant clause alone does not cover: without
 * this a row could reach `revoked` with null provenance, satisfying the letter
 * of the grant requirement while defeating the revocation one.
 */
export function authorizeAdminRevocation(input: {
  revokedByAdminId: string;
  revokedByAdminLabel: string;
  revokedReason: string;
  revokedAt?: Date;
}): AdminRevocationAuthorization {
  const revokedByAdminId = input.revokedByAdminId?.trim();
  const revokedByAdminLabel = input.revokedByAdminLabel?.trim();
  const revokedReason = input.revokedReason?.trim();

  if (!revokedByAdminId) throw new UnauthorizedGrantError("no revoking actor");
  if (!revokedByAdminLabel) throw new UnauthorizedGrantError("no actor label to attribute it to");
  if (!revokedReason) throw new UnauthorizedGrantError("no revocation reason");

  return {
    revokedByAdminId,
    revokedByAdminLabel,
    revokedReason,
    revokedAt: input.revokedAt ?? new Date(),
    lifecycleStatus: "revoked",
  };
}
