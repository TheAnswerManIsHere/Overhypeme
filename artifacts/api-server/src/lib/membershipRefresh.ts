/**
 * The authoritative refresh — the only way provider state reaches an
 * entitlement source.
 *
 * Every caller that used to write local rows from an event payload now calls one
 * of these instead: the subscription webhooks, the Stripe-mutating routes, the
 * admin soft-delete, reinstatement, and reconciliation. They all take an
 * IDENTIFIER, retrieve the current object inside the trust boundary, and apply
 * it under the source's lease and fence.
 *
 * Why the routes go through here too: cancel, reactivate and switch-plan each
 * complete their Stripe call BEFORE their local write, so a token minted after
 * the lock orders database application rather than provider state — a stalled
 * route response could acquire the lock after a newer webhook stored `canceled`,
 * mint the highest token, and overwrite it with stale `active`. Re-retrieving
 * removes the special case instead of trying to order it.
 */

import type Stripe from "stripe";
import { db } from "@workspace/db";
import { membershipEntitlementsTable, membershipHistoryTable, usersTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import {
  listAllPages,
  verifyMembershipSubscription,
  verifyOneTimeMembershipPurchase,
  type EntitlementRetriever,
  type UserBinding,
  type PagedResult,
  type VerificationDeps,
} from "./entitlementVerification.js";
import {
  assertFenceHeld,
  acquireLeaseWithWait,
  releaseLease,
  runBoundedApply,
  sourceLeaseScope,
  type LeaseHandle,
} from "./membershipLease.js";
import { loadMembershipConfig } from "./membershipTiming.js";
import { notifyUserAccessRevoked } from "./userNotify.js";
import type { VerifiedLifetimePurchase, VerifiedSubscription } from "./entitlementVerification.js";
import type { EntitlementSourceType } from "@workspace/db/schema";
import {
  applyDisputeTransition,
  applySubscriptionSource,
  createLifetimeSource,
  findSourceByProviderRef,
  markLifetimeRefunded,
  recomputeMembership,
} from "./membershipSources.js";
import { logger } from "./logger.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Deps.
// ---------------------------------------------------------------------------

export function makeVerificationDeps(stripe: Stripe): VerificationDeps {
  const retriever: EntitlementRetriever = {
    retrieveProduct: (id) => stripe.products.retrieve(id),
    retrieveCheckoutSession: (id) => stripe.checkout.sessions.retrieve(id),
    listCheckoutLineItems: (sessionId, params) =>
      stripe.checkout.sessions.listLineItems(sessionId, {
        ...params,
        expand: ["data.price.product"],
      }),
    retrievePaymentIntent: (id) => stripe.paymentIntents.retrieve(id),
    retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
    listSubscriptionItems: (subscriptionId, params) =>
      stripe.subscriptionItems.list({
        subscription: subscriptionId,
        ...params,
        expand: ["data.price.product"],
      }),
  };

  const binding: UserBinding = {
    async findUserIdByCustomerId(customerId) {
      const [row] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.stripeCustomerId, customerId))
        .limit(1);
      return row?.id ?? null;
    },
    async linkCustomerToUser(userId, customerId) {
      // Only ever links a user who has NO customer yet. `WHERE stripe_customer_id
      // IS NULL` is what makes that true under concurrency, rather than a
      // read-then-write that two requests can both pass. `eq(col, null)`
      // compiles to `col = $1` with a null parameter, which SQL never treats as
      // true regardless of the row's actual value — this must be `isNull`.
      const result = await db
        .update(usersTable)
        .set({ stripeCustomerId: customerId })
        .where(and(eq(usersTable.id, userId), isNull(usersTable.stripeCustomerId)))
        .returning({ id: usersTable.id });
      return result.length > 0;
    },
  };

  return { retriever, binding };
}

// ---------------------------------------------------------------------------
// Grace episode start — the first FAILED attempt, never the invoice's creation.
// ---------------------------------------------------------------------------

/**
 * Resolve when the current delinquency episode began.
 *
 * "14 days from first failure" is unimplementable from the subscription alone:
 * the pinned `Subscription` carries no first-failure or status-transition
 * timestamp. And the obvious invoice fields are all wrong —
 * `Invoice.created` is object creation (its own type comment warns an invoice is
 * not attempted until an hour later), `attempted` is a boolean with no
 * timestamp, and `status_transitions` has no failed-attempt time at all.
 *
 * So: the episode began with the earliest still-unpaid invoice in the
 * CONTIGUOUS run of unpaid invoices ending at the present — so a previous,
 * resolved delinquency cannot backdate a new one — and its anchor is that
 * invoice's **first failed charge**, not its latest. Anchoring to the latest
 * restarts the 14-day window on every dunning retry, so a permanently failing
 * card would never expire.
 *
 * Returns null when no attempt is resolvable. The caller then derives NO
 * deadline and reports the case: a guessed start can only be early, and early
 * means revoking a paying customer.
 */
export async function resolveGraceEpisodeStart(
  stripe: Stripe,
  subscriptionId: string,
): Promise<{ startedAt: Date } | { startedAt: null; reason: string }> {
  let invoices: Stripe.Invoice[];
  try {
    const page = await stripe.invoices.list({
      subscription: subscriptionId,
      limit: PAGE_SIZE,
    });
    invoices = page.data;
  } catch (error) {
    return { startedAt: null, reason: `invoice list failed: ${(error as Error).message}` };
  }

  // `list` returns newest first. Walk back from the present and stop at the first
  // invoice that is NOT unpaid — everything after it belongs to an earlier,
  // resolved delinquency.
  const unpaidRun: Stripe.Invoice[] = [];
  for (const invoice of invoices) {
    const unpaid = invoice.status === "open" || invoice.status === "uncollectible";
    if (!unpaid) break;
    unpaidRun.push(invoice);
  }

  if (unpaidRun.length === 0) {
    return { startedAt: null, reason: "no unpaid invoice in the current run" };
  }

  const episodeInvoice = unpaidRun[unpaidRun.length - 1];

  const paymentIntentId = await firstPaymentIntentForInvoice(stripe, episodeInvoice.id!);
  if (!paymentIntentId) {
    return { startedAt: null, reason: `no payment intent for invoice ${episodeInvoice.id}` };
  }

  const charges = await listAllCharges(stripe, paymentIntentId);
  if (!charges.complete) {
    // An incomplete list cannot support "this is the earliest".
    return { startedAt: null, reason: `charge list incomplete: ${charges.reason}` };
  }

  const failed = charges.items.filter((charge) => charge.status === "failed");
  if (failed.length === 0) {
    return { startedAt: null, reason: "no failed charge on the episode invoice" };
  }

  // `created` is whole-second, so two failures in one second tie; list position
  // is stable and either yields the same second.
  const earliest = failed.reduce((min, charge) => (charge.created < min.created ? charge : min));
  return { startedAt: new Date(earliest.created * 1000) };
}

async function firstPaymentIntentForInvoice(
  stripe: Stripe,
  invoiceId: string,
): Promise<string | null> {
  try {
    // In this API version an invoice's PaymentIntent is reached through
    // `invoice_payments`, not a top-level `payment_intent` field.
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: PAGE_SIZE });
    for (const payment of payments.data) {
      const intent = payment.payment?.payment_intent;
      if (typeof intent === "string") return intent;
      if (intent && typeof intent === "object") return intent.id;
    }
  } catch (error) {
    logger.warn({ err: error, invoiceId }, "could not list invoice payments for the grace anchor");
  }
  return null;
}

/** Every charge on a PaymentIntent, or an explicit "could not read them all". */
async function listAllCharges(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<PagedResult<Stripe.Charge>> {
  return listAllPages<Stripe.Charge>((params) =>
    stripe.charges.list({ payment_intent: paymentIntentId, ...params }),
  );
}

// ---------------------------------------------------------------------------
// Prepare, then apply.
// ---------------------------------------------------------------------------

/**
 * The two phases, kept apart by the type system rather than by discipline.
 *
 * The webhook path must claim idempotency and perform every domain write in ONE
 * transaction — otherwise a handler throw leaves the claim committed and Stripe's
 * retry sees an already-processed event, so the work never happens. But invariant
 * 1 forbids holding a transaction across network I/O, and the domain handlers
 * retrieve from Stripe. Both requirements have to hold at once.
 *
 * So: **prepare** does every retrieval and acquires the per-source lease with no
 * transaction open, and produces a plain description of the intended writes.
 * **apply** takes a transaction executor and performs them, with no network call
 * in it at all. A `Prepared` value carries no Stripe client, so an apply step
 * cannot reach the network even by mistake.
 */
export type Prepared =
  | {
      kind: "subscription";
      lease: LeaseHandle;
      verified: VerifiedSubscription;
      graceStartedAt: Date | null;
      graceUnresolvedReason?: string;
      transitionEvent?: string;
    }
  | { kind: "lifetime_purchase"; lease: LeaseHandle; verified: VerifiedLifetimePurchase }
  | {
      kind: "lifetime_refund";
      lease: LeaseHandle;
      paymentIntentId: string;
      amountRefunded: number;
      chargeAmount: number;
      currency: string;
    }
  | {
      kind: "dispute";
      lease: LeaseHandle;
      dispute: Stripe.Dispute;
      sourceType: "stripe_subscription" | "stripe_lifetime_payment";
      providerRef: string;
    }
  | { kind: "noop"; reason: string };

/**
 * A notification the apply phase decided to send, executed only AFTER the
 * transaction commits.
 *
 * Eligibility is decided from the locked PRE-mutation state at the moment the
 * transition is applied. Recomputing it after the commit would read post-mutation
 * state and change behaviour — the refund email would stop being sent at all,
 * because by then the user is already `registered`.
 *
 * The list is transient and in memory. A crash between commit and execution
 * loses it, and that loss is accepted: these are best-effort courtesy emails,
 * exactly as unguaranteed as they are today.
 */
export interface NotificationAction {
  kind: "access_revoked";
  userId: string;
  reason: "refund" | "dispute_opened" | "dispute_lost";
}

export interface ApplyResult {
  applied: boolean;
  userId: string | null;
  reason?: string;
  notifications: NotificationAction[];
}

const NOTHING: ApplyResult = { applied: false, userId: null, notifications: [] };

async function claimLease(
  sourceType: EntitlementSourceType,
  providerRef: string,
): Promise<LeaseHandle | null> {
  const config = await loadMembershipConfig();
  return acquireLeaseWithWait(
    sourceLeaseScope(sourceType, providerRef),
    config.lease_ttl_seconds,
    config.lease_waiter_timeout_seconds,
  );
}

/** Release whatever lease a prepared write is holding. Safe to call on a no-op. */
export async function releasePrepared(prepared: Prepared): Promise<void> {
  if (prepared.kind === "noop") return;
  await releaseLease(prepared.lease).catch((error) => {
    logger.warn({ err: error, scope: prepared.lease.scope }, "failed to release entitlement lease");
  });
}

// ---------------------------------------------------------------------------
// Prepare.
// ---------------------------------------------------------------------------

/**
 * Retrieve a subscription's CURRENT state and take its lease.
 *
 * Used for `customer.subscription.created`, `.updated` and `.deleted`, for
 * `invoice.payment_failed`, after every Stripe-mutating route, by the admin
 * soft-delete and reinstatement, and by reconciliation. One path, so the local
 * row cannot diverge by which event happened to arrive, or in what order.
 */
export async function prepareSubscriptionRefresh(
  stripe: Stripe,
  subscriptionId: string,
  opts: { expectedUserId?: string; linkHintUserId?: string; transitionEvent?: string } = {},
): Promise<Prepared> {
  const lease = await claimLease("stripe_subscription", subscriptionId);
  if (!lease) {
    // The waiter timed out. Abandon the write rather than proceed unordered —
    // reconciliation repairs it. That is why the timeout may be short.
    logger.info({ subscriptionId }, "subscription source busy — write abandoned, reconciliation will repair");
    return { kind: "noop", reason: "source_busy" };
  }

  try {
    const verified = await verifyMembershipSubscription(subscriptionId, makeVerificationDeps(stripe), {
      ...(opts.expectedUserId ? { expectedUserId: opts.expectedUserId } : {}),
      ...(opts.linkHintUserId ? { linkHintUserId: opts.linkHintUserId } : {}),
    });

    if (!verified.ok) {
      await releaseLease(lease);
      logger.warn(
        { subscriptionId, code: verified.code, detail: verified.detail },
        "subscription refresh could not be prepared",
      );
      return { kind: "noop", reason: verified.code };
    }

    // The grace anchor needs its own Stripe calls, so it belongs here with the
    // rest of the retrieval — never inside the apply transaction.
    let graceStartedAt: Date | null = null;
    let graceUnresolvedReason: string | undefined;
    if (verified.lifecycleStatus === "past_due") {
      const grace = await resolveGraceEpisodeStart(stripe, subscriptionId);
      if (grace.startedAt) {
        graceStartedAt = grace.startedAt;
      } else {
        graceUnresolvedReason = grace.reason;
        logger.warn(
          { subscriptionId, reason: grace.reason },
          "past_due subscription has no resolvable first failed attempt — no grace deadline derived, " +
            "the source keeps qualifying and the case is reported",
        );
      }
    }

    return {
      kind: "subscription",
      lease,
      verified,
      graceStartedAt,
      ...(graceUnresolvedReason ? { graceUnresolvedReason } : {}),
      ...(opts.transitionEvent ? { transitionEvent: opts.transitionEvent } : {}),
    };
  } catch (error) {
    await releaseLease(lease);
    throw error;
  }
}

/**
 * Verify a completed one-time membership purchase from a session id.
 *
 * The signature is a session ID and nothing else. The path it replaces built a
 * PaymentIntent literal — `{ id, status: "succeeded", amount, currency }` — from
 * event fields and handed it to a helper whose whole contract was "this is proof
 * of payment". A structurally-valid lie, accepted because the signature allowed
 * one.
 */
export async function prepareOneTimeCheckout(
  stripe: Stripe,
  sessionId: string,
  opts: { expectedUserId?: string } = {},
): Promise<Prepared> {
  const verified = await verifyOneTimeMembershipPurchase(sessionId, makeVerificationDeps(stripe), opts);

  if (!verified.ok) {
    logger.warn({ sessionId, code: verified.code, detail: verified.detail }, "one-time purchase not applied");
    return { kind: "noop", reason: verified.code };
  }

  if (!verified.isMembershipProduct) {
    // Merch or credits. Not an error, and no entitlement source: recording one
    // would put a non-qualifying row in the model for every non-membership sale.
    return { kind: "noop", reason: "not_membership_product" };
  }

  const lease = await claimLease("stripe_lifetime_payment", verified.providerRef);
  if (!lease) return { kind: "noop", reason: "source_busy" };

  return { kind: "lifetime_purchase", lease, verified };
}

/**
 * A refunded charge. `chargeAmount` is what makes partial distinguishable from
 * full, and its absence from the old handler's destructured parameter is exactly
 * why that handler could not tell them apart.
 */
export async function prepareLifetimeRefund(input: {
  paymentIntentId: string;
  amountRefunded: number;
  chargeAmount: number;
  currency: string;
}): Promise<Prepared> {
  const lease = await claimLease("stripe_lifetime_payment", input.paymentIntentId);
  if (!lease) return { kind: "noop", reason: "source_busy" };
  return { kind: "lifetime_refund", lease, ...input };
}

/**
 * The one preparation `charge.dispute.created`, `.updated` and `.closed` all go
 * through — and the one reconciliation uses to repair a missed `lost`.
 *
 * The dispute is re-fetched authoritatively rather than trusted from the event
 * payload, which may be an out-of-order delivery carrying an older status.
 */
export async function prepareDisputeEvent(
  stripe: Stripe,
  disputeId: string,
): Promise<Prepared> {
  let dispute: Stripe.Dispute;
  try {
    dispute = await stripe.disputes.retrieve(disputeId);
  } catch (error) {
    logger.warn({ err: error, disputeId }, "could not retrieve dispute");
    return { kind: "noop", reason: "retrieval_failed" };
  }

  const located = await locateDisputedSource(stripe, dispute);
  if (!located) {
    // Nothing held, and reported. The uncertainty is about WHAT this is, not
    // about whether the customer is entitled, and an indefinite hold nobody can
    // clear is a worse failure than a reported gap.
    logger.warn({ disputeId }, "dispute could not be mapped to an entitlement source — nothing held");
    return { kind: "noop", reason: "source_unknown" };
  }

  const lease = await claimLease(located.sourceType, located.providerRef);
  if (!lease) return { kind: "noop", reason: "source_busy" };

  return { kind: "dispute", lease, dispute, ...located };
}

// ---------------------------------------------------------------------------
// Apply — one transaction, no network.
// ---------------------------------------------------------------------------

/**
 * Perform the prepared writes inside the caller's transaction.
 *
 * Begins by re-checking the lease fence, so a holder whose lease expired while it
 * was retrieving is aborted rather than admitted. The version guard cannot cover
 * that case: a successor still retrieving has stored no newer token to compare
 * against.
 */
export async function applyPrepared(tx: Tx, prepared: Prepared): Promise<ApplyResult> {
  if (prepared.kind === "noop") return { ...NOTHING, reason: prepared.reason };

  await assertFenceHeld(tx, prepared.lease);

  switch (prepared.kind) {
    case "subscription":
      return applySubscription(tx, prepared);
    case "lifetime_purchase":
      return applyLifetimePurchase(tx, prepared);
    case "lifetime_refund":
      return applyRefund(tx, prepared);
    case "dispute":
      return applyDispute(tx, prepared);
  }
}

async function applySubscription(
  tx: Tx,
  prepared: Extract<Prepared, { kind: "subscription" }>,
): Promise<ApplyResult> {
  const { verified } = prepared;

  const { created } = await applySubscriptionSource(
    tx,
    {
      sourceType: "stripe_subscription",
      userId: verified.userId,
      providerRef: verified.providerRef,
      isMembershipProduct: verified.isMembershipProduct,
      lifecycleStatus: verified.lifecycleStatus,
      plan: verified.plan,
      currentPeriodEnd: verified.currentPeriodEnd,
      cancelAtPeriodEnd: verified.cancelAtPeriodEnd,
    },
    { graceStartedAt: prepared.graceStartedAt },
  );

  if (created) {
    // A payment FACT, recorded whether or not the tier moved — same reasoning
    // as `lifetime_purchase` in `applyLifetimePurchase`. Gating this on
    // `recomputeMembership`'s tier-changed check would silently drop it
    // whenever `checkout.session.completed` had already applied the tier
    // change moments earlier (or a subscription arrives via `created` with no
    // preceding checkout event at all) — the fact that a subscription became
    // active is true independent of whether it was the source that flipped
    // the tier.
    await tx.insert(membershipHistoryTable).values({
      userId: verified.userId,
      event: "subscription_activated",
      plan: verified.plan ?? undefined,
      stripeSubscriptionId: verified.providerRef,
    });
  }

  const result = await recomputeMembership(tx, verified.userId, {
    ...(prepared.transitionEvent
      ? {
          transitionEvent: {
            event: prepared.transitionEvent,
            stripeSubscriptionId: verified.providerRef,
          },
        }
      : {}),
  });

  return { applied: true, userId: verified.userId, notifications: [], ...(result ? {} : {}) };
}

async function applyLifetimePurchase(
  tx: Tx,
  prepared: Extract<Prepared, { kind: "lifetime_purchase" }>,
): Promise<ApplyResult> {
  const { verified } = prepared;

  const { created } = await createLifetimeSource(tx, {
    sourceType: "stripe_lifetime_payment",
    userId: verified.userId,
    providerRef: verified.providerRef,
    isMembershipProduct: true,
    lifecycleStatus: "active",
    amount: verified.amount,
    currency: verified.currency,
  });

  if (created) {
    // A payment FACT, recorded whether or not the tier moved — the user may
    // already have been Legendary via a subscription, and the purchase still
    // happened.
    await tx.insert(membershipHistoryTable).values({
      userId: verified.userId,
      event: "lifetime_purchase",
      amount: verified.amount,
      currency: verified.currency,
      stripePaymentIntentId: verified.providerRef,
    });
  }

  await recomputeMembership(tx, verified.userId);
  return { applied: created, userId: verified.userId, notifications: [] };
}

async function applyRefund(
  tx: Tx,
  prepared: Extract<Prepared, { kind: "lifetime_refund" }>,
): Promise<ApplyResult> {
  const source = await findSourceByProviderRef(tx, "stripe_lifetime_payment", prepared.paymentIntentId);
  if (!source) return { ...NOTHING, reason: "source_unknown" };

  // Settled decision 6: a partial refund does not revoke a full entitlement. A
  // customer refunded part of a purchase has not stopped being entitled to it.
  const isFullRefund = prepared.amountRefunded >= prepared.chargeAmount;

  await tx.insert(membershipHistoryTable).values({
    userId: source.userId,
    event: isFullRefund ? "refund" : "partial_refund",
    amount: prepared.amountRefunded,
    currency: prepared.currency,
    stripePaymentIntentId: prepared.paymentIntentId,
  });

  if (!isFullRefund) {
    return { applied: false, userId: source.userId, reason: "partial_refund", notifications: [] };
  }

  await markLifetimeRefunded(tx, prepared.paymentIntentId);
  const result = await recomputeMembership(tx, source.userId, {
    transitionEvent: { event: "refund", stripePaymentIntentId: prepared.paymentIntentId },
  });

  // Decided here, from the locked pre-state, and executed after the commit.
  const notifications: NotificationAction[] =
    result && result.previousTier === "legendary" && result.tier !== "legendary"
      ? [{ kind: "access_revoked", userId: source.userId, reason: "refund" }]
      : [];

  return { applied: true, userId: source.userId, notifications };
}

async function applyDispute(
  tx: Tx,
  prepared: Extract<Prepared, { kind: "dispute" }>,
): Promise<ApplyResult> {
  const source = await findSourceByProviderRef(tx, prepared.sourceType, prepared.providerRef);
  if (!source) return { ...NOTHING, reason: "source_unknown" };

  const outcome = await applyDisputeTransition(tx, {
    stripeDisputeId: prepared.dispute.id,
    status: prepared.dispute.status,
    sourceId: source.id,
  });

  if (outcome.outcome !== "applied") {
    // Deliberately not an error: raising one would roll back the claim and
    // Stripe would retry the same anomaly indefinitely, turning an observation
    // into a stuck event.
    logger.warn({ disputeId: prepared.dispute.id, outcome }, "dispute transition was not applied");
    return { applied: false, userId: source.userId, reason: outcome.outcome, notifications: [] };
  }

  const status = prepared.dispute.status;
  const transitionEvent =
    status === "lost"
      ? "dispute_lost"
      : status === "won"
        ? "dispute_won"
        : outcome.isTerminal
          ? "dispute_closed"
          : "dispute_opened";

  const result = await recomputeMembership(tx, source.userId, {
    transitionEvent: { event: transitionEvent, stripeDisputeId: prepared.dispute.id },
  });

  // Only when access was actually lost HERE. In the common path `created`
  // already held the source, so a later `lost` sends nothing; the fallback path
  // — `created` never delivered — is the one that needs it.
  const lostAccess = !!result && result.previousTier === "legendary" && result.tier !== "legendary";
  const notifications: NotificationAction[] =
    lostAccess && (transitionEvent === "dispute_opened" || transitionEvent === "dispute_lost")
      ? [{ kind: "access_revoked", userId: source.userId, reason: transitionEvent }]
      : [];

  return { applied: true, userId: source.userId, reason: transitionEvent, notifications };
}

// ---------------------------------------------------------------------------
// Convenience wrapper for the callers that own their own transaction.
// ---------------------------------------------------------------------------

/**
 * prepare -> its own transaction -> apply -> release.
 *
 * For every caller outside the webhook: the Stripe-mutating routes, the admin
 * soft-delete, reinstatement and reconciliation. The webhook does NOT use this —
 * it needs the apply to share the transaction that claims idempotency.
 */
export async function refreshSubscriptionSource(
  stripe: Stripe,
  subscriptionId: string,
  opts: { expectedUserId?: string; linkHintUserId?: string; transitionEvent?: string } = {},
): Promise<ApplyResult> {
  const prepared = await prepareSubscriptionRefresh(stripe, subscriptionId, opts);
  try {
    const result = await runBoundedApply((tx) => applyPrepared(tx, prepared));
    await runNotifications(result.notifications);
    return result;
  } finally {
    await releasePrepared(prepared);
  }
}

/** Refresh every Stripe-backed source a user holds, then recompute once. */
export async function refreshAllSourcesForUser(
  stripe: Stripe,
  userId: string,
): Promise<{ refreshed: number; failed: number }> {
  const sources = await db
    .select({
      sourceType: membershipEntitlementsTable.sourceType,
      providerRef: membershipEntitlementsTable.providerRef,
    })
    .from(membershipEntitlementsTable)
    .where(eq(membershipEntitlementsTable.userId, userId));

  let refreshed = 0;
  let failed = 0;

  for (const source of sources) {
    if (source.sourceType !== "stripe_subscription" || !source.providerRef) continue;
    try {
      const outcome = await refreshSubscriptionSource(stripe, source.providerRef);
      if (outcome.applied) refreshed += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, userId, providerRef: source.providerRef }, "source refresh failed");
    }
  }

  // Recompute unconditionally: even when nothing refreshed, the horizon may have
  // lapsed since the stored value was written.
  await db.transaction(async (tx) => {
    await recomputeMembership(tx, userId);
  });

  return { refreshed, failed };
}

/** Execute post-commit notifications. Best-effort by construction. */
export async function runNotifications(actions: NotificationAction[]): Promise<void> {
  for (const action of actions) {
    if (action.kind === "access_revoked") {
      void notifyUserAccessRevoked(action.userId, action.reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Dispute source mapping.
// ---------------------------------------------------------------------------

/**
 * Map a dispute to the EXACT source it attaches to.
 *
 * A hold on the wrong source revokes the wrong thing, so this resolves a SOURCE
 * and not, as the path it replaces did, merely a user:
 *   - lifetime — payment_intent -> the `stripe_lifetime_payment` source;
 *   - subscription — payment_intent -> invoice payment -> invoice ->
 *     subscription -> that source.
 *
 * The subscription walk goes through `invoice_payments` rather than
 * `charge.invoice`: in this API version a `Charge` carries no invoice link at
 * all, and `invoicePayments.list({ payment: { payment_intent } })` is the
 * supported reverse lookup.
 */
async function locateDisputedSource(
  stripe: Stripe,
  dispute: Stripe.Dispute,
): Promise<{ sourceType: "stripe_subscription" | "stripe_lifetime_payment"; providerRef: string } | null> {
  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : (dispute.payment_intent?.id ?? null);

  if (!paymentIntentId) return null;

  const lifetime = await findSourceByProviderRef(db, "stripe_lifetime_payment", paymentIntentId);
  if (lifetime) return { sourceType: "stripe_lifetime_payment", providerRef: paymentIntentId };

  try {
    const payments = await stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntentId },
      limit: PAGE_SIZE,
    });

    for (const payment of payments.data) {
      const invoiceId = typeof payment.invoice === "string" ? payment.invoice : payment.invoice?.id;
      if (!invoiceId) continue;

      const invoice = await stripe.invoices.retrieve(invoiceId);
      const subscriptionId = subscriptionIdForInvoice(invoice);
      if (!subscriptionId) continue;

      const source = await findSourceByProviderRef(db, "stripe_subscription", subscriptionId);
      if (source) return { sourceType: "stripe_subscription", providerRef: subscriptionId };
    }
  } catch (error) {
    logger.warn(
      { err: error, disputeId: dispute.id },
      "could not walk payment intent -> invoice -> subscription for the dispute",
    );
  }

  return null;
}

function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  const shape = invoice as Stripe.Invoice & {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
    subscription?: string | { id: string };
  };
  const fromParent = shape.parent?.subscription_details?.subscription;
  if (typeof fromParent === "string") return fromParent;
  if (fromParent && typeof fromParent === "object") return fromParent.id;

  const legacy = shape.subscription;
  if (typeof legacy === "string") return legacy;
  if (legacy && typeof legacy === "object") return legacy.id;
  return null;
}
