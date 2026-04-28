import { type Request, type Response, type NextFunction } from "express";
import { deriveUserRole, isAtLeastLegendary, isAtLeastRegistered, type UserRole } from "../lib/userRole";

/**
 * Unified role-gating middleware factory.
 *
 * Takes a minimum required role and returns a middleware that:
 * - Returns 401 when the request is not authenticated.
 * - Returns 403 with a role-appropriate error code when the user's real role
 *   (ignoring the "view as user" toggle) does not satisfy the requirement.
 * - Calls next() when the user satisfies the requirement.
 *
 * Uses `req.user.realUserRole` (populated by authMiddleware from `isRealAdmin`
 * + `membershipTier`, ignoring `adminModeDisabled`) so backend authorization
 * is never affected by the session-scoped admin-mode toggle.
 *
 * Role hierarchy: admin > legendary > registered > unregistered.
 */
export function requireRole(role: "admin" | "legendary" | "registered") {
  return async function roleMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const realRole: UserRole = req.user.realUserRole ?? deriveUserRole(req.user.membershipTier, !!req.user.isRealAdmin);

      if (role === "admin") {
        if (realRole === "admin") { next(); return; }
        res.status(403).json({ error: "admin_required" });
        return;
      }

      if (role === "legendary") {
        if (isAtLeastLegendary(realRole)) { next(); return; }
        res.status(403).json({
          error: "legendary_required",
          message: "This feature requires a Legendary membership.",
        });
        return;
      }

      if (role === "registered") {
        if (isAtLeastRegistered(realRole)) { next(); return; }
        res.status(403).json({ error: "registered_required" });
        return;
      }

      res.status(403).json({ error: "forbidden" });
    } catch {
      const errorCode =
        role === "admin" ? "admin_required" :
        role === "legendary" ? "legendary_required" :
        "registered_required";
      res.status(403).json({ error: errorCode });
    }
  };
}

/**
 * Middleware that requires the user to be a legendary (paid) member.
 * Shim for backwards-compatibility — calls requireRole("legendary").
 */
export const requireLegendary = requireRole("legendary");

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
