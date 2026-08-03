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
  refreshSubscriptionSourceAfterMutation,
  releasePrepared,
  runNotifications,
} from "../lib/membershipRefresh";
import { runBoundedApply } from "../lib/membershipLease";
import { hasQualifyingLifetimeSource, loadSourceSnapshots } from "../lib/membershipSources";
import {
  QUALIFIABLE_SUBSCRIPTION_STATUSES,
  getEffectiveMembership,
  qualifySource,
} from "../lib/membershipState";
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

/**
 * The ONE subscription the panel describes AND its controls act on.
 *
 * Shared deliberately. When only the GET path used this selection, cancel,
 * reactivate, switch-preview and switch-plan each independently took the first
 * entry of `subscriptions.list({ status: "active" })` — so if newer
 * subscription B was disputed or on a non-membership price while older A was
 * the qualifying source, the panel described A and every button mutated B. A
 * user could be told their subscription was cancelled while A kept billing.
 *
 * `qualifies` is returned rather than folded in, because the two consumers want
 * different things from a non-qualifying result: the panel still renders the
 * newest row so a fully-cancelled user sees their history instead of an empty
 * card, while a mutation must refuse — cancelling an already-cancelled
 * subscription is not a request anyone made.
 */
async function selectMembershipSubscription(userId: string): Promise<{
  hasLifetime: boolean;
  source: typeof membershipEntitlementsTable.$inferSelect | null;
  qualifies: boolean;
}> {
  // ONE snapshot, and REPEATABLE READ is what makes that true. Qualification
  // and the row that gets returned must come from the same read: a webhook
  // cancelling or disputing B between the two statements leaves B in
  // `qualifyingIds` from the first while the second returns its new
  // non-qualifying state — selecting B over the older qualifying A and
  // recreating exactly the mismatch this selection exists to prevent.
  //
  // A bare transaction does NOT prevent that. Under the pool's default READ
  // COMMITTED isolation every statement takes a fresh snapshot, so grouping the
  // two reads changes only their atomicity on write, which this read path has
  // none of. The isolation level is the fix; the transaction alone was the
  // appearance of one. Safe to raise because this is a pure read: a
  // serialization failure has nothing to undo and no write to retry.
  //
  // "Does a lifetime row exist" is likewise the wrong question under a model
  // that deliberately RETAINS refunded and dispute-revoked rows. Ask whether one
  // currently QUALIFIES — `loadSourceSnapshots` resolves the dispute hold as a
  // query, which is what makes qualification here mean the same thing it means
  // in the derivation.
  const { hasLifetime, subscriptionSnapshots, appSubRows } = await db.transaction(async (tx) => {
    const snapshots = await loadSourceSnapshots(tx, userId);
    const rows = await tx.select().from(membershipEntitlementsTable)
      .where(and(
        eq(membershipEntitlementsTable.userId, userId),
        eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
      ))
      .orderBy(desc(membershipEntitlementsTable.createdAt));
    return {
      hasLifetime: snapshots.some(
        (snapshot) =>
          (snapshot.sourceType === "stripe_lifetime_payment" ||
            snapshot.sourceType === "admin_grant") &&
          qualifySource(snapshot, new Date()).qualifies,
      ),
      subscriptionSnapshots: snapshots.filter(
        (snapshot) => snapshot.sourceType === "stripe_subscription",
      ),
      appSubRows: rows,
    };
  }, { isolationLevel: "repeatable read" });

  // The newest source that still GRANTS access, not simply the newest row. The
  // model supports more than one subscription source, and picking by recency
  // alone returns a cancelled subscription B while access rests on an older
  // active A.
  const now = new Date();
  const qualifyingIds = new Set(
    subscriptionSnapshots
      .filter((snapshot) => qualifySource(snapshot, now).qualifies)
      .map((snapshot) => snapshot.id),
  );
  const qualifying = appSubRows.find((row) => qualifyingIds.has(row.id)) ?? null;
  return {
    hasLifetime,
    source: qualifying ?? appSubRows[0] ?? null,
    qualifies: qualifying !== null,
  };
}

// GET /stripe/subscription — current user's subscription + membership state
router.get("/stripe/subscription", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const userId = req.user.id;
    // authMiddleware already loaded the canonical user row, so prefer
    // req.user.membershipTier over re-querying the DB here.
    const tier = req.user.membershipTier ?? "unregistered";
    const { hasLifetime, source } = await selectMembershipSubscription(userId);

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
    // BY ID, so both halves of this response describe the same subscription.
    const stripeSub = appSub?.stripeSubscriptionId
      ? await stripeStorage.getSubscriptionForUser(userId, appSub.stripeSubscriptionId)
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
      let stale = false;
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean }).deleted) stale = true;
      } catch (e) {
        if ((e as { code?: string }).code === "resource_missing") {
          stale = true;
        } else {
          throw e;
        }
      }
      if (stale) {
        // CLEAR THE COLUMN, not just the local variable.
        //
        // The conditional bind below only fires on a NULL column, so leaving a
        // known-dead id stored meant the bind necessarily lost, the adopt-the-
        // winner re-read handed back that same dead id, and session creation
        // failed — turning a path that used to recover on its own into a hard
        // error. Compare-and-swap on the exact stale value so this cannot stomp
        // a good id another request bound in the meantime.
        await stripeStorage.clearStripeCustomerIfMatches(user.id, customerId);
        logger.info(
          { userId: user.id, staleCustomerId: customerId },
          "the saved Stripe customer is gone from this account — clearing it and creating a fresh one",
        );
        customerId = undefined;
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      // Bind CONDITIONALLY, and settle the race before any session exists.
      //
      // The unconditional setter is last-writer-wins: two racing first
      // checkouts each created a customer and the user ended up pointing at
      // only one of them. A paid session on the other belongs to nobody — its
      // verification resolves no user, `user_unresolvable` is permanent, and the
      // purchase is silently lost. So the loser adopts the winner's customer
      // here, while the customer it created is still session-free and therefore
      // harmless to abandon.
      if (await stripeStorage.bindStripeCustomerIfUnset(user.id, customer.id)) {
        customerId = customer.id;
      } else {
        const rebound = await stripeStorage.getUserById(user.id);
        customerId = rebound?.stripeCustomerId ?? customer.id;
        logger.info(
          { userId: user.id, abandonedCustomerId: customer.id, customerId },
          "another checkout bound this user's Stripe customer first — using theirs",
        );
      }
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
        // The hint must come from the SESSION's own metadata (set by our backend
        // at checkout creation — see POST /stripe/checkout), never from the
        // caller's identity. Hinting with req.user.id would let bindUser link an
        // unbound customer to whichever authenticated caller happens to submit
        // this session id, and then trivially pass expectedUserId because it had
        // just linked the customer to that same id moments before.
        ...(session.metadata?.userId ? { linkHintUserId: session.metadata.userId } : {}),
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

/**
 * What a mutation route is allowed to act on.
 *
 * `target_changed` is a first-class outcome, not an error dressed up as one.
 * When the displayed subscription turns out to be stale, this helper repairs the
 * local source — and the correct target afterwards may be a DIFFERENT
 * subscription. Silently mutating that one would mean a single click aimed at B
 * cancels A, which the user never saw and never asked for. So the route stops
 * and tells the client to refetch.
 */
type MutationTarget =
  | { kind: "subscription"; subscription: Stripe.Subscription }
  | { kind: "none" }
  | { kind: "target_changed" };

/**
 * The Stripe subscription a mutation route may act on — the SAME one the panel
 * is describing.
 *
 * Retrieved by id from the server-side selection rather than taken as the first
 * entry of `subscriptions.list({ status: "active" })`. The list order is
 * Stripe's, not ours, so it could hand back a subscription the panel is not
 * showing; and `status: "active"` excludes a `past_due` subscription that still
 * qualifies during its grace window, which left a member in dunning unable to
 * cancel the thing they were being dunned for.
 *
 * The panel's fallback to the newest non-qualifying row is for DISPLAY only and
 * must never become a mutation target.
 */
async function getMutationTarget(stripe: Stripe, userId: string): Promise<MutationTarget> {
  // The CALLER's client, not a fresh one. `stripe_live_mode` is operator-tunable
  // at runtime, so a second `getUncachableStripeClient()` here could resolve to
  // the other account mid-request: the target would be retrieved from one mode
  // and mutated through the other. One client per request means one mode
  // snapshot across selection, price validation, mutation and refresh.
  const selected = await selectMembershipSubscription(userId);
  if (!selected.qualifies || !selected.source?.providerRef) return { kind: "none" };

  const live = await retrieveSubscription(stripe, userId, selected.source.providerRef);
  if (!live) return { kind: "none" };

  // The question is whether the LIVE subscription still qualifies — not whether
  // Stripe would technically accept an update on it.
  //
  // Those differ, and the difference is a money bug: `unpaid` and `paused` are
  // both mutable and both non-qualifying, so a locally-stale row that Stripe had
  // moved to one of them passed a mutability check and became the target while
  // an OLDER, actually-qualifying subscription kept billing. Asking the
  // qualification question means this gate and the derivation agree by
  // construction.
  if (QUALIFIABLE_SUBSCRIPTION_STATUSES.has(live.status)) return { kind: "subscription", subscription: live };

  // Local state was stale. Repair it authoritatively, then reselect ONCE — one
  // retry, not a loop: if the second selection is also stale, something is
  // actively racing us and refusing beats spinning.
  logger.info(
    { userId, subscriptionId: live.id, status: live.status },
    "the selected subscription no longer qualifies at Stripe — refreshing the local source and reselecting",
  );
  await refreshSubscriptionSourceAfterMutation(stripe, live.id);

  const reselected = await selectMembershipSubscription(userId);
  if (!reselected.qualifies || !reselected.source?.providerRef) return { kind: "none" };

  // A DIFFERENT subscription is now the right target — but it is not the one the
  // user was looking at when they clicked, so acting on it would be acting
  // without consent. The local source has been repaired, so the client's refetch
  // will show the truth and a second click means what it says.
  if (reselected.source.providerRef !== live.id) return { kind: "target_changed" };

  const fresh = await retrieveSubscription(stripe, userId, reselected.source.providerRef);
  return fresh && QUALIFIABLE_SUBSCRIPTION_STATUSES.has(fresh.status)
    ? { kind: "subscription", subscription: fresh }
    : { kind: "none" };
}

/** The 409 a route answers when its target moved out from under the click. */
function respondTargetChanged(res: Response): void {
  res.status(409).json({
    error:
      "Your subscription details have changed since this page loaded. " +
      "Refresh and try again — nothing was modified.",
    targetChanged: true,
  });
}

async function retrieveSubscription(stripe: Stripe, userId: string, subscriptionId: string) {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    logger.warn(
      { err: error, userId, subscriptionId },
      "the qualifying subscription source could not be retrieved from Stripe",
    );
    return null;
  }
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
    // The subscription the PANEL is describing, not whichever entry Stripe's
    // list happens to return first — otherwise the button and the card can
    // disagree about which subscription they mean.
    const target = await getMutationTarget(stripe, userId);
    if (target.kind === "target_changed") {
      respondTargetChanged(res);
      return;
    }
    if (target.kind === "none") {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }
    const sub = target.subscription;

    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    // Re-retrieve rather than write what we believe we just set. This route
    // completes its Stripe call BEFORE its local write, so a token minted after
    // the lock would order database application rather than provider state: a
    // stalled response could acquire the lock after a newer webhook stored
    // `canceled` and overwrite it with stale `active`. Going through the same
    // authoritative refresh the webhook uses removes the special case instead of
    // trying to order it.
    const localRefresh = await refreshSubscriptionSourceAfterMutation(stripe, sub.id);

    // The Stripe half of this response is authoritative either way; the flag
    // says only that our local entitlement row may lag until its webhook lands.
    res.json({ subscription: updated, ...(localRefresh.applied ? {} : { localStateStale: true }) });
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
    // The subscription the PANEL is describing, not whichever entry Stripe's
    // list happens to return first — otherwise the button and the card can
    // disagree about which subscription they mean.
    const target = await getMutationTarget(stripe, userId);
    if (target.kind === "target_changed") {
      respondTargetChanged(res);
      return;
    }
    if (target.kind === "none") {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }
    const sub = target.subscription;

    if (!sub.cancel_at_period_end) {
      res.status(400).json({ error: "Subscription is not set to cancel" });
      return;
    }

    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });

    // Re-retrieve rather than write what we believe we just set — see the cancel
    // route above for why a local write after a Stripe call cannot be ordered.
    const localRefresh = await refreshSubscriptionSourceAfterMutation(stripe, sub.id);

    // The Stripe half of this response is authoritative either way; the flag
    // says only that our local entitlement row may lag until its webhook lands.
    res.json({ subscription: updated, ...(localRefresh.applied ? {} : { localStateStale: true }) });
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

    const target = await getMutationTarget(stripe, req.user.id);
    if (target.kind === "target_changed") {
      respondTargetChanged(res);
      return;
    }
    if (target.kind === "none") {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }
    const sub = target.subscription;

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

    const target = await getMutationTarget(stripe, req.user.id);
    if (target.kind === "target_changed") {
      respondTargetChanged(res);
      return;
    }
    if (target.kind === "none") {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }
    const sub = target.subscription;

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
    const localRefresh = await refreshSubscriptionSourceAfterMutation(stripe, sub.id);

    // The Stripe half of this response is authoritative either way; the flag
    // says only that our local entitlement row may lag until its webhook lands.
    res.json({ subscription: updated, ...(localRefresh.applied ? {} : { localStateStale: true }) });
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
