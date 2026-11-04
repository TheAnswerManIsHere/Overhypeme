/**
 * @purpose The "check your email" step for a signed-in account whose address is not verified yet (launch Phase 5, plan S8): makes sure a link is out (#868: an account that did not just register had none) and says where it went only once one is, resends it, checks again once the person says they have clicked it, and lets them sign out; a verified account is sent on to onboarding.
 * @subsystem accounts-auth
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { returnToFromSearch } from "@/lib/safe-return-to";
import { useSignOut } from "@/hooks/use-sign-out";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

export default function CheckEmail() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading, user, refreshUser } = useAuth();
  const signOut = useSignOut();
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [resendError, setResendError] = useState("");
  const [checking, setChecking] = useState(false);
  // Whether a link is out: the claim "We sent a link" is made only on "out".
  const [linkState, setLinkState] = useState<"checking" | "out" | "error">("checking");
  const [linkError, setLinkError] = useState("");
  const linkRequested = useRef(false);

  const returnTo = typeof window === "undefined" ? "/" : returnToFromSearch(window.location.search);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) setLocation("/login");
    else if (user?.eligibility && user.eligibility !== "unverified") {
      setLocation(`/onboard?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [isLoading, isAuthenticated, user?.eligibility, returnTo, setLocation]);

  const unverified = isAuthenticated && user?.eligibility === "unverified";
  useEffect(() => {
    if (!unverified || linkRequested.current) return;
    linkRequested.current = true;
    void (async () => {
      try {
        const res = await fetch(`${BASE_URL}api/auth/resend-verification`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ifNoneOut: true }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setLinkError(data.error ?? "We couldn't send the link. Try again in a minute.");
          setLinkState("error");
          return;
        }
        setLinkState("out");
      } catch {
        setLinkError("Network error. Try again.");
        setLinkState("error");
      }
    })();
  }, [unverified]);

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
      setLinkState("out");
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
        {linkState === "checking" ? (
          <p className="text-muted-foreground text-sm">
            Sending a link to <span className="text-foreground font-semibold">{user?.email ?? "your address"}</span>…
          </p>
        ) : linkState === "error" ? (
          <p className="text-muted-foreground text-sm">
            We couldn't send a link to <span className="text-foreground font-semibold">{user?.email ?? "your address"}</span> yet.{" "}
            <span className="text-destructive font-medium" role="alert">{linkError}</span>
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            We sent a link to <span className="text-foreground font-semibold">{user?.email ?? "your address"}</span>.
            Open it to confirm the address is yours, then come back here.
          </p>
        )}

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
            {resendState === "sending" ? "Sending…" : resendState === "sent" ? "Sent. Check your inbox." : linkState === "error" ? "Send the link" : "Send the link again"}
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
