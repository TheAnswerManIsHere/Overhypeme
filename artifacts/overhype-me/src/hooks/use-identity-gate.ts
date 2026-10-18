/**
 * @purpose The identity module's decisions as consumers read them (#719): whether the identity sheet should be open now, and whether a builder may start from the identity; assembles the auth state, completeness and location once so no consumer rebuilds the policy's inputs.
 * @subsystem public-site
 */
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { LANDING_LOCATION, usePersonName } from "@/hooks/use-person-name";
import { canStartBuilder, shouldAskForIdentity, type IdentityAuthState } from "@/lib/identity";

export interface IdentityGate {
  /** The identity sheet should be open on this page now. */
  shouldAsk: boolean;
  /** A builder may initialize its draft from the identity now. */
  builderReady: boolean;
}

export function useIdentityGate(): IdentityGate {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { name, pronounsSupplied } = usePersonName();
  const [location] = useLocation();
  const auth: IdentityAuthState = isLoading ? "loading" : isAuthenticated ? "signedIn" : "signedOut";
  const completeness = { hasName: !!name.trim(), pronounsSupplied };
  return {
    shouldAsk: shouldAskForIdentity({
      auth,
      completeness,
      accountDisplayName: (user as { displayName?: string | null } | null)?.displayName ?? null,
      location,
      landingLocation: LANDING_LOCATION,
    }),
    builderReady: canStartBuilder(auth, completeness),
  };
}
