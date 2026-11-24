/**
 * @purpose The screen an account under 18 is sent to, and a browser marked as having given an under-18 date (launch Phase 14, increment 4; Q3): it says Overhype.me is for adults, that a mistyped date is corrected through support, and offers the only two things such an account can do — sign out, or ask for its deletion — and marks this browser so a fresh sign-up here is told the same without being asked; an account support has since corrected is moved on to set-up.
 * @subsystem accounts-auth
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Loader2 } from "lucide-react";
import { useSignOut } from "@/hooks/use-sign-out";
import { Button } from "@/components/ui/Button";
import { AccountStateShell } from "@/components/account/AccountStateShell";
import { DeleteAccountSection } from "@/components/account/DeleteAccountSection";
import { isSupportCorrected, markAgeRefusedBrowser } from "@/lib/age-refusal";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

interface DeletionStatus {
  pending: boolean;
  purgeAfter?: string;
  confirmWith?: { hasPassword: boolean; linkedProviders: string[] };
}

export default function AccountAdultsOnly() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const signOut = useSignOut();
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const underAge = isAuthenticated && user?.eligibility === "underage";
  const corrected = isAuthenticated && isSupportCorrected({ eligibility: user?.eligibility, is18Plus: user?.is18Plus });
  const [, setLocation] = useLocation();

  useEffect(() => {
    // Support has corrected this account's date: it has set-up to finish, so a
    // tab left on this screen moves on (launch Phase 14, increment 4).
    if (corrected) setLocation("/onboard");
  }, [corrected, setLocation]);

  useEffect(() => {
    // An account the server holds under age marks this browser too, whether
    // it refused at set-up here or its stored date says so.
    if (underAge) markAgeRefusedBrowser();
  }, [underAge]);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}api/users/me/deletion`, { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("load");
        const body = (await res.json()) as DeletionStatus;
        if (!cancelled) setStatus(body);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoading, isAuthenticated]);

  return (
    <AccountStateShell title="Overhype.me is for adults">
      <p className="text-muted-foreground text-sm" data-testid="adults-only-explanation">
        You need to be 18 or over to use Overhype.me, so this account can't be set up or used.
      </p>
      <p className="text-sm text-muted-foreground">
        Typed your date of birth wrong?{" "}
        <Link href="/support?category=account" className="underline hover:text-primary" data-testid="adults-only-support">
          Contact support
        </Link>{" "}
        and we'll correct it.
      </p>

      {isAuthenticated && (
        <div className="space-y-4 text-left">
          {status === null && !loadFailed && (
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking this account…
            </p>
          )}
          {loadFailed && (
            <p className="text-sm text-destructive text-center" role="alert">
              We couldn't load the option to delete this account. Refresh to try again, or sign out.
            </p>
          )}
          {status?.pending && (
            <p className="text-sm text-muted-foreground text-center" data-testid="adults-only-deletion-pending">
              This account is scheduled for deletion
              {status.purgeAfter ? ` on ${new Date(status.purgeAfter).toLocaleDateString()}` : ""}.
            </p>
          )}
          {status && !status.pending && status.confirmWith && (
            <DeleteAccountSection
              hasPassword={status.confirmWith.hasPassword}
              linkedProviders={status.confirmWith.linkedProviders}
            />
          )}
          <Button onClick={() => void signOut()} className="w-full" data-testid="adults-only-sign-out">
            Sign out
          </Button>
        </div>
      )}
    </AccountStateShell>
  );
}
