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

const TEASER_FACT = "The universe doesn't expand. {NAME} pushes it.";

function canSave(draftPronouns: string): boolean {
  if (!isCustomPronouns(draftPronouns)) return true;
  const p = parseCustom(draftPronouns);
  if (!p) return false;
  return !!(p.subj.trim() && p.obj.trim() && p.poss.trim() && p.possPro.trim() && p.refl.trim());
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
  const nameInputRef  = useRef<HTMLInputElement>(null);
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
      const hasName = !!name.trim();
      setKnownName(hasName);
      setDraftName(name || "");
      userChosenRef.current = pronounsSupplied;
      setDraftPronouns(pronounsSupplied ? pronouns : (inferPronounsFromName(name) ?? DEFAULT_PRONOUNS));
      setPronounsExpanded(hasName);
      setOpen(true);
    }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAsk]);

  useEffect(() => {
    if (!open || knownName) return;
    const t = setTimeout(() => nameInputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, [open, knownName]);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setDraftName(val);
    // Suggest pronouns from the name, locally, until the visitor picks.
    if (!userChosenRef.current) setDraftPronouns(inferPronounsFromName(val) ?? DEFAULT_PRONOUNS);
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
  const displayName = draftName.trim() || "You";

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
          ref={nameInputRef}
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
        <HighlightedFactText template={TEASER_FACT} name={displayName} pronouns={draftPronouns} />
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
      <div className="md:hidden fixed inset-0 z-[100] flex flex-col justify-end" data-testid="identity-sheet">
        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />

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
      <div className="hidden md:flex fixed inset-0 z-[100]" data-testid="identity-sheet">
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

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
