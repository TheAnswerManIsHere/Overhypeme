import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, Link } from "wouter";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useAuth } from "@workspace/replit-auth-web";

import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { renderFact } from "@/lib/render-fact";
import {
  ShieldAlert, AlertTriangle, Sparkles, Copy, Loader2,
  CheckCircle2, ChevronRight, ChevronLeft, Pencil,
} from "lucide-react";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

type Step = "write" | "preview" | "submit";

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

const PRONOUN_PREVIEWS: { label: string; subject: string; object: string; name: string }[] = [
  { label: "he/him",    subject: "he",   object: "him",  name: "David Franklin" },
  { label: "she/her",   subject: "she",  object: "her",  name: "Sarah Mitchell" },
  { label: "they/them", subject: "they", object: "them", name: "Alex Jordan"    },
];

export default function SubmitFact() {
  const { isAuthenticated, login } = useAuth();
  const [, setLocation] = useLocation();
  const { createFact } = useAppMutations();

  const [step, setStep] = useState<Step>("write");

  // Step 1: raw input
  const [rawText, setRawText] = useState("");
  const [duplicate, setDuplicate] = useState<DuplicateResult | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);

  // Step 2: tokenization + preview
  const [template, setTemplate] = useState("");
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenizeError, setTokenizeError] = useState("");

  // Step 3: hashtags / captcha / submit
  const [hashtagsStr, setHashtagsStr] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [acceptedTags, setAcceptedTags] = useState<Set<string>>(new Set());
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [serverConflict, setServerConflict] = useState<ServerConflict | null>(null);
  const [error, setError] = useState("");

  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSuggestedTextRef = useRef("");

  // ── Duplicate check ──────────────────────────────────────────────────────────
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
    } catch { setDuplicate(null); }
    finally { setCheckingDuplicate(false); }
  }, []);

  useEffect(() => {
    if (dupTimer.current) clearTimeout(dupTimer.current);
    if (rawText.length < 20) { setDuplicate(null); return; }
    dupTimer.current = setTimeout(() => { void checkDuplicate(rawText); }, 1500);
    return () => { if (dupTimer.current) clearTimeout(dupTimer.current); };
  }, [rawText, checkDuplicate]);

  // ── Hashtag suggestions (trigger on entering step 3) ────────────────────────
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
    } catch { setSuggestedTags([]); }
    finally { setLoadingSuggestions(false); }
  }, []);

  useEffect(() => {
    if (step !== "submit") return;
    if (tagTimer.current) clearTimeout(tagTimer.current);
    if (suggestionsLoaded) return;
    tagTimer.current = setTimeout(() => { void fetchSuggestions(rawText); }, 800);
    return () => { if (tagTimer.current) clearTimeout(tagTimer.current); };
  }, [step, rawText, suggestionsLoaded, fetchSuggestions]);

  // ── Tokenize via AI ──────────────────────────────────────────────────────────
  async function handleTokenize() {
    if (rawText.length < 10) return;
    setTokenizing(true);
    setTokenizeError("");
    try {
      const r = await fetch("/api/ai/tokenize-fact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: rawText }),
      });
      const data = await r.json() as { template?: string; error?: string };
      if (!r.ok || !data.template) {
        setTokenizeError(data.error ?? "Tokenization failed — please try again.");
        return;
      }
      setTemplate(data.template);
      setStep("preview");
    } catch {
      setTokenizeError("Network error — please try again.");
    } finally {
      setTokenizing(false);
    }
  }

  // ── Submit ───────────────────────────────────────────────────────────────────
  const getTags = () =>
    hashtagsStr.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);

  function doSubmit(skipDuplicate: boolean) {
    setError("");
    setServerConflict(null);
    createFact.mutate(
      { data: { text: template, hashtags: getTags(), captchaToken, skipDuplicateCheck: skipDuplicate } },
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
  }

  async function doSubmitForReview(conflict: ServerConflict) {
    setSubmittingReview(true);
    setError("");
    try {
      const r = await fetch("/api/facts/submit-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          text: template,
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
    } catch { setError("Network error — please try again."); }
    finally { setSubmittingReview(false); }
  }

  function handleFinalSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setServerConflict(null);
    if (!template || template.length < 5) { setError("No template to submit."); return; }
    if (!captchaToken) { setError("Please complete the CAPTCHA."); return; }
    doSubmit(false);
  }

  const toggleTag = (tag: string) => {
    setAcceptedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
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

  // ── Not logged in ────────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <ShieldAlert className="w-20 h-20 text-primary mx-auto mb-6 opacity-80" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Restricted Area</h1>
          <p className="text-muted-foreground text-lg mb-8">You must be authorized to submit facts to the database.</p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => setLocation("/login")}>IDENTIFY YOURSELF (LOGIN)</Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/")}>GO BACK</Button>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Review submitted ─────────────────────────────────────────────────────────
  if (reviewSubmitted) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <CheckCircle2 className="w-20 h-20 text-green-500 mx-auto mb-6" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Submitted for Review</h1>
          <p className="text-muted-foreground text-lg mb-4">
            Your fact has been queued for admin review. If approved, it will be added to the database.
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => { setRawText(""); setTemplate(""); setReviewSubmitted(false); setStep("write"); }}>
              Submit Another
            </Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/")}>Back to Home</Button>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Step indicator ───────────────────────────────────────────────────────────
  const steps: { id: Step; label: string }[] = [
    { id: "write",   label: "1. Write" },
    { id: "preview", label: "2. Preview" },
    { id: "submit",  label: "3. Submit" },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 py-12 md:py-20">
        <div className="mb-10 text-center">
          <h1 className="text-5xl font-display uppercase tracking-wider text-foreground mb-4">Submit Protocol</h1>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Write your fact in plain English. AI converts it to a personalized template that works for any name and pronouns.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-0 mb-10">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <div className={`px-4 py-1.5 text-sm font-bold uppercase tracking-wider rounded-sm border transition-colors ${
                step === s.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : stepIndex > i
                  ? "bg-green-500/10 text-green-500 border-green-500/40"
                  : "bg-background text-muted-foreground border-border"
              }`}>
                {stepIndex > i ? "✓ " : ""}{s.label}
              </div>
              {i < steps.length - 1 && <div className="w-8 h-px bg-border" />}
            </div>
          ))}
        </div>

        <div className="bg-card border-2 border-border p-6 md:p-10 rounded-sm shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary to-destructive" />

          {/* ── STEP 1: WRITE ───────────────────────────────────────────────── */}
          {step === "write" && (
            <div className="space-y-6">
              <div>
                <label className="block font-display text-xl uppercase text-foreground mb-2">The Fact</label>
                <Textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder={'Write the fact using any name — e.g. "When John does pushups, he doesn\'t push himself up, he pushes the Earth down."'}
                  className="text-lg min-h-[160px]"
                />
                <div className="flex items-center justify-between mt-2">
                  <p className="text-sm text-muted-foreground">
                    Plain English is fine. AI will detect pronouns and verb forms automatically.
                  </p>
                  {checkingDuplicate && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0 ml-4">
                      <Loader2 className="w-3 h-3 animate-spin" /> Checking…
                    </span>
                  )}
                </div>

                {duplicate && (
                  <div className="mt-3 p-4 bg-yellow-500/10 border-l-4 border-yellow-500 text-yellow-700 dark:text-yellow-400 rounded-r-sm">
                    <div className="flex items-start gap-3">
                      <Copy className="w-5 h-5 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-sm">Possible duplicate ({duplicate.confidence}% match)</p>
                        {duplicate.matchingFactId && (
                          <>
                            <p className="text-xs mt-1 opacity-80 italic">"{duplicate.matchingFactText}"</p>
                            <Link href={`/facts/${duplicate.matchingFactId}`} className="text-xs underline mt-1 block hover:opacity-80">
                              View existing fact →
                            </Link>
                          </>
                        )}
                        <p className="text-xs mt-2 opacity-70">You can still continue — the server will confirm on submit.</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {tokenizeError && (
                <div className="p-4 bg-destructive/10 border-l-4 border-destructive text-destructive flex items-center gap-3 rounded-r-sm">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span>{tokenizeError}</span>
                </div>
              )}

              <Button
                size="lg"
                className="w-full h-14 text-lg"
                disabled={rawText.length < 10 || tokenizing}
                onClick={() => void handleTokenize()}
              >
                {tokenizing
                  ? <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Tokenizing…</>
                  : <><Sparkles className="w-5 h-5 mr-2" /> TOKENIZE & PREVIEW <ChevronRight className="w-5 h-5 ml-1" /></>
                }
              </Button>
            </div>
          )}

          {/* ── STEP 2: PREVIEW ─────────────────────────────────────────────── */}
          {step === "preview" && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="font-display text-xl uppercase text-foreground">Template</label>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Pencil className="w-3 h-3" /> Editable — fix any AI mistakes
                  </span>
                </div>
                <Textarea
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  className="font-mono text-sm min-h-[100px] bg-background/50"
                />
                <div className="mt-2 p-3 bg-background/40 rounded-sm border border-border/50 text-xs text-muted-foreground space-y-1">
                  <p>
                    <span className="font-bold text-foreground/70">Pronoun tokens:</span>{" "}
                    <code className="text-primary">{"{NAME}"}</code>{" "}
                    <code className="text-primary">{"{SUBJ}"}</code>{" "}
                    <code className="text-primary">{"{OBJ}"}</code>{" "}
                    <code className="text-primary">{"{POSS}"}</code>{" "}
                    <code className="text-primary">{"{POSS_PRO}"}</code>{" "}
                    <code className="text-primary">{"{REFL}"}</code>
                  </p>
                  <p>
                    <span className="font-bold text-foreground/70">Verb conjugation:</span>{" "}
                    <code className="text-primary">{"{does|do}"}</code>{" "}
                    <code className="text-primary">{"{doesn't|don't}"}</code>{" "}
                    <code className="text-primary">{"{was|were}"}</code>{" "}
                    — left form for he/she, right for they
                  </p>
                  <p>
                    <span className="font-bold text-foreground/70">Capitalize for sentence-start:</span>{" "}
                    <code className="text-primary">{"{Subj}"}</code> → He / She / They
                  </p>
                </div>
              </div>

              <div>
                <p className="font-display text-sm uppercase text-muted-foreground mb-3 tracking-wider">Rendered Previews — verify all three</p>
                <div className="space-y-3">
                  {PRONOUN_PREVIEWS.map((p) => (
                    <div key={p.label} className="rounded-sm border border-border bg-background/60 p-4">
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-xs font-bold text-primary uppercase tracking-wider">{p.label}</span>
                        <span className="text-xs text-muted-foreground">→ {p.name}</span>
                      </div>
                      <p className="text-foreground font-medium leading-snug">
                        "{renderFact(template, p.name, p.subject, p.object)}"
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="outline"
                  size="lg"
                  className="flex-1"
                  onClick={() => { setStep("write"); setTokenizeError(""); }}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" /> Edit Fact
                </Button>
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={!template.trim()}
                  onClick={() => setStep("submit")}
                >
                  Looks Correct <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* ── STEP 3: SUBMIT ──────────────────────────────────────────────── */}
          {step === "submit" && (
            <form onSubmit={handleFinalSubmit}>
              {/* Template reminder */}
              <div className="mb-8 p-4 bg-background/60 border border-border rounded-sm">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Submitting Template</p>
                <p className="text-sm font-mono text-foreground/80 break-words leading-relaxed">{template}</p>
                <button
                  type="button"
                  className="text-xs text-primary underline mt-2 hover:opacity-80"
                  onClick={() => setStep("preview")}
                >
                  ← Go back to edit
                </button>
              </div>

              {error && (
                <div className="mb-6 p-4 bg-destructive/10 border-l-4 border-destructive text-destructive flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span className="font-bold">{error}</span>
                </div>
              )}

              {serverConflict && (
                <div className="mb-6 space-y-4">
                  <div className="p-4 bg-destructive/10 border-l-4 border-destructive rounded-r-sm">
                    <div className="flex items-start gap-3 mb-3">
                      <Copy className="w-5 h-5 shrink-0 mt-0.5 text-destructive" />
                      <p className="font-bold text-sm text-destructive">
                        Likely duplicate ({serverConflict.confidence}% confidence match)
                      </p>
                    </div>
                    {serverConflict.matchingFactText && (
                      <p className="text-xs italic mb-3 text-muted-foreground">"{serverConflict.matchingFactText}"</p>
                    )}
                    {serverConflict.matchingFactId && (
                      <Link href={`/facts/${serverConflict.matchingFactId}`} className="text-xs text-primary underline">
                        View existing fact →
                      </Link>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <Button type="button" variant="outline" className="flex-1" onClick={() => doSubmit(true)}>
                      Submit Anyway
                    </Button>
                    <Button
                      type="button"
                      className="flex-1"
                      isLoading={submittingReview}
                      onClick={() => void doSubmitForReview(serverConflict)}
                    >
                      Request Admin Review
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-8">
                {/* Hashtags */}
                <div>
                  <label className="block font-display text-xl uppercase text-foreground mb-3">
                    <Sparkles className="w-5 h-5 inline-block mr-2 text-primary" />
                    Hashtags
                  </label>

                  {loadingSuggestions && (
                    <div className="flex items-center gap-2 mb-3 text-muted-foreground text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" /> Generating tag suggestions…
                    </div>
                  )}

                  {suggestedTags.length > 0 && (
                    <div className="mb-3 p-3 bg-background border border-primary/20 rounded-sm">
                      <p className="text-xs text-muted-foreground font-bold uppercase tracking-wide mb-2">AI Suggestions</p>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {suggestedTags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={`px-2 py-0.5 rounded-sm text-xs font-bold border transition-colors ${
                              acceptedTags.has(tag)
                                ? "bg-primary/10 border-primary text-primary"
                                : "border-border text-muted-foreground hover:border-primary/40"
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
                    onChange={(e) => setHashtagsStr(e.target.value)}
                    placeholder="strength, impossible, facts"
                  />
                  <p className="text-sm text-muted-foreground mt-2">Comma separated. No # symbol needed.</p>
                </div>

                {/* CAPTCHA */}
                <div className="pt-4 border-t-2 border-border">
                  <label className="block font-display text-xl uppercase text-foreground mb-4">Security Clearance</label>
                  <div className="bg-background p-4 rounded-sm border-2 border-border inline-block">
                    <HCaptcha sitekey={HCAPTCHA_SITE_KEY} onVerify={setCaptchaToken} />
                  </div>
                </div>

                {/* Submit */}
                <div className="pt-2">
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
          )}
        </div>
      </div>
    </Layout>
  );
}
