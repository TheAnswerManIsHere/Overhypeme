import { useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LogIn, UserPlus, ArrowLeft, Mail } from "lucide-react";
import { PronounEditor } from "@/components/ui/PronounEditor";

const STORAGE_KEY_NAME    = "fact_db_name";
const STORAGE_KEY_PRONOUNS = "fact_db_pronouns";
const DEFAULT_NAME        = "David Franklin";

function getStoredName(): string {
  const v = localStorage.getItem(STORAGE_KEY_NAME);
  return (!v || v === DEFAULT_NAME) ? "" : v;
}

function getStoredPronouns(): string {
  return localStorage.getItem(STORAGE_KEY_PRONOUNS) ?? "";
}

function getResetSuccess(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("reset") === "success";
}

export default function Login() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(() => getStoredName());
  const [pronouns, setPronouns] = useState(() => getStoredPronouns());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState("");
  const resetSuccess = getResetSuccess();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const endpoint =
        mode === "login" ? "/api/auth/local-login" : "/api/auth/register";
      const body: Record<string, string> = { email, password };
      if (mode === "register") {
        if (!pronouns) {
          setError("Please select your pronouns.");
          setLoading(false);
          return;
        }
        body.displayName = displayName;
        body.pronouns = pronouns;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }

      if (data.sid) {
        localStorage.setItem("auth_token", data.sid);
      }

      if (mode === "register" && email) {
        setRegisteredEmail(email);
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleReplitLogin = () => {
    const returnTo = encodeURIComponent("/");
    window.open(
      `/api/login?returnTo=${returnTo}&popup=1`,
      "_blank",
      "width=600,height=700,menubar=no,toolbar=no",
    );
  };

  if (registeredEmail) {
    return (
      <Layout>
        <div className="min-h-[80vh] flex items-center justify-center px-4">
          <div className="w-full max-w-md">
            <div className="bg-card border-2 border-border rounded-sm p-10 shadow-lg text-center">
              <Mail className="w-16 h-16 text-primary mx-auto mb-5" />
              <h1 className="font-display text-2xl font-bold text-foreground tracking-wider mb-3">
                CHECK YOUR EMAIL
              </h1>
              <p className="text-muted-foreground mb-2">
                We sent a verification link to:
              </p>
              <p className="text-foreground font-bold mb-6">{registeredEmail}</p>
              <p className="text-muted-foreground text-sm mb-8">
                Click the link in the email to verify your account. You can browse in the meantime, but some features require a verified email.
              </p>
              <Button variant="primary" className="w-full mb-3" onClick={() => { window.location.href = "/"; }}>
                CONTINUE BROWSING
              </Button>
              <button
                className="text-xs text-muted-foreground hover:text-foreground underline transition-colors"
                onClick={async () => {
                  await fetch("/api/auth/resend-verification", { method: "POST", credentials: "include" });
                  alert("Verification email resent. Please check your inbox.");
                }}
              >
                Didn't receive it? Resend verification email
              </button>
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
          {resetSuccess && (
            <div className="mb-6 bg-green-500/10 text-green-700 dark:text-green-400 border border-green-500/20 rounded-sm px-4 py-3 text-sm font-medium">
              Your password has been reset successfully. Please sign in with your new password.
            </div>
          )}

          <div className="text-center mb-8">
            <h1 className="font-display text-3xl font-bold text-foreground tracking-wider">
              {mode === "login" ? "LOGIN" : "CREATE ACCOUNT"}
            </h1>
            <p className="text-muted-foreground mt-2">
              {mode === "login"
                ? "Sign in to vote, comment, and submit facts"
                : "Join the community and personalize every fact"}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                Email <span className="text-destructive">*</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
              {mode === "register" && (
                <p className="text-xs text-muted-foreground mt-1">You'll receive a verification link at this address.</p>
              )}
            </div>

            {mode === "register" && (
              <>
                <div>
                  <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                    Display Name <span className="text-destructive">*</span>
                  </label>
                  <Input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="How facts will address you (e.g. Alex Smith)"
                    required
                    maxLength={100}
                    autoComplete="name"
                  />
                  <p className="text-xs text-muted-foreground mt-1">This is the name inserted into personalized facts.</p>
                </div>

                <div>
                  <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                    Pronouns <span className="text-destructive">*</span>
                  </label>
                  <PronounEditor value={pronouns} onChange={setPronouns} />
                </div>
              </>
            )}

            <div>
              <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                Password{mode === "register" && <span className="text-destructive ml-1">*</span>}
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === "register" ? "Min 8 characters" : "Enter your password"
                }
                required
                minLength={mode === "register" ? 8 : 1}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
              />
              {mode === "login" && (
                <div className="text-right mt-1">
                  <button
                    type="button"
                    onClick={() => setLocation("/forgot-password")}
                    className="text-xs text-muted-foreground hover:text-primary"
                  >
                    Forgot password?
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-sm px-4 py-3 text-sm font-medium">
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full gap-2"
              isLoading={loading}
            >
              {mode === "login" ? (
                <>
                  <LogIn className="w-5 h-5" /> SIGN IN
                </>
              ) : (
                <>
                  <UserPlus className="w-5 h-5" /> CREATE ACCOUNT
                </>
              )}
            </Button>
          </form>

          <div className="mt-4 text-center">
            {mode === "login" ? (
              <p className="text-sm text-muted-foreground">
                Don't have an account?{" "}
                <button
                  onClick={() => {
                    setMode("register");
                    setError("");
                  }}
                  className="text-primary font-bold hover:underline"
                >
                  Sign up
                </button>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Already have an account?{" "}
                <button
                  onClick={() => {
                    setMode("login");
                    setError("");
                  }}
                  className="text-primary font-bold hover:underline"
                >
                  Sign in
                </button>
              </p>
            )}
          </div>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-card px-4 text-muted-foreground font-display uppercase tracking-wider">
                or
              </span>
            </div>
          </div>

          <Button
            variant="outline"
            size="md"
            className="w-full gap-2"
            onClick={handleReplitLogin}
          >
            <svg width="20" height="20" viewBox="0 0 32 32" fill="currentColor">
              <path d="M7 5.5C7 4.11929 8.11929 3 9.5 3H16.5C17.8807 3 19 4.11929 19 5.5V11.5C19 12.8807 17.8807 14 16.5 14H9.5C8.11929 14 7 12.8807 7 11.5V5.5Z" />
              <path d="M19 11.5C19 10.1193 20.1193 9 21.5 9H24.5C25.8807 9 27 10.1193 27 11.5V20.5C27 21.8807 25.8807 23 24.5 23H21.5C20.1193 23 19 21.8807 19 20.5V11.5Z" />
              <path d="M7 20.5C7 19.1193 8.11929 18 9.5 18H16.5C17.8807 18 19 19.1193 19 20.5V26.5C19 27.8807 17.8807 29 16.5 29H9.5C8.11929 29 7 27.8807 7 26.5V20.5Z" />
            </svg>
            SIGN IN WITH REPLIT
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-4 gap-2"
            onClick={() => setLocation("/")}
          >
            <ArrowLeft className="w-4 h-4" /> BACK TO FACTS
          </Button>
        </div>
      </div>
    </div>
    </Layout>
  );
}
