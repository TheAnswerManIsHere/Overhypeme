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
  releasePrepared,
  runNotifications,
  type NotificationAction,
  type Prepared,
} from "./membershipRefresh";
import { findSourceByProviderRef } from "./membershipSources";

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
  dispute: { id: string; amount?: number; currency?: string; livemode?: boolean },
  kind: "created" | "updated" | "closed",
  afterCommit: PreparedDomainEvent["afterCommit"],
): Promise<Prepared> {
  if (kind === "created") {
    // Sent regardless of whether the source resolves: Stripe's response window
    // is short and the operator needs to gather evidence now.
    afterCommit.push(() =>
      notifyAdminsOfDispute({
        kind: "created",
        disputeId: dispute.id,
        amount: dispute.amount ?? 0,
        currency: dispute.currency ?? "usd",
        livemode: dispute.livemode === true,
      }),
    );
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
          transitionEvent: "subscription_activated",
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
      entitlement = await prepareSubscriptionRefresh(stripe, sub.id, {
        ...(event.type === "customer.subscription.deleted"
          ? { transitionEvent: "subscription_cancelled" }
          : {}),
      });
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
        const paidSubscriptionId = inv.subscription
          ? (typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id)
          : undefined;
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
        const subscriptionId = inv.subscription
          ? (typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id)
          : undefined;
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

      const subscriptionId = inv.subscription
        ? (typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id)
        : undefined;
      pushHistory(user.id, "payment_action_required", {
        amount: inv.amount_due ?? undefined,
        currency: inv.currency ?? undefined,
        stripeInvoiceId: inv.id,
        stripeSubscriptionId: subscriptionId,
      });

      if (!event.livemode) {
        logger.info({ userId: user.id, invoiceId: inv.id }, "invoice.payment_action_required: skipping SCA email — test-mode event");
        break;
      }
      if (inv.hosted_invoice_url && user.email) {
        const { subject, text, html } = buildSCAActionRequiredEmail({
          hostedInvoiceUrl: inv.hosted_invoice_url,
          amountMinor: inv.amount_due ?? null,
          currency: inv.currency ?? null,
        });
        try {
          await sendEmail({ to: user.email, subject, text, html });
          logger.info({ userId: user.id, invoiceId: inv.id }, "Sent SCA action-required email");
        } catch (err) {
          logger.error({ err, userId: user.id, invoiceId: inv.id }, "SCA email send failed");
        }
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
      const subscriptionId = inv.subscription
        ? (typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id)
        : undefined;
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
      if (user.email && inv.amount_due != null && inv.currency) {
        const { subject, text, html } = buildRenewalReminderEmail({
          amountMinor: inv.amount_due,
          currency: inv.currency,
          nextAttemptAt: inv.next_payment_attempt ?? null,
          plan: plan ?? null,
        });
        try {
          await sendEmail({ to: user.email, subject, text, html });
          logger.info({ userId: user.id, subscriptionId }, "Sent renewal reminder email");
        } catch (err) {
          logger.error({ err, userId: user.id, subscriptionId }, "Renewal reminder email send failed");
        }
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
      if (user.email) {
        const { subject, text, html } = buildCardAutomaticallyUpdatedEmail({
          brand: pm.card?.brand ?? null,
          last4: pm.card?.last4 ?? null,
        });
        try {
          await sendEmail({ to: user.email, subject, text, html });
        } catch (err) {
          logger.error({ err, userId: user.id, paymentMethodId: pm.id }, "Card-updated email send failed");
        }
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

      void notifyAdminsOfFraudWarning({
        warningId: warning.id,
        chargeId,
        amount: chargeAmount,
        currency: chargeCurrency,
        livemode: warning.livemode ?? event.livemode,
        fraudType: warning.fraud_type ?? null,
        actionable: warning.actionable ?? null,
      });

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
      if (refundPaymentIntentId) {
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
        { ...dispute, livemode: dispute.livemode ?? event.livemode },
        event.type === "charge.dispute.created" ? "created" : "closed",
        afterCommit,
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
      entitlement = await prepareDispute(stripe, dispute, "updated", afterCommit);

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
          void notifyAdminsOfDispute({
            kind: "deadline_approaching",
            disputeId: dispute.id,
            amount: dispute.amount,
            currency: dispute.currency,
            livemode: dispute.livemode ?? event.livemode,
            hoursUntilDue: ceiledHours,
          });
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
      // accounting matters even when the user lookup fails.
      void notifyAdminsOfDispute({
        kind: event.type === "charge.dispute.funds_withdrawn" ? "funds_withdrawn" : "funds_reinstated",
        disputeId: dispute.id,
        amount: dispute.amount,
        currency: dispute.currency,
        livemode: dispute.livemode ?? event.livemode,
      });

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
      const notifications = await db.transaction((tx) => applyDomainEvent(tx, prepared));
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
    // If credentials are unavailable, skip domain logic — the sync already persisted
    // the event data to stripe.* tables so nothing is lost.
    let stripe: Stripe | null = null;
    try {
      stripe = await getUncachableStripeClient();
    } catch (credErr) {
      logger.warn({ err: credErr }, "Stripe credentials unavailable — skipping domain event processing");
      return;
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

      // Phase B — apply. The claim and every domain write, one transaction, no
      // network. A throw rolls the claim back so Stripe's retry can succeed.
      const readyToApply = prepared;
      const notifications = await db.transaction(async (tx) => {
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
      const isUniqueViolation = err instanceof Error &&
        ((err as unknown as { code?: string }).code === "23505" || err.message.toLowerCase().includes("unique"));
      if (isUniqueViolation) {
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
