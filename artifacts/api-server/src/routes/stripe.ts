import { Router, type IRouter, type Request, type Response } from "express";
import { getUncachableStripeClient, getStripePublishableKey } from "../lib/stripeClient";
import { stripeStorage } from "../lib/stripeStorage";

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

// GET /stripe/plans — list products+prices from Stripe (synced to local DB)
router.get("/stripe/plans", async (_req: Request, res: Response) => {
  try {
    const products = await stripeStorage.listProductsWithPrices();
    res.json({ plans: products });
  } catch {
    res.json({ plans: [] });
  }
});

// GET /stripe/subscription — current user's subscription
router.get("/stripe/subscription", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const sub = await stripeStorage.getSubscriptionForUser(req.user.id);
    res.json({ subscription: sub });
  } catch {
    res.json({ subscription: null });
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

    // Determine if this is a one-time (lifetime) or recurring price
    const priceObj = await stripe.prices.retrieve(priceId);
    const isOneTime = priceObj.type === "one_time";

    const base = getBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: isOneTime ? "payment" : "subscription",
      success_url: `${base}/chuck-norris-facts/profile?checkout=success`,
      cancel_url: `${base}/chuck-norris-facts/pricing`,
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
  if (!req.isAuthenticated()) { res.status(401).json({ tier: "free" }); return; }
  try {
    const tier = await stripeStorage.getMembershipTierForUser(req.user.id);
    res.json({ tier });
  } catch {
    res.json({ tier: "free" });
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
      return_url: `${base}/chuck-norris-facts/profile`,
    });

    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Portal session failed";
    res.status(500).json({ error: msg });
  }
});

export default router;
