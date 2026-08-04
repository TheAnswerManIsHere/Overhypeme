import type Stripe from "stripe";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { db } from "@workspace/db";
import {
  usersTable,
  membershipHistoryTable,
  membershipEntitlementsTable,
  stripeProcessedEventsTable,
  stripeWebhookAuditTable,
} from "@workspace/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "./logger";
import { checkoutLineItemsGrantMembership, subscriptionGrantsMembership } from "./membershipPricing";
import { notifyAdminsOfDispute, notifyAdminsOfFraudWarning } from "./adminNotify";
import { notifyUserAccessRevoked } from "./userNotify";
import {
  sendEmail,
  buildSCAActionRequiredEmail,
  buildCardAutomaticallyUpdatedEmail,
  buildRenewalReminderEmail,
} from "./email";
import {
  applyPrepared,
  prepareDisputeEvent,
  prepareLifetimeRefund,
  prepareOneTimeCheckout,
  prepareSubscriptionRefresh,
  hasOneTimeCheckoutOrigin,
  releasePrepared,
  resolveInvoiceForPaymentIntent,
  runNotifications,
  subscriptionIdForInvoice,
  type NotificationAction,
  type Prepared,
} from "./membershipRefresh";
import { findSourceByProviderRef } from "./membershipSources";
import { runBoundedApply } from "./membershipLease";

/**
 * ─── Stripe webhook event coverage (Task #230) ────────────────────────────────
 *
 * The Stripe Dashboard webhook endpoint(s) — both test and live — must subscribe
 * to exactly this set of events. Update both Dashboards whenever this list changes.
 *
 * Membership lifecycle (grants & cancellations)
 *   - checkout.session.completed
 *   - customer.subscription.created
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 *
 * Invoice / billing lifecycle
 *   - invoice.paid
 *   - invoice.payment_failed
 *   - invoice.payment_action_required   (SCA/3DS — new in #230)
 *   - invoice.upcoming                   (renewal reminder — new in #230)
 *
 * Refund / dispute / fraud (also see #226, #227, #228, #229)
 *   - charge.refunded
 *   - charge.dispute.created
 *   - charge.dispute.updated
 *   - charge.dispute.closed
 *   - charge.dispute.funds_withdrawn
 *   - charge.dispute.funds_reinstated
 *   - radar.early_fraud_warning.created (new in #230)
 *
 * Card maintenance
 *   - payment_method.automatically_updated (new in #230)
 *
 * REMOVED in #230:
 *   - payment_intent.succeeded — redundant with checkout.session.completed
 *     (one-time lifetime) and invoice.paid (subscription renewals). The handler
 *     case is retained as a logged no-op so any in-flight retries during the
 *     Dashboard cutover ack 200 instead of erroring.
 */

async function findUserByStripeCustomerId(customerId: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.stripeCustomerId, customerId))
    .limit(1);
  return user ?? null;
}

async function findUserById(userId: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return user ?? null;
}

// setMembershipTier, userHasLifetimeEntitlement and userHasActiveSubscription
// are gone. Nothing in this file writes users.membership_tier any more, and
// nothing asks "does a lifetime row exist" — a bare-existence read is wrong
// under a model that deliberately RETAINS refunded and dispute-revoked rows.
// Both questions are now answered by the derivation, from the whole source set.

// recordHistory is gone. History rows are now COLLECTED during prepare and
// inserted inside the claim's transaction, so a retry after a failed apply
// cannot duplicate them.

// upsertSubscription, handleSubscriptionActivated and handleSubscriptionCancelled
// are replaced by ONE call to refreshSubscriptionSource. Writing local rows from
// an event payload is what let created/updated/deleted each maintain the same
// derived state with its own guards; retrieving the subscription's current state
// and applying it under the source lease means the local row cannot diverge by
// which event happened to arrive, or in what order.

/**
 * The prepared description of one event.
 *
 * The webhook has to claim idempotency and perform every domain write in ONE
 * transaction — otherwise a handler throw leaves the claim committed, Stripe's
 * retry sees an already-processed event, and the work never happens. But
 * invariant 1 forbids holding a transaction across network I/O, and the handlers
 * retrieve from Stripe. Both hold at once only if the phases are separated:
 *
 *   - **prepare** (`prepareDomainEvent`) does every Stripe retrieval and user
 *     resolution, takes the per-source lease, and produces this plain value.
 *   - **apply** (`applyDomainEvent`) performs the writes inside the caller's
 *     transaction, with no network call in it at all.
 *
 * `afterCommit` holds the emails and admin alerts. They must not run inside the
 * transaction: an awaited `sendEmail` would commit an outbox row independently
 * of the claim, so a rollback would leave a queued email for a grant that never
 * happened, and a fire-and-forget call could outlive the transaction and notify
 * on state that rolled back moments later. They keep exactly today's semantics —
 * best-effort, unguaranteed, lost on a crash.
 */
/**
 * Noop reasons that describe OUR failure to observe an object right now, not a
 * settled fact about the object — a retry might succeed where this attempt
 * didn't. Every other noop reason (`not_membership_product`, `wrong_mode`,
 * `user_mismatch`, `no_customer`, `payment_not_complete`, …) is permanent:
 * retrying the SAME event will reach the SAME conclusion, so claiming those is
 * correct.
 *
 * `source_unknown` is in this set, and the DISPUTE and REFUND prepares can both
 * produce it. It reads like a settled fact and is not: Stripe does not order
 * deliveries, so a `charge.dispute.created` — or a `charge.refunded` — can arrive
 * before the `checkout.session.completed` that creates the entitlement it
 * attaches to. Claiming it would leave the source with no dispute row, no access
 * hold and no permanent loss revocation (or, for a refund, an entitlement that
 * the later checkout event then creates as ACTIVE), and nothing reconstructs
 * that afterwards.
 *
 * The cost is that a dispute which never maps to one of our sources at all — a
 * merch charge, say — is retried until Stripe stops (a few days) and audited as
 * failed each time. That is the right side to err on: noisy logs for a
 * non-membership dispute, against silently keeping paid access for a customer
 * who charged back. The admin alert does NOT ride on this: it is sent during
 * prepare, before any of it, precisely so a retried dispute still warns an
 * operator inside the evidence window.
 */
const RETRYABLE_NOOP_REASONS = new Set([
  "source_busy",
  "retrieval_failed",
  "incomplete_enumeration",
  "source_unknown",
  // A `past_due` refresh that could not resolve a fresh grace anchor while the
  // stored episode has already expired. Ambiguous between "same episode" and
  // "new episode after a missed recovery", and deciding it wrongly demotes a
  // paying customer with nothing to repair it. See `prepareSubscriptionRefresh`.
  "grace_anchor_ambiguous",
]);

/**
 * The primary key of `stripe_processed_events` — the idempotency claim itself.
 *
 * Named rather than inferred because the whole point is to distinguish THIS
 * constraint from every other unique index a webhook's processing can touch.
 */
const PROCESSED_EVENTS_PK = "stripe_processed_events_pkey";

/**
 * True only for a Postgres unique/PK violation on the NAMED constraint.
 *
 * `code === "23505"` alone is not enough: it says "some unique index was
 * violated", and every table a handler writes to has its own.
 */
export function isConstraintViolation(err: unknown, constraint: string): boolean {
  if (!(err instanceof Error)) return false;
  const pg = err as unknown as { code?: string; constraint?: string };
  return pg.code === "23505" && pg.constraint === constraint;
}

export interface PreparedDomainEvent {
  entitlement: Prepared;
  historyWrites: Array<{
    userId: string;
    event: string;
    plan?: string;
    amount?: number;
    currency?: string;
    stripePaymentIntentId?: string;
    stripeSubscriptionId?: string;
    stripeInvoiceId?: string;
    stripeDisputeId?: string;
  }>;
  afterCommit: Array<() => void | Promise<void>>;
}

/**
 * Has this event already been claimed?
 *
 * A plain read of the same row the claim transaction inserts. Advisory only —
 * the claim's unique constraint is what actually enforces idempotency — so a
 * false negative here is harmless. It exists so a side effect that must run
 * BEFORE the claim (the dispute alert) can still skip a redelivery of work that
 * already completed.
 */
async function eventAlreadyProcessed(eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ eventId: stripeProcessedEventsTable.eventId })
    .from(stripeProcessedEventsTable)
    .where(eq(stripeProcessedEventsTable.eventId, eventId))
    .limit(1);
  return row !== undefined;
}

/** The plan label for a subscription, from its entitlement source. History-only. */
async function planLabelForSubscription(subscriptionId: string): Promise<string | null> {
  const [row] = await db
    .select({ plan: membershipEntitlementsTable.plan })
    .from(membershipEntitlementsTable)
    .where(
      and(
        eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
        eq(membershipEntitlementsTable.providerRef, subscriptionId),
      ),
    )
    .limit(1);
  return row?.plan ?? null;
}

/**
 * Resolve the USER behind a charge, for the paths that only record history —
 * early-fraud warnings and dispute funds movements. Those genuinely want a user
 * and not a source: they change no entitlement.
 *
 * Three escalating lookups. The first now reads `membership_entitlements`
 * instead of the dropped `lifetime_entitlements`.
 */
async function resolveUserForCharge(
  stripe: Stripe,
  paymentIntentId: string | null,
  chargeId: string,
): Promise<{ user: Awaited<ReturnType<typeof findUserByStripeCustomerId>> } | null> {
  if (paymentIntentId) {
    const source = await findSourceByProviderRef(db, "stripe_lifetime_payment", paymentIntentId);
    if (source) {
      const user = await findUserById(source.userId);
      if (user) return { user };
    }

    const [historyRow] = await db
      .select({ userId: membershipHistoryTable.userId })
      .from(membershipHistoryTable)
      .where(eq(membershipHistoryTable.stripePaymentIntentId, paymentIntentId))
      .limit(1);
    if (historyRow) {
      const user = await findUserById(historyRow.userId);
      if (user) return { user };
    }
  }

  try {
    const charge = await stripe.charges.retrieve(chargeId);
    const customerId = charge.customer
      ? (typeof charge.customer === "string" ? charge.customer : charge.customer.id)
      : null;
    if (customerId) {
      const user = await findUserByStripeCustomerId(customerId);
      if (user) return { user };
    }
  } catch (err) {
    logger.warn({ err, chargeId }, "could not retrieve charge from Stripe for customer lookup");
  }

  return null;
}

/**
 * All three dispute events route through ONE transition writer.
 *
 * `resolveUserForDispute`, `handleDisputeCreated` and `handleDisputeClosed` are
 * gone. The first resolved a USER, which is all tier-level revocation ever
 * needed — a source-local hold needs the source, or a dispute on one of two
 * qualifying entitlements revokes the wrong one. The other two each decided the
 * tier themselves from bare-existence reads, and between them covered only two
 * of the four terminal outcomes Stripe defines.
 *
 * `.updated` reaching this writer is the behaviour change that matters most:
 * Stripe sends it for status transitions, and it previously did only
 * evidence-deadline alert work, so `needs_response -> under_review` stayed stale
 * until a reconciliation pass happened to sweep it. That alert still fires — it
 * is a separate concern riding the same event, and dropping it would be an
 * unrelated regression.
 */
async function prepareDispute(
  stripe: Stripe,
  eventId: string,
  dispute: { id: string; amount?: number; currency?: string; livemode?: boolean },
  kind: "created" | "updated" | "closed",
): Promise<Prepared> {
  if (kind === "created" && !(await eventAlreadyProcessed(eventId))) {
    // Sent NOW, not deferred to afterCommit, and not tied to the entitlement
    // write succeeding.
    //
    // `afterCommit` runs only if the claim transaction commits. A dispute whose
    // entitlement source has not landed yet — or never will, because the charge
    // was merch or credits — prepares as a retryable `source_unknown` and throws
    // BEFORE the claim, so the deferred alert never ran at all. The operator lost
    // the warning for exactly the disputes we understand least, during a
    // response window Stripe measures in days.
    //
    // The accepted cost (David, 2026-07-30) is that Stripe's retries of an
    // UNPROCESSED event re-alert. That is the right side to err on: a repeated
    // alert is noise, a missing one is an undefended chargeback.
    //
    // A redelivery of an ALREADY-CLAIMED event is a different case and is not
    // covered by that trade: `notifyAdminsOfDispute` enqueues a durable
    // `async_jobs` row per admin, so a lost 200 on a fully processed event would
    // permanently double-write the email queue for work that already happened.
    //
    // The guard is an ADVISORY read, and deliberately not a claim. It suppresses
    // the sequential redelivery above — the common case, where the first
    // delivery committed long ago. It does NOT suppress two deliveries racing
    // before either commits: both reads return false and both alert. That is the
    // same duplicate-alert cost David already accepted for unprocessed events,
    // reached by a narrower window, and making it atomic would mean claiming the
    // event during PREPARE — which is exactly the ordering this handler was
    // rewritten to remove, because a claim that outlives a failed prepare drops
    // the event entirely. A duplicate chargeback warning is noise; a missing one
    // is an undefended chargeback.
    //
    // Best-effort — an alert that fails must not take the entitlement write
    // down with it.
    try {
      await notifyAdminsOfDispute({
        kind: "created",
        disputeId: dispute.id,
        amount: dispute.amount ?? 0,
        currency: dispute.currency ?? "usd",
        livemode: dispute.livemode === true,
      });
    } catch (error) {
      logger.error({ err: error, disputeId: dispute.id }, "could not alert admins of a new dispute");
    }
  }
  return prepareDisputeEvent(stripe, dispute.id);
}

/**
 * Phase one: retrieve everything, write nothing.
 *
 * Shared by `processWebhook` and `processEventDirectly`. Every `pushHistory`
 * call below appends a row to be inserted inside the claim's transaction rather
 * than committing it here, so a retry after a failed apply cannot duplicate it —
 * which the old claim-then-process ordering could not have caused only because a
 * failure meant the event was never retried at all.
 */
async function prepareDomainEvent(stripe: Stripe, event: Stripe.Event): Promise<PreparedDomainEvent> {
  const historyWrites: PreparedDomainEvent["historyWrites"] = [];
  const afterCommit: PreparedDomainEvent["afterCommit"] = [];
  let entitlement: Prepared = { kind: "noop", reason: "no_entitlement_effect" };

  const pushHistory = (
    userId: string,
    eventName: string,
    opts: Omit<PreparedDomainEvent["historyWrites"][number], "userId" | "event"> = {},
  ) => {
    historyWrites.push({ userId, event: eventName, ...opts });
  };

  switch (event.type) {
    case "checkout.session.completed": {
      // When a checkout completes with a subscription, the embedded subscription object
      // carries the membership grant. We process it as a subscription activation.
      const session = event.data.object as unknown as {
        id: string;
        customer: string | null;
        mode?: string;
        subscription?: string | { id: string; status?: string; items?: Stripe.Subscription["items"]; cancel_at_period_end?: boolean } | null;
        payment_intent?: string | null;
        amount_total?: number | null;
        currency?: string | null;
        metadata?: Record<string, string>;
      };
      const customerId = session.customer;
      const metadataUserId = session.metadata?.userId;

      if (session.mode === "subscription" && session.subscription) {
        // Every status is persisted, not just active/trialing. A subscription
        // that reaches `past_due` and stays there is the case a three-status
        // switch could never see, and a permanently failing card could sit in it
        // forever with access intact.
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        entitlement = await prepareSubscriptionRefresh(stripe, subscriptionId, {
          // The customer may not be linked to a user yet on a FIRST purchase.
          // The hint can only ever link a user who has no customer — it can
          // never re-point one that already belongs to someone else.
          ...(metadataUserId ? { linkHintUserId: metadataUserId } : {}),
          // No transitionEvent here: a genuinely NEW source already gets an
          // unconditional "subscription_activated" fact inside applySubscription.
          // Passing one here too would double-write it whenever this event is
          // also the one that happens to flip the tier.
        });
      } else if (session.mode === "payment") {
        // The session id, and nothing else. Amount, currency, payment status and
        // the allowlist decision all come from objects retrieved inside the
        // trust boundary.
        entitlement = await prepareOneTimeCheckout(stripe, session.id);
      } else if (!customerId) {
        logger.info({ sessionId: session.id }, "checkout.session.completed with no customer — nothing to apply");
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // One path for all three. The handler no longer decides anything from the
      // event's status — it retrieves the subscription's CURRENT state, which is
      // also what makes an out-of-order delivery harmless.
      const sub = event.data.object as Stripe.Subscription;
      // subscription_cancelled is now recorded unconditionally by applySubscription
      // itself when this source's own status transitions to canceled — passing it
      // here too would double-write the history fact whenever the transition also
      // happens to change the user's aggregate tier.
      entitlement = await prepareSubscriptionRefresh(stripe, sub.id);
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as unknown as {
        id: string; customer: string | { id: string }; amount_paid: number; currency: string;
        subscription?: string | { id: string } | null;
        payment_intent?: string | { id: string } | null;
      };
      const paidCustomerId = typeof inv.customer === "string" ? inv.customer : inv.customer.id;
      const paidUser = await findUserByStripeCustomerId(paidCustomerId);
      if (paidUser) {
        const paidSubscriptionId =
          subscriptionIdForInvoice(inv as unknown as Stripe.Invoice) ?? undefined;
        pushHistory(paidUser.id, "invoice_paid", {
          ...(paidSubscriptionId
            ? { plan: (await planLabelForSubscription(paidSubscriptionId)) ?? undefined }
            : {}),
          amount: inv.amount_paid,
          currency: inv.currency,
          stripeInvoiceId: inv.id,
          stripeSubscriptionId: paidSubscriptionId,
          stripePaymentIntentId: inv.payment_intent
            ? (typeof inv.payment_intent === "string" ? inv.payment_intent : inv.payment_intent.id)
            : undefined,
        });

        if (paidSubscriptionId) {
          // Payment recovery is an authoritative event about the SOURCE, not
          // just a receipt. If the `customer.subscription.updated` that would
          // have cleared the dunning state was never delivered, a history-only
          // handler leaves the source `past_due` carrying its old deadline —
          // and then demotes a customer whose invoice we know was paid. With no
          // reconciliation pass, nothing else revisits it.
          //
          // The refresh clears the grace window when Stripe reports the
          // subscription active again, which is the whole point of retrieving
          // rather than trusting the event we happened to receive.
          entitlement = await prepareSubscriptionRefresh(stripe, paidSubscriptionId);
        }
      }
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as unknown as {
        id: string; customer: string | { id: string };
        subscription?: string | { id: string } | null;
        amount_due?: number; currency?: string;
      };
      const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer.id;
      const user = await findUserByStripeCustomerId(customerId);
      if (user) {
        const subscriptionId =
          subscriptionIdForInvoice(inv as unknown as Stripe.Invoice) ?? undefined;
        pushHistory(user.id, "payment_failed", {
          amount: inv.amount_due,
          currency: inv.currency,
          stripeInvoiceId: inv.id,
          stripeSubscriptionId: subscriptionId,
        });
        if (subscriptionId) {
          // Not a hand-written `past_due`. The refresh retrieves the
          // subscription's current status AND resolves the grace episode's
          // anchor — the first failed attempt on the earliest still-unpaid
          // invoice of this delinquency, which is the whole reason the 14-day
          // window can be bounded at all.
          entitlement = await prepareSubscriptionRefresh(stripe, subscriptionId);
        }
        logger.warn({ userId: user.id, invoiceId: inv.id }, "Payment failed — subscription refreshed from Stripe");
      }
      break;
    }
    case "payment_intent.succeeded": {
      // Removed in Task #230 — handled redundantly by checkout.session.completed
      // (one-time lifetime) and invoice.paid (subscription renewals). The case
      // remains as a logged no-op so any in-flight retries from the Stripe
      // Dashboard during cutover ack 200 instead of erroring out.
      logger.info({ eventId: event.id }, "payment_intent.succeeded received — handled by checkout.session.completed / invoice.paid; no-op");
      break;
    }
    case "invoice.payment_action_required": {
      // SCA / 3DS — Stripe needs the customer to confirm the payment. Email them
      // the hosted invoice URL so they can complete authentication and keep their
      // Legendary access alive.
      const inv = event.data.object as unknown as {
        id: string;
        customer: string | { id: string } | null;
        hosted_invoice_url?: string | null;
        amount_due?: number | null;
        currency?: string | null;
        subscription?: string | { id: string } | null;
      };
      const customerId = inv.customer
        ? (typeof inv.customer === "string" ? inv.customer : inv.customer.id)
        : null;
      if (!customerId) { logger.warn({ invoiceId: inv.id }, "invoice.payment_action_required: no customer — skipping"); break; }
      const user = await findUserByStripeCustomerId(customerId);
      if (!user) { logger.warn({ customerId, invoiceId: inv.id }, "invoice.payment_action_required: no user found"); break; }

      const subscriptionId =
        subscriptionIdForInvoice(inv as unknown as Stripe.Invoice) ?? undefined;
      pushHistory(user.id, "payment_action_required", {
        amount: inv.amount_due ?? undefined,
        currency: inv.currency ?? undefined,
        stripeInvoiceId: inv.id,
        stripeSubscriptionId: subscriptionId,
      });

      if (subscriptionId) {
        // Authoritative about the source, exactly like `invoice.paid` and
        // `invoice.payment_failed`. A renewal that needs SCA can already have
        // moved the subscription to `past_due`, so if this is the only lifecycle
        // event delivered, a history-only handler leaves the local source
        // `active` with no grace deadline indefinitely — while holding an
        // authoritative invoice event that says otherwise.
        entitlement = await prepareSubscriptionRefresh(stripe, subscriptionId);
      }

      if (!event.livemode) {
        logger.info({ userId: user.id, invoiceId: inv.id }, "invoice.payment_action_required: skipping SCA email — test-mode event");
        break;
      }
      // Deferred to afterCommit: a genuine Stripe retry of an already-processed
      // event must not resend this email. Moving it here is what actually makes
      // that true — the claim's uniqueness check runs before afterCommit, never
      // before this point in prepare.
      if (inv.hosted_invoice_url && user.email) {
        const hostedInvoiceUrl = inv.hosted_invoice_url;
        const email = user.email;
        const amountMinor = inv.amount_due ?? null;
        const currency = inv.currency ?? null;
        afterCommit.push(async () => {
          const { subject, text, html } = buildSCAActionRequiredEmail({
            hostedInvoiceUrl,
            amountMinor,
            currency,
          });
          try {
            await sendEmail({ to: email, subject, text, html });
            logger.info({ userId: user.id, invoiceId: inv.id }, "Sent SCA action-required email");
          } catch (err) {
            logger.error({ err, userId: user.id, invoiceId: inv.id }, "SCA email send failed");
          }
        });
      } else {
        logger.warn(
          { userId: user.id, invoiceId: inv.id, hasUrl: !!inv.hosted_invoice_url, hasEmail: !!user.email },
          "invoice.payment_action_required: cannot send SCA email — TODO investigate (missing hosted_invoice_url or user email)",
        );
      }
      break;
    }
    case "invoice.upcoming": {
      // Renewal reminder — fired ~7 days before the next charge attempt. Email
      // the customer so they can update their card or cancel before being billed.
      const inv = event.data.object as unknown as {
        customer: string | { id: string } | null;
        amount_due?: number | null;
        currency?: string | null;
        next_payment_attempt?: number | null;
        subscription?: string | { id: string } | null;
      };
      const customerId = inv.customer
        ? (typeof inv.customer === "string" ? inv.customer : inv.customer.id)
        : null;
      if (!customerId) { logger.warn("invoice.upcoming: no customer — skipping"); break; }
      const user = await findUserByStripeCustomerId(customerId);
      if (!user) { logger.warn({ customerId }, "invoice.upcoming: no user found"); break; }

      // Look up plan label from the local subscriptions table (if present)
      let plan: string | undefined;
      const subscriptionId =
        subscriptionIdForInvoice(inv as unknown as Stripe.Invoice) ?? undefined;
      if (subscriptionId) {
        plan = (await planLabelForSubscription(subscriptionId)) ?? undefined;
      }

      pushHistory(user.id, "renewal_reminder", {
        plan,
        amount: inv.amount_due ?? undefined,
        currency: inv.currency ?? undefined,
        stripeSubscriptionId: subscriptionId,
      });

      if (!event.livemode) {
        logger.info({ userId: user.id, subscriptionId }, "invoice.upcoming: skipping renewal reminder email — test-mode event");
        break;
      }
      // Deferred to afterCommit — same reason as the SCA email above.
      if (user.email && inv.amount_due != null && inv.currency) {
        const email = user.email;
        const amountMinor = inv.amount_due;
        const currency = inv.currency;
        const nextAttemptAt = inv.next_payment_attempt ?? null;
        afterCommit.push(async () => {
          const { subject, text, html } = buildRenewalReminderEmail({
            amountMinor,
            currency,
            nextAttemptAt,
            plan: plan ?? null,
          });
          try {
            await sendEmail({ to: email, subject, text, html });
            logger.info({ userId: user.id, subscriptionId }, "Sent renewal reminder email");
          } catch (err) {
            logger.error({ err, userId: user.id, subscriptionId }, "Renewal reminder email send failed");
          }
        });
      } else {
        logger.warn(
          { userId: user.id, hasEmail: !!user.email, hasAmount: inv.amount_due != null },
          "invoice.upcoming: cannot send renewal reminder email — TODO investigate (missing email/amount/currency)",
        );
      }
      break;
    }
    case "payment_method.automatically_updated": {
      // Card network handed Stripe refreshed expiration / number for a saved card.
      // Log so analytics doesn't read the silent re-auth as churn, and email the
      // customer a heads-up.
      const pm = event.data.object as unknown as {
        id: string;
        customer: string | { id: string } | null;
        card?: { brand?: string | null; last4?: string | null } | null;
      };
      const customerId = pm.customer
        ? (typeof pm.customer === "string" ? pm.customer : pm.customer.id)
        : null;
      if (!customerId) { logger.warn({ paymentMethodId: pm.id }, "payment_method.automatically_updated: no customer — skipping"); break; }
      const user = await findUserByStripeCustomerId(customerId);
      if (!user) { logger.warn({ customerId, paymentMethodId: pm.id }, "payment_method.automatically_updated: no user found"); break; }

      pushHistory(user.id, "payment_method_updated", {
        stripePaymentIntentId: pm.id, // reuse column to record the PM id
      });
      logger.info(
        { userId: user.id, paymentMethodId: pm.id, brand: pm.card?.brand, last4: pm.card?.last4 },
        "Card on file automatically updated by network",
      );

      if (!event.livemode) {
        logger.info({ userId: user.id, paymentMethodId: pm.id }, "payment_method.automatically_updated: skipping card-updated email — test-mode event");
        break;
      }
      // Deferred to afterCommit — same reason as the SCA email above.
      if (user.email) {
        const email = user.email;
        const brand = pm.card?.brand ?? null;
        const last4 = pm.card?.last4 ?? null;
        afterCommit.push(async () => {
          const { subject, text, html } = buildCardAutomaticallyUpdatedEmail({ brand, last4 });
          try {
            await sendEmail({ to: email, subject, text, html });
          } catch (err) {
            logger.error({ err, userId: user.id, paymentMethodId: pm.id }, "Card-updated email send failed");
          }
        });
      }
      break;
    }
    case "radar.early_fraud_warning.created": {
      // Stripe Radar flagged a charge as likely-fraudulent. Record against the
      // user/charge and alert admins so they can decide whether to proactively
      // refund within the 24–72h window before a formal chargeback is filed.
      // We deliberately DO NOT auto-refund.
      const warning = event.data.object as unknown as {
        id: string;
        charge: string | { id: string };
        payment_intent?: string | { id: string } | null;
        actionable?: boolean | null;
        fraud_type?: string | null;
        livemode?: boolean;
      };
      const chargeId = typeof warning.charge === "string" ? warning.charge : warning.charge.id;
      const paymentIntentId = warning.payment_intent
        ? (typeof warning.payment_intent === "string" ? warning.payment_intent : warning.payment_intent.id)
        : null;

      // Best-effort user resolution + history record — but the admin alert fires
      // regardless so the team always finds out within the 24h window.
      let chargeAmount = 0;
      let chargeCurrency = "usd";
      try {
        const charge = await stripe.charges.retrieve(chargeId);
        chargeAmount = charge.amount ?? 0;
        chargeCurrency = charge.currency ?? "usd";
      } catch (err) {
        logger.warn({ err, chargeId }, "early_fraud_warning: could not retrieve charge from Stripe");
      }

      // Deferred to afterCommit, same as every other admin alert in this
      // switch — a retry of an already-processed warning must not re-alert.
      afterCommit.push(() =>
        notifyAdminsOfFraudWarning({
          warningId: warning.id,
          chargeId,
          amount: chargeAmount,
          currency: chargeCurrency,
          livemode: warning.livemode ?? event.livemode,
          fraudType: warning.fraud_type ?? null,
          actionable: warning.actionable ?? null,
        }),
      );

      const resolved = await resolveUserForCharge(stripe, paymentIntentId, chargeId);
      if (!resolved) {
        logger.warn({ warningId: warning.id, chargeId }, "early_fraud_warning: could not resolve user — alert sent, no history recorded");
        break;
      }
      const { user } = resolved;
      pushHistory(user.id, "early_fraud_warning", {
        amount: chargeAmount,
        currency: chargeCurrency,
        stripePaymentIntentId: paymentIntentId ?? undefined,
      });
      logger.info(
        { userId: user.id, warningId: warning.id, chargeId, actionable: warning.actionable, fraudType: warning.fraud_type },
        "Early fraud warning recorded — admin alerted (no auto-refund)",
      );
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as unknown as {
        id: string;
        customer: string | { id: string } | null;
        payment_intent: string | { id: string } | null;
        // `amount` is what makes partial distinguishable from full. Its absence
        // from the old destructured parameter is why the handler could not tell.
        amount: number;
        amount_refunded: number;
        currency: string;
      };
      const refundPaymentIntentId = charge.payment_intent
        ? (typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id)
        : null;

      // Not every PaymentIntent on a `charge.refunded` event is a lifetime
      // purchase — a subscription invoice, or any other charge, carries one too.
      // A lifetime source routes through prepareLifetimeRefund, which records
      // its own full/partial history tied to the entitlement; anything else
      // falls back to the record-only path the old handler always took for a
      // subscription/unrecognized refund, so it does not silently vanish from
      // the audit trail.
      const lifetimeSource = refundPaymentIntentId
        ? await findSourceByProviderRef(db, "stripe_lifetime_payment", refundPaymentIntentId)
        : null;

      if (refundPaymentIntentId && lifetimeSource) {
        // A PARTIAL refund records history and leaves the entitlement active
        // (settled decision 6). `charge.amount` is what makes partial
        // distinguishable from full, and its absence from the old handler's
        // destructured parameter is exactly why it could not tell them apart.
        entitlement = await prepareLifetimeRefund({
          paymentIntentId: refundPaymentIntentId,
          amountRefunded: charge.amount_refunded,
          chargeAmount: charge.amount,
          currency: charge.currency,
        });
      } else if (refundPaymentIntentId) {
        // No local lifetime source. That is NOT proof this was not a lifetime
        // purchase: Stripe does not order deliveries, so `charge.refunded` can
        // overtake the `checkout.session.completed` that would have created the
        // row. Treating local absence as proof is how a fully refunded purchase
        // ended up granting Legendary forever — the refund recorded audit-only
        // and claimed the event, and the checkout that arrived afterwards still
        // saw a succeeded PaymentIntent and created an ACTIVE source.
        //
        // So resolve it authoritatively instead — by asking the question a
        // lifetime source is actually created from. `prepareOneTimeCheckout`
        // builds one only from a payment-mode Checkout Session, so if such a
        // session exists for this PaymentIntent the source can still appear and
        // this refund is ordering-ambiguous, not settled.
        //
        // Invoice linkage cannot answer it: `invoice_creation` is available on
        // payment-mode sessions, so an invoice-backed charge may still be a
        // one-time membership purchase. See `hasOneTimeCheckoutOrigin`.
        if (await hasOneTimeCheckoutOrigin(stripe, refundPaymentIntentId)) {
          entitlement = { kind: "noop", reason: "source_unknown" };
          break;
        }

        // Subscription invoice refund — record for the audit trail only; the
        // subscription cancellation flow (if any) handles downgrades separately,
        // same as the handler this replaces.
        const customerId = charge.customer
          ? (typeof charge.customer === "string" ? charge.customer : charge.customer.id)
          : null;
        const user = customerId ? await findUserByStripeCustomerId(customerId) : null;
        if (user) {
          // Looked up rather than read off the charge: `Charge` has no `invoice`
          // field in this API version. Only for the receipt link on the history
          // row — the origin question is already settled above.
          const refundInvoiceId =
            (await resolveInvoiceForPaymentIntent(stripe, refundPaymentIntentId)) ?? undefined;
          pushHistory(user.id, "refund", {
            amount: charge.amount_refunded,
            currency: charge.currency,
            stripePaymentIntentId: refundPaymentIntentId,
            stripeInvoiceId: refundInvoiceId,
          });
        } else {
          logger.warn(
            { chargeId: charge.id, paymentIntentId: refundPaymentIntentId },
            "charge.refunded: non-lifetime refund, could not resolve user — nothing recorded",
          );
        }
      } else {
        logger.warn({ chargeId: charge.id }, "charge.refunded has no payment intent — nothing to apply");
      }
      break;
    }
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      const dispute = event.data.object as unknown as {
        id: string;
        amount: number;
        currency: string;
        livemode?: boolean;
      };
      // Fall back to the event-level livemode flag if the dispute object omits
      // it (minimal test fixtures), so the admin alert links to the right
      // dashboard.
      entitlement = await prepareDispute(
        stripe,
        event.id,
        { ...dispute, livemode: dispute.livemode ?? event.livemode },
        event.type === "charge.dispute.created" ? "created" : "closed",
      );
      break;
    }
    case "charge.dispute.updated": {
      // Only fire admin alert when the evidence deadline is approaching (< 48h)
      // AND the dispute is still in an actionable state. Stripe sends this event
      // for many reasons (evidence updates, status transitions, etc) so the
      // narrow predicate avoids spamming admins for every change.
      const dispute = event.data.object as unknown as {
        id: string;
        status: string;
        amount: number;
        currency: string;
        livemode?: boolean;
        evidence_details?: { due_by?: number | null } | null;
      };
      // The transition write, which this case previously did not do at all —
      // Stripe sends `.updated` for status transitions, so `needs_response ->
      // under_review` reached no writer and stayed stale until reconciliation
      // happened to sweep it.
      entitlement = await prepareDispute(stripe, event.id, dispute, "updated");

      const dueBy = dispute.evidence_details?.due_by ?? null;
      const isActionable = dispute.status === "needs_response" || dispute.status === "warning_needs_response";
      if (dueBy != null && isActionable) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secondsUntilDue = dueBy - nowSec;
        const hoursUntilDue = secondsUntilDue / 3600;
        if (hoursUntilDue > 0 && hoursUntilDue < 48) {
          // Round up so a deadline 30 minutes out reads as "1 hour" rather than
          // "0 hours" — operators need a non-zero urgency cue in the subject line.
          const ceiledHours = Math.max(1, Math.ceil(hoursUntilDue));
          // Deferred to afterCommit — a retry of an already-processed `.updated`
          // must not re-alert with a recomputed (and now smaller) hours-until-due.
          afterCommit.push(() =>
            notifyAdminsOfDispute({
              kind: "deadline_approaching",
              disputeId: dispute.id,
              amount: dispute.amount,
              currency: dispute.currency,
              livemode: dispute.livemode ?? event.livemode,
              hoursUntilDue: ceiledHours,
            }),
          );
        }
      }
      break;
    }
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      const dispute = event.data.object as unknown as {
        id: string;
        charge?: string | { id: string } | null;
        payment_intent?: string | { id: string } | null;
        amount: number;
        currency: string;
        livemode?: boolean;
      };

      // Always alert admins regardless of whether we can resolve the user — balance
      // accounting matters even when the user lookup fails. Deferred to
      // afterCommit, same reason as every other alert in this switch.
      afterCommit.push(() =>
        notifyAdminsOfDispute({
          kind: event.type === "charge.dispute.funds_withdrawn" ? "funds_withdrawn" : "funds_reinstated",
          disputeId: dispute.id,
          amount: dispute.amount,
          currency: dispute.currency,
          livemode: dispute.livemode ?? event.livemode,
        }),
      );

      // Record a history entry against the user/dispute so the admin dispute
      // history page (#229) can show when Stripe actually debited / reinstated
      // funds, separately from when the dispute was opened.
      const chargeId = dispute.charge
        ? (typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id)
        : null;
      const paymentIntentId = dispute.payment_intent
        ? (typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent.id)
        : null;

      if (chargeId) {
        const resolved = await resolveUserForCharge(stripe, paymentIntentId, chargeId);
        if (resolved) {
          pushHistory(
            resolved.user.id,
            event.type === "charge.dispute.funds_withdrawn" ? "dispute_funds_withdrawn" : "dispute_funds_reinstated",
            {
              amount: dispute.amount,
              currency: dispute.currency,
              stripePaymentIntentId: paymentIntentId ?? undefined,
              stripeDisputeId: dispute.id,
            },
          );
          logger.info(
            { userId: resolved.user.id, disputeId: dispute.id, eventType: event.type },
            "Recorded dispute funds movement against dispute history",
          );
        } else {
          logger.warn({ disputeId: dispute.id, chargeId, eventType: event.type }, "dispute funds movement: could not resolve user — admin alert sent, no history recorded");
        }
      } else {
        logger.warn({ disputeId: dispute.id, eventType: event.type }, "dispute funds movement: no charge on dispute object — admin alert sent, no history recorded");
      }
      break;
    }
    default:
      break;
  }

  return { entitlement, historyWrites, afterCommit };
}

/**
 * Execute the emails and admin alerts a committed event owes.
 *
 * Best-effort by construction, exactly as today: a crash between commit and here
 * loses them, and that loss is accepted — see the plan's *Notifications are out
 * of scope*. What this ordering buys is that nothing notifies on state that
 * rolled back moments later.
 */
async function runAfterCommit(
  prepared: PreparedDomainEvent,
  notifications: NotificationAction[],
): Promise<void> {
  await runNotifications(notifications);
  for (const action of prepared.afterCommit) {
    try {
      await action();
    } catch (err) {
      logger.error({ err }, "post-commit webhook side effect failed");
    }
  }
}

/**
 * Phase two: perform the prepared writes inside the caller's transaction.
 *
 * No network call happens here — a `PreparedDomainEvent` carries no Stripe
 * client, so this phase cannot reach the network even by mistake. Returns the
 * notifications the apply decided on, from the locked pre-mutation state.
 */
async function applyDomainEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  prepared: PreparedDomainEvent,
): Promise<NotificationAction[]> {
  const result = await applyPrepared(tx, prepared.entitlement);

  if (prepared.historyWrites.length > 0) {
    await tx.insert(membershipHistoryTable).values(prepared.historyWrites);
  }

  return result.notifications;
}

export class WebhookHandlers {
  private static async audit(eventId: string, eventType: string, state: "received" | "processed" | "ignored_duplicate" | "failed", detail?: string) {
    await db.insert(stripeWebhookAuditTable).values({ eventId, eventType, state, detail });
  }
  /**
   * Process a pre-constructed Stripe event object directly through the domain event switch,
   * skipping Stripe sync and signature verification. For use in test mode QA only.
   * The caller is responsible for ensuring the event is well-formed and only used in test mode.
   */
  static async processEventDirectly(event: Stripe.Event): Promise<void> {
    const stripe = await getUncachableStripeClient();
    const prepared = await prepareDomainEvent(stripe, event);
    try {
      // No idempotency claim on this path — it is test-mode QA, replaying a
      // hand-built event deliberately. The prepare/apply split still holds, so
      // the same code runs here as in production.
      const notifications = await runBoundedApply((tx) => applyDomainEvent(tx, prepared));
      await runAfterCommit(prepared, notifications);
    } catch (err) {
      logger.error({ err, eventType: event.type }, "Test domain event handler error");
      throw err;
    } finally {
      await releasePrepared(prepared.entitlement);
    }
  }

  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    // Phase 1: Pass to stripe-replit-sync for data sync AND signature verification.
    // sync.processWebhook verifies the signature using the integration's managed signing
    // secret and throws on any invalid/forged event. After this line succeeds, the event
    // is guaranteed authentic — no second verification pass is needed or correct (the
    // integration manages its own signing secret, separate from STRIPE_WEBHOOK_SECRET).
    const sync = await getStripeSync();
    try {
      await sync.processWebhook(payload, signature);
    } catch (sigErr) {
      // Best-effort: pull the event id out of the (untrusted) payload so the
      // log line is correlatable with Stripe's dashboard even though we
      // rejected the event. Falls back to undefined if the body isn't JSON.
      let eventIdGuess: string | undefined;
      try {
        const parsed = JSON.parse(payload.toString()) as { id?: unknown };
        if (typeof parsed?.id === "string") eventIdGuess = parsed.id;
      } catch { /* non-JSON payload — skip */ }
      const message = sigErr instanceof Error ? sigErr.message : String(sigErr);
      let reason = "unknown error during signature verification";
      if (/signature/i.test(message)) {
        reason = "Stripe signature verification failed (signing secret mismatch or tampered payload)";
      } else if (/secret/i.test(message)) {
        reason = "Stripe webhook signing secret is missing or unreadable";
      } else if (/timestamp/i.test(message)) {
        reason = "Stripe webhook timestamp outside tolerance window";
      }
      logger.warn(
        { err: sigErr, eventId: eventIdGuess, reason },
        "Stripe webhook rejected before domain processing",
      );
      throw sigErr;
    }

    // Phase 2: Acquire the Stripe client for domain processing.
    //
    // THROWS rather than returning. This used to return, on the reasoning that
    // the sync had already persisted the event to the `stripe.*` tables so
    // nothing was lost — but that only held while reconciliation existed to
    // consume those tables. With reconciliation deferred, returning here means
    // the route answers 200, Stripe never redelivers, and a received
    // cancellation, refund or dispute is dropped permanently with no repair
    // path. A credential outage is transient by nature, which is exactly what
    // Stripe's retry schedule is for.
    let stripe: Stripe | null = null;
    try {
      stripe = await getUncachableStripeClient();
    } catch (credErr) {
      logger.error(
        { err: credErr },
        "Stripe credentials unavailable — failing the webhook so Stripe redelivers rather than dropping the event",
      );
      throw credErr;
    }

    // Phase 3: Parse the verified payload as a typed Stripe event.
    // The payload is authentic (verified by the sync above); parse it for domain logic.
    let event: Stripe.Event;
    try {
      event = JSON.parse(payload.toString()) as Stripe.Event;
    } catch (parseErr) {
      logger.error({ err: parseErr }, "Failed to parse webhook event payload");
      return;
    }
    await this.audit(event.id, event.type, "received");

    let prepared: PreparedDomainEvent | undefined;

    // The idempotency claim and the domain processing share ONE transaction.
    //
    // Claimed-then-processed as two commits drops events: the claim survives a
    // handler throw, so Stripe's retry sees the event as already processed and
    // the work never happens. In one transaction a throw rolls the claim back
    // and the retry can succeed.
    //
    // The AUDIT writes stay OUTSIDE it, deliberately. A `failed` audit row that
    // rolled back with the claim would destroy the only evidence the failure
    // ever happened — which is exactly the record you need when an event
    // silently did not apply.
    try {
      // Phase A — prepare. Every Stripe retrieval and the per-source lease,
      // with no transaction open. At this point stripe is guaranteed non-null:
      // either we acquired it in phase 1, or we returned early above.
      prepared = await prepareDomainEvent(stripe!, event);

      // A noop is not automatically a settled fact. `source_busy` (lease
      // contention), `retrieval_failed` and `incomplete_enumeration` (a Stripe
      // call or pagination pass that didn't complete) describe OUR inability to
      // observe the object right now, not something about the object itself —
      // unlike e.g. `not_membership_product`, which will never become true on a
      // retry. Committing the idempotency claim on a retryable noop would
      // permanently ack a transient failure: Stripe would never redeliver it, and
      // nothing else reconstructs a one-time grant or dispute transition from
      // scratch. So this throws BEFORE the claim, same as any other failure.
      if (prepared.entitlement.kind === "noop" && RETRYABLE_NOOP_REASONS.has(prepared.entitlement.reason)) {
        throw new Error(`retryable prepare failure: ${prepared.entitlement.reason}`);
      }

      // Phase B — apply. The claim and every domain write, one transaction, no
      // network. A throw rolls the claim back so Stripe's retry can succeed.
      const readyToApply = prepared;
      const notifications = await runBoundedApply(async (tx) => {
        // Fails on duplicate under concurrent deliveries. Inside the transaction
        // it also holds the row lock for the whole of processing, so two
        // simultaneous deliveries of one event cannot both proceed.
        await tx.insert(stripeProcessedEventsTable).values({ eventId: event.id });
        return applyDomainEvent(tx, readyToApply);
      });

      await this.audit(event.id, event.type, "processed");

      // Phase C — after the commit, and only if it committed.
      await runAfterCommit(readyToApply, notifications);
    } catch (err) {
      // ONLY the claim's own unique violation means "already processed".
      //
      // This catch spans preparation, the whole domain transaction, auditing and
      // post-commit work, so a broad 23505 test convicts the wrong error: two
      // first-purchase events racing in `linkCustomerToUser` make the loser
      // violate the unique Stripe-customer constraint during PREPARE, before any
      // claim exists. Calling that a duplicate returns 200, so Stripe never
      // redelivers and a real purchase is dropped — the exact failure the
      // claim-inside-the-transaction design exists to prevent, reached through
      // the error path instead. Matching on the constraint name is what makes
      // "already claimed" mean it. The message-substring test is gone with it:
      // "unique" appears in plenty of unrelated errors.
      const isDuplicateClaim = isConstraintViolation(err, PROCESSED_EVENTS_PK);
      if (isDuplicateClaim) {
        await this.audit(event.id, event.type, "ignored_duplicate");
        logger.info({ eventId: event.id, eventType: event.type }, "Webhook event already processed — skipping (idempotency)");
        return;
      }
      await this.audit(event.id, event.type, "failed", err instanceof Error ? err.message.slice(0, 400) : String(err));
      logger.error({ err, eventType: event.type }, "Webhook domain handler error");
      throw err;
    } finally {
      if (prepared) await releasePrepared(prepared.entitlement);
    }
  }
}
