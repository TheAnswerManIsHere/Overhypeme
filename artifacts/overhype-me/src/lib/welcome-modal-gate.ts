/**
 * @purpose The rule for when the welcome name-and-pronoun sheet opens: whenever no personalization name is set, on any page except the account pages, and never from a share link or for a signed-in user whose account has a display name (#705).
 * @subsystem public-site
 */

// Account pages, where the account itself supplies the name (sign-in syncs the
// profile's display name into usePersonName). Matched as a whole path segment,
// so "/admin/users" is suppressed and "/loginx" is not. "/" is deliberately not
// here: there is no value in the site until a name is set, so the sheet opens on
// every other page, Home included (David, #705).
const SUPPRESSED_PATHS = ["/login", "/onboard", "/forgot-password", "/reset-password", "/verify-email", "/admin"];

export interface WelcomeModalGateInput {
  authLoading: boolean;
  isAuthenticated: boolean;
  /** The signed-in account's display name, which sign-in syncs into usePersonName. */
  accountDisplayName: string | null | undefined;
  /** usePersonName's current name (already seeded from a share link when one is active). */
  name: string;
  shareLinkActive: boolean;
  path: string;
}

/**
 * Whether the sheet should open: whenever no personalization name is set, and
 * never once one is (#705).
 */
export function shouldOpenWelcomeModal(input: WelcomeModalGateInput): boolean {
  if (input.authLoading) return false;
  if (input.shareLinkActive) return false;
  if (input.name.trim()) return false;
  if (input.isAuthenticated && input.accountDisplayName?.trim()) return false;
  const onSuppressedPath = SUPPRESSED_PATHS.some(
    (p) => input.path === p || input.path.startsWith(`${p}/`),
  );
  return !onSuppressedPath;
}
