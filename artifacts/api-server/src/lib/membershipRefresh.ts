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
import {
  loadMembershipConfig,
  startRetrievalDeadline,
  type RetrievalDeadline,
} from "./membershipTiming.js";
import { checkoutLineItemsGrantMembership } from "./membershipPricing.js";
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
/** Same bound `listAllPages` applies; a truncated walk cannot support "this is the earliest". */
const MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// Deps.
// ---------------------------------------------------------------------------

/**
 * @param deadline When the caller holds a lease across this retrieval, the phase
 * budget that lease was sized against. Every method below consults it before
 * issuing, which is what makes the bound complete rather than best-effort: the
 * retriever is the verifier's ONLY route to Stripe (that is the whole point of
 * W1a taking identifiers), so a check here cannot be bypassed by a call site
 * that forgot one. Omitted by callers that take their lease AFTER retrieving —
 * `prepareOneTimeCheckout` and `prepareDisputeEvent` both have to learn the
 * provider ref before they can name the lease scope, so nothing is being held
 * while they read.
 */
export function makeVerificationDeps(
  stripe: Stripe,
  deadline?: RetrievalDeadline,
): VerificationDeps {
  const gated = <T>(label: string, call: () => Promise<T>): Promise<T> => {
    deadline?.assertCanIssue(label);
    return call();
  };

  const retriever: EntitlementRetriever = {
    retrieveProduct: (id) => gated("products.retrieve", () => stripe.products.retrieve(id)),
    retrieveCheckoutSession: (id) =>
      gated("checkout.sessions.retrieve", () => stripe.checkout.sessions.retrieve(id)),
    listCheckoutLineItems: (sessionId, params) =>
      gated("checkout.sessions.listLineItems", () =>
        stripe.checkout.sessions.listLineItems(sessionId, {
          ...params,
          expand: ["data.price.product"],
        }),
      ),
    retrievePaymentIntent: (id) =>
      gated("paymentIntents.retrieve", () => stripe.paymentIntents.retrieve(id)),
    retrieveSubscription: (id) =>
      gated("subscriptions.retrieve", () => stripe.subscriptions.retrieve(id)),
    listSubscriptionItems: (subscriptionId, params) =>
      gated("subscriptionItems.list", () =>
        stripe.subscriptionItems.list({
          subscription: subscriptionId,
          ...params,
          expand: ["data.price.product"],
        }),
      ),
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
  deadline?: RetrievalDeadline,
): Promise<{ startedAt: Date } | { startedAt: null; reason: string }> {
  // `list` returns newest first. Walk back from the present and stop at the first
  // invoice that is NOT unpaid — everything after it belongs to an earlier,
  // resolved delinquency.
  //
  // PAGINATED, not one page: an episode longer than a page would otherwise end at
  // the oldest invoice we happened to fetch rather than at the episode's own
  // first unpaid invoice, moving the 14-day start FORWARD and extending access
  // past the settled first-failure boundary. Reaching the page bound without
  // finding the boundary is an explicit incomplete result, never a guess.
  //
  // These lists are the reason a per-REQUEST budget could not bound the phase:
  // they run after the verifier has already spent an unknown share of it, and
  // they paginate. An exhausted budget surfaces here as "no resolvable start",
  // which is the already-correct safe direction — no deadline is derived, the
  // source keeps qualifying, and the case is reported rather than guessed.
  const unpaidRun: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;
  let episodeBoundaryFound = false;

  for (let page = 0; page < MAX_PAGES && !episodeBoundaryFound; page += 1) {
    let response: Stripe.ApiList<Stripe.Invoice>;
    try {
      deadline?.assertCanIssue("invoices.list");
      response = await stripe.invoices.list({
        subscription: subscriptionId,
        limit: PAGE_SIZE,
        starting_after: startingAfter,
      });
    } catch (error) {
      return { startedAt: null, reason: `invoice list failed: ${(error as Error).message}` };
    }

    for (const invoice of response.data) {
      const unpaid = invoice.status === "open" || invoice.status === "uncollectible";
      if (!unpaid) {
        episodeBoundaryFound = true;
        break;
      }
      unpaidRun.push(invoice);
    }
    if (episodeBoundaryFound) break;

    // Running off the end of the subscription's whole invoice history is also a
    // boundary: the episode began with its very first invoice.
    if (!response.has_more) {
      episodeBoundaryFound = true;
      break;
    }

    const last = response.data[response.data.length - 1];
    // has_more with an empty page would loop forever on the same cursor.
    if (!last) {
      return { startedAt: null, reason: "invoice pagination: has_more with no cursor to advance" };
    }
    startingAfter = last.id;
  }

  if (!episodeBoundaryFound) {
    return {
      startedAt: null,
      reason: `invoice pagination bound (${MAX_PAGES} pages) reached before the episode start`,
    };
  }

  if (unpaidRun.length === 0) {
    return { startedAt: null, reason: "no unpaid invoice in the current run" };
  }

  const episodeInvoice = unpaidRun[unpaidRun.length - 1];

  const paymentIntentId = await firstPaymentIntentForInvoice(stripe, episodeInvoice.id!, deadline);
  if (!paymentIntentId) {
    return { startedAt: null, reason: `no payment intent for invoice ${episodeInvoice.id}` };
  }

  const charges = await listAllCharges(stripe, paymentIntentId, deadline);
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
  deadline?: RetrievalDeadline,
): Promise<string | null> {
  try {
    // In this API version an invoice's PaymentIntent is reached through
    // `invoice_payments`, not a top-level `payment_intent` field.
    deadline?.assertCanIssue("invoicePayments.list");
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

/**
 * Could this PaymentIntent still become a one-time membership source?
 *
 * The question `charge.refunded` has to answer before it may claim an event. A
 * lifetime source is only ever created by `prepareOneTimeCheckout`, from a
 * **payment-mode Checkout Session**, so the precise question is whether such a
 * session exists for this PaymentIntent — not whether the charge happens to be
 * invoice-backed.
 *
 * The invoice-linkage test that stood here was wrong, and wrong in the direction
 * that matters. The pinned API supports `invoice_creation` on payment-mode
 * sessions, so a one-time membership purchase CAN carry an invoice; treating
 * invoice linkage as proof of subscription billing would let a refund that
 * overtakes its own checkout event record audit-only and claim, after which the
 * checkout event still creates an ACTIVE lifetime source. That is precisely the
 * Legendary-forever ordering bug, reintroduced through a different door. Our own
 * checkout does not set `invoice_creation` today, which makes the defect latent
 * rather than live — but the verifier accepts any paid payment-mode session
 * carrying a membership product, so the invariant held only by a parameter we
 * happen to omit, which is the same shape of defect this whole model exists to
 * remove.
 *
 * `subscription`-mode sessions are deliberately excluded: those become
 * subscription sources, never lifetime ones.
 *
 * Throws rather than returning a verdict when the lookup fails — a failed read
 * must not be flattened into "no session", which is the answer that permits a
 * claim.
 */
export async function hasOneTimeCheckoutOrigin(
  stripe: Stripe,
  paymentIntentId: string,
  deadline?: RetrievalDeadline,
): Promise<boolean> {
  deadline?.assertCanIssue("checkout.sessions.list");
  const sessions = await stripe.checkout.sessions.list({
    payment_intent: paymentIntentId,
    limit: PAGE_SIZE,
  });

  const deps = makeVerificationDeps(stripe, deadline);

  for (const session of sessions.data) {
    if (session.mode !== "payment") continue;

    // Mode alone is not enough. `prepareOneTimeCheckout` refuses a session whose
    // line items are not membership products (`not_membership_product`), so a
    // merch or credits checkout can never produce a lifetime source however many
    // payment-mode sessions it has. Answering true for one would make its refund
    // retry on every delivery, never claim, and finally vanish from the refunds
    // surface when Stripe gives up — an audit row lost to a permanent
    // "ordering ambiguity" that was never ambiguous.
    const lineItems = await listAllPages<Stripe.LineItem>((params) =>
      deps.retriever.listCheckoutLineItems(session.id, params),
    );
    // An incomplete list cannot support the NEGATIVE conclusion "this could
    // never be a membership purchase", so it takes the retryable side.
    if (!lineItems.complete) return true;

    if (await checkoutLineItemsGrantMembership(lineItems.items, deps.retriever)) return true;
  }

  return false;
}

/**
 * The invoice a PaymentIntent paid, or null when it paid no invoice at all.
 *
 * Used for the receipt link on a subscription refund's history row. `Charge`
 * carries no `invoice` field in this API version — the cast that used to read
 * one always produced `undefined` — so it has to be looked up rather than read
 * off the event.
 *
 * NOT a classifier. See `hasOneTimeCheckoutOrigin` for why invoice linkage
 * cannot decide whether a charge is a one-time membership purchase.
 *
 * A `null` return is only sound because it distinguishes "no invoice" from "the
 * lookup failed": a throw propagates rather than being flattened into null.
 */
export async function resolveInvoiceForPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
  deadline?: RetrievalDeadline,
): Promise<string | null> {
  deadline?.assertCanIssue("invoicePayments.list");
  const payments = await stripe.invoicePayments.list({
    payment: { payment_intent: paymentIntentId, type: "payment_intent" },
    limit: 1,
  });
  const invoice = payments.data[0]?.invoice;
  if (typeof invoice === "string") return invoice;
  if (invoice && typeof invoice === "object") return invoice.id ?? null;
  return null;
}

/** Every charge on a PaymentIntent, or an explicit "could not read them all". */
async function listAllCharges(
  stripe: Stripe,
  paymentIntentId: string,
  deadline?: RetrievalDeadline,
): Promise<PagedResult<Stripe.Charge>> {
  return listAllPages<Stripe.Charge>((params) => {
    // Per PAGE, not per call: MAX_PAGES is a correctness bound (a truncated list
    // cannot support "this is the earliest failure"), not a timing one, so
    // nothing else stops twenty pages from outliving the lease.
    deadline?.assertCanIssue("charges.list");
    return stripe.charges.list({ payment_intent: paymentIntentId, ...params });
  });
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
 *
 * This is the ONE prepare that takes its lease BEFORE retrieving, and that is
 * deliberate: the subscription id is known up front, so exactly one
 * retrieval-and-apply can be in flight per source. Retrieving first and taking
 * the lease after would let two concurrent deliveries both read, then apply in
 * lock-acquisition order — and since the version token is minted inside the
 * apply transaction, the LATER applier always wins the version guard even
 * holding the OLDER read. That is precisely the stale-overwrite this module's
 * header says re-retrieving exists to remove. The cost of holding the lease
 * across the read is that the read must be bounded, which is what the deadline
 * below does.
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

  // Started at the lease, not at the first request: what the lease has to
  // outlive is everything after it was taken.
  const deadline = startRetrievalDeadline();

  try {
    const verified = await verifyMembershipSubscription(
      subscriptionId,
      makeVerificationDeps(stripe, deadline),
      {
        ...(opts.expectedUserId ? { expectedUserId: opts.expectedUserId } : {}),
        ...(opts.linkHintUserId ? { linkHintUserId: opts.linkHintUserId } : {}),
      },
    );

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
      const grace = await resolveGraceEpisodeStart(stripe, subscriptionId, deadline);
      if (grace.startedAt) {
        graceStartedAt = grace.startedAt;
      } else {
        // Unresolvable is SAFE only when there is no stored episode to inherit.
        // Then no deadline is derived, the source keeps qualifying, and the case
        // is reported — a guessed start can only be early, and early means
        // revoking a paying customer.
        //
        // With ANY stored episode, the fallback is that stored anchor, and we
        // cannot tell "the same episode, still running" from "a NEW episode we
        // failed to anchor because the recovery webhook was missed". Both
        // readings hurt: inheriting an already-expired anchor demotes on the
        // spot, and inheriting one with two days left gives the new episode two
        // days instead of fourteen. Neither is repaired by anything.
        //
        // An earlier revision narrowed this to an already-expired deadline,
        // which caught only the louder half. The ambiguity is the stored episode
        // itself, so the condition is its existence — a transient exhaustion
        // then resolves on Stripe's next delivery and the new episode gets its
        // full window, and a permanently unresolvable one is audited rather than
        // silently decided against the customer.
        const existing = await findSourceByProviderRef(db, "stripe_subscription", subscriptionId);
        if (existing?.graceExpiresAt) {
          await releaseLease(lease);
          logger.warn(
            { subscriptionId, reason: grace.reason, storedDeadline: existing.graceExpiresAt },
            "past_due refresh could not resolve a fresh grace anchor while an episode is already " +
              "stored — ambiguous between the same episode and a new one, so retrying rather than deciding",
          );
          return { kind: "noop", reason: "grace_anchor_ambiguous" };
        }

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
 *
 * No retrieval deadline here, and that is not an oversight: the lease is taken
 * AFTER verification, because the PaymentIntent id that names its scope is one
 * of the things verification discovers. Nothing is held while this reads, so
 * there is no lease for a slow read to outlive. Anyone reordering this to take
 * the lease first owes it a deadline, as `prepareSubscriptionRefresh` has.
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
export async function applyPrepared(
  tx: Tx,
  prepared: Prepared,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  if (prepared.kind === "noop") return { ...NOTHING, reason: prepared.reason };

  await assertFenceHeld(tx, prepared.lease);

  switch (prepared.kind) {
    case "subscription":
      return applySubscription(tx, prepared, opts);
    case "lifetime_purchase":
      return applyLifetimePurchase(tx, prepared);
    case "lifetime_refund":
      return applyRefund(tx, prepared);
    case "dispute":
      return applyDispute(tx, prepared);
  }
}

export interface ApplyOptions {
  /**
   * A last check run INSIDE the apply transaction, while this user's row lock is
   * already held and before anything is mutated. Returning a reason aborts the
   * apply; returning null proceeds.
   */
  guard?: (tx: Tx, userId: string) => Promise<string | null>;
  /**
   * The instant BOTH the guard and the recompute it authorizes evaluate at.
   *
   * One timestamp, or they can disagree: a guard deriving at the run's start
   * can judge a grace-bound source still qualifying while the recompute moments
   * later — at `now()` — sees the same deadline expired, producing exactly the
   * downgrade the guard declined to admit.
   */
  asOf?: Date;
}

/**
 * Take this user's row lock — the same one `recomputeMembership` takes.
 *
 * Taken UNCONDITIONALLY by every apply that can move this user's effective
 * tier, and BEFORE the source write, not only when a guard is supplied. An
 * earlier revision locked only on the guarded path and claimed that made the
 * guard atomic; it did not. Every writer does take this lock eventually — but
 * inside `recomputeMembership`, i.e. AFTER mutating its own source. So an
 * unguarded writer B could write source B, then block on the lock, while
 * guarded reconciliation A held it, read B's still-uncommitted old state,
 * admitted A's cancellation and committed. B would then recompute both
 * cancellations into precisely the downgrade the guard was there to count.
 *
 * "Every writer takes the lock" was true and not sufficient. The property the
 * guard needs is that every writer takes it *before mutating*, which is only
 * true if this call is unconditional.
 */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .for("update")
    .limit(1);
}

async function applySubscription(
  tx: Tx,
  prepared: Extract<Prepared, { kind: "subscription" }>,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const { verified } = prepared;

  await lockUser(tx, verified.userId);

  if (opts.guard) {
    const veto = await opts.guard(tx, verified.userId);
    if (veto) {
      // Nothing written. The caller decides what a veto means for its own
      // accounting; here it is simply an apply that did not happen.
      return { applied: false, userId: verified.userId, reason: veto, notifications: [] };
    }
  }

  const { applied, created, previousLifecycleStatus } = await applySubscriptionSource(
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

  // Activation is a LIFECYCLE transition, not a row insert. Keying it on
  // `created` got both ends wrong: Stripe can deliver
  // `customer.subscription.created` while the subscription is still
  // `incomplete`, or the first event we see can retrieve an already-`canceled`
  // one — both wrote "activated" — while the later move to `active` had
  // `created === false` and wrote nothing at all.
  //
  // `past_due` counts as continuing rather than activating, so a recovery from
  // dunning is not reported as a fresh activation; a genuine reactivation out of
  // `canceled` or `incomplete` is.
  const ACTIVATING = new Set(["active", "trialing"]);
  const CONTINUING = new Set(["active", "trialing", "past_due"]);
  const becameActive =
    applied &&
    ACTIVATING.has(verified.lifecycleStatus) &&
    (previousLifecycleStatus === null || !CONTINUING.has(previousLifecycleStatus));

  if (becameActive) {
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
  } else if (
    applied &&
    previousLifecycleStatus !== null &&
    previousLifecycleStatus !== "canceled" &&
    verified.lifecycleStatus === "canceled"
  ) {
    // The same independence as `subscription_activated`, for the opposite
    // transition: a user holding a second qualifying source (another
    // subscription, a lifetime purchase, an admin grant) never loses the
    // aggregate tier when THIS subscription cancels, so gating the fact on
    // `recomputeMembership`'s tier-changed check would silently drop it for
    // exactly those users — even though the old handler always recorded a
    // subscription's own cancellation as a fact about that source.
    await tx.insert(membershipHistoryTable).values({
      userId: verified.userId,
      event: "subscription_cancelled",
      plan: verified.plan ?? undefined,
      stripeSubscriptionId: verified.providerRef,
    });
  }

  const result = await recomputeMembership(tx, verified.userId, {
    // The SAME instant the guard judged at — see ApplyOptions.asOf.
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
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

  await lockUser(tx, verified.userId);

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

  await lockUser(tx, source.userId);

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
  // The `refund` fact is already recorded unconditionally above — passing a
  // transitionEvent here too would insert it a second time whenever the
  // refund also changes the user's aggregate tier. recomputeMembership's
  // result is used only to decide the notification below.
  const result = await recomputeMembership(tx, source.userId);

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

  await lockUser(tx, source.userId);

  const outcome = await applyDisputeTransition(tx, {
    stripeDisputeId: prepared.dispute.id,
    status: prepared.dispute.status,
    sourceId: source.id,
  });

  // A no-op dispute-ROW upsert (already terminal, e.g. re-observed after a
  // prior `won`) is independent of the source's permanent loss-revocation
  // write, which is gated only on `disputeLossRevokedAt IS NULL` — so it can
  // still have just been written even though the dispute row itself no-opped.
  // Skipping recompute here would leave a permanently disqualified source
  // never demoting the stored tier.
  const lostRevocationWritten =
    outcome.outcome !== "unrecognised_status" &&
    outcome.outcome !== "source_unknown" &&
    outcome.lostRevocationWritten;

  if (outcome.outcome !== "applied" && !lostRevocationWritten) {
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
        : outcome.outcome === "applied" && outcome.isTerminal
          ? "dispute_closed"
          : "dispute_opened";

  // The dispute's outcome is a fact about the SOURCE, recorded whether or not
  // the user's aggregate tier moves — the same independence `lifetime_purchase`
  // and `subscription_activated` already have.
  //
  // Routing it through `recomputeMembership`'s tier-gated transition event lost
  // it in the ordinary sequence: `dispute_opened` has already demoted the user,
  // so the later `lost` changes no tier and wrote no row, leaving the payment
  // history and the admin dispute surface showing an open dispute Stripe had
  // already resolved. A user with a second qualifying source lost every dispute
  // outcome for the same reason.
  // The financial identifiers travel with the row. The handler this replaced
  // recorded amount, currency and the PaymentIntent id, and dropping them made
  // the Refunds & Disputes surface render an em dash for every dispute amount
  // and lose its payment link — a regression invisible from the database, since
  // the columns are nullable and `prepared.dispute` carries the values all
  // along.
  const disputePaymentIntentId =
    typeof prepared.dispute.payment_intent === "string"
      ? prepared.dispute.payment_intent
      : (prepared.dispute.payment_intent?.id ?? undefined);

  await tx.insert(membershipHistoryTable).values({
    userId: source.userId,
    event: transitionEvent,
    amount: prepared.dispute.amount,
    currency: prepared.dispute.currency,
    stripeDisputeId: prepared.dispute.id,
    stripePaymentIntentId: disputePaymentIntentId,
  });

  const result = await recomputeMembership(tx, source.userId);

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

/**
 * Refresh after a route has already mutated Stripe, and REPORT whether it stuck.
 *
 * `refreshSubscriptionSource` resolves for a retryable no-op just as it does for
 * a successful apply — `source_busy` when another writer holds the lease,
 * `retrieval_failed`, `incomplete_enumeration`, `grace_anchor_ambiguous`. The
 * three mutation routes discarded that result and answered 200 regardless, so a
 * cancel whose refresh lost the lease race left the local source describing the
 * pre-cancel state, and if the mutation's webhook was also missed it stayed that
 * way. The Stripe side of the response is still correct — the user sees the real
 * outcome — but the panel reads the local row on its next load.
 *
 * So: retry the retryable reasons a few times, and tell the caller if it never
 * applied. Deliberately does NOT throw: the Stripe mutation succeeded, and
 * failing the request would invite the user to retry an action that already
 * happened.
 */
/**
 * The whole post-mutation refresh, end to end. Sized so a mutation route stays
 * within an ordinary HTTP timeout even when every attempt waits out a lease.
 */
const POST_MUTATION_REFRESH_BUDGET_MS = 10_000;

/** Sentinel for "the deadline fired first". Distinct from any `ApplyResult`. */
const TIMED_OUT = Symbol("post-mutation refresh deadline") as unknown as ApplyResult;

/**
 * Await `work`, but give up after `ms` and let it finish on its own.
 *
 * Abandonment, not cancellation — there is no safe way to interrupt a refresh
 * mid-apply, and no need to: it is fenced, idempotent and lease-held, so the
 * worst case of letting it run is that it applies a moment after the caller
 * stopped waiting. The rejection handler is what keeps an abandoned failure from
 * surfacing as an unhandled rejection and taking the process down.
 */
async function withDeadline(
  work: Promise<ApplyResult>,
  ms: number,
  context: Record<string, unknown>,
): Promise<ApplyResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ApplyResult>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const winner = await Promise.race([work, timeout]);
    if (winner === TIMED_OUT) {
      logger.warn(
        { ...context, deadlineMs: ms },
        "post-mutation refresh exceeded its deadline — abandoning the wait, the refresh continues",
      );
      void work.catch((error) => {
        logger.warn({ err: error, ...context }, "abandoned post-mutation refresh later failed");
      });
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LOCAL_REFRESH_RETRY_REASONS = new Set([
  "source_busy",
  "retrieval_failed",
  "incomplete_enumeration",
  "grace_anchor_ambiguous",
]);

export async function refreshSubscriptionSourceAfterMutation(
  stripe: Stripe,
  subscriptionId: string,
  opts: { attempts?: number; delayMs?: number; budgetMs?: number } = {},
): Promise<{ applied: boolean; reason?: string }> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 200;
  // ONE wall-clock budget across every attempt, not a fresh one per attempt.
  //
  // Each attempt can independently wait the full lease-waiter timeout and then
  // spend a whole retrieval-phase budget, so three attempts at the supported
  // maxima would hold this request for minutes — an HTTP handler for a mutation
  // Stripe has ALREADY accepted, which is the worst place to be slow: the client
  // may time out and retry an operation that already happened.
  const budgetMs = opts.budgetMs ?? POST_MUTATION_REFRESH_BUDGET_MS;
  const startedAt = Date.now();
  const budgetSpent = () => Date.now() - startedAt >= budgetMs;

  let last: ApplyResult | null = null;
  let abandoned = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && budgetSpent()) {
      logger.warn(
        { subscriptionId, attempt, budgetMs },
        "post-mutation refresh budget spent — not starting another attempt",
      );
      break;
    }
    try {
      // Bounded WITHIN the attempt, not merely between attempts. A single
      // attempt can wait out the lease-waiter timeout and then spend a whole
      // retrieval-phase budget, so checking the clock only at the top of the
      // loop still let the FIRST attempt hold this handler for about a minute —
      // leaving the exact client-timeout-and-retry exposure the budget was
      // added to remove.
      //
      // The refresh is abandoned, not cancelled: it is already fenced,
      // idempotent and lease-held, so letting it finish in the background is
      // harmless and strictly better than tearing down a transaction mid-apply.
      // What the caller loses is only the ANSWER, which is precisely what
      // `localStateStale` reports.
      last = await withDeadline(
        refreshSubscriptionSource(stripe, subscriptionId),
        Math.max(0, budgetMs - (Date.now() - startedAt)),
        { subscriptionId, attempt },
      );
      if (last === TIMED_OUT) {
        abandoned = true;
        last = null;
        break;
      }
    } catch (error) {
      logger.warn({ err: error, subscriptionId, attempt }, "post-mutation refresh threw");
      last = null;
    }

    if (last?.applied) return { applied: true };
    if (last && !LOCAL_REFRESH_RETRY_REASONS.has(last.reason ?? "")) break;
    if (attempt < attempts - 1 && !budgetSpent()) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const reason = abandoned ? "budget_exhausted" : (last?.reason ?? "refresh_threw");
  logger.error(
    { subscriptionId, reason, attempts },
    "post-mutation refresh never applied — the Stripe mutation succeeded but the local entitlement " +
      "source may be stale until its webhook arrives",
  );
  return { applied: false, reason };
}

/**
 * Bring a lifetime source's refund state up to date from Stripe.
 *
 * The counterpart to `refreshSubscriptionSource` for the other paid source type.
 * A lifetime purchase's local row is frozen at creation apart from one
 * transition — `active` → `refunded` — so this asks Stripe the only question
 * that can have changed: has the payment been refunded in full?
 *
 * `verified: false` means the answer could not be established, never that the
 * purchase is fine. Callers that fail closed depend on that distinction.
 */
export async function refreshLifetimePaymentSource(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<{ verified: boolean; refunded: boolean }> {
  const charges = await listAllCharges(stripe, paymentIntentId);
  if (!charges.complete) {
    // A negative conclusion ("not refunded") over an incomplete list is exactly
    // the unsound one.
    logger.warn(
      { paymentIntentId, reason: charges.reason },
      "could not read every charge for a lifetime source — treating as unverified",
    );
    return { verified: false, refunded: false };
  }

  const fullyRefunded = charges.items.some(
    (charge) => charge.refunded === true || charge.amount_refunded >= charge.amount,
  );

  if (!fullyRefunded) return { verified: true, refunded: false };

  const lease = await claimLease("stripe_lifetime_payment", paymentIntentId);
  if (!lease) return { verified: false, refunded: true };

  try {
    await runBoundedApply(async (tx) => {
      const source = await findSourceByProviderRef(tx, "stripe_lifetime_payment", paymentIntentId);
      if (!source) return;
      await assertFenceHeld(tx, lease);
      await lockUser(tx, source.userId);
      await markLifetimeRefunded(tx, paymentIntentId);
      await recomputeMembership(tx, source.userId);
    });
    return { verified: true, refunded: true };
  } finally {
    await releaseLease(lease).catch((error) => {
      logger.warn({ err: error, paymentIntentId }, "failed to release lifetime lease");
    });
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
    if (!source.providerRef) continue;

    // `admin_grant` has no provider state to retrieve — it IS the authority — so
    // skipping it is correct and does not make the refresh incomplete.
    if (source.sourceType === "admin_grant") continue;

    try {
      if (source.sourceType === "stripe_subscription") {
        const outcome = await refreshSubscriptionSource(stripe, source.providerRef);
        if (outcome.applied) refreshed += 1;
        else failed += 1;
      } else if (source.sourceType === "stripe_lifetime_payment") {
        // Silently skipped until now, and `failed` stayed zero — so a lifetime
        // purchase refunded while its `charge.refunded` webhook was dropped left
        // an `active` local row that reinstatement then restored Legendary from.
        // Precisely the stale-row case reinstatement's authoritative refresh
        // exists to prevent.
        const outcome = await refreshLifetimePaymentSource(stripe, source.providerRef);
        if (outcome.verified) refreshed += 1;
        else failed += 1;
      } else {
        // An unhandled Stripe-backed source type is UNVERIFIED, not fine. A new
        // source type must fail closed here until it has a refresh path, rather
        // than inheriting a silent pass.
        failed += 1;
        logger.warn(
          { userId, sourceType: source.sourceType },
          "source type has no authoritative refresh — counted as unverified",
        );
      }
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

/**
 * The subscription an invoice belongs to.
 *
 * Exported because **every** invoice event needs it, not just the dispute walk.
 * In this pinned API version `Invoice` has NO top-level `subscription` field —
 * the source moved to `parent.subscription_details.subscription` — so a handler
 * reading `invoice.subscription` gets `undefined` for every real event, silently
 * and without a type error (the reads were all through `as unknown as` casts).
 * The legacy branch below stays for fixtures and older payloads.
 */
export function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
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
