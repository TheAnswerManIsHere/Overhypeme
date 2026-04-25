import { useState, useEffect } from "react";
import { Navbar } from "./Navbar";
import { AdSlot } from "@/components/AdSlot";
import { WelcomeModal } from "@/components/WelcomeModal";
import { AccessRevocationBanner } from "@/components/AccessRevocationBanner";
import { useAuth } from "@workspace/replit-auth-web";
import { Mail, X, CheckCircle, Loader2 } from "lucide-react";

function EmailVerificationBanner() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [verified, setVerified] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || authLoading) return;
    fetch("/api/auth/email-status", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { verified: boolean; email: string | null };
        setVerified(data.verified);
        setEmail(data.email);
      })
      .catch(() => {});
  }, [isAuthenticated, authLoading]);

  if (!isAuthenticated || authLoading || verified !== false || dismissed) return null;

  const handleResend = async () => {
    setResending(true);
    try {
      await fetch("/api/auth/resend-verification", {
        method: "POST",
        credentials: "include",
      });
      setResendDone(true);
    } catch {
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="w-full bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <Mail className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-sm text-amber-700 dark:text-amber-400 truncate">
            {resendDone
              ? "Verification email sent — check your inbox."
              : email
                ? `Please verify your email address (${email}) to unlock all features.`
                : "Please verify your email address to unlock all features."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!resendDone && (
            <button
              onClick={handleResend}
              disabled={resending}
              className="text-xs font-semibold text-amber-600 dark:text-amber-400 hover:underline flex items-center gap-1 disabled:opacity-60"
            >
              {resending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
              Resend email
            </button>
          )}
          <button
            onClick={() => setDismissed(true)}
            className="text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <EmailVerificationBanner />
      <AccessRevocationBanner />
      <WelcomeModal />
      <main className="flex-1 w-full">
        {children}
      </main>
      {/* Leaderboard ad above footer — hidden for premium users */}
      <div className="w-full max-w-7xl mx-auto px-4 py-4">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_LEADERBOARD ?? "0987654321"} format="horizontal" />
      </div>
      <footer className="w-full bg-black border-t border-border py-12 mt-auto">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <div className="font-display text-4xl text-border mb-4 uppercase tracking-widest">Overhype.me</div>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            The world's most personalized facts database. Enter your name. Become legendary.
          </p>
          <div className="mt-8 text-xs text-border tracking-wider">
            © {new Date().getFullYear()} Overhype.me. ALL RIGHTS RESERVED.
          </div>
        </div>
      </footer>
    </>
  );
}
