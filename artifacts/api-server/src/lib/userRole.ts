export type UserRole = "free" | "premium" | "legendary" | "admin";

/**
 * Derives the effective user role from a user's membershipTier and isAdmin flag.
 * Admin takes precedence over all tiers. Legendary > premium > free.
 */
export function deriveUserRole(
  membershipTier: string | null | undefined,
  isAdmin: boolean | null | undefined,
): UserRole {
  if (isAdmin) return "admin";
  if (membershipTier === "legendary") return "legendary";
  if (membershipTier === "premium") return "premium";
  return "free";
}

/**
 * Returns true if the role has at least premium-level access.
 * Legendary is a superset of premium.
 */
export function isAtLeastPremium(role: UserRole): boolean {
  return role === "premium" || role === "legendary" || role === "admin";
}
