import { type Request, type Response, type NextFunction } from "express";
import { deriveUserRole, type UserRole } from "../lib/userRole";

/**
 * Middleware that requires the user to be a legendary (paid) member.
 * Returns 403 with { error: "legendary_required" } if user is not legendary or admin.
 *
 * Reads `req.user.membershipTier` and `req.user.isRealAdmin`, both of which
 * are populated fresh from the database by `authMiddleware` on every
 * authenticated request. Real admins bypass the legendary check regardless
 * of the session-scoped admin-mode toggle.
 */
export async function requireLegendary(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const tier = req.user.membershipTier ?? "unregistered";
    if (tier === "legendary" || req.user.isRealAdmin) {
      next();
      return;
    }
    res.status(403).json({
      error: "legendary_required",
      message: "This feature requires a Legendary membership.",
    });
  } catch {
    res.status(403).json({ error: "legendary_required" });
  }
}

/**
 * Inject membership tier into request for conditional logic downstream.
 *
 * Reads `req.user.membershipTier` and `req.user.userRole` populated by
 * `authMiddleware`. No additional DB roundtrip — this middleware exists only
 * to project those fields onto the top-level request object for callers that
 * predate the AuthUser shape.
 */
export async function injectMembershipTier(req: Request, _res: Response, next: NextFunction) {
  if (req.isAuthenticated()) {
    try {
      const tier = req.user.membershipTier ?? "unregistered";
      const role: UserRole =
        req.user.userRole ?? deriveUserRole(tier, !!req.user.isAdmin);
      (req as Request & { membershipTier?: string; userRole?: string }).membershipTier = tier;
      (req as Request & { membershipTier?: string; userRole?: string }).userRole = role;
    } catch {
      (req as Request & { membershipTier?: string; userRole?: string }).membershipTier = "unregistered";
      (req as Request & { membershipTier?: string; userRole?: string }).userRole = "unregistered";
    }
  }
  next();
}
