/**
 * @purpose The one sign-out operation every sign-out control calls (#719), and the one statement of what "forget this browser" means: the visitor's identity and meme-builder drafts are cleared before the auth sign-out, whose redirect would otherwise pre-empt any clear that waits to observe the signed-out state. Deleting an account forgets the browser the same way before it leaves for its confirmation page.
 * @subsystem accounts-auth
 */
import { useCallback } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";
import { clearAllWizardStates } from "@/components/meme-builder/wizard/state/wizardStorage";

/** Clears this browser's copy of who the person is (name, pronouns) and their meme-builder drafts. */
export function useForgetThisBrowser(): () => void {
  const { reset } = usePersonName();
  return useCallback(() => {
    reset();
    clearAllWizardStates();
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
