import { useState, useRef, useEffect, useCallback } from "react";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { usePersonName, SHARE_LINK_ACTIVE } from "@/hooks/use-person-name";
import { PronounEditor } from "@/components/ui/PronounEditor";
import {
  PRONOUN_PRESETS,
  isCustomPronouns,
  parseCustom,
} from "@/lib/pronouns";
import { renderFact } from "@/lib/render-fact";

const TEASER_FACT = "The universe doesn't expand. {NAME} pushes it.";

// Home now has an inline name input baked into the cold-visitor hero, so the
// auto-popping bottom-sheet would just duplicate that interaction.  We also
// suppress on auth/admin paths where it has always been intrusive.
const SUPPRESSED_PATHS = ["/", "/login", "/onboard", "/forgot-password", "/reset-password", "/verify-email", "/admin"];

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
    if (storedName) return false;
  } catch {
    return false;
  }
  return true;
}

function FlameMark() {
  return (
    <svg width="13" height="16" viewBox="0 0 16 20" fill="none">
      <path d="M8 1c1 4 5 5 5 10s-2.5 8-5 8-5-3-5-8c0-4 2-5 3-7 0 2 1 3 2 3z" fill="currentColor" />
    </svg>
  );
}

export function WelcomeModal() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { name, pronouns, setName, setPronouns } = usePersonName();
  const [location] = useLocation();

  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(name || "");
  const [draftPronouns, setDraftPronouns] = useState(pronouns);
  const [aiLoading, setAiLoading] = useState(false);
  const [pronounsExpanded, setPronounsExpanded] = useState(false);

  const userChosenRef      = useRef(false);
  const hasOverriddenRef   = useRef(false);
  const debounceTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const nameInputRef       = useRef<HTMLInputElement>(null);
  const hasOpenedRef       = useRef(false);

  useEffect(() => {
    if (authLoading) return;
    if (isAuthenticated) return;
    if (hasOpenedRef.current) return;
    if (SUPPRESSED_PATHS.some((p) => location.startsWith(p))) return;
    if (!shouldShowModal()) return;
    try {
      if (sessionStorage.getItem("welcome_modal_skipped") === "1") return;
      if (sessionStorage.getItem("welcome_modal_opened") === "1") return;
    } catch { /* ignore */ }
    const t = setTimeout(() => {
      hasOpenedRef.current = true;
      try { sessionStorage.setItem("welcome_modal_opened", "1"); } catch { /* ignore */ }
      setOpen(true);
    }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAuthenticated, location]);

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

  useEffect(() => {
    if (!open) return;
    setTimeout(() => nameInputRef.current?.focus(), 100);
    if (!hasOverriddenRef.current && draftName.trim()) triggerSuggestion(draftName);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
  }, []);

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
    const finalName = draftName.trim();
    if (!finalName) return; // disabled state should prevent this, but be defensive
    setName(finalName);
    setPronouns(draftPronouns);
    setOpen(false);
  }

  function handleSkip() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setOpen(false);
    try { sessionStorage.setItem("welcome_modal_skipped", "1"); } catch { /* ignore */ }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && canSave(draftPronouns) && draftName.trim()) handleSave();
    if (e.key === "Escape") handleSkip();
  }

  const prefersReducedMotion = useReducedMotion();

  if (!open) return null;

  const saveEnabled = canSave(draftPronouns) && draftName.trim().length > 0;
  const displayName = draftName.trim() || "You";
  const teaserRendered = renderFact(TEASER_FACT, displayName, draftPronouns);
  const teaserParts = teaserRendered.split(displayName);

  const nameForm = (
    <>
      <h2 className="font-display font-bold text-2xl md:text-[36px] uppercase tracking-tight leading-tight mb-1 md:mb-2">
        What's <span className="text-primary">your</span> name?
      </h2>
      <p className="text-[13px] md:text-[15px] text-muted-foreground mb-5 md:mb-7 leading-relaxed">
        Type your name and every fact in the database becomes about you.
      </p>

      <div className="relative mb-3">
        <input
          ref={nameInputRef}
          type="text"
          value={draftName}
          onChange={handleNameChange}
          onKeyDown={handleKeyDown}
          placeholder="First name"
          maxLength={100}
          autoComplete="given-name"
          className="w-full h-[52px] md:h-[56px] px-4 bg-secondary border border-border rounded-[14px] text-[17px] md:text-[18px] font-medium text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
        />
        {aiLoading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setPronounsExpanded(v => !v)}
        className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors mb-3 font-medium"
      >
        {pronounsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        Customize pronouns
        {aiLoading && !pronounsExpanded && <span className="text-[10px] italic ml-1">detecting…</span>}
      </button>

      <AnimatePresence>
        {pronounsExpanded && (
          <motion.div
            initial={{ height: prefersReducedMotion ? "auto" : 0, opacity: prefersReducedMotion ? 1 : 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: prefersReducedMotion ? "auto" : 0, opacity: prefersReducedMotion ? 1 : 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
            className="overflow-hidden mb-3"
          >
            <PronounEditor value={draftPronouns} onChange={handlePronounsChange} />
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={handleSave}
        disabled={!saveEnabled}
        className="w-full h-[52px] md:h-[56px] bg-primary text-white rounded-[14px] font-display font-bold text-[15px] uppercase tracking-[0.12em] flex items-center justify-center gap-2 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <FlameMark /> Hype me
      </button>

      <div className="text-center mt-3.5 text-[11px] md:text-[12px] text-muted-foreground">
        Stored on this device · No account required ·{" "}
        <button onClick={handleSkip} className="underline underline-offset-2 hover:text-foreground transition-colors">
          skip
        </button>
      </div>
    </>
  );

  const billboard = (
    <>
      <div className="flex items-center gap-2 mb-3 text-[11px] font-bold tracking-[0.18em] text-muted-foreground uppercase font-display">
        <span className="w-5 h-px bg-muted-foreground/40" />
        ABOUT {displayName.toUpperCase()}
        <span className="w-5 h-px bg-muted-foreground/40" />
      </div>
      <h1 className="font-display font-bold text-4xl md:text-[88px] uppercase tracking-tight leading-[1.0] md:leading-[0.95] text-foreground" style={{ textWrap: "pretty" } as React.CSSProperties}>
        {teaserParts.map((p, i) =>
          i < teaserParts.length - 1
            ? <span key={i}>{p}<span className="text-primary">{displayName}</span></span>
            : <span key={i}>{p}</span>
        )}
      </h1>
      <p className="mt-4 text-sm md:text-base text-muted-foreground italic flex items-center gap-3">
        <span className="hidden md:inline-block w-9 h-px bg-border flex-shrink-0" />
        Enough about {draftName.trim() || "them"}.
      </p>
    </>
  );

  return (
    <>
      {/* ── Mobile: bottom sheet ───────────────────────────── */}
      <div className="md:hidden fixed inset-0 z-[100] flex flex-col justify-end">
        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={handleSkip} />

        <div className="relative z-10 px-6 pb-0" style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 2rem)" }}>
          {billboard}
        </div>

        <motion.div
          initial={prefersReducedMotion ? false : { y: "100%" }}
          animate={prefersReducedMotion ? {} : { y: 0 }}
          exit={prefersReducedMotion ? {} : { y: "100%" }}
          transition={prefersReducedMotion ? { duration: 0 } : { type: "spring", damping: 30, stiffness: 300 }}
          className="relative z-10 w-full bg-card rounded-t-[24px] shadow-[0_-20px_40px_rgba(0,0,0,0.5)] mt-6"
        >
          <div className="flex justify-center pt-3">
            <div className="w-9 h-1 rounded-full bg-border" />
          </div>
          <div className="px-6 pt-4">
            <h2 className="font-display font-bold text-2xl uppercase tracking-tight leading-tight mb-1">Your turn.</h2>
            <p className="text-[13px] text-muted-foreground mb-5">Add your name. Every fact becomes about you.</p>
            {nameForm}
            <div style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 2rem)" }} />
          </div>
        </motion.div>
      </div>

      {/* ── Desktop: two-column overlay ────────────────────── */}
      <div className="hidden md:flex fixed inset-0 z-[100]">
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleSkip} />

        <div className="relative z-10 w-full m-auto max-w-[1100px] grid grid-cols-[1.4fr_1fr] shadow-[0_40px_100px_rgba(0,0,0,0.7)] rounded-[28px] overflow-hidden">
          {/* Billboard L */}
          <div className="bg-background px-20 py-24 flex flex-col justify-center">
            {billboard}

            {/* Stats row */}
            <div className="flex items-center gap-8 mt-12">
              <div>
                <div className="font-display font-bold text-2xl">4,832</div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-[0.1em] font-display mt-1">Facts in database</div>
              </div>
              <div className="w-px h-9 bg-border" />
              <div>
                <div className="font-display font-bold text-2xl">192k</div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-[0.1em] font-display mt-1">Memes made</div>
              </div>
            </div>
          </div>

          {/* Sign-up card R */}
          <div className="bg-secondary border-l border-border px-16 py-24 flex flex-col justify-center">
            <div className="text-[12px] font-bold tracking-[0.22em] text-primary uppercase font-display mb-3">Your turn</div>
            {nameForm}
          </div>
        </div>
      </div>
    </>
  );
}
