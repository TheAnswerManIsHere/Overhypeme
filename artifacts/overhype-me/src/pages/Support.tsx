/**
 * @purpose The contact page (launch Phase 16, increment 5, plan design E): email, a category and a message, a captcha, and one request to /api/support/contact; it works signed out, from every account state, and during read-only mode, and when the request cannot be sent it says so and shows the address.
 * @subsystem operations
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/textarea";
import { Turnstile, type TurnstileHandle } from "@/components/ui/Turnstile";
import { Mail, Send } from "lucide-react";

/** Shown when the API cannot be reached at all; the API names its own address otherwise. */
export const SUPPORT_ADDRESS = "support@overhype.me";

export const SUPPORT_CATEGORIES = [
  { value: "account", label: "My account" },
  { value: "billing", label: "Billing or membership" },
  { value: "bug", label: "Something isn't working" },
  { value: "content", label: "A fact, meme or comment" },
  { value: "other", label: "Something else" },
] as const;

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

function categoryParam(): string {
  const c = new URLSearchParams(window.location.search).get("category") ?? "";
  return SUPPORT_CATEGORIES.some((o) => o.value === c) ? c : "";
}

type Outcome = { kind: "sent"; acknowledged: boolean } | { kind: "unavailable"; address: string } | null;

export default function Support() {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState(categoryParam);
  const [message, setMessage] = useState("");
  const [hpField, setHpField] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const formStartedAt = useRef(Date.now());
  const captchaRef = useRef<TurnstileHandle>(null);

  // A signed-in member's address is the default; they can change it.
  const userEmail = (user as { email?: string | null } | null)?.email ?? "";
  useEffect(() => {
    if (userEmail) setEmail((current) => current || userEmail);
  }, [userEmail]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!category) { setError("Choose what your message is about."); return; }
    if (message.trim().length < MESSAGE_MIN) { setError(`Tell us a little more: at least ${MESSAGE_MIN} characters.`); return; }
    if (!captchaToken) { setError("Complete the challenge first."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, category, message, captchaToken, hpField, formStartedAt: formStartedAt.current }),
      });
      const data = (await res.json().catch(() => ({}))) as { acknowledged?: boolean; error?: string; code?: string; address?: string };
      if (res.ok) {
        setOutcome({ kind: "sent", acknowledged: data.acknowledged !== false });
      } else if (res.status === 503 && data.code === "SUPPORT_UNAVAILABLE") {
        setOutcome({ kind: "unavailable", address: data.address ?? SUPPORT_ADDRESS });
      } else {
        setError(data.error ?? "That didn't send. Please try again.");
        captchaRef.current?.reset();
        setCaptchaToken("");
      }
    } catch {
      setOutcome({ kind: "unavailable", address: SUPPORT_ADDRESS });
    } finally {
      setLoading(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <Layout>
      <div className="min-h-[80vh] flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg">
          <div className="bg-card border-2 border-border rounded-sm p-8 shadow-lg">
            <div className="text-center mb-8">
              <h1 className="font-display text-3xl font-bold text-foreground tracking-wider">CONTACT SUPPORT</h1>
              <p className="text-muted-foreground mt-2">A person reads every message. We'll reply by email.</p>
            </div>

            {outcome?.kind === "sent" ? (
              <div className="space-y-6" data-testid="support-sent">
                <div className="bg-primary/10 border border-primary/20 rounded-sm px-4 py-4 text-sm text-foreground">
                  <p className="font-medium">We got your message.</p>
                  <p className="mt-1 text-muted-foreground">
                    {outcome.acknowledged
                      ? `We've sent a confirmation to ${email}, and we'll reply there.`
                      : `We'll reply to ${email}. The confirmation email didn't go out, but your message arrived.`}
                  </p>
                </div>
                <Link href="/" className="block text-center text-sm text-muted-foreground hover:text-primary">Back to the facts</Link>
              </div>
            ) : outcome?.kind === "unavailable" ? (
              <div className="space-y-4" data-testid="support-unavailable">
                <div className="bg-destructive/10 border border-destructive/30 rounded-sm px-4 py-4 text-sm text-foreground">
                  <p className="font-medium">We couldn't send your message just now.</p>
                  <p className="mt-1 text-muted-foreground">
                    Please email us at{" "}
                    <a href={`mailto:${outcome.address}`} className="font-semibold text-primary underline">{outcome.address}</a>.
                  </p>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div>
                  <label htmlFor="support-email" className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">Your email</label>
                  <Input id="support-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" required autoComplete="email" />
                </div>
                <div>
                  <label htmlFor="support-category" className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">What's it about?</label>
                  <select
                    id="support-category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    required
                    className="w-full rounded-sm border-2 border-border bg-background px-3 py-2 text-foreground"
                  >
                    <option value="" disabled>Choose one</option>
                    {SUPPORT_CATEGORIES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="support-message" className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">Message</label>
                  <Textarea id="support-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={6} maxLength={MESSAGE_MAX} required />
                </div>
                {/* Left empty by people; filled by form-filling scripts. */}
                <input type="text" name="website" value={hpField} onChange={(e) => setHpField(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
                <Turnstile ref={captchaRef} theme="dark" onVerify={setCaptchaToken} onExpire={() => setCaptchaToken("")} />
                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                <Button type="submit" variant="primary" size="lg" className="w-full gap-2" isLoading={loading}>
                  <Send className="w-5 h-5" /> SEND MESSAGE
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  <Mail className="w-3 h-3 inline mr-1" />
                  Or email <a href={`mailto:${SUPPORT_ADDRESS}`} className="underline hover:text-primary">{SUPPORT_ADDRESS}</a>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
