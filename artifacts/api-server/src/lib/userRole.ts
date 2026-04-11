export type UserRole = "unregistered" | "registered" | "legendary" | "admin";

/**
 * Derives the effective user role from a user's membershipTier and isAdmin flag.
 * Admin takes precedence over all tiers. Legendary > registered > unregistered.
 */
export function deriveUserRole(
  membershipTier: string | null | undefined,
  isAdmin: boolean | null | undefined,
): UserRole {
  if (isAdmin) return "admin";
  if (membershipTier === "legendary") return "legendary";
  if (membershipTier === "registered") return "registered";
  return "unregistered";
}

/**
 * Returns true if the role has legendary-level access (paid subscriber or admin).
 */
export function isAtLeastLegendary(role: UserRole): boolean {
  return role === "legendary" || role === "admin";
}

/**
 * Returns true if the role has at least registered-level access (any logged-in user).
 * Legendary is a superset of registered.
 */
export function isAtLeastRegistered(role: UserRole): boolean {
  return role === "registered" || role === "legendary" || role === "admin";
}
