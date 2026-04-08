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

    // Fail-closed membership validation: price must be in allowlist OR product must have
    // metadata.membership="true". This check always runs, regardless of allowlist presence.
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const inAllowlist = allowlist.length > 0 && allowlist.includes(priceId);
    const prod = priceObj.product as import("stripe").Stripe.Product | null;
    const hasMetaTag = prod && typeof prod !== "string" && prod.metadata?.membership === "true";
    if (!inAllowlist && !hasMetaTag) {
      res.status(400).json({ error: "Invalid price: not a recognized membership product" });
      return;
    }

    const base = getBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: isOneTime ? "payment" : "subscription",
      // Tag one-time payments so the webhook can identify lifetime purchases
      ...(isOneTime ? { payment_intent_data: { metadata: { membership: "true", plan: "lifetime" } } } : {}),
      success_url: `${base}/overhype-me/profile?checkout=success`,
      cancel_url: `${base}/overhype-me/pricing`,
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
      return_url: `${base}/overhype-me/profile`,
    });

    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portal session failed";
    res.status(500).json({ error: msg });
  }
});

export default router;
