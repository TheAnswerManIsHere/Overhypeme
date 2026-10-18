/**
 * @purpose The one sign-out operation every sign-out control calls (#719): clears the visitor's identity and meme-builder drafts in this browser before handing over to the auth sign-out, whose redirect would otherwise pre-empt any clear that waits to observe the signed-out state.
 * @subsystem accounts-auth
 */
import { useCallback } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";
import { clearAllWizardStates } from "@/components/meme-builder/wizard/state/wizardStorage";

export function useSignOut(): () => Promise<void> {
  const { logout } = useAuth();
  const { reset } = usePersonName();
  return useCallback(async () => {
    reset();
    clearAllWizardStates();
    await logout();
  }, [logout, reset]);
}
