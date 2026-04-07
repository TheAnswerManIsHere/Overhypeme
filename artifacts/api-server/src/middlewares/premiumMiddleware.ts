import { type Request, type Response, type NextFunction } from "express";
import { stripeStorage } from "../lib/stripeStorage";
import { deriveUserRole } from "../lib/userRole";
import { getSessionId, getSession } from "../lib/auth";

/**
 * Middleware that requires the user to be a premium member.
 * Returns 403 with { error: "premium_required" } if user is free tier.
 * Admin users (determined via session) bypass this check.
 */
export async function requirePremium(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const sid = getSessionId(req);
    const session = sid ? await getSession(sid) : null;
    const isAdmin = !!(session?.isAdmin);
    const tier = await stripeStorage.getMembershipTierForUser(req.user.id);
    const role = deriveUserRole(tier, isAdmin);
    if (role !== "premium" && role !== "legendary" && role !== "admin") {
      res.status(403).json({ error: "premium_required", message: "This feature requires a Legendary membership." });
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
      const sid = getSessionId(req);
      const session = sid ? await getSession(sid) : null;
      const isAdmin = !!(session?.isAdmin);
      const tier = await stripeStorage.getMembershipTierForUser(req.user.id);
      const role = deriveUserRole(tier, isAdmin);
      (req as Request & { membershipTier?: string; userRole?: string }).membershipTier = tier;
      (req as Request & { membershipTier?: string; userRole?: string }).userRole = role;
    } catch {
      (req as Request & { membershipTier?: string; userRole?: string }).membershipTier = "free";
      (req as Request & { membershipTier?: string; userRole?: string }).userRole = "free";
    }
  }
  next();
}
