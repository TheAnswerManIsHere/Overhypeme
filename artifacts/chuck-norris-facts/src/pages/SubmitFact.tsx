import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, Link } from "wouter";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useAuth } from "@workspace/replit-auth-web";

import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { ShieldAlert, AlertTriangle, Sparkles, Copy, Loader2, CheckCircle2, ClipboardList } from "lucide-react";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

interface DuplicateResult {
  isDuplicate: boolean;
  confidence: number;
  matchingFactId?: number;
  matchingFactText?: string;
}

interface ServerConflict {
  confidence: number;
  matchingFactId?: number;
  matchingFactText?: string;
}

export default function SubmitFact() {
  const { isAuthenticated, login } = useAuth();
  const [, setLocation] = useLocation();
  const { createFact } = useAppMutations();

  const [text, setText] = useState("");
  const [hashtagsStr, setHashtagsStr] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [error, setError] = useState("");

  const [serverConflict, setServerConflict] = useState<ServerConflict | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateResult | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [acceptedTags, setAcceptedTags] = useState<Set<string>>(new Set());
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSuggestedTextRef = useRef("");

  const checkDuplicate = useCallback(async (factText: string) => {
    if (factText.length < 20) { setDuplicate(null); return; }
    setCheckingDuplicate(true);
    try {
      const r = await fetch("/api/ai/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: factText }),
      });
      if (r.ok) {
        const data: DuplicateResult = await r.json();
        setDuplicate(data.isDuplicate && data.confidence > 65 ? data : null);
      }
    } catch {
      setDuplicate(null);
    } finally {
      setCheckingDuplicate(false);
    }
  }, []);

  useEffect(() => {
    if (dupTimer.current) clearTimeout(dupTimer.current);
    if (text.length < 20) { setDuplicate(null); return; }
    dupTimer.current = setTimeout(() => { checkDuplicate(text); }, 1500);
    return () => { if (dupTimer.current) clearTimeout(dupTimer.current); };
  }, [text, checkDuplicate]);

  const fetchSuggestions = useCallback(async (factText: string) => {
    if (factText.length < 20) return;
    lastSuggestedTextRef.current = factText;
    setLoadingSuggestions(true);
    try {
      const r = await fetch("/api/ai/suggest-hashtags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: factText }),
      });
      if (r.ok) {
        const data: { hashtags: string[] } = await r.json();
        setSuggestedTags(data.hashtags);
        setAcceptedTags(new Set(data.hashtags));
        setSuggestionsLoaded(true);
      }
    } catch {
      setSuggestedTags([]);
    } finally {
      setLoadingSuggestions(false);
    }
  }, []);

  useEffect(() => {
    if (tagTimer.current) clearTimeout(tagTimer.current);
    if (text.length < 20) {
      if (suggestionsLoaded) {
        setSuggestionsLoaded(false);
        setSuggestedTags([]);
        lastSuggestedTextRef.current = "";
      }
      return;
    }
    const lastText = lastSuggestedTextRef.current;
    const materiallyChanged = lastText === "" || Math.abs(text.length - lastText.length) > 20 || !text.startsWith(lastText.slice(0, 20));
    if (!materiallyChanged) return;
    setSuggestionsLoaded(false);
    setSuggestedTags([]);
    tagTimer.current = setTimeout(() => { void fetchSuggestions(text); }, 2000);
    return () => { if (tagTimer.current) clearTimeout(tagTimer.current); };
  }, [text, suggestionsLoaded, fetchSuggestions]);

  const toggleTag = (tag: string) => {
    setAcceptedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const applyTagsToInput = () => {
    const existing = hashtagsStr.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
    const combined = Array.from(new Set([...existing, ...acceptedTags])).join(", ");
    setHashtagsStr(combined);
    setSuggestedTags([]);
    setSuggestionsLoaded(false);
  };

  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <ShieldAlert className="w-20 h-20 text-primary mx-auto mb-6 opacity-80" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Restricted Area</h1>
          <p className="text-muted-foreground text-lg mb-8">You must be authorized to submit facts to the database.</p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => setLocation("/login")}>IDENTIFY YOURSELF (LOGIN)</Button>
            <Button size="lg" variant="outline" onClick={() => window.history.length > 1 ? window.history.back() : setLocation("/")}>GO BACK</Button>
          </div>
        </div>
      </Layout>
    );
  }

  const getTags = () =>
    hashtagsStr.split(",").map((t) => t.trim().replace(/^#/, "")).filter((t) => t.length > 0);

  const doSubmit = (skipDuplicate: boolean) => {
    setError("");
    setServerConflict(null);
    createFact.mutate(
      { data: { text, hashtags: getTags(), captchaToken, skipDuplicateCheck: skipDuplicate } },
      {
        onSuccess: (data) => { setLocation(`/facts/${data.id}`); },
        onError: (err) => {
          const errData = err.data as { error?: string; isDuplicate?: boolean; confidence?: number; matchingFactId?: number; matchingFactText?: string } | null;
          if (err.status === 409 && errData?.isDuplicate) {
            setServerConflict({
              confidence: errData.confidence ?? 90,
              matchingFactId: errData.matchingFactId,
              matchingFactText: errData.matchingFactText,
            });
          } else {
            setError(errData?.error || err.message || "Failed to submit fact");
          }
        },
      }
    );
  };

  const doSubmitForReview = async (conflict: ServerConflict) => {
    setSubmittingReview(true);
    setError("");
    try {
      const r = await fetch("/api/facts/submit-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          text,
          matchingFactId: conflict.matchingFactId,
          matchingSimilarity: conflict.confidence,
          hashtags: getTags(),
        }),
      });
      if (r.ok) {
        setReviewSubmitted(true);
        setServerConflict(null);
      } else {
        const d = await r.json() as { error?: string };
        setError(d.error ?? "Failed to submit for review");
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setServerConflict(null);
    if (text.length < 10) { setError("Fact must be at least 10 characters."); return; }
    if (!captchaToken) { setError("Please prove you are not a bot."); return; }
    doSubmit(false);
  };

  if (reviewSubmitted) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <CheckCircle2 className="w-20 h-20 text-green-500 mx-auto mb-6" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Submitted for Review</h1>
          <p className="text-muted-foreground text-lg mb-4">
            Your fact has been queued for admin review. If approved, it will be added to the database and you'll be notified.
          </p>
          <p className="text-muted-foreground text-sm mb-8">
            You can track the status in your{" "}
            <Link href="/activity" className="text-primary underline">Activity Feed</Link>.
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => { setText(""); setReviewSubmitted(false); }}>Submit Another</Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/")}>Back to Home</Button>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 py-12 md:py-20">
        <div className="mb-10 text-center">
          <h1 className="text-5xl font-display uppercase tracking-wider text-foreground mb-4">Submit Protocol</h1>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Add a new verified fact to the database. Duplicate submissions will be dealt with severely.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-card border-2 border-border p-6 md:p-10 rounded-sm shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary to-destructive" />

          {error && (
            <div className="mb-8 p-4 bg-destructive/10 border-l-4 border-destructive text-destructive flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span className="font-bold">{error}</span>
            </div>
          )}

          <div className="space-y-8">
            <div>
              <label className="block font-display text-xl uppercase text-foreground mb-2">The Fact</label>
              <Textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="When {First_Name} {Last_Name} looks in a mirror, there is no reflection. Tip: 'Chuck Norris' is auto-replaced with name tokens on submit."
                className="text-lg min-h-[160px]"
                disabled={createFact.isPending || submittingReview}
              />
              <div className="flex items-center justify-between mt-2">
                <p className="text-sm text-muted-foreground font-medium">Minimum 10 characters. Make it hit hard.</p>
                {checkingDuplicate && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Checking uniqueness…
                  </span>
                )}
              </div>

              {/* Inline duplicate warning (real-time, before submit) */}
              {duplicate && !serverConflict && (
                <div className="mt-3 p-4 bg-yellow-500/10 border-l-4 border-yellow-500 text-yellow-700 dark:text-yellow-400 rounded-r-sm">
                  <div className="flex items-start gap-3">
                    <Copy className="w-5 h-5 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-sm">Possible duplicate detected ({duplicate.confidence}% confidence)</p>
                      {duplicate.matchingFactId && (
                        <>
                          <p className="text-xs mt-1 opacity-80 italic">"{duplicate.matchingFactText}"</p>
                          <Link href={`/facts/${duplicate.matchingFactId}`} className="text-xs underline mt-1 block hover:opacity-80">
                            View existing fact →
                          </Link>
                        </>
                      )}
                      <p className="text-xs mt-2 opacity-70">You can still submit — if the server flags it you can request an admin review.</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Server-confirmed duplicate — show side-by-side and options */}
              {serverConflict && (
                <div className="mt-4 space-y-4">
                  <div className="p-4 bg-destructive/10 border-l-4 border-destructive rounded-r-sm">
                    <div className="flex items-start gap-3 mb-3">
                      <Copy className="w-5 h-5 shrink-0 mt-0.5 text-destructive" />
                      <p className="font-bold text-sm text-destructive">
                        Likely duplicate detected ({serverConflict.confidence}% confidence match)
                      </p>
                    </div>

                    {/* Side-by-side comparison */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                      <div className="bg-background border border-border rounded-sm p-3">
                        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Your submission</p>
                        <p className="text-sm text-foreground italic">"{text}"</p>
                      </div>
                      <div className="bg-background border border-primary/40 rounded-sm p-3">
                        <p className="text-xs font-bold text-primary uppercase tracking-wide mb-2">
                          Existing fact
                          {serverConflict.matchingFactId && (
                            <Link href={`/facts/${serverConflict.matchingFactId}`} className="ml-2 normal-case text-primary underline hover:opacity-80">
                              View →
                            </Link>
                          )}
                        </p>
                        <p className="text-sm text-foreground italic">"{serverConflict.matchingFactText}"</p>
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground mb-4">
                      If you believe your fact is genuinely different, submit it for admin review. An admin will compare both and decide.
                    </p>

                    <div className="flex flex-wrap gap-3">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => doSubmitForReview(serverConflict)}
                        isLoading={submittingReview}
                        className="gap-2"
                      >
                        <ClipboardList className="w-4 h-4" />
                        Submit for Review
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-muted-foreground/30 text-muted-foreground hover:text-foreground"
                        onClick={() => { setServerConflict(null); setText(""); }}
                        disabled={submittingReview}
                      >
                        Discard & Start Over
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-destructive/50 text-destructive hover:bg-destructive/10 text-xs"
                        onClick={() => doSubmit(true)}
                        isLoading={createFact.isPending}
                        disabled={submittingReview}
                      >
                        Force Submit Anyway
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {!serverConflict && (
              <>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block font-display text-xl uppercase text-foreground">Hashtags</label>
                    {text.length >= 20 && (
                      <button
                        type="button"
                        onClick={() => {
                          setSuggestionsLoaded(false);
                          setSuggestedTags([]);
                          void fetchSuggestions(text);
                        }}
                        disabled={loadingSuggestions}
                        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                      >
                        {loadingSuggestions ? (
                          <><Loader2 className="w-3 h-3 animate-spin" /> Thinking…</>
                        ) : (
                          <><Sparkles className="w-3 h-3" /> {suggestionsLoaded ? "Re-suggest" : "AI Suggest"}</>
                        )}
                      </button>
                    )}
                  </div>

                  {suggestedTags.length > 0 && (
                    <div className="mb-3 p-3 bg-primary/5 border border-primary/20 rounded-sm">
                      <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-primary" />
                        AI suggestions — click to toggle, then apply:
                      </p>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {suggestedTags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                              acceptedTags.has(tag)
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted text-muted-foreground border-border hover:border-primary"
                            }`}
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={applyTagsToInput}
                        className="text-xs text-primary underline hover:opacity-80"
                      >
                        Apply selected tags →
                      </button>
                    </div>
                  )}

                  <Input
                    value={hashtagsStr}
                    onChange={e => setHashtagsStr(e.target.value)}
                    placeholder="impossible, strong, facts"
                    disabled={createFact.isPending}
                  />
                  <p className="text-sm text-muted-foreground mt-2 font-medium">Comma separated. No need for the # symbol.</p>
                </div>

                <div className="pt-4 border-t-2 border-border">
                  <label className="block font-display text-xl uppercase text-foreground mb-4">Security Clearance</label>
                  <div className="bg-background p-4 rounded-sm border-2 border-border inline-block">
                    <HCaptcha sitekey={HCAPTCHA_SITE_KEY} onVerify={setCaptchaToken} />
                  </div>
                </div>

                <div className="pt-6">
                  <Button
                    type="submit"
                    size="lg"
                    className="w-full h-16 text-xl"
                    isLoading={createFact.isPending}
                  >
                    COMMIT TO DATABASE
                  </Button>
                </div>
              </>
            )}
          </div>
        </form>
      </div>
    </Layout>
  );
}
