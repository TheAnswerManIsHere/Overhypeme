/**
 * Canonical user permission model
 * ────────────────────────────────────────────────────────────────────────────
 * Three membership tiers (stored in users.membership_tier, see lib/db/schema/auth.ts):
 *   • "unregistered" — anonymous / guest visitor with no user record
 *   • "registered"   — logged-in user with no paid membership (the default)
 *   • "legendary"    — paid member, granted via Stripe subscription OR
 *                      one-time "Legendary for Life" purchase
 *
 * `users.is_admin` is a SEPARATE boolean flag, NOT a tier. It grants elevated
 * permissions on top of whatever membership tier the user holds. The derived
 * `UserRole` below collapses (membershipTier + isAdmin) into a single string
 * for convenience: when isAdmin=true, role becomes "admin" regardless of tier.
 *
 * "Lifetime Legendary" / "Legendary for Life" is a BILLING ARTIFACT, not a
 * tier. It's recorded as a row in the `lifetime_entitlements` table and a
 * recurring-vs-one-time distinction in `membership_history.plan` ("monthly",
 * "annual", or "lifetime"). Lifetime users still have membership_tier='legendary'
 * — the lifetime status only changes how the subscription is billed/cancelled.
 * The client reads this distinction from /api/users/subscription as
 * `subData.isLifetime` (consumed by SubscriptionPanel.tsx) and uses it to render
 * "Legendary for Life" instead of "Annual"/"Monthly". It is NOT a separate tier.
 *
 * There is no "free" tier. The marketing word "Free" may appear in user-facing
 * copy (e.g. "Free Plan" badge, "Create a free account" prompt), but any
 * internal name, DB row, log string, or admin label uses the canonical
 * vocabulary above.
 */
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
