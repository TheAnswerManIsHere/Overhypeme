import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LogIn, UserPlus, ArrowLeft, Loader2 } from "lucide-react";

const STORAGE_KEY_NAME    = "fact_db_name";
const STORAGE_KEY_SUBJECT = "fact_db_pronoun_subject";
const STORAGE_KEY_OBJECT  = "fact_db_pronoun_object";
const LEGACY_KEY_PRONOUNS = "fact_db_pronouns";
const DEFAULT_NAME        = "David Franklin";
const DEFAULT_SUBJECT     = "he";
const DEFAULT_OBJECT      = "him";

function getStoredName(): string {
  const v = localStorage.getItem(STORAGE_KEY_NAME);
  return (!v || v === DEFAULT_NAME) ? "" : v;
}

function getStoredSubject(): string {
  const v = localStorage.getItem(STORAGE_KEY_SUBJECT);
  if (v && v !== DEFAULT_SUBJECT) return v;
  const legacy = localStorage.getItem(LEGACY_KEY_PRONOUNS);
  if (legacy) {
    const part = legacy.split("/")[0];
    if (part && part !== DEFAULT_SUBJECT) return part;
  }
  return "";
}

function getStoredObject(): string {
  const v = localStorage.getItem(STORAGE_KEY_OBJECT);
  if (v && v !== DEFAULT_OBJECT) return v;
  const legacy = localStorage.getItem(LEGACY_KEY_PRONOUNS);
  if (legacy) {
    const part = legacy.split("/")[1];
    if (part && part !== DEFAULT_OBJECT) return part;
  }
  return "";
}

function getResetSuccess(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("reset") === "success";
}

async function fetchSuggestedPronouns(
  name: string,
  signal: AbortSignal,
): Promise<{ subject: string; object: string } | null> {
  try {
    const res = await fetch("/api/ai/suggest-pronouns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { subject?: string; object?: string };
    if (typeof data.subject === "string" && typeof data.object === "string") {
      return { subject: data.subject, object: data.object };
    }
    return null;
  } catch {
    return null;
  }
}

export default function Login() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState(() => getStoredName());
  const [pronounSubject, setPronounSubject] = useState(() => getStoredSubject());
  const [pronounObject, setPronounObject] = useState(() => getStoredObject());
  const [pronounsLoading, setPronounsLoading] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const resetSuccess = getResetSuccess();

  const pronounsManuallyEditedRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  const pronounSubjectRef = useRef(pronounSubject);
  const pronounObjectRef  = useRef(pronounObject);
  useEffect(() => { pronounSubjectRef.current = pronounSubject; }, [pronounSubject]);
  useEffect(() => { pronounObjectRef.current  = pronounObject;  }, [pronounObject]);

  const triggerPronounSuggestion = useCallback((nameValue: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!nameValue.trim()) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setPronounsLoading(false);
      return;
    }

    debounceTimerRef.current = setTimeout(async () => {
      if (pronounsManuallyEditedRef.current) return;
      if (pronounSubjectRef.current || pronounObjectRef.current) return;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setPronounsLoading(true);
      const suggestion = await fetchSuggestedPronouns(nameValue.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setPronounsLoading(false);

      if (suggestion && !pronounsManuallyEditedRef.current) {
        setPronounSubject(suggestion.subject);
        setPronounObject(suggestion.object);
      }
    }, 400);
  }, []);

  function handleDisplayNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setDisplayName(value);
    triggerPronounSuggestion(value);
  }

  function handleSubjectChange(e: React.ChangeEvent<HTMLInputElement>) {
    pronounsManuallyEditedRef.current = true;
    setPronounSubject(e.target.value);
  }

  function handleObjectChange(e: React.ChangeEvent<HTMLInputElement>) {
    pronounsManuallyEditedRef.current = true;
    setPronounObject(e.target.value);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const endpoint =
        mode === "login" ? "/api/auth/local-login" : "/api/auth/register";
      const body: Record<string, string> = { username, password };
      if (mode === "register") {
        if (email) body.email = email;
        body.displayName = displayName;
        // Send pronouns if any pronoun field is non-empty at submit time (includes AI suggestions
        // the user saw and did not clear, as well as manually typed or localStorage-prefilled values)
        if (pronounSubject.trim() || pronounObject.trim()) {
          const subject = pronounSubject.trim() || DEFAULT_SUBJECT;
          const object  = pronounObject.trim()  || DEFAULT_OBJECT;
          body.pronouns = `${subject}/${object}`;
        }
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
                Username
              </label>
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                required
                minLength={3}
                maxLength={30}
                autoComplete="username"
              />
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
                    onChange={handleDisplayNameChange}
                    placeholder="How facts will address you (e.g. Alex Smith)"
                    required
                    maxLength={100}
                    autoComplete="name"
                  />
                  <p className="text-xs text-muted-foreground mt-1">This is the name inserted into personalized facts.</p>
                </div>

                <div>
                  <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                    Pronouns{" "}
                    <span className="text-xs font-normal normal-case">(optional)</span>
                    {pronounsLoading && (
                      <Loader2 className="inline w-3 h-3 ml-1 animate-spin text-muted-foreground" />
                    )}
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={pronounSubject}
                      onChange={handleSubjectChange}
                      placeholder="he / she / they"
                      maxLength={10}
                      title="Subject pronoun"
                      className={`flex-1 ${pronounsLoading ? "opacity-50" : ""}`}
                    />
                    <span className="text-muted-foreground font-bold shrink-0">/</span>
                    <Input
                      type="text"
                      value={pronounObject}
                      onChange={handleObjectChange}
                      placeholder="him / her / them"
                      maxLength={10}
                      title="Object pronoun"
                      className={`flex-1 ${pronounsLoading ? "opacity-50" : ""}`}
                    />
                  </div>
                </div>

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
                  <p className="text-xs text-muted-foreground mt-1">You'll receive a verification link at this address.</p>
                </div>
              </>
            )}

            <div>
              <label className="block text-sm font-display font-bold text-muted-foreground mb-1 uppercase tracking-wider">
                Password
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
