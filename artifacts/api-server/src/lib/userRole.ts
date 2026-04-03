export type UserRole = "free" | "premium" | "admin";

/**
 * Derives the effective user role from a user's membershipTier and isAdmin flag.
 * Admin takes precedence over premium, which takes precedence over free.
 */
export function deriveUserRole(
  membershipTier: string | null | undefined,
  isAdmin: boolean | null | undefined,
): UserRole {
  if (isAdmin) return "admin";
  if (membershipTier === "premium") return "premium";
  return "free";
}
