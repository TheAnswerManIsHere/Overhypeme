/**
 * @purpose The identity sheet (#719): the one place a visitor is asked for their name and pronouns, mounted once at route level; it opens and closes on the identity module's decision, pre-fills whatever half is known, and suggests pronouns from the name in the browser only.
 * @subsystem public-site
 */
import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { usePersonName } from "@/hooks/use-person-name";
import { useIdentityGate } from "@/hooks/use-identity-gate";
import { inferPronounsFromName } from "@/lib/infer-pronouns";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { DEFAULT_PRONOUNS, isCustomPronouns, parseCustom } from "@/lib/pronouns";
import { HighlightedFactText } from "@/components/facts/HighlightedFactText";
import { teaserFor } from "@/components/welcomeTeaser";

/** Pronouns are saved only once the visitor can see them: a suggestion shown, or their own pick. Never the fallback. */
function canSave(draftPronouns: string): boolean {
  if (!draftPronouns.trim()) return false;
  if (!isCustomPronouns(draftPronouns)) return true;
  const p = parseCustom(draftPronouns);
  if (!p) return false;
  return !!(p.subj.trim() && p.obj.trim() && p.poss.trim() && p.possPro.trim() && p.refl.trim());
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The controls a keyboard can reach inside `root`, in tab order, visible ones only. */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

function FlameMark() {
  return (
    <svg width="13" height="16" viewBox="0 0 16 20" fill="none">
      <path d="M8 1c1 4 5 5 5 10s-2.5 8-5 8-5-3-5-8c0-4 2-5 3-7 0 2 1 3 2 3z" fill="currentColor" />
    </svg>
  );
}

export function WelcomeModal() {
  const { name, pronouns, pronounsSupplied, setName, setPronouns } = usePersonName();
  const { shouldAsk } = useIdentityGate();

  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(name || "");
  const [draftPronouns, setDraftPronouns] = useState(pronouns);
  const [pronounsExpanded, setPronounsExpanded] = useState(false);
  const userChosenRef = useRef(false);
  const nameTouchedRef = useRef(false);
  // The provider's latest values, so a sheet that opens after a delay, or is
  // already open, starts from what is stored now rather than from the render
  // that scheduled it (another tab can change either half meanwhile).
  const latestRef = useRef({ name, pronouns, pronounsSupplied });
  latestRef.current = { name, pronouns, pronounsSupplied };
  // One root per responsive layout; only the visible one takes focus.
  const mobileRootRef  = useRef<HTMLDivElement>(null);
  const desktopRootRef = useRef<HTMLDivElement>(null);
  // The half that was already known when the sheet opened; only the rest is asked.
  const [knownName, setKnownName] = useState(false);

  // Open shortly after the decision turns true; close as soon as it turns
  // false, whatever made it false (another tab's save, a suppressed page).
  useEffect(() => {
    if (!shouldAsk) {
      setOpen(false);
      return;
    }
    if (open) return;
    const t = setTimeout(() => {
      const { name, pronouns, pronounsSupplied } = latestRef.current;
      setKnownName(!!name.trim());
      setDraftName(name || "");
      nameTouchedRef.current = false;
      userChosenRef.current = pronounsSupplied;
      setDraftPronouns(pronounsSupplied ? pronouns : (inferPronounsFromName(name) ?? ""));
      // Always shown, so whatever is saved is a value the visitor saw.
      setPronounsExpanded(true);
      setOpen(true);
    }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAsk]);

  // While open, a half another tab stores fills any field the visitor has not
  // touched here, so saving never writes this sheet's stale draft over it.
  useEffect(() => {
    if (!open) return;
    if (name.trim() && !nameTouchedRef.current) {
      setKnownName(true);
      setDraftName(name);
      if (!userChosenRef.current) setDraftPronouns(inferPronounsFromName(name) ?? "");
    }
    if (pronounsSupplied && !userChosenRef.current) {
      userChosenRef.current = true;
      setDraftPronouns(pronouns);
    }
  }, [open, name, pronouns, pronounsSupplied]);

  // The sheet is a gate: focus moves into the visible layout when it opens
  // (the name field, or the pronoun choices when the name is known) and Tab
  // and Shift+Tab stay inside it until it closes (#723).
  useEffect(() => {
    if (!open) return;
    const visibleRoot = () =>
      [mobileRootRef.current, desktopRootRef.current].find((el) => el && el.getClientRects().length > 0) ?? null;
    const t = setTimeout(() => {
      const root = visibleRoot();
      const target = knownName
        ? root?.querySelector<HTMLElement>("[data-identity-pronouns] button")
        : root?.querySelector<HTMLElement>('[data-testid="identity-name-input"]');
      target?.focus();
    }, 100);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const root = visibleRoot();
      if (!root) return;
      const focusable = focusableIn(root);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, knownName]);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    nameTouchedRef.current = true;
    setDraftName(val);
    // Suggest pronouns from the name, locally, until the visitor picks; no
    // confident suggestion leaves the choice open rather than defaulting.
    if (!userChosenRef.current) setDraftPronouns(inferPronounsFromName(val) ?? "");
  }

  function handlePronounsChange(val: string) {
    userChosenRef.current = true;
    setDraftPronouns(val);
  }

  function handleSave() {
    if (!canSave(draftPronouns)) return;
    const finalName = draftName.trim();
    if (!finalName) return; // disabled state should prevent this, but be defensive
    setName(finalName);
    setPronouns(draftPronouns);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && canSave(draftPronouns) && draftName.trim()) handleSave();
  }

  const prefersReducedMotion = useReducedMotion();

  if (!open) return null;

  const saveEnabled = canSave(draftPronouns) && draftName.trim().length > 0;
  const teaser = teaserFor(draftName);
  const displayName = teaser.name;

  const nameForm = (
    <>
      <h2 className="font-display font-bold text-2xl md:text-[36px] uppercase tracking-tight leading-tight mb-1 md:mb-2">
        {knownName
          ? <>Pick <span className="text-primary">your</span> pronouns</>
          : <>What's <span className="text-primary">your</span> name?</>}
      </h2>
      <p className="text-[13px] md:text-[15px] text-muted-foreground mb-5 md:mb-7 leading-relaxed">
        {knownName
          ? "One more thing, so every fact reads right about you."
          : "Type your name and every fact in the database becomes about you."}
      </p>

      <div className="relative mb-3">
        <input
          type="text"
          value={draftName}
          onChange={handleNameChange}
          onKeyDown={handleKeyDown}
          placeholder="First name"
          data-testid="identity-name-input"
          maxLength={100}
          autoComplete="given-name"
          className="w-full h-[52px] md:h-[56px] px-4 bg-secondary border border-border rounded-[14px] text-[17px] md:text-[18px] font-medium text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
        />
      </div>

      <button
        type="button"
        onClick={() => setPronounsExpanded(v => !v)}
        className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors mb-3 font-medium"
      >
        {pronounsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        Customize pronouns
      </button>

      <AnimatePresence>
        {/* Never hidden while nothing is chosen, so a disabled Save always has its reason in view. */}
        {(pronounsExpanded || !draftPronouns) && (
          <motion.div
            data-identity-pronouns
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
        data-testid="identity-save"
        className="w-full h-[52px] md:h-[56px] bg-primary text-white rounded-[14px] font-display font-bold text-[15px] uppercase tracking-[0.12em] flex items-center justify-center gap-2 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <FlameMark /> Hype me
      </button>

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
        <HighlightedFactText template={teaser.template} name={displayName} pronouns={draftPronouns || DEFAULT_PRONOUNS} />
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
      {/* The sheet cannot be dismissed, so it scrolls when taller than the
          screen (short phones, the keyboard up, custom pronouns open); the
          inner min-h-full wrapper keeps it bottom-anchored when it fits, and
          the backdrop is fixed so it never scrolls away. */}
      <div ref={mobileRootRef} role="dialog" aria-modal="true" aria-label="Your name and pronouns" className="md:hidden fixed inset-0 z-[100] overflow-y-auto overscroll-contain" data-testid="identity-sheet">
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm" />

        <div className="relative min-h-full flex flex-col justify-end">
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
            {!knownName && <p className="text-[13px] text-muted-foreground mb-5">Add your name. Every fact becomes about you.</p>}
            {nameForm}
            <div style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 2rem)" }} />
          </div>
        </motion.div>
        </div>
      </div>

      {/* ── Desktop: two-column overlay ────────────────────── */}
      <div ref={desktopRootRef} role="dialog" aria-modal="true" aria-label="Your name and pronouns" className="hidden md:block fixed inset-0 z-[100] overflow-y-auto overscroll-contain" data-testid="identity-sheet">
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" />

        <div className="relative min-h-full flex p-6">
        <div className="relative z-10 w-full m-auto max-w-[1100px] grid grid-cols-[1.4fr_1fr] shadow-[0_40px_100px_rgba(0,0,0,0.7)] rounded-[28px] overflow-hidden">
          {/* Billboard L */}
          <div className="bg-background px-20 py-24 flex flex-col justify-center">
            {billboard}
          </div>

          {/* Sign-up card R */}
          <div className="bg-secondary border-l border-border px-16 py-24 flex flex-col justify-center">
            <div className="text-[12px] font-bold tracking-[0.22em] text-primary uppercase font-display mb-3">Your turn</div>
            {nameForm}
          </div>
        </div>
        </div>
      </div>
    </>
  );
}
