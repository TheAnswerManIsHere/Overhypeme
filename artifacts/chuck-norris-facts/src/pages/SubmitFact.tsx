import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, Link } from "wouter";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useAuth } from "@workspace/replit-auth-web";

import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { ShieldAlert, AlertTriangle, Sparkles, Copy, Loader2 } from "lucide-react";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

interface DuplicateResult {
  isDuplicate: boolean;
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

  const [duplicate, setDuplicate] = useState<DuplicateResult | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [acceptedTags, setAcceptedTags] = useState<Set<string>>(new Set());
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const fetchSuggestions = async () => {
    if (text.length < 20) return;
    setLoadingSuggestions(true);
    try {
      const r = await fetch("/api/ai/suggest-hashtags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text }),
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
  };

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
          <Button size="lg" onClick={login}>IDENTIFY YOURSELF (LOGIN)</Button>
        </div>
      </Layout>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (text.length < 10) {
      setError("Fact must be at least 10 characters.");
      return;
    }
    if (!captchaToken) {
      setError("Please prove you are not a bot.");
      return;
    }

    const tags = hashtagsStr.split(",")
      .map(t => t.trim().replace(/^#/, ""))
      .filter(t => t.length > 0);

    createFact.mutate(
      { data: { text, hashtags: tags, captchaToken } },
      {
        onSuccess: (data) => {
          setLocation(`/facts/${data.id}`);
        },
        onError: (err) => {
          setError(err.data?.error || err.message || "Failed to submit fact");
        }
      }
    );
  };

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
                placeholder="When Chuck Norris looks in a mirror, there is no reflection. There can only be one Chuck Norris."
                className="text-lg min-h-[160px]"
                disabled={createFact.isPending}
              />
              <div className="flex items-center justify-between mt-2">
                <p className="text-sm text-muted-foreground font-medium">Minimum 10 characters. Make it hit hard.</p>
                {checkingDuplicate && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Checking uniqueness…
                  </span>
                )}
              </div>

              {duplicate && (
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
                      <p className="text-xs mt-2 opacity-70">You can still submit if you believe your version is meaningfully different.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block font-display text-xl uppercase text-foreground">Hashtags</label>
                {text.length >= 20 && !suggestionsLoaded && (
                  <button
                    type="button"
                    onClick={fetchSuggestions}
                    disabled={loadingSuggestions}
                    className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                  >
                    {loadingSuggestions ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Thinking…</>
                    ) : (
                      <><Sparkles className="w-3 h-3" /> AI Suggest</>
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
                <HCaptcha
                  sitekey={HCAPTCHA_SITE_KEY}
                  onVerify={setCaptchaToken}
                />
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
          </div>
        </form>
      </div>
    </Layout>
  );
}
