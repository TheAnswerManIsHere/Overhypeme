/**
 * The one place a signed-in account's name and pronouns reach this browser's
 * identity (identity-flow Phase 2: "the account wins thereafter"). Before it,
 * four places wrote the browser copy on their own — the sign-in sync in
 * `App.tsx`, the name tag's account-sync effect, Profile after a save, and
 * Onboard after completion — and the sign-in sync fetched the account outside
 * the auth provider, so a late answer could put a signed-out account back
 * (#725).
 *
 * It mirrors only the account the auth provider has PUBLISHED, which is the
 * canonical read: the provider discards any read sign-out invalidated, and a
 * save's caller re-reads through `refreshUser()`, so the browser never takes
 * a value the account has not confirmed. An account with no display name yet
 * mirrors nothing, so the browser's name stays available for onboarding to
 * pre-fill; an account with a name but no pronouns keeps the browser's own
 * supplied choice. The browser copy is never written back to the account
 * from here.
 *
 * @purpose Mirrors the published signed-in account's display name and pronouns into the browser identity whenever they change; mirrors nothing for an account with no display name, and keeps the browser's supplied pronouns for an account with none.
 * @subsystem accounts-auth
 */
import { useEffect } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";

export interface MirrorInput {
  account: { displayName?: string | null; pronouns?: string | null } | null;
  device: { pronouns: string; pronounsSupplied: boolean };
}

/** What the browser copy should become, or null for "leave it alone". */
export function accountMirrorFor({ account, device }: MirrorInput): { name: string; pronouns: string } | null {
  const name = account?.displayName?.trim();
  if (!name) return null;
  const pronouns = account?.pronouns || (device.pronounsSupplied ? device.pronouns : "");
  return { name, pronouns };
}

export function AccountIdentityMirror() {
  const { user, isAuthenticated, status } = useAuth();
  const { syncFromProfile, pronouns, pronounsSupplied } = usePersonName();
  const displayName = (user as { displayName?: string | null } | null)?.displayName ?? null;
  const accountPronouns = (user as { pronouns?: string | null } | null)?.pronouns ?? null;

  useEffect(() => {
    if (status !== "resolved" || !isAuthenticated) return;
    const next = accountMirrorFor({
      account: { displayName, pronouns: accountPronouns },
      device: { pronouns, pronounsSupplied },
    });
    if (next) syncFromProfile(next.name, next.pronouns);
    // Runs when the published account's identity changes, not on the browser's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isAuthenticated, user?.id, displayName, accountPronouns]);

  return null;
}
