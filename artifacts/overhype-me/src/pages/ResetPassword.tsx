import { useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { KeyRound, Eye, EyeOff } from "lucide-react";

function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const token = getTokenFromUrl();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (!token) {
      setError("Missing reset token. Please use the link from your email.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }

      setLocation("/login?reset=success");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Layout>
        <div className="min-h-[80vh] flex items-center justify-center px-4">
          <div className="w-full max-w-md">
            <div className="bg-card border-2 border-border rounded-sm p-8 shadow-lg text-center space-y-4">
              <h1 className="font-display text-2xl font-bold text-foreground tracking-wider">
                INVALID RESET LINK
              </h1>
              <p className="text-muted-foreground">
                This reset link is missing a token. Please use the link from your email.
              </p>
              <Button
                variant="primary"
                size="md"
                className="w-full"
                onClick={() => setLocation("/forgot-password")}
              >
                REQUEST A NEW RESET LINK
              </Button>
            </div>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-card border-2 border-border rounded-sm p-8 shadow-lg">
            <div className="text-center mb-8">
              <h1 className="font-display text-3xl font-bold text-foreground tracking-wider">
                RESET PASSWORD
              </h1>
              <p className="text-muted-foreground mt-2">
                Enter your new password below
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                  New Password
                </label>
                <div className="relative">
                  <Input
                    type={showNewPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    aria-label={showNewPassword ? "Hide password" : "Show password"}
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Input
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat your new password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-sm px-4 py-3 text-sm font-medium">
                  {error}{" "}
                  {(error.includes("invalid") || error.includes("expired") || error.includes("used")) && (
                    <button
                      type="button"
                      onClick={() => setLocation("/forgot-password")}
                      className="underline font-bold ml-1"
                    >
                      Request a new link
                    </button>
                  )}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full gap-2"
                isLoading={loading}
              >
                <KeyRound className="w-5 h-5" /> SET NEW PASSWORD
              </Button>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
}
