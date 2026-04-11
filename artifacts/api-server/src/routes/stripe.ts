import { Router, type IRouter, type Request, type Response } from "express";
import { getUncachableStripeClient, getStripePublishableKey } from "../lib/stripeClient";
import { stripeStorage } from "../lib/stripeStorage";
import { db } from "@workspace/db";
import { lifetimeEntitlementsTable, subscriptionsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

function getBaseUrl(req: Request): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domain) return `https://${domain}`;
  return `${req.protocol}://${req.get("host")}`;
}

// GET /stripe/config — return publishable key for frontend
router.get("/stripe/config", async (_req: Request, res: Response) => {
  try {
    const publishableKey = await getStripePublishableKey();
    res.json({ publishableKey });
  } catch {
    res.json({ publishableKey: null });
  }
});

// GET /stripe/plans — list membership products+prices from Stripe (synced to local DB)
// Only returns products tagged with metadata.membership="true" OR in MEMBERSHIP_PRICE_IDS allowlist
router.get("/stripe/plans", async (_req: Request, res: Response) => {
  try {
    const products = await stripeStorage.listProductsWithPrices();
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);

    const membershipProducts = products.filter(p => {
      const hasMetaTag = p.metadata?.membership === "true";
      const hasPriceInAllowlist = allowlist.length > 0 && p.prices.some(pr => allowlist.includes(pr.id));
      return hasMetaTag || hasPriceInAllowlist;
    });

    // Return all if no products are tagged (dev/initial setup — no products configured yet)
    res.json({ plans: membershipProducts.length > 0 ? membershipProducts : products });
  } catch {
    res.json({ plans: [] });
  }
});

// GET /stripe/subscription — current user's subscription + membership state
router.get("/stripe/subscription", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const userId = req.user.id;
    const [tier, lifetimeRows, appSubRows] = await Promise.all([
      stripeStorage.getMembershipTierForUser(userId),
      db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, userId)).limit(1),
      db.select().from(subscriptionsTable)
        .where(eq(subscriptionsTable.userId, userId))
        .orderBy(desc(subscriptionsTable.createdAt))
        .limit(1),
    ]);

    const hasLifetime = lifetimeRows.length > 0;
    const appSub = appSubRows[0] ?? null;

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
  } catch {
    res.json({ subscription: null, appSubscription: null, membershipTier: "unregistered", isLifetime: false });
  }
});

// POST /stripe/checkout — create a Stripe Checkout session
router.post("/stripe/checkout", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { priceId } = req.body as { priceId?: string };
  if (!priceId) { res.status(400).json({ error: "priceId required" }); return; }

  try {
    const stripe = await getUncachableStripeClient();
    const user = await stripeStorage.getUserById(req.user.id);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    let customerId = user.stripeCustomerId ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      await stripeStorage.updateUserStripeCustomerId(user.id, customer.id);
      customerId = customer.id;
    }

    // Validate + resolve price — always fetch with product expanded
    const priceObj = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    const isOneTime = priceObj.type === "one_time";

    // Membership validation: price must be in allowlist OR product must have
    // metadata.membership="true". Mirrors the /stripe/plans fallback: if neither
    // is configured (no allowlist set, no tagged products), allow all prices through
    // so the app works out of the box before Stripe metadata is configured.
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const inAllowlist = allowlist.length > 0 && allowlist.includes(priceId);
    const prod = priceObj.product as import("stripe").Stripe.Product | null;
    const hasMetaTag = prod && typeof prod !== "string" && prod.metadata?.membership === "true";
    const noGlobalConfig = allowlist.length === 0 && !hasMetaTag;
    if (!inAllowlist && !hasMetaTag && !noGlobalConfig) {
      res.status(400).json({ error: "Invalid price: not a recognized membership product" });
      return;
    }

    const base = getBaseUrl(req);
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
      success_url: `${base}/profile?checkout=success`,
      cancel_url: `${base}/pricing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Checkout failed";
    res.status(500).json({ error: msg });
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

// GET /stripe/membership — current user's membership tier
router.get("/stripe/membership", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ tier: "unregistered" }); return; }
  try {
    const tier = await stripeStorage.getMembershipTierForUser(req.user.id);
    res.json({ tier });
  } catch {
    res.json({ tier: "unregistered" });
  }
});

// POST /stripe/portal — create a Stripe Customer Portal session
router.post("/stripe/portal", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const user = await stripeStorage.getUserById(req.user.id);
    if (!user?.stripeCustomerId) {
      res.status(400).json({ error: "No active subscription found" });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const base = getBaseUrl(req);
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${base}/profile`,
    });

    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portal session failed";
    res.status(500).json({ error: msg });
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

    // Block lifetime users
    const [lifetimeRows] = await Promise.all([
      db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, userId)).limit(1),
    ]);
    if (lifetimeRows.length > 0) {
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

    // Sync local DB immediately so next GET /stripe/subscription reflects updated state
    await db
      .update(subscriptionsTable)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptionsTable.stripeSubscriptionId, sub.id));

    res.json({ subscription: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cancel failed";
    res.status(500).json({ error: msg });
  }
});

// POST /stripe/subscription/reactivate — undo cancel_at_period_end
router.post("/stripe/subscription/reactivate", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const userId = req.user.id;

    // Block lifetime users — same guard as cancel
    const lifetimeRowsReactivate = await db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, userId)).limit(1);
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

    // Sync local DB immediately so next GET /stripe/subscription reflects updated state
    await db
      .update(subscriptionsTable)
      .set({ cancelAtPeriodEnd: false })
      .where(eq(subscriptionsTable.stripeSubscriptionId, sub.id));

    res.json({ subscription: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Reactivate failed";
    res.status(500).json({ error: msg });
  }
});

// GET /stripe/subscription/switch-preview?targetPriceId=... — proration preview
router.get("/stripe/subscription/switch-preview", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { targetPriceId } = req.query as { targetPriceId?: string };
  if (!targetPriceId) { res.status(400).json({ error: "targetPriceId required" }); return; }

  try {
    // Block lifetime users — same guard as switch-plan/cancel/reactivate
    const lifetimeRowsPreview = await db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, req.user.id)).limit(1);
    if (lifetimeRowsPreview.length > 0) {
      res.status(400).json({ error: "Legendary for Life members do not have a recurring subscription to switch" });
      return;
    }

    const stripe = await getUncachableStripeClient();

    // Validate target price is a recognized membership price — fail-closed
    const priceObj = await stripe.prices.retrieve(targetPriceId, { expand: ["product"] });
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const inAllowlist = allowlist.length > 0 && allowlist.includes(targetPriceId);
    const prod = priceObj.product as import("stripe").Stripe.Product | null;
    const hasMetaTag = prod && typeof prod !== "string" && prod.metadata?.membership === "true";
    if (!inAllowlist && !hasMetaTag) {
      res.status(400).json({ error: "Invalid price: not a recognized membership product" });
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
    const msg = err instanceof Error ? err.message : "Preview failed";
    res.status(500).json({ error: msg });
  }
});

// POST /stripe/subscription/switch-plan — switch subscription to a new price
router.post("/stripe/subscription/switch-plan", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { targetPriceId } = req.body as { targetPriceId?: string };
  if (!targetPriceId) { res.status(400).json({ error: "targetPriceId required" }); return; }

  try {
    const stripe = await getUncachableStripeClient();

    // Validate target price — fail-closed (no allowlist bypass for mutation endpoints)
    const priceObj = await stripe.prices.retrieve(targetPriceId, { expand: ["product"] });
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const inAllowlist = allowlist.length > 0 && allowlist.includes(targetPriceId);
    const prod = priceObj.product as import("stripe").Stripe.Product | null;
    const hasMetaTag = prod && typeof prod !== "string" && prod.metadata?.membership === "true";
    if (!inAllowlist && !hasMetaTag) {
      res.status(400).json({ error: "Invalid price: not a recognized membership product" });
      return;
    }

    // Block lifetime users
    const lifetimeRows = await db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, req.user.id)).limit(1);
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

    // Sync local DB immediately so next GET /stripe/subscription reflects updated plan
    await db
      .update(subscriptionsTable)
      .set({ plan: "annual" })
      .where(eq(subscriptionsTable.stripeSubscriptionId, sub.id));

    res.json({ subscription: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Plan switch failed";
    res.status(500).json({ error: msg });
  }
});

export default router;
