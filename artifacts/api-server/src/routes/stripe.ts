import { Router, type IRouter, type Request, type Response } from "express";
import type Stripe from "stripe";
import { z } from "zod";
import { getUncachableStripeClient, getStripePublishableKey, isLiveMode } from "../lib/stripeClient";
import { stripeStorage } from "../lib/stripeStorage";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { db } from "@workspace/db";
import { membershipEntitlementsTable, stripeCheckoutRequestLedgerTable, usersTable } from "@workspace/db/schema";
import {
  applyPrepared,
  prepareOneTimeCheckout,
  refreshSubscriptionSource,
  releasePrepared,
  runNotifications,
} from "../lib/membershipRefresh";
import { runBoundedApply } from "../lib/membershipLease";
import { hasQualifyingLifetimeSource } from "../lib/membershipSources";
import { getEffectiveMembership } from "../lib/membershipState";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { paymentErrorResponse } from "../lib/paymentErrorResponse";
import { handleReceiptRequest } from "../lib/receiptHandler";
import { resolveCheckoutRequestKey } from "../lib/checkoutIdempotency";
import { priceGrantsMembership } from "../lib/membershipPricing";

const router: IRouter = Router();

// GET /stripe/config — return publishable key for frontend
router.get("/stripe/config", async (_req: Request, res: Response) => {
  try {
    const publishableKey = await getStripePublishableKey();
    res.json({ publishableKey });
  } catch {
    res.json({ publishableKey: null });
  }
});

// GET /stripe/plans — list all active products+prices from Stripe (synced to local DB)
// Any product a registered user pays for qualifies them for Legendary membership.
router.get("/stripe/plans", async (_req: Request, res: Response) => {
  try {
    const live = await isLiveMode();
    const products = await stripeStorage.listProductsWithPrices(live);
    res.json({ plans: products });
  } catch {
    res.json({ plans: [] });
  }
});

// GET /stripe/subscription — current user's subscription + membership state
router.get("/stripe/subscription", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const userId = req.user.id;
    // authMiddleware already loaded the canonical user row, so prefer
    // req.user.membershipTier over re-querying the DB here.
    const tier = req.user.membershipTier ?? "unregistered";
    // "Does a lifetime row exist" is the wrong question under a model that
    // deliberately RETAINS refunded and dispute-revoked rows: a refunded
    // purchase still has a row, and a bare-existence read would report the user
    // as a lifetime member forever. Ask whether one currently QUALIFIES.
    const [hasLifetime, appSubRows] = await Promise.all([
      hasQualifyingLifetimeSource(userId),
      db.select().from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, userId),
          eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
        ))
        .orderBy(desc(membershipEntitlementsTable.createdAt))
        .limit(1),
    ]);

    const source = appSubRows[0] ?? null;
    // The shape GET /stripe/subscription has always returned, rebuilt from the
    // entitlement source so the client contract is unchanged.
    const appSub = source
      ? {
          id: source.id,
          userId: source.userId,
          stripeSubscriptionId: source.providerRef,
          plan: source.plan,
          status: source.lifecycleStatus,
          currentPeriodEnd: source.currentPeriodEnd,
          cancelAtPeriodEnd: source.cancelAtPeriodEnd ?? false,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        }
      : null;

    // Also fetch the live subscription from Stripe-synced data for renewal dates
    const stripeSub = appSub?.stripeSubscriptionId
      ? await stripeStorage.getSubscriptionForUser(userId)
      : null;

    res.json({
      subscription: stripeSub,
      appSubscription: appSub,
      membershipTier: tier,
      isLifetime: hasLifetime,
    });
  } catch (err) {
    const { logger } = await import("../lib/logger");
    logger.error({ err }, "GET /stripe/subscription DB error");
    res.status(503).json({ error: "Service unavailable — could not load subscription data" });
  }
});

// POST /stripe/checkout — create a Stripe Checkout session
router.post("/stripe/checkout", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { priceId, clientRequestId } = req.body as { priceId?: string; clientRequestId?: string };
  if (!priceId) { res.status(400).json({ error: "priceId required" }); return; }

  try {
    const stripe = await getUncachableStripeClient();
    const user = await stripeStorage.getUserById(req.user.id);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    let customerId = user.stripeCustomerId ?? undefined;
    if (customerId) {
      // Verify the saved customer still exists in Stripe. It may have been
      // deleted, or the Stripe account / API keys may have been rotated since
      // the ID was stored. If it's gone, fall through to create a fresh one.
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean }).deleted) customerId = undefined;
      } catch (e) {
        if ((e as { code?: string }).code === "resource_missing") {
          customerId = undefined;
        } else {
          throw e;
        }
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      await stripeStorage.updateUserStripeCustomerId(user.id, customer.id);
      customerId = customer.id;
    }

    // Validate + resolve price — confirm it exists and is active in Stripe.
    // Expand the product so we can read its membership tag without a 2nd call.
    const priceObj = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    const isOneTime = priceObj.type === "one_time";

    if (!priceObj.active) {
      res.status(400).json({ error: "Invalid price: price is not active" });
      return;
    }

    // Positive membership allowlist (source of truth: the product's
    // `overhype_membership=true` tag). Only membership prices may be checked
    // out here — this endpoint exists solely to purchase Legendary. Reject any
    // other active price (render credits, merch, a cheaper SKU, a $0 price)
    // BEFORE creating the Checkout Session or writing the ledger, so a
    // non-membership purchase can never mint Legendary via price tampering.
    // (Future non-membership purchases get their own flow; the grant layer in
    // membershipGrant/webhookHandlers stays the authoritative gate regardless.)
    const isMembershipPrice = await priceGrantsMembership(priceObj, {
      retrieveProduct: (id) => stripe.products.retrieve(id),
    });
    if (!isMembershipPrice) {
      res.status(400).json({ error: "Invalid price: not a membership plan" });
      return;
    }

    const base = getSiteBaseUrl();
    const requestKey = resolveCheckoutRequestKey({
      userId: user.id,
      priceId,
      clientRequestId,
    });

    const existing = await db.select().from(stripeCheckoutRequestLedgerTable)
      .where(and(
        eq(stripeCheckoutRequestLedgerTable.userId, user.id),
        eq(stripeCheckoutRequestLedgerTable.priceId, priceId),
        eq(stripeCheckoutRequestLedgerTable.requestKey, requestKey),
      ))
      .orderBy(desc(stripeCheckoutRequestLedgerTable.createdAt))
      .limit(1);
    if (existing[0]?.sessionId) {
      const reusedSession = await stripe.checkout.sessions.retrieve(existing[0].sessionId);
      if (reusedSession.url) {
        res.json({ url: reusedSession.url, reused: true });
        return;
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: isOneTime ? "payment" : "subscription",
      // Pass userId so the webhook handler can link the purchase to the user even
      // if the Stripe customer lookup fails for any reason (safety net)
      metadata: { userId: user.id },
      // Tag one-time payments so the webhook can identify lifetime purchases
      ...(isOneTime ? { payment_intent_data: { metadata: { membership: "true", plan: "lifetime", userId: user.id } } } : {}),
      // {CHECKOUT_SESSION_ID} is a Stripe template substituted at redirect time.
      // The confirm endpoint uses this ID to verify payment synchronously, so the
      // frontend can grant Legendary immediately without waiting for the webhook.
      success_url: `${base}/profile?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/pricing`,
    }, {
      idempotencyKey: requestKey,
    });

    if (session.id) {
      await db.insert(stripeCheckoutRequestLedgerTable).values({
        userId: user.id,
        priceId,
        requestKey,
        sessionId: session.id,
      }).onConflictDoNothing();
    }

    res.json({ url: session.url });
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to start checkout. Please try again.",
      logMessage: "POST /stripe/checkout error",
      extra: { userId: req.user.id, priceId },
    });
  }
});

// GET /stripe/payment-history — current user's payment history
router.get("/stripe/payment-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const history = await stripeStorage.getPaymentHistory(req.user.id);
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

// GET /stripe/invoice/:invoiceId/receipt — redirect to the customer-facing hosted
// invoice page (no Stripe login required). Verifies the invoice belongs to the
// authenticated user before redirecting, to prevent information disclosure.
router.get("/stripe/invoice/:invoiceId/receipt", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { invoiceId } = req.params;
  if (typeof invoiceId !== "string" || !invoiceId.startsWith("in_")) {
    res.status(400).json({ error: "Invalid invoice ID" });
    return;
  }
  try {
    const stripe = await getUncachableStripeClient();
    const result = await handleReceiptRequest(req.user.id, invoiceId, {
      getUserById: (id) => stripeStorage.getUserById(id),
      retrieveInvoice: (id) => stripe.invoices.retrieve(id),
    });
    if (result.type === "redirect") {
      res.redirect(302, result.url);
    } else {
      res.status(result.status).json({ error: result.message });
    }
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to retrieve receipt. Please try again.",
      logMessage: "GET /stripe/invoice/:invoiceId/receipt error",
      extra: { userId: req.user.id, invoiceId },
    });
  }
});

// GET /stripe/membership — current user's membership tier
router.get("/stripe/membership", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  // authMiddleware already loaded the canonical user row, so prefer
  // req.user.membershipTier over re-querying the DB here.
  const tier = req.user.membershipTier ?? "unregistered";
  res.json({ tier });
});

// GET /stripe/access-revocation-notice — informational notice shown to users
// who were involuntarily downgraded to 'registered' due to a refund or
// dispute. Returns { notice: null } when no notice should be shown.
// The payload intentionally omits all sensitive Stripe data (IDs, amounts).
router.get("/stripe/access-revocation-notice", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const notice = await stripeStorage.getAccessRevocationNotice(req.user.id);
    res.json({ notice });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, "GET /stripe/access-revocation-notice error");
    res.json({ notice: null });
  }
});

// POST /stripe/checkout/confirm — synchronously verify a completed checkout session and
// immediately grant Legendary without waiting for the webhook. Called by the success page
// with the session_id Stripe injects into {CHECKOUT_SESSION_ID} in the success_url.
//
// The webhook remains the source of truth for renewals, cancellations, and refunds.
// This endpoint handles only the initial grant so the UX is instant (~500ms) instead
// of waiting up to 30 seconds for the webhook to arrive.

const confirmBodySchema = z.object({
  sessionId: z.string().min(1).refine((s) => s.startsWith("cs_"), {
    message: "sessionId must start with cs_",
  }),
});

router.post("/stripe/checkout/confirm", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const parsed = confirmBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid sessionId" });
    return;
  }
  const { sessionId } = parsed.data;

  try {
    const [stripe, user] = await Promise.all([
      getUncachableStripeClient(),
      stripeStorage.getUserById(req.user.id),
    ]);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    // The same trust boundary the webhook uses, with `expectedUserId` bound to
    // the caller: the acceptance case is that a valid session belonging to
    // ANOTHER customer cannot be applied to the requesting user, and binding it
    // here is what makes the ownership check a property of the verifier rather
    // than a separate guard this route has to remember.
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.mode === "subscription") {
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (!subscriptionId) {
        res.status(400).json({ error: "Checkout session has no subscription" });
        return;
      }
      const applied = await refreshSubscriptionSource(stripe, subscriptionId, {
        linkHintUserId: req.user.id,
        expectedUserId: req.user.id,
        // subscription_activated is now recorded unconditionally by applySubscription
        // itself when the source is newly created — passing it here too would
        // double-write the history fact.
      });
      if (!applied.applied) {
        logger.warn({ userId: req.user.id, sessionId, reason: applied.reason }, "checkout/confirm did not apply");
        res.status(applied.reason === "user_mismatch" ? 403 : 400).json({
          error: applied.reason === "user_mismatch"
            ? "This checkout session belongs to a different account"
            : "Checkout could not be confirmed yet — it will apply automatically once Stripe confirms payment",
        });
        return;
      }
      const membership = await getEffectiveMembership(req.user.id);
      res.json({ source: "subscription", result: "granted", tier: membership?.tier ?? null });
      return;
    }

    const prepared = await prepareOneTimeCheckout(stripe, sessionId, { expectedUserId: req.user.id });
    if (prepared.kind === "noop") {
      logger.warn({ userId: req.user.id, sessionId, reason: prepared.reason }, "checkout/confirm did not apply");
      res.status(prepared.reason === "user_mismatch" ? 403 : 400).json({
        error: prepared.reason === "user_mismatch"
          ? "This checkout session belongs to a different account"
          : "Checkout could not be confirmed yet — it will apply automatically once Stripe confirms payment",
      });
      return;
    }

    try {
      const applied = await runBoundedApply((tx) => applyPrepared(tx, prepared));
      await runNotifications(applied.notifications);
      logger.info(
        { userId: req.user.id, sessionId, applied: applied.applied },
        "checkout/confirm applied through the trust boundary",
      );
      const membership = await getEffectiveMembership(req.user.id);
      res.json({
        source: "lifetime",
        result: applied.applied ? "granted" : "already_recorded",
        tier: membership?.tier ?? null,
      });
    } finally {
      await releasePrepared(prepared);
    }

  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to confirm checkout. Please try again or contact support.",
      logMessage: "POST /stripe/checkout/confirm error",
      extra: { sessionId, userId: req.user.id },
    });
  }
});

// POST /stripe/portal — create a Stripe Customer Portal session
router.post("/stripe/portal", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const user = await stripeStorage.getUserById(req.user.id);
    if (!user?.stripeCustomerId) {
      res.status(400).json({ error: "No billing account found" });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const base = getSiteBaseUrl();
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${base}/profile?from_portal=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to open billing portal. Please try again.",
      logMessage: "POST /stripe/portal error",
      extra: { userId: req.user.id },
    });
  }
});

// Helper: get the user's active non-lifetime subscription from Stripe
async function getActiveStripeSub(userId: string) {
  const user = await stripeStorage.getUserById(userId);
  if (!user?.stripeCustomerId) return null;

  // Fetch active subscriptions from Stripe (not local DB)
  const stripe = await getUncachableStripeClient();
  const subs = await stripe.subscriptions.list({
    customer: user.stripeCustomerId,
    status: "active",
    limit: 5,
  });
  return subs.data[0] ?? null;
}

// POST /stripe/subscription/cancel — cancel subscription at period end
router.post("/stripe/subscription/cancel", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const userId = req.user.id;

    // Block lifetime users — but only those whose entitlement still QUALIFIES.
    // A refunded lifetime purchase keeps its row, and blocking on mere existence
    // would leave a refunded user unable to cancel a subscription they do have.
    if (await hasQualifyingLifetimeSource(userId)) {
      res.status(400).json({ error: "Legendary for Life members do not have a recurring subscription to cancel" });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const user = await stripeStorage.getUserById(userId);
    if (!user?.stripeCustomerId) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "active", limit: 5 });
    const sub = subs.data[0];
    if (!sub) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    // Re-retrieve rather than write what we believe we just set. This route
    // completes its Stripe call BEFORE its local write, so a token minted after
    // the lock would order database application rather than provider state: a
    // stalled response could acquire the lock after a newer webhook stored
    // `canceled` and overwrite it with stale `active`. Going through the same
    // authoritative refresh the webhook uses removes the special case instead of
    // trying to order it.
    await refreshSubscriptionSource(stripe, sub.id);

    res.json({ subscription: updated });
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to cancel subscription. Please try again.",
      logMessage: "POST /stripe/subscription/cancel error",
      extra: { userId: req.user.id },
    });
  }
});

// POST /stripe/subscription/reactivate — undo cancel_at_period_end
router.post("/stripe/subscription/reactivate", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const userId = req.user.id;

    // Block lifetime users — same guard as cancel
    const lifetimeRowsReactivate = (await hasQualifyingLifetimeSource(userId)) ? [1] : [];
    if (lifetimeRowsReactivate.length > 0) {
      res.status(400).json({ error: "Legendary for Life members do not have a recurring subscription to reactivate" });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const user = await stripeStorage.getUserById(userId);
    if (!user?.stripeCustomerId) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    // Find subscriptions that are active or set to cancel at period end
    const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "active", limit: 5 });
    const sub = subs.data[0];
    if (!sub) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    if (!sub.cancel_at_period_end) {
      res.status(400).json({ error: "Subscription is not set to cancel" });
      return;
    }

    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });

    // Re-retrieve rather than write what we believe we just set — see the cancel
    // route above for why a local write after a Stripe call cannot be ordered.
    await refreshSubscriptionSource(stripe, sub.id);

    res.json({ subscription: updated });
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to reactivate subscription. Please try again.",
      logMessage: "POST /stripe/subscription/reactivate error",
      extra: { userId: req.user.id },
    });
  }
});

// GET /stripe/subscription/switch-preview?targetPriceId=... — proration preview
router.get("/stripe/subscription/switch-preview", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { targetPriceId } = req.query as { targetPriceId?: string };
  if (!targetPriceId) { res.status(400).json({ error: "targetPriceId required" }); return; }

  try {
    // Block lifetime users — same guard as switch-plan/cancel/reactivate
    const lifetimeRowsPreview = (await hasQualifyingLifetimeSource(req.user.id)) ? [1] : [];
    if (lifetimeRowsPreview.length > 0) {
      res.status(400).json({ error: "Legendary for Life members do not have a recurring subscription to switch" });
      return;
    }

    const stripe = await getUncachableStripeClient();

    // Validate target price exists and is active
    const priceObj = await stripe.prices.retrieve(targetPriceId, { expand: ["product"] });
    if (!priceObj.active) {
      res.status(400).json({ error: "Invalid price: price is not active" });
      return;
    }
    // Membership allowlist: you can only switch onto another membership price —
    // never a non-membership plan (which would keep Legendary while paying for
    // something else).
    if (!(await priceGrantsMembership(priceObj, { retrieveProduct: (id) => stripe.products.retrieve(id) }))) {
      res.status(400).json({ error: "Invalid price: not a membership plan" });
      return;
    }

    const sub = await getActiveStripeSub(req.user.id);
    if (!sub) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    const currentItem = sub.items.data[0];
    if (!currentItem) {
      res.status(400).json({ error: "Subscription has no price item" });
      return;
    }

    // Enforce monthly→annual only: current must be monthly, target must be annual
    const currentInterval = currentItem.price?.recurring?.interval;
    const targetInterval = priceObj.recurring?.interval;
    if (currentInterval !== "month") {
      res.status(400).json({ error: "Plan switches are only supported from monthly to annual billing" });
      return;
    }
    if (targetInterval !== "year") {
      res.status(400).json({ error: "Target plan must be an annual price" });
      return;
    }

    // Retrieve proration preview via invoice preview
    const upcoming = await stripe.invoices.createPreview({
      customer: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      subscription: sub.id,
      subscription_details: {
        items: [{ id: currentItem.id, price: targetPriceId }],
        proration_behavior: "create_prorations",
      },
    });

    res.json({
      amountDue: upcoming.amount_due,
      currency: upcoming.currency,
      lines: upcoming.lines.data.map((l: { description: string | null; amount: number }) => ({
        description: l.description,
        amount: l.amount,
      })),
    });
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to preview subscription change. Please try again.",
      logMessage: "GET /stripe/subscription/switch-preview error",
      extra: { userId: req.user.id, targetPriceId },
    });
  }
});

// POST /stripe/subscription/switch-plan — switch subscription to a new price
router.post("/stripe/subscription/switch-plan", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { targetPriceId } = req.body as { targetPriceId?: string };
  if (!targetPriceId) { res.status(400).json({ error: "targetPriceId required" }); return; }

  try {
    const stripe = await getUncachableStripeClient();

    // Validate target price exists and is active
    const priceObj = await stripe.prices.retrieve(targetPriceId, { expand: ["product"] });
    if (!priceObj.active) {
      res.status(400).json({ error: "Invalid price: price is not active" });
      return;
    }
    // Membership allowlist: only switch onto another membership price (see
    // switch-preview) — never a non-membership plan.
    if (!(await priceGrantsMembership(priceObj, { retrieveProduct: (id) => stripe.products.retrieve(id) }))) {
      res.status(400).json({ error: "Invalid price: not a membership plan" });
      return;
    }

    // Block lifetime users
    const lifetimeRows = (await hasQualifyingLifetimeSource(req.user.id)) ? [1] : [];
    if (lifetimeRows.length > 0) {
      res.status(400).json({ error: "Legendary for Life members do not have a recurring subscription to switch" });
      return;
    }

    const sub = await getActiveStripeSub(req.user.id);
    if (!sub) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    const currentItem = sub.items.data[0];
    if (!currentItem) {
      res.status(400).json({ error: "Subscription has no price item" });
      return;
    }

    // Enforce monthly→annual only: current must be monthly, target must be annual
    const currentSwitchInterval = currentItem.price?.recurring?.interval;
    const targetSwitchInterval = priceObj.recurring?.interval;
    if (currentSwitchInterval !== "month") {
      res.status(400).json({ error: "Plan switches are only supported from monthly to annual billing" });
      return;
    }
    if (targetSwitchInterval !== "year") {
      res.status(400).json({ error: "Target plan must be an annual price" });
      return;
    }

    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: currentItem.id, price: targetPriceId }],
      proration_behavior: "create_prorations",
    });

    // Re-retrieve rather than write what we believe we just set. This matters
    // most here: the plan switch is exactly the path that can move a
    // subscription OFF an allowlisted product, and only a refresh re-evaluates
    // `is_membership_product` against what the user is now subscribed to.
    await refreshSubscriptionSource(stripe, sub.id);

    res.json({ subscription: updated });
  } catch (err) {
    paymentErrorResponse({
      req,
      res,
      err,
      clientMessage: "Unable to switch subscription plan. Please try again.",
      logMessage: "POST /stripe/subscription/switch-plan error",
      extra: { userId: req.user.id, targetPriceId },
    });
  }
});

export default router;
