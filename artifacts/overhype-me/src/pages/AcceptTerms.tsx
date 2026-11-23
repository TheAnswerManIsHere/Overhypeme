/**
 * @purpose The screen that asks an account which finished set-up before the current Terms of Service and Privacy Policy to agree to the Terms and acknowledge the Privacy Policy (launch Phase 14, increment 4): it says why it is asking, links both documents, takes one explicit action, and records the versions it showed; "Not now" lets the account keep reading this visit, while the server still refuses its writes until it accepts.
 * @subsystem accounts-auth
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { AccountStateShell } from "@/components/account/AccountStateShell";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";
import { returnToFromSearch } from "@/lib/safe-return-to";
import { deferTermsForThisVisit } from "@/lib/setup-redirect";
import { shownLegalVersions } from "@/lib/legal-versions";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

export default function AcceptTerms() {
  const [, setLocation] = useLocation();
  const { refreshUser } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [outdated, setOutdated] = useState(false);
  const returnTo = typeof window === "undefined" ? "/" : returnToFromSearch(window.location.search);

  async function accept() {
    if (!agreed || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${BASE_URL}api/users/me/legal-acceptance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(shownLegalVersions()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (data.code === "LEGAL_VERSION_OUTDATED") setOutdated(true);
        setError(data.error || "That didn't go through. Try again.");
        return;
      }
      await refreshUser();
      setLocation(returnTo);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function notNow() {
    deferTermsForThisVisit();
    setLocation(returnTo);
  }

  return (
    <AccountStateShell title="Our Terms">
      <p className="text-sm text-muted-foreground" data-testid="accept-terms-why">
        Before you post, vote or make memes, please agree to our current Terms of Service and confirm you've read our
        Privacy Policy. We ask once, and again only if either one changes.
      </p>
      <p className="text-sm">
        <Link href="/terms" className="underline hover:text-primary">Read the Terms of Service</Link>
        {" · "}
        <Link href="/privacy" className="underline hover:text-primary">Read the Privacy Policy</Link>
      </p>
      <label className="flex items-start gap-3 text-left text-sm text-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
          data-testid="accept-terms-checkbox"
        />
        <span>I agree to the Terms of Service and I've read the Privacy Policy.</span>
      </label>
      {error && (
        <p className="text-destructive text-sm font-medium" role="alert">
          {error}
          {outdated && (
            <>
              {" "}
              <button type="button" className="underline" onClick={() => window.location.reload()}>Reload</button>
            </>
          )}
        </p>
      )}
      <PausedWhenReadOnly className="w-full">
        <Button onClick={() => void accept()} disabled={!agreed || saving} className="w-full" data-testid="accept-terms-submit">
          {saving ? "Saving…" : "Agree and continue"}
        </Button>
      </PausedWhenReadOnly>
      <button type="button" onClick={notNow} className="text-sm text-muted-foreground underline hover:text-primary" data-testid="accept-terms-not-now">
        Not now — just look around
      </button>
    </AccountStateShell>
  );
}
