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
import { LegalLinks } from "@/components/legal/LegalLinks";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";
import { useReadOnly } from "@/hooks/use-read-only";
import { resendVerification } from "@/lib/resendVerification";


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
  const readOnly = useReadOnly();
  useEffect(() => {
    // While the site is read-only the link is not sent; it goes once the pause ends (#1109 D3).
    if (!unverified || linkRequested.current || readOnly) return;
    linkRequested.current = true;
    void (async () => {
      const result = await resendVerification({ ifNoneOut: true });
      // Verified elsewhere (another tab or device): nothing was sent, so the
      // screen claims nothing and refreshes the session, which moves the
      // person on as it does for any verified account (#884).
      if (result.verified) await refreshUser();
      else if (result.sent) setLinkState("out");
      else {
        setLinkError(result.message);
        setLinkState("error");
      }
    })();
  }, [unverified, readOnly, refreshUser]);

  async function resend() {
    setResendState("sending");
    setResendError("");
    const result = await resendVerification();
    if (!result.sent) {
      setResendError(result.message);
      setResendState("error");
      return;
    }
    setResendState("sent");
    setLinkState("out");
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
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6 p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 sm:p-8 shadow-lg space-y-5 text-center">
        <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">Check your email</h1>
        {linkState === "checking" && readOnly ? (
          <p className="text-muted-foreground text-sm" data-testid="check-email-paused">
            Sending the link to <span className="text-foreground font-semibold">{user?.email ?? "your address"}</span> is paused while
            Overhype.me is undergoing maintenance. It goes out as soon as we're done. If you already have a link, it still works.
          </p>
        ) : linkState === "checking" ? (
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
          <PausedWhenReadOnly>
          <button
            type="button"
            onClick={resend}
            disabled={resendState === "sending" || resendState === "sent"}
            className="text-sm text-primary hover:underline disabled:opacity-60 disabled:no-underline"
          >
            {resendState === "sending" ? "Sending…" : resendState === "sent" ? "Sent. Check your inbox." : linkState === "error" ? "Send the link" : "Send the link again"}
          </button>
          </PausedWhenReadOnly>
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
      <LegalLinks className="text-xs text-muted-foreground" />
    </div>
  );
}
