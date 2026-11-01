/**
 * @purpose The "Delete your account" section of Profile (launch Phase 5, plan S14; David's answer 2: "it should be HARD to do without really meaning to"): says exactly what deleting does and what stays, asks the person to tick that they understand, then re-authenticates — the password for an account that has one, a fresh Google or Apple sign-in for one that does not — and on success sends them, signed out everywhere, to the screen that confirms the date.
 * @subsystem accounts-auth
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

/** Where a provider re-authentication comes back to: this section, open, ready to confirm. */
export const DELETE_CONFIRM_RETURN = "/profile?delete=confirm";

type Provider = "google" | "apple";
const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", apple: "Apple" };

/** Module-level navigation seam — tests stub this instead of fighting jsdom's non-configurable `window.location.assign`. */
export const deleteAccountNavigation = {
  go(url: string) {
    window.location.assign(url);
  },
};

export function providerReauthUrl(provider: Provider): string {
  return `${BASE_URL}api/login/${provider}?returnTo=${encodeURIComponent(DELETE_CONFIRM_RETURN)}`;
}

export function DeleteAccountSection({ hasPassword, linkedProviders }: { hasPassword: boolean; linkedProviders: string[] }) {
  const [open, setOpen] = useState(false);
  const [backFromSignIn, setBackFromSignIn] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reauthProviders, setReauthProviders] = useState<Provider[] | null>(null);

  // Back from the provider sign-in this section sent the person to.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("delete") !== "confirm") return;
    setOpen(true);
    setBackFromSignIn(true);
    params.delete("delete");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  }, []);

  const providers = linkedProviders.filter((p): p is Provider => p === "google" || p === "apple");

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${BASE_URL}api/users/me/deletion`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { password } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { purgeAfter?: string; error?: string; code?: string; providers?: Provider[] };
      if (res.ok && data.purgeAfter) {
        // Every session is gone now, this one included: a full load starts the
        // signed-out page fresh.
        deleteAccountNavigation.go(`${BASE_URL}account/deletion?scheduled=${encodeURIComponent(data.purgeAfter)}`);
        return;
      }
      if (data.code === "REAUTH_REQUIRED") {
        setReauthProviders(data.providers?.length ? data.providers : providers);
        return;
      }
      setError(data.error ?? "That didn't work. Try again.");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = understood && (!hasPassword || password.length > 0) && !submitting;

  return (
    <div className="bg-card border-2 border-destructive/40 p-6 rounded-sm shadow mb-8">
      <h2 className="font-display text-xl uppercase tracking-wide text-foreground mb-4 border-b border-border pb-4 flex items-center gap-2">
        <Trash2 className="w-5 h-5 text-destructive" /> Delete your account
      </h2>

      {!open ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Remove your account, your memes, photos and images from Overhype.me. You get 14 days to change your mind.
          </p>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-2 border-destructive/50 text-destructive hover:bg-destructive/10">
            <Trash2 className="w-4 h-4" /> Delete my account…
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {backFromSignIn && !reauthProviders && (
            <p className="text-sm text-foreground">You signed in again. You can delete your account now.</p>
          )}
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-bold text-foreground">What happens</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>You're signed out everywhere, at once.</li>
              <li>Your memes, photos and images are hidden at once.</li>
              <li>A paid membership is cancelled at once.</li>
              <li>For 14 days you can sign in and choose Keep my account to bring everything back.</li>
              <li>After that your account, memes, photos, images, comments and reactions are removed for good.</li>
              <li>Facts you submitted stay on the site, credited to a former member.</li>
              <li>Someone who already loaded one of your memes may still see it for up to a day.</li>
            </ul>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--destructive))]"
            />
            <span className="text-sm text-foreground">I understand that after 14 days this can't be undone.</span>
          </label>

          {hasPassword && (
            <div>
              <label htmlFor="delete-password" className="block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1">
                Your password
              </label>
              <div className="relative">
                <input
                  id="delete-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Confirm it's you"
                  className="w-full bg-background border border-border rounded-sm px-3 py-2 pr-10 text-sm text-foreground focus:outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {reauthProviders ? (
            <div className="space-y-3 border border-border rounded-sm p-4">
              <p className="text-sm text-foreground flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                To confirm it's you, sign in again. You'll come back here to finish. A sign-in counts for 10 minutes.
              </p>
              <div className="flex flex-wrap gap-2">
                {reauthProviders.map((p) => (
                  <Button key={p} variant="outline" size="sm" onClick={() => deleteAccountNavigation.go(providerReauthUrl(p))}>
                    Sign in with {PROVIDER_LABEL[p]}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {error && <p className="text-sm text-destructive font-medium" role="alert">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button variant="danger" size="sm" onClick={() => void submit()} disabled={!canSubmit} className="gap-2">
              {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Deleting…</> : <><Trash2 className="w-4 h-4" /> Delete my account</>}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setOpen(false); setUnderstood(false); setPassword(""); setError(""); setReauthProviders(null); setBackFromSignIn(false); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
