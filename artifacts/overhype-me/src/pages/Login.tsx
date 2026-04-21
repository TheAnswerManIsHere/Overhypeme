import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LogIn, UserPlus, ArrowLeft, Mail, Eye, EyeOff } from "lucide-react";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { inferPronounsFromName } from "@/lib/infer-pronouns";

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

function getFromParam(): string | null {
  return new URLSearchParams(window.location.search).get("from") || null;
}

function getBackDestination(): { path: string; label: string } {
  const from = getFromParam();
  if (!from) return { path: "/", label: "BACK TO FACTS" };
  if (from.startsWith("/facts/")) return { path: from, label: "BACK TO FACT" };
  if (from === "/profile") return { path: "/profile", label: "BACK TO PROFILE" };
  return { path: from, label: "GO BACK" };
}

export default function Login() {
  const [, setLocation] = useLocation();
  const backDest = getBackDestination();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(() => getStoredName());
  const [pronouns, setPronouns] = useState(() => getStoredPronouns());
  const pronounsExplicit = useRef(!!getStoredPronouns());
  const [showPassword, setShowPassword] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  // Track whether each name field has been manually edited — stop auto-filling if so
  const firstNameTouched = useRef(false);
  const lastNameTouched  = useRef(false);

  // Parse displayName into First / Last name while the user hasn't manually edited each field
  useEffect(() => {
    if (mode !== "register") return;
    const parts = displayName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      if (!firstNameTouched.current) setFirstName("");
      if (!lastNameTouched.current)  setLastName("");
      return;
    }
    if (!firstNameTouched.current) setFirstName(parts[0]);
    if (!lastNameTouched.current)  setLastName(parts.slice(1).join(" "));
  }, [displayName, mode]);

  // Auto-suggest pronouns from the first name while the user hasn't made an explicit choice
  useEffect(() => {
    if (mode !== "register") return;
    if (pronounsExplicit.current) return;
    const suggested = inferPronounsFromName(displayName);
    if (suggested) setPronouns(suggested);
  }, [displayName, mode]);
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
        if (!firstName.trim()) {
          setError("First Name is required.");
          setLoading(false);
          return;
        }
        if (!lastName.trim()) {
          setError("Last Name is required.");
          setLoading(false);
          return;
        }
        if (!pronouns) {
          setError("Please select your pronouns.");
          setLoading(false);
          return;
        }
        body.displayName = displayName;
        body.pronouns = pronouns;
        body.firstName = firstName.trim();
        body.lastName  = lastName.trim();
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

      window.location.href = getFromParam() ?? "/";
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    const returnTo = encodeURIComponent(getFromParam() ?? "/");
    window.open(
      `/api/login/google?returnTo=${returnTo}&popup=1`,
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

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                      First Name <span className="text-destructive">*</span>
                    </label>
                    <Input
                      type="text"
                      value={firstName}
                      onChange={(e) => {
                        firstNameTouched.current = true;
                        setFirstName(e.target.value);
                      }}
                      placeholder="First"
                      required
                      maxLength={100}
                      autoComplete="given-name"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                      Last Name <span className="text-destructive">*</span>
                    </label>
                    <Input
                      type="text"
                      value={lastName}
                      onChange={(e) => {
                        lastNameTouched.current = true;
                        setLastName(e.target.value);
                      }}
                      placeholder="Last"
                      required
                      maxLength={100}
                      autoComplete="family-name"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                    Pronouns <span className="text-destructive">*</span>
                  </label>
                  <PronounEditor
                    value={pronouns}
                    onChange={(v) => {
                      pronounsExplicit.current = true;
                      setPronouns(v);
                    }}
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                Password{mode === "register" && <span className="text-destructive ml-1">*</span>}
              </label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    mode === "register" ? "Min 8 characters" : "Enter your password"
                  }
                  required
                  minLength={mode === "register" ? 8 : 1}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {mode === "login" && (
                <div className="text-right mt-1">
                  <button
                    type="button"
                    onClick={() => setLocation(`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`)}
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
                    firstNameTouched.current = false;
                    lastNameTouched.current  = false;
                    // Allow auto-inference to run when switching to register if no explicit choice yet
                    if (!pronouns) pronounsExplicit.current = false;
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
            onClick={handleGoogleLogin}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            CONTINUE WITH GOOGLE
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-4 gap-2"
            onClick={() => setLocation(backDest.path)}
          >
            <ArrowLeft className="w-4 h-4" /> {backDest.label}
          </Button>
        </div>
      </div>
    </div>
    </Layout>
  );
}
