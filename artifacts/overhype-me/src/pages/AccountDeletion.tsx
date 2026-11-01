/**
 * @purpose The "Keep my account" screen (launch Phase 5, plan S14; David's answer 7): an account scheduled for deletion is sent here after it signs in, sees the date its account goes and keeps it with one button; signed out, it is told to sign in first (the email's link lands here); straight after a request it confirms the date and that the person was signed out everywhere.
 * @subsystem accounts-auth
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useSignOut } from "@/hooks/use-sign-out";

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const HERE = "/account/deletion";

type Pending =
  | { pending: true; purgeAfter: string; requestedAt: string; cancellable: boolean }
  | { pending: false };

type View =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | { kind: "pending"; purgeAfter: string; cancellable: boolean }
  | { kind: "not-pending" }
  | { kind: "kept" };

/** "14 November 2026": the purge date, in the visitor's own calendar. */
export function deletionDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 sm:p-8 shadow-lg space-y-5 text-center">{children}</div>
    </div>
  );
}

export default function AccountDeletion() {
  const { isAuthenticated, isLoading, user, refreshUser } = useAuth();
  const signOut = useSignOut();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState("");

  // Straight after a request the person is signed out; the date rides the address.
  const scheduledFor = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("scheduled");

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    try {
      const res = await fetch(`${BASE_URL}api/users/me/deletion`, { credentials: "include", cache: "no-store" });
      if (!res.ok) { setView({ kind: "load-error", message: "We couldn't check your account. Try again." }); return; }
      const data = (await res.json()) as Pending;
      setView(data.pending ? { kind: "pending", purgeAfter: data.purgeAfter, cancellable: data.cancellable } : { kind: "not-pending" });
    } catch {
      setView({ kind: "load-error", message: "Network error. Try again." });
    }
  }, []);

  useEffect(() => {
    if (!isLoading && isAuthenticated) void load();
  }, [isLoading, isAuthenticated, load]);

  async function keep() {
    setKeeping(true);
    setKeepError("");
    try {
      const res = await fetch(`${BASE_URL}api/users/me/deletion/cancel`, { method: "POST", credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (res.ok) {
        setView({ kind: "kept" });
        await refreshUser();
        return;
      }
      if (data.code === "DELETION_IN_PROGRESS") { setView({ kind: "pending", purgeAfter: new Date().toISOString(), cancellable: false }); return; }
      if (res.status === 404) { setView({ kind: "not-pending" }); return; }
      setKeepError(data.error ?? "That didn't work. Try again.");
    } catch {
      setKeepError("Network error. Try again.");
    } finally {
      setKeeping(false);
    }
  }

  if (isLoading) {
    return <Shell><Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto" aria-label="Loading" /></Shell>;
  }

  if (!isAuthenticated) {
    return (
      <Shell>
        <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">
          {scheduledFor ? "Your account is scheduled for deletion" : "Keep your account"}
        </h1>
        {scheduledFor ? (
          <p className="text-muted-foreground text-sm">
            On <span className="text-foreground font-semibold">{deletionDateLabel(scheduledFor)}</span> your account, your memes,
            photos and images are removed for good. Until then they're hidden, and you've been signed out everywhere. Changed your
            mind? Sign in before that date and choose Keep my account.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            If your account is scheduled for deletion, sign in to keep it. You can do this any time before the date in your email.
          </p>
        )}
        <Link href={`/login?returnTo=${encodeURIComponent(HERE)}`}>
          <Button variant={scheduledFor ? "outline" : undefined} className="w-full">Sign in</Button>
        </Link>
        <Link href="/" className="block text-xs text-muted-foreground hover:text-foreground underline">Back to Overhype.me</Link>
      </Shell>
    );
  }

  if (view.kind === "loading") {
    return <Shell><Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto" aria-label="Checking your account" /></Shell>;
  }

  if (view.kind === "load-error") {
    return (
      <Shell>
        <p className="text-destructive text-sm font-medium" role="alert">{view.message}</p>
        <Button onClick={() => void load()} className="w-full">Try again</Button>
      </Shell>
    );
  }

  if (view.kind === "kept") {
    const mustFinish = user?.eligibility === "unonboarded" || user?.eligibility === "unverified";
    return (
      <Shell>
        <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">Your account is staying</h1>
        <p className="text-muted-foreground text-sm">
          The deletion is cancelled. Your memes, photos and images are back where they were. We've emailed you to confirm.
        </p>
        {mustFinish ? (
          <Link href="/onboard"><Button className="w-full">Finish setting up</Button></Link>
        ) : (
          <Link href="/"><Button className="w-full">Back to Overhype.me</Button></Link>
        )}
      </Shell>
    );
  }

  if (view.kind === "not-pending") {
    return (
      <Shell>
        <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">Nothing to keep</h1>
        <p className="text-muted-foreground text-sm">Your account isn't scheduled for deletion.</p>
        <Link href="/"><Button className="w-full">Back to Overhype.me</Button></Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">
        {view.cancellable ? "Your account is scheduled for deletion" : "Your account is being deleted"}
      </h1>
      {view.cancellable ? (
        <>
          <p className="text-muted-foreground text-sm">
            On <span className="text-foreground font-semibold">{deletionDateLabel(view.purgeAfter)}</span> your account, your memes,
            photos and images are removed from Overhype.me for good. Facts you submitted stay, credited to a former member.
          </p>
          <p className="text-muted-foreground text-sm">Until then your memes, photos and images are hidden and you can't post. Keep your account to bring them back.</p>
          <Button onClick={() => void keep()} disabled={keeping} className="w-full">
            {keeping ? <><Loader2 className="w-4 h-4 animate-spin" /> Keeping…</> : "Keep my account"}
          </Button>
          {keepError && <p className="text-destructive text-sm font-medium" role="alert">{keepError}</p>}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          The deletion has started and can't be stopped now.
        </p>
      )}
      <button type="button" onClick={() => void signOut()} className="text-xs text-muted-foreground hover:text-foreground underline">
        Sign out
      </button>
    </Shell>
  );
}
