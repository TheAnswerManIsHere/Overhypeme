import { useState, useRef, useEffect, useCallback } from "react";
import { Loader2, Zap } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { usePersonName, SHARE_LINK_ACTIVE, DEFAULT_NAME } from "@/hooks/use-person-name";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { Button } from "@/components/ui/Button";
import {
  PRONOUN_PRESETS,
  isCustomPronouns,
  parseCustom,
  displayPronouns,
} from "@/lib/pronouns";

// Pages where the modal should never interrupt the user
const SUPPRESSED_PATHS = ["/login", "/onboard", "/forgot-password", "/reset-password", "/verify-email", "/admin"];

async function fetchSuggestedPronouns(name: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/ai/suggest-pronouns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { subject?: string; object?: string };
    if (typeof data.subject === "string" && typeof data.object === "string") {
      const preset = `${data.subject}/${data.object}`;
      if (PRONOUN_PRESETS.includes(preset as typeof PRONOUN_PRESETS[number])) return preset;
    }
    return null;
  } catch {
    return null;
  }
}

function canSave(draftPronouns: string): boolean {
  if (!isCustomPronouns(draftPronouns)) return true;
  const p = parseCustom(draftPronouns);
  if (!p) return false;
  return !!(p.subj.trim() && p.obj.trim() && p.poss.trim() && p.possPro.trim() && p.refl.trim());
}

function shouldShowModal(): boolean {
  if (SHARE_LINK_ACTIVE) return false;
  try {
    if (localStorage.getItem("fact_db_name_explicit") === "1") return false;
    const storedName = localStorage.getItem("fact_db_name");
    if (storedName && storedName !== DEFAULT_NAME) return false;
  } catch {
    return false;
  }
  return true;
}

export function WelcomeModal() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { name, pronouns, setName, setPronouns } = usePersonName();
  const [location] = useLocation();

  const [open, setOpen] = useState(false);

  const [draftName, setDraftName] = useState(name === DEFAULT_NAME ? "" : name);
  const [draftPronouns, setDraftPronouns] = useState(pronouns);
  const [aiLoading, setAiLoading] = useState(false);

  const userChosenRef      = useRef(false);
  const hasOverriddenRef   = useRef(false);
  const debounceTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const nameInputRef       = useRef<HTMLInputElement>(null);
  // Prevent re-opening after dismiss/save within the same page session
  const hasOpenedRef       = useRef(false);

  // ── Determine whether to open ─────────────────────────────────────────────

  useEffect(() => {
    if (authLoading) return;
    if (isAuthenticated) return;
    if (hasOpenedRef.current) return;
    if (SUPPRESSED_PATHS.some((p) => location.startsWith(p))) return;
    if (!shouldShowModal()) return;
    // Don't re-open if user already skipped this browser session
    try { if (sessionStorage.getItem("welcome_modal_skipped") === "1") return; } catch { /* ignore */ }
    // Small delay so the page content renders first
    const t = setTimeout(() => {
      hasOpenedRef.current = true;
      setOpen(true);
    }, 600);
    return () => clearTimeout(t);
  // Only re-evaluate after auth finishes loading or the path changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAuthenticated, location]);

  // ── AI suggestion ─────────────────────────────────────────────────────────

  const triggerSuggestion = useCallback((nameValue: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!nameValue.trim()) {
      abortControllerRef.current?.abort();
      setAiLoading(false);
      return;
    }
    debounceTimerRef.current = setTimeout(async () => {
      if (userChosenRef.current) return;
      abortControllerRef.current?.abort();
      const ctrl = new AbortController();
      abortControllerRef.current = ctrl;
      setAiLoading(true);
      const suggestion = await fetchSuggestedPronouns(nameValue.trim(), ctrl.signal);
      if (ctrl.signal.aborted) return;
      setAiLoading(false);
      if (suggestion && !userChosenRef.current) setDraftPronouns(suggestion);
    }, 450);
  }, []);

  // Focus input and trigger suggestion when modal opens
  useEffect(() => {
    if (!open) return;
    setTimeout(() => nameInputRef.current?.focus(), 50);
    if (!hasOverriddenRef.current && draftName.trim()) triggerSuggestion(draftName);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setDraftName(val);
    hasOverriddenRef.current = false;
    triggerSuggestion(val);
  }

  function handlePronounsChange(val: string) {
    userChosenRef.current = true;
    hasOverriddenRef.current = true;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setDraftPronouns(val);
  }

  function handleSave() {
    if (!canSave(draftPronouns)) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    const finalName = draftName.trim() || DEFAULT_NAME;
    setName(finalName);
    setPronouns(draftPronouns);
    setOpen(false);
  }

  function handleSkip() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setOpen(false);
    // Mark explicit so the modal doesn't open again this session
    try { sessionStorage.setItem("welcome_modal_skipped", "1"); } catch { /* ignore */ }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && canSave(draftPronouns) && draftName.trim()) handleSave();
    if (e.key === "Escape") handleSkip();
  }

  if (!open) return null;

  const saveEnabled = canSave(draftPronouns) && draftName.trim().length > 0;
  const displayPron = displayPronouns(draftPronouns);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={handleSkip}
      />

      {/* Modal panel */}
      <div className="relative z-10 w-full max-w-md bg-card border-2 border-primary/40 rounded-sm shadow-2xl shadow-primary/20 overflow-hidden">
        {/* Header stripe */}
        <div className="bg-primary/10 border-b border-primary/30 px-6 pt-6 pb-5 text-center">
          <div className="text-4xl mb-3">🥊</div>
          <h2 className="font-display font-bold text-xl text-foreground uppercase tracking-widest mb-1">
            Who Are We Hyping?
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Every fact on this site is written about <em>you</em>. Tell us your name and pronouns so we can personalise them properly.
          </p>
        </div>

        {/* Form body */}
        <div className="px-6 py-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-display font-bold text-muted-foreground uppercase tracking-widest mb-1.5">
              Your Name
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={nameInputRef}
                type="text"
                value={draftName}
                onChange={handleNameChange}
                onKeyDown={handleKeyDown}
                placeholder="e.g. Alex Johnson"
                maxLength={100}
                autoComplete="name"
                className="flex-1 bg-secondary border border-border rounded-sm px-3 py-2 text-sm font-bold text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/60"
              />
              {aiLoading && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              This is the name inserted into every personalised fact.
            </p>
          </div>

          {/* Pronouns */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-xs font-display font-bold text-muted-foreground uppercase tracking-widest">
                Pronouns
              </label>
              {aiLoading && (
                <span className="text-[10px] text-muted-foreground italic">suggesting…</span>
              )}
            </div>
            <PronounEditor value={draftPronouns} onChange={handlePronounsChange} />
          </div>

          {/* Preview */}
          {draftName.trim() && (
            <div className="bg-secondary/50 border border-border/60 rounded-sm px-3 py-2 text-xs text-muted-foreground">
              <span className="text-foreground font-medium">Preview: </span>
              "{draftName.trim()} is so legendary, {displayPron || "…"} broke the internet."
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col gap-2">
          <Button
            variant="primary"
            className="w-full gap-2 font-bold uppercase tracking-wider"
            onClick={handleSave}
            disabled={!saveEnabled}
          >
            <Zap className="w-4 h-4" /> Hype Me!
          </Button>
          <button
            onClick={handleSkip}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 text-center py-1"
          >
            Skip for now — use default name
          </button>
        </div>
      </div>
    </div>
  );
}
