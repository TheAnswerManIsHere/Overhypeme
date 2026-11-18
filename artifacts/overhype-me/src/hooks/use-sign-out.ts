/**
 * @purpose The one sign-out operation every sign-out control calls (#719), and the one statement of what "forget this browser" means: the visitor's identity and meme-builder drafts are cleared before the auth sign-out, whose redirect would otherwise pre-empt any clear that waits to observe the signed-out state. Deleting an account forgets the browser the same way before it leaves for its confirmation page.
 * @subsystem accounts-auth
 */
import { useCallback } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";
import { clearAllWizardStates } from "@/components/meme-builder/wizard/state/wizardStorage";
import { resetIdentity } from "@/lib/analytics";

/** Clears this browser's copy of who the person is (name, pronouns), their meme-builder drafts and the analytics identity. */
export function useForgetThisBrowser(): () => void {
  const { reset } = usePersonName();
  return useCallback(() => {
    reset();
    clearAllWizardStates();
    // Analytics forget the member too, before the sign-out's redirect replaces
    // the page (launch Phase 16, increment 3).
    resetIdentity();
  }, [reset]);
}

export function useSignOut(): () => Promise<void> {
  const { logout } = useAuth();
  const forget = useForgetThisBrowser();
  return useCallback(async () => {
    forget();
    await logout();
  }, [logout, forget]);
}
