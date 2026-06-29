import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation, Link } from "wouter";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useAuth } from "@workspace/replit-auth-web";
import { validateTemplate } from "@workspace/api-zod";

import { Layout } from "@/components/layout/Layout";
import { AccessGate } from "@/components/AccessGate";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea, Input } from "@/components/ui/Input";
import { renderFact } from "@/lib/render-fact";
import { useToast } from "@/hooks/use-toast";
import { useFormDraft } from "@/hooks/use-form-draft";
import { createLocalStorageAdapter } from "@/lib/form-draft-storage";
import {
  ShieldAlert, AlertTriangle, Sparkles, Loader2,
  CheckCircle2, ChevronRight, ChevronLeft, CheckCheck,
  ChevronDown, ChevronUp, GitBranch, Trash2,
} from "lucide-react";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

type Step = "write" | "preview";

interface SubmitDraft {
  rawText: string;
  template: string;
  hashtagsStr: string;
}

interface DuplicateResult {
  isDuplicate: boolean;
  confidence: number;
  matchingFactId?: number;
  matchingFactText?: string;
  matchingCanonicalText?: string;
  llmChecked?: boolean;
}

const PRONOUN_PREVIEWS: { label: string; subject: string; object: string; name: string }[] = [
  { label: "he/him",    subject: "he",   object: "him",  name: "David Franklin" },
  { label: "she/her",   subject: "she",  object: "her",  name: "Sarah Mitchell" },
  { label: "they/them", subject: "they", object: "them", name: "Alex Jordan"    },
];

export default function SubmitFact() {
  const { isAuthenticated, isLoading: authLoading, role, user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const isLegendary = role === "legendary" || role === "admin";
  const isCaptchaVerified = isLegendary || !!user?.captchaVerified;

  const [step, setStep] = useState<Step>("write");

  const [rawText, setRawText] = useState("");
  const [duplicate, setDuplicate] = useState<DuplicateResult | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);

  const [template, setTemplate] = useState("");
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenizeError, setTokenizeError] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [templateGrammarError, setTemplateGrammarError] = useState<string | null>(null);

  const [hashtagsStr, setHashtagsStr] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [onboardingRequired, setOnboardingRequired] = useState(false);
  const [duplicateThreshold, setDuplicateThreshold] = useState(80);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  // AI hashtag suggestions — a non-blocking pre-fill of the (editable) Hashtags
  // field when we reach the Preview step. Race-safe: a slow/stale response must
  // never clobber what the user typed.
  const [suggestingHashtags, setSuggestingHashtags] = useState(false);
  const suggestReqIdRef = useRef(0);          // latest-request guard
  const hashtagsEditedRef = useRef(false);    // true once the user touches the field

  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<Record<string, unknown>> : Promise.reject())
      .then((cfg) => {
        const t = cfg["review_duplicate_threshold"];
        if (typeof t === "number" && isFinite(t)) setDuplicateThreshold(t);
      })
      .catch(() => {});
  }, []);

  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Draft autosave to localStorage — survives leaving the page (24h TTL).
  const draftAdapter = useMemo(
    () =>
      createLocalStorageAdapter<SubmitDraft>({
        key: "submit_fact_draft",
        isValid: (v): v is SubmitDraft =>
          !!v &&
          typeof v === "object" &&
          typeof (v as SubmitDraft).rawText === "string" &&
          typeof (v as SubmitDraft).template === "string" &&
          typeof (v as SubmitDraft).hashtagsStr === "string",
      }),
    [],
  );

  const draft = useFormDraft<SubmitDraft>({
    value: { rawText, template, hashtagsStr },
    adapter: draftAdapter,
    enabled: !submitted,
    isEmpty: (d) => !d.rawText && !d.template && !d.hashtagsStr,
    onRestore: (d) => {
      if (d.rawText) setRawText(d.rawText);
      if (d.template) { setTemplate(d.template); setStep("preview"); }
      if (d.hashtagsStr) setHashtagsStr(d.hashtagsStr);
      toast({
        title: "Draft restored",
        description: "Your saved draft has been loaded — pick up right where you left off.",
        duration: 4000,
      });
    },
  });

  useEffect(() => {
    if (!template) { setTemplateGrammarError(null); return; }
    const result = validateTemplate(template);
    setTemplateGrammarError(result.valid ? null : (result.error ?? "Invalid template"));
  }, [template]);

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
        setDuplicate(data.confidence > 0 ? data : null);
      }
    } catch { setDuplicate(null); }
    finally { setCheckingDuplicate(false); }
  }, []);

  useEffect(() => {
    if (dupTimer.current) clearTimeout(dupTimer.current);
    if (rawText.length < 20) { setDuplicate(null); return; }
    dupTimer.current = setTimeout(() => { void checkDuplicate(rawText); }, 1200);
    return () => { if (dupTimer.current) clearTimeout(dupTimer.current); };
  }, [rawText, checkDuplicate]);

  async function handleTokenize() {
    if (rawText.length < 10) return;
    if (!captchaToken && !isCaptchaVerified) return;
    setTokenizing(true);
    setTokenizeError("");
    setDuplicate(null);
    const sanitizedText = rawText.replace(/[{}]/g, "");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 35_000);
    try {
      const tokenizeBody: Record<string, unknown> = { text: sanitizedText };
      if (captchaToken) tokenizeBody.captchaToken = captchaToken;
      const r = await fetch("/api/ai/tokenize-fact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(tokenizeBody),
        signal: controller.signal,
      });
      const data = await r.json() as { template?: string; error?: string };
      if (!r.ok || !data.template) {
        setTokenizeError(data.error ?? "Something went wrong — please try again.");
        return;
      }
      setTemplate(data.template);
      setShowAdvanced(false);
      setStep("preview");
      window.scrollTo({ top: 0, behavior: "smooth" });
      void checkDuplicate(data.template);
      void fetchHashtagSuggestions(data.template);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setTokenizeError("The request took too long — please try again.");
      } else {
        setTokenizeError("Network error — please try again.");
      }
    } finally {
      clearTimeout(abortTimer);
      setTokenizing(false);
    }
  }

  // Fetch AI-suggested tags for the generated template and pre-fill the field —
  // but ONLY when the field is still empty and the user hasn't edited it, and
  // only for the most recent request (older responses are ignored). Best-effort:
  // any failure leaves the field empty for manual entry.
  const fetchHashtagSuggestions = useCallback(async (templateText: string) => {
    const myId = ++suggestReqIdRef.current;
    setSuggestingHashtags(true);
    try {
      const r = await fetch("/api/ai/suggest-hashtags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: templateText }),
      });
      if (suggestReqIdRef.current !== myId) return;   // superseded by a newer request
      if (!r.ok) return;
      const data = await r.json() as { hashtags?: string[] };
      if (suggestReqIdRef.current !== myId) return;
      const tags = Array.isArray(data.hashtags) ? data.hashtags : [];
      if (!tags.length || hashtagsEditedRef.current) return;
      // Functional update reads the CURRENT field value — never overwrite content.
      setHashtagsStr((prev) => (prev.trim() ? prev : tags.join(", ")));
    } catch {
      // silent — suggestions are a convenience, never a gate
    } finally {
      if (suggestReqIdRef.current === myId) setSuggestingHashtags(false);
    }
  }, []);

  const getTags = () => {
    const manual = hashtagsStr.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
    return Array.from(new Set(manual));
  };

  async function handleFinalSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setOnboardingRequired(false);
    if (!template || template.length < 5) { setError("No template to submit."); return; }
    if (!captchaToken && !isCaptchaVerified) { setError("Please complete the CAPTCHA."); return; }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        text: template,
        hashtags: getTags(),
      };
      if (duplicate) {
        if (duplicate.matchingFactId) body.matchingFactId = duplicate.matchingFactId;
        if (duplicate.confidence > 0) body.matchingSimilarity = duplicate.confidence;
        body.isDuplicate = duplicate.isDuplicate;
      }
      const r = await fetch("/api/facts/submit-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (r.ok) {
        draft.clear();
        setSubmitted(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        const d = await r.json() as { error?: string; code?: string };
        if (d.code === "ONBOARDING_REQUIRED") {
          setOnboardingRequired(true);
        } else {
          setError(d.error ?? "Failed to submit — please try again.");
        }
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const handleHashtagsChange = (value: string) => {
    hashtagsEditedRef.current = true;   // user has taken over — suppress auto-fill
    setHashtagsStr(value);
  };

  const handleStartOver = () => {
    draft.clear();
    setRawText("");
    setTemplate("");
    setHashtagsStr("");
    hashtagsEditedRef.current = false;   // allow auto-fill again on the next preview
    suggestReqIdRef.current++;           // invalidate any in-flight suggestion
    setSuggestingHashtags(false);
    setDuplicate(null);
    setStep("write");
    setTokenizeError("");
    setError("");
    setOnboardingRequired(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const hasDraftContent = !!(rawText || template || hashtagsStr);

  if (authLoading) {
    return (
      <Layout>
        <div className="flex h-[50vh] items-center justify-center">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </Layout>
    );
  }

  if (!isAuthenticated) {
    return (
      <Layout>
        <AccessGate variant="page" reason="login" returnTo="/submit" description="You must be signed in to submit facts." />
      </Layout>
    );
  }

  if (submitted) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <CheckCircle2 className="w-24 h-24 text-green-500 mx-auto mb-6" />
          <h1 className="text-5xl font-display uppercase mb-4 text-foreground">You're Done!</h1>
          <p className="text-muted-foreground text-xl mb-2">
            Your fact is in the queue for review.
          </p>
          <p className="text-muted-foreground mb-8">
            Check your{" "}
            <Link href="/activity" className="text-primary underline hover:opacity-80">
              activity feed
            </Link>{" "}
            to see when it goes live.
          </p>
          {(duplicate && duplicate.confidence >= duplicateThreshold) && (
            <div className="mb-8 p-4 bg-amber-500/10 border border-amber-500/30 rounded-sm text-amber-600 dark:text-amber-400">
              <GitBranch className="w-4 h-4 inline mr-1.5" />
              Your fact was flagged as similar to an existing one. The moderator will decide how to handle it.
            </div>
          )}
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => {
              draft.clear();
              setRawText(""); setTemplate(""); setSubmitted(false);
              setDuplicate(null); setHashtagsStr(""); setStep("write");
              setOnboardingRequired(false); setError("");
            }}>
              Submit Another
            </Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/activity")}>
              View Activity Feed
            </Button>
          </div>
        </div>
      </Layout>
    );
  }

  const steps: { id: Step; label: string }[] = [
    { id: "write",   label: "Write" },
    { id: "preview", label: "Preview & Submit" },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-4 py-12 md:py-16">

        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-4xl md:text-5xl font-display uppercase tracking-wider text-foreground mb-3">
            Submit a Fact
          </h1>
          <p className="text-muted-foreground text-lg">
            Write it about anyone. We'll make it work for everyone.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center mb-4">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <div className={`flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold tracking-wide transition-all ${
                step === s.id
                  ? "bg-primary text-primary-foreground"
                  : stepIndex > i
                  ? "text-green-500"
                  : "text-muted-foreground"
              }`}>
                {stepIndex > i
                  ? <CheckCheck className="w-4 h-4" />
                  : <span className="w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs
                      border-current">{i + 1}</span>
                }
                {s.label}
              </div>
              {i < steps.length - 1 && (
                <div className={`w-10 h-px mx-1 ${stepIndex > i ? "bg-green-500/40" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Discard / start-over link — only shown when there is content to discard */}
        <div className="flex justify-center mb-6 h-5">
          {hasDraftContent && (
            <button
              type="button"
              onClick={() => setShowDiscardDialog(true)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-destructive transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Discard and start over
            </button>
          )}
        </div>

        {/* Discard confirmation dialog */}
        <Dialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-destructive" />
                Discard and start over?
              </DialogTitle>
              <DialogDescription>
                This will clear everything you've written. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setShowDiscardDialog(false)}
              >
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setShowDiscardDialog(false);
                  handleStartOver();
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-primary to-primary/40" />

          {/* ── STEP 1: WRITE ─────────────────────────────────────────────────── */}
          {step === "write" && (
            <div className="p-6 md:p-10 space-y-8">

              {/* Captcha gate */}
              {!isCaptchaVerified && (
                <div className={`rounded-lg p-5 border-2 ${captchaToken ? "border-green-500/30 bg-green-500/5" : "border-border bg-background/50"}`}>
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-lg font-bold text-foreground">
                      {captchaToken ? "✓ Verified" : "Quick Verification"}
                    </span>
                    {captchaToken && (
                      <span className="text-xs font-bold uppercase tracking-wider text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
                        Ready
                      </span>
                    )}
                  </div>
                  {captchaToken ? (
                    <p className="text-muted-foreground">You're verified — write your fact below.</p>
                  ) : (
                    <>
                      <p className="text-muted-foreground mb-4">Complete this once to unlock submission.</p>
                      <div className="bg-background rounded-lg border border-border inline-block p-3">
                        <HCaptcha sitekey={HCAPTCHA_SITE_KEY} onVerify={setCaptchaToken} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Fact input */}
              <div>
                <label className="block text-xl font-bold text-foreground mb-2">
                  Write your fact
                </label>
                <p className="text-muted-foreground mb-4">
                  Use any real name. Our AI will convert it into a universal template that works for any person.
                </p>
                <Textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder={
                    !captchaToken && !isCaptchaVerified
                      ? "Complete verification above to start writing…"
                      : 'e.g. "When John does pushups, he doesn\'t push himself up — he pushes the Earth down."'
                  }
                  className={`text-lg min-h-[180px] leading-relaxed transition-opacity ${
                    !captchaToken && !isCaptchaVerified ? "opacity-40 cursor-not-allowed" : ""
                  }`}
                  disabled={!captchaToken && !isCaptchaVerified}
                />
                {draft.savedAt !== null && (
                  <p className="mt-2 text-xs text-muted-foreground/60 flex items-center gap-1.5 animate-in fade-in duration-300">
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    {draft.savedLabel}
                  </p>
                )}
              </div>

              {tokenizeError && (
                <div className="p-4 bg-destructive/10 border border-destructive/30 text-destructive flex items-center gap-3 rounded-lg">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span>{tokenizeError}</span>
                </div>
              )}

              <Button
                size="lg"
                className="w-full h-14 text-lg font-bold"
                disabled={rawText.length < 10 || tokenizing || (!captchaToken && !isCaptchaVerified)}
                onClick={() => void handleTokenize()}
              >
                {tokenizing
                  ? <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Converting…</>
                  : <><Sparkles className="w-5 h-5 mr-2" /> Preview <ChevronRight className="w-5 h-5 ml-1" /></>
                }
              </Button>
            </div>
          )}

          {/* ── STEP 2: PREVIEW & SUBMIT ──────────────────────────────────────── */}
          {step === "preview" && (
            <form onSubmit={(e) => void handleFinalSubmit(e)}>
            <div className="p-6 md:p-10 space-y-8">

              {/* Intro */}
              <div>
                <h2 className="text-2xl font-bold text-foreground mb-2">Does this look right?</h2>
                <p className="text-muted-foreground text-lg leading-relaxed">
                  The system automatically adjusts grammar so the fact sounds natural for any person —
                  regardless of their name or pronouns. Review the three examples below and make sure they all read correctly.
                </p>
              </div>

              {/* Checking indicator */}
              {checkingDuplicate && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Checking database for similar facts…
                </div>
              )}

              {/* Duplicate warning — only shown if confidence meets the admin threshold */}
              {!checkingDuplicate && duplicate && duplicate.confidence >= duplicateThreshold && (
                <div className="rounded-xl border-2 border-amber-500/40 bg-amber-500/5 p-6">
                  <p className="text-lg font-semibold text-amber-600 dark:text-amber-400 mb-4">
                    Your fact is very similar to another fact already in the database:
                  </p>
                  <div className="bg-background rounded-lg border border-border px-5 py-4 mb-4">
                    <p className="text-xl font-bold text-foreground leading-snug">
                      "{duplicate.matchingCanonicalText ?? duplicate.matchingFactText}"
                    </p>
                    {duplicate.matchingFactId && (
                      <a
                        href={`/facts/${duplicate.matchingFactId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary underline mt-3 block hover:opacity-80"
                      >
                        View this fact →
                      </a>
                    )}
                  </div>
                  <p className="text-muted-foreground">
                    You may continue to submit this fact and the moderator will decide how to handle it,
                    or just{" "}
                    <button
                      type="button"
                      onClick={() => setStep("write")}
                      className="text-foreground font-semibold underline underline-offset-2 hover:text-primary"
                    >
                      give up now
                    </button>
                    {" "}and avoid wasting everyone's time.
                  </p>
                </div>
              )}

              {/* Three pronoun examples — the main UI */}
              <div className="space-y-4">
                {PRONOUN_PREVIEWS.map((p) => (
                  <div key={p.label} className="rounded-lg border border-border bg-background/60 p-5">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-xs font-bold text-primary uppercase tracking-wider bg-primary/10 px-3 py-1 rounded-full">
                        {p.label}
                      </span>
                      <span className="text-sm text-muted-foreground">{p.name}</span>
                    </div>
                    <p className="text-xl font-medium text-foreground leading-snug">
                      "{renderFact(template, p.name, p.label)}"
                    </p>
                  </div>
                ))}
              </div>

              {/* Advanced — collapsible template editor */}
              <div className="border border-border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                >
                  <span>Advanced — view & edit template</span>
                  {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {showAdvanced && (
                  <div className="border-t border-border p-5 space-y-4">
                    <div>
                      <label className="block text-sm font-semibold text-muted-foreground mb-2">
                        Template — edit to fix any AI mistakes
                      </label>
                      <Textarea
                        value={template}
                        onChange={(e) => setTemplate(e.target.value)}
                        className={`font-mono text-sm min-h-[100px] bg-background/50 ${templateGrammarError ? "border-destructive" : ""}`}
                      />
                      {templateGrammarError && (
                        <div className="mt-2 flex items-start gap-2 text-destructive text-sm">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{templateGrammarError}</span>
                        </div>
                      )}
                    </div>
                    <div className="p-3 bg-muted/30 rounded-lg text-xs text-muted-foreground space-y-1.5">
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
                        <span className="font-bold text-foreground/70">Verb forms:</span>{" "}
                        <code className="text-primary">{"{does|do}"}</code>{" "}
                        <code className="text-primary">{"{doesn't|don't}"}</code>{" "}
                        <code className="text-primary">{"{was|were}"}</code>{" "}
                        — left for he/she, right for they
                      </p>
                      <p>
                        <span className="font-bold text-foreground/70">Capitalize:</span>{" "}
                        <code className="text-primary">{"{Subj}"}</code> → He / She / They
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Hashtags */}
              <div>
                <label className="block text-xl font-bold text-foreground mb-1">
                  Hashtags
                </label>
                <p className="text-muted-foreground mb-4">
                  We suggest a few automatically to help people find your fact —
                  edit, add, or remove freely. Comma-separated, optional.
                </p>
                <Input
                  value={hashtagsStr}
                  onChange={(e) => handleHashtagsChange(e.target.value)}
                  placeholder="e.g. strength, legendary, coffee"
                  className="text-base"
                />
                {suggestingHashtags && (
                  <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5 animate-in fade-in duration-300">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    Suggesting tags…
                  </p>
                )}
              </div>

              {onboardingRequired && (
                <div className="p-5 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-4">
                  <ShieldAlert className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-foreground mb-1">Onboarding required</p>
                    <p className="text-muted-foreground text-sm mb-3">
                      You need to complete a quick one-time setup before submitting facts.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        // Flush the latest draft before navigating; restore (which
                        // no longer clears) brings it back when the user returns.
                        void draft.saveNow().finally(() => {
                          setLocation("/onboard?returnTo=/submit");
                        });
                      }}
                      className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-600 dark:text-amber-400 underline hover:opacity-80"
                    >
                      Complete onboarding <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/30 text-destructive flex items-center gap-3 rounded-lg">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span className="font-semibold">{error}</span>
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="flex-1"
                  onClick={() => { setStep("write"); setTokenizeError(""); setDuplicate(null); setOnboardingRequired(false); setError(""); }}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" /> Edit
                </Button>
                <Button
                  type="submit"
                  size="lg"
                  className="flex-1 text-lg font-bold"
                  disabled={!template.trim() || !!templateGrammarError || submitting}
                >
                  {submitting
                    ? <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Submitting…</>
                    : <><CheckCircle2 className="w-5 h-5 mr-2" /> Looks Great — Submit</>
                  }
                </Button>
              </div>

              {/* Moderation notice */}
              <div className="pt-4 border-t border-border">
                <p className="text-sm text-muted-foreground text-center">
                  All submissions go through a quick review before going live.
                  You'll be notified in your{" "}
                  <Link href="/activity" className="text-primary underline hover:opacity-80">
                    activity feed
                  </Link>{" "}
                  once it's approved or declined.
                  {duplicate && duplicate.confidence >= duplicateThreshold && (
                    <span className="block mt-2 text-amber-600 dark:text-amber-400">
                      <GitBranch className="w-3.5 h-3.5 inline mr-1" />
                      Flagged as similar to an existing fact ({duplicate.confidence}% match) — the moderator will decide.
                    </span>
                  )}
                </p>
              </div>

            </div>
            </form>
          )}
        </div>
      </div>
    </Layout>
  );
}
