import { type Request, type Response, type NextFunction } from "express";
import { stripeStorage } from "../lib/stripeStorage";

/**
 * Middleware that requires the user to be a premium member.
 * Returns 403 with { error: "premium_required" } if user is free tier.
 */
export async function requirePremium(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const tier = await stripeStorage.getMembershipTierForUser(req.user.id);
    if (tier !== "premium") {
      res.status(403).json({ error: "premium_required", message: "This feature requires a premium membership." });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "premium_required" });
  }
}

/**
 * Inject membership tier into request for conditional logic downstream.
 */
export async function injectMembershipTier(req: Request, _res: Response, next: NextFunction) {
  if (req.isAuthenticated()) {
    try {
      const tier = await stripeStorage.getMembershipTierForUser(req.user.id);
      (req as Request & { membershipTier?: string }).membershipTier = tier;
    } catch {
      (req as Request & { membershipTier?: string }).membershipTier = "free";
    }
  }
  next();
}
