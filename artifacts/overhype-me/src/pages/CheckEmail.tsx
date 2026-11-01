/**
 * @purpose The "check your email" step for a signed-in account whose address is not verified yet (launch Phase 5, plan S8): says where the link went, resends it, checks again once the person says they have clicked it, and lets them sign out; a verified account is sent on to onboarding.
 * @subsystem accounts-auth
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getSafeReturnTo } from "@/lib/safe-return-to";
import { useSignOut } from "@/hooks/use-sign-out";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

export default function CheckEmail() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading, user, refreshUser } = useAuth();
  const signOut = useSignOut();
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [resendError, setResendError] = useState("");
  const [checking, setChecking] = useState(false);

  const returnTo = (() => {
    if (typeof window === "undefined") return "/";
    const params = new URLSearchParams(window.location.search);
    return getSafeReturnTo(params.get("returnTo")) ?? "/";
  })();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) setLocation("/login");
    else if (user?.eligibility && user.eligibility !== "unverified") {
      setLocation(`/onboard?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [isLoading, isAuthenticated, user?.eligibility, returnTo, setLocation]);

  async function resend() {
    setResendState("sending");
    setResendError("");
    try {
      const res = await fetch(`${BASE_URL}api/auth/resend-verification`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setResendError(data.error ?? "We couldn't send it. Try again in a minute.");
        setResendState("error");
        return;
      }
      setResendState("sent");
    } catch {
      setResendError("Network error. Try again.");
      setResendState("error");
    }
  }

  async function checkAgain() {
    setChecking(true);
    try {
      await refreshUser();
    } finally {
      setChecking(false);
    }
  }

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 sm:p-8 shadow-lg space-y-5 text-center">
        <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">Check your email</h1>
        <p className="text-muted-foreground text-sm">
          We sent a link to <span className="text-foreground font-semibold">{user?.email ?? "your address"}</span>.
          Open it to confirm the address is yours, then come back here.
        </p>

        <Button onClick={checkAgain} disabled={checking} className="w-full">
          {checking ? "Checking…" : "I've clicked the link"}
        </Button>

        <div className="space-y-1">
          <button
            type="button"
            onClick={resend}
            disabled={resendState === "sending" || resendState === "sent"}
            className="text-sm text-primary hover:underline disabled:opacity-60 disabled:no-underline"
          >
            {resendState === "sending" ? "Sending…" : resendState === "sent" ? "Sent. Check your inbox." : "Send the link again"}
          </button>
          {resendState === "error" && (
            <p className="text-destructive text-sm font-medium" role="alert">{resendError}</p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Once it's confirmed, you'll finish setting up your account.
        </p>

        <button
          type="button"
          onClick={() => void signOut()}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
