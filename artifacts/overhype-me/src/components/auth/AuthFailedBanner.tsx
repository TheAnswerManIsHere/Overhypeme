/**
 * When the sign-in check fails, the site doesn't know who the visitor is. It
 * says so, offers a retry, and grants nothing meanwhile (identity-flow Phase 2:
 * a failed read is not "signed out").
 *
 * @purpose The banner shown while the auth read has failed: says the sign-in could not be checked and offers a retry, which re-runs the read.
 * @subsystem accounts-auth
 */
import { useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";

export function AuthFailedBanner() {
  const { status, retry } = useAuth();
  const [retrying, setRetrying] = useState(false);
  if (status !== "failed") return null;
  return (
    <div
      role="alert"
      data-testid="auth-failed-banner"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-card border border-border rounded-sm shadow-lg px-4 py-2 text-sm"
    >
      <span className="text-foreground">We couldn't check your sign-in.</span>
      <button
        type="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          try {
            await retry();
          } finally {
            setRetrying(false);
          }
        }}
        className="font-bold text-primary hover:underline disabled:opacity-50"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
