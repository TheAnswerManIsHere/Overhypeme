import { useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

export default function Onboard() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const captchaRef = useRef<HCaptcha>(null);
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const returnTo = (() => {
    if (typeof window === "undefined") return "/";
    const params = new URLSearchParams(window.location.search);
    const r = params.get("returnTo") || "/";
    if (!r.startsWith("/") || r.startsWith("//")) return "/";
    return r;
  })();

  async function handleVerify() {
    if (!captchaToken) {
      setError("Please complete the CAPTCHA challenge.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/users/me/complete-onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ captchaToken }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error || "Verification failed. Please try again.");
        captchaRef.current?.resetCaptcha();
        setCaptchaToken("");
      } else {
        setLocation(returnTo);
      }
    } catch {
      setError("Network error. Please try again.");
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    setLocation("/");
    return null;
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-8 shadow-lg space-y-6 text-center">
        <div className="text-5xl">🥊</div>
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            Welcome to The Facts Database
          </h1>
          <p className="text-muted-foreground text-sm">
            Before you can submit facts or leave comments, we need to confirm
            you're a human — not a robot.
          </p>
        </div>

        <div className="flex justify-center">
          <HCaptcha
            ref={captchaRef}
            sitekey={HCAPTCHA_SITE_KEY}
            theme="dark"
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken("")}
          />
        </div>

        {error && (
          <p className="text-destructive text-sm font-medium">{error}</p>
        )}

        <Button
          onClick={handleVerify}
          disabled={!captchaToken || submitting}
          className="w-full"
        >
          {submitting ? "Verifying…" : "I'm Human — Let Me In"}
        </Button>

        <button
          onClick={() => setLocation("/")}
          className="text-xs text-muted-foreground hover:text-foreground underline transition-colors"
        >
          Skip for now (browse-only mode)
        </button>
      </div>
    </div>
  );
}
