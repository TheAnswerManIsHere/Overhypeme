import { useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ArrowLeft, Mail } from "lucide-react";

function getEmailParam(): string {
  return new URLSearchParams(window.location.search).get("email") ?? "";
}

export default function ForgotPassword() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState(() => getEmailParam());
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // silently ignore network errors — show the same confirmation regardless
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  };

  return (
    <Layout>
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-card border-2 border-border rounded-sm p-8 shadow-lg">
            <div className="text-center mb-8">
              <h1 className="font-display text-3xl font-bold text-foreground tracking-wider">
                FORGOT PASSWORD
              </h1>
              <p className="text-muted-foreground mt-2">
                Enter your email and we'll send you a reset link
              </p>
            </div>

            {submitted ? (
              <div className="space-y-6">
                <div className="bg-primary/10 border border-primary/20 rounded-sm px-4 py-4 text-sm text-foreground">
                  <p className="font-medium">Check your inbox</p>
                  <p className="mt-1 text-muted-foreground">
                    If an account with that email exists and has a local password, you will receive a reset link shortly. The link expires in 1 hour.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="md"
                  className="w-full gap-2"
                  onClick={() => setLocation("/login")}
                >
                  <ArrowLeft className="w-4 h-4" /> BACK TO LOGIN
                </Button>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                      Email Address
                    </label>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      required
                      autoComplete="email"
                    />
                  </div>

                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    className="w-full gap-2"
                    isLoading={loading}
                  >
                    <Mail className="w-5 h-5" /> SEND RESET LINK
                  </Button>
                </form>

                <div className="mt-4 text-center">
                  <button
                    onClick={() => setLocation("/login")}
                    className="text-sm text-muted-foreground hover:text-primary"
                  >
                    <ArrowLeft className="w-3 h-3 inline mr-1" />
                    Back to login
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
