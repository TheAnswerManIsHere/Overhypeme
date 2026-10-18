/**
 * @purpose The identity module's decisions as consumers read them (#719): whether the identity sheet should be open now, and whether a builder may start from the identity; assembles the auth state, completeness and location once so no consumer rebuilds the policy's inputs.
 * @subsystem public-site
 */
import { useEffect } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { LANDING_LOCATION, usePersonName } from "@/hooks/use-person-name";
import { canStartBuilder, shouldAskForIdentity, type IdentityAuthState } from "@/lib/identity";

export interface IdentityGate {
  /** The identity sheet should be open on this page now. */
  shouldAsk: boolean;
  /**
   * A builder may initialize its draft from the identity now: auth has
   * resolved, the share link is settled (a builder copies the identity once,
   * so it must never copy a link's pending halves an account then drops), and
   * the identity is complete where Phase 1 requires it.
   */
  builderReady: boolean;
}

/**
 * Set the first time this page load's location differs from where it landed,
 * and never cleared: the landing exception lapses for good once the visitor
 * leaves, whatever consumer is mounted when they return. A reload or a new tab
 * is a fresh page load, so it lands afresh.
 */
let landingLapsed = false;

export function useIdentityGate(): IdentityGate {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { name, pronounsSupplied, shareLinkResolved } = usePersonName();
  const [location] = useLocation();
  if (location !== LANDING_LOCATION) landingLapsed = true;
  const auth: IdentityAuthState = isLoading ? "loading" : isAuthenticated ? "signedIn" : "signedOut";
  const completeness = { hasName: !!name.trim(), pronounsSupplied };
  return {
    shouldAsk: shouldAskForIdentity({
      auth,
      completeness,
      accountDisplayName: (user as { displayName?: string | null } | null)?.displayName ?? null,
      location,
      landingLocation: LANDING_LOCATION,
      landingLapsed,
    }),
    builderReady: shareLinkResolved && canStartBuilder(auth, completeness),
  };
}

/**
 * Settles this page load's share link once auth resolves: a signed-out visitor
 * keeps its halves, a signed-in account wins over them. Nothing from the link
 * is written before that, so a reload in between resolves the same way.
 * Mounted once.
 */
export function ShareLinkResolver(): null {
  const { isAuthenticated, isLoading } = useAuth();
  const { resolveShareLink } = usePersonName();
  useEffect(() => {
    if (!isLoading) resolveShareLink(isAuthenticated);
  }, [isLoading, isAuthenticated, resolveShareLink]);
  return null;
}
