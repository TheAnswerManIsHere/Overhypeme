import { useListFacts, useListHashtags, getListHashtagsQueryKey, type FactSummary } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { Layout } from "@/components/layout/Layout";
import { ChevronDown, ChevronUp, Flame, ThumbsUp, ThumbsDown, MessageSquare, Loader2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { usePersonName, SHARE_LINK_ACTIVE, DEFAULT_PRONOUNS } from "@/hooks/use-person-name";
import { useHeroFact } from "@/hooks/use-hero-fact";
import { cn } from "@/components/ui/Button";
import { renderFact } from "@/lib/render-fact";
import { inferPronounsFromName } from "@/lib/infer-pronouns";
import { PRONOUN_PRESETS, isCustomPronouns, parseCustom, serializeCustom, EMPTY_CUSTOM, type CustomPronounSet } from "@/lib/pronouns";

type FilterMode = "default" | "hall-of-fame" | "hashtags";

// Placeholder fact used in the cold-visitor hero before they've typed a name.
const COLD_TEASER_FACT = "The universe doesn't expand. {NAME} pushes it.";

// Sample name shown in the cold-visitor hero so visitors immediately see
// the personalisation — the name renders in orange just like their own will.
const DEMO_NAME = "David Franklin";
const COLD_DEMO_RENDERED = renderFact(COLD_TEASER_FACT, DEMO_NAME, DEFAULT_PRONOUNS);

function HashtagRail({
  hashtags,
  selectedTags,
  onToggle,
  onForYou,
  isForYou,
}: {
  hashtags: { name: string }[];
  selectedTags: string[];
  onToggle: (t: string) => void;
  onForYou: () => void;
  isForYou: boolean;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-3 no-scrollbar">
      <button
        onClick={onForYou}
        className={cn(
          "flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors",
          isForYou
            ? "bg-foreground text-background"
            : "bg-card border border-border text-foreground hover:border-primary/50"
        )}
      >
        {isForYou && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
        For you
      </button>
      {hashtags.map(tag => {
        const active = selectedTags.includes(tag.name);
        return (
          <button
            key={tag.name}
            onClick={() => onToggle(tag.name)}
            className={cn(
              "flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors",
              active
                ? "bg-foreground text-background"
                : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
            )}
          >
            #{tag.name}
          </button>
        );
      })}
    </div>
  );
}

function HeroHeadline({ rendered, name }: { rendered: string; name: string }) {
  if (!name) {
    return <>{rendered}</>;
  }
  const parts = rendered.split(name);
  return (
    <>
      {parts.map((p, i) =>
        i < parts.length - 1
          ? <span key={i}>{p}<span className="text-primary">{name}</span></span>
          : <span key={i}>{p}</span>
      )}
    </>
  );
}

// Mobile billboard — bold hero showcase with full interaction.
function HeroBillboardMobile({
  fact,
  rendered,
  name,
  onShuffle,
  isShuffling,
}: {
  fact: FactSummary | null;
  rendered: string;
  name: string;
  onShuffle: () => void;
  isShuffling: boolean;
}) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const swapKey = fact ? `f-${fact.id}` : "loading";
  const prefersReducedMotion = useReducedMotion();

  const handleRate = (type: "up" | "down") => {
    if (!fact) return;
    if (!isAuthenticated) { setLocation(`/login?from=/facts/${fact.id}`); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  const handleShare = async () => {
    if (!fact) return;
    const url = `${window.location.origin}/facts/${fact.id}`;
    if (navigator.share) {
      await navigator.share({ url }).catch(() => null);
    } else {
      await navigator.clipboard.writeText(url).catch(() => null);
    }
  };

  return (
    <div className="px-4 pb-4">
      <div
        className="rounded-[24px] relative overflow-hidden border border-primary/25"
        style={{ background: "linear-gradient(145deg, hsl(var(--card)) 0%, rgba(249,115,22,0.07) 100%)", boxShadow: "0 0 40px rgba(249,115,22,0.12), inset 0 1px 0 rgba(255,255,255,0.07)" }}
      >
        {/* Badge */}
        <div className="px-5 pt-5 flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.22em] text-primary uppercase font-display">
            <Flame className="w-3 h-3" /> Random Fact
          </span>
        </div>

        {/* Fact text — large and punchy */}
        <div className="px-5 pt-4 pb-4 min-h-[9rem]">
          <AnimatePresence mode="wait" initial={false}>
            {fact ? (
              <motion.h2
                key={swapKey}
                initial={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : -8 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
                className="font-display font-bold uppercase tracking-tight leading-[0.95] text-foreground"
                style={{ fontSize: "clamp(30px, 8.5vw, 40px)" }}
              >
                <Link href={`/facts/${fact.id}`} className="hover:opacity-80 transition-opacity block">
                  <HeroHeadline rendered={rendered} name={name} />
                </Link>
              </motion.h2>
            ) : (
              <motion.div key="skeleton" className="space-y-3 pt-1" aria-hidden="true">
                <div className="h-7 w-full rounded-lg bg-secondary/80 animate-pulse" />
                <div className="h-7 w-5/6 rounded-lg bg-secondary/80 animate-pulse" />
                <div className="h-7 w-4/5 rounded-lg bg-secondary/60 animate-pulse" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Hashtags */}
        <AnimatePresence>
          {fact && fact.hashtags.length > 0 && (
            <motion.div
              key={`tags-${fact.id}`}
              initial={{ opacity: prefersReducedMotion ? 1 : 0 }}
              animate={{ opacity: 1 }}
              className="px-5 pb-3 flex flex-wrap gap-1.5"
            >
              {fact.hashtags.map(tag => (
                <Link
                  key={tag}
                  href={`/search?q=%23${tag}`}
                  className="text-[11px] font-bold font-display tracking-wide text-primary/80 hover:text-primary bg-primary/10 px-2.5 py-1 rounded-full uppercase transition-colors"
                >
                  #{tag}
                </Link>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Engagement footer */}
        <div className="px-5 pb-5 pt-3 border-t border-primary/15 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <button
              onClick={() => handleRate("up")}
              disabled={rateFact.isPending || !fact}
              className={cn("flex items-center gap-1.5 transition-colors", fact?.userRating === "up" ? "text-primary" : "text-muted-foreground hover:text-primary")}
            >
              <ThumbsUp className={cn("w-5 h-5", fact?.userRating === "up" && "fill-current")} />
              <span className="text-xs font-bold">{fact?.upvotes ?? 0}</span>
            </button>
            <button
              onClick={() => handleRate("down")}
              disabled={rateFact.isPending || !fact}
              className={cn("flex items-center gap-1.5 transition-colors", fact?.userRating === "down" ? "text-destructive" : "text-muted-foreground hover:text-destructive")}
            >
              <ThumbsDown className={cn("w-5 h-5", fact?.userRating === "down" && "fill-current")} />
              <span className="text-xs font-bold">{fact?.downvotes ?? 0}</span>
            </button>
            {fact && (
              <Link href={`/facts/${fact.id}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors">
                <MessageSquare className="w-5 h-5" />
                <span className="text-xs font-bold">{fact.commentCount}</span>
              </Link>
            )}
            <button onClick={handleShare} disabled={!fact} className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <button
            onClick={onShuffle}
            disabled={isShuffling}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-full text-[11px] font-display font-bold uppercase tracking-[0.1em] hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-60 shadow-[0_0_16px_rgba(249,115,22,0.45)]"
          >
            {isShuffling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Flame className="w-3 h-3" />}
            Next Random Fact
          </button>
        </div>
      </div>
    </div>
  );
}

// Desktop billboard — bold hero showcase with full interaction.
function DesktopHeroBillboard({
  fact,
  rendered,
  name,
  onShuffle,
  isShuffling,
  onMakeMeme,
}: {
  fact: FactSummary | null;
  rendered: string;
  name: string;
  onShuffle: () => void;
  isShuffling: boolean;
  onMakeMeme: ((factId: number) => void) | null;
}) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const swapKey = fact ? `f-${fact.id}` : "loading";
  const prefersReducedMotion = useReducedMotion();

  const handleRate = (type: "up" | "down") => {
    if (!fact) return;
    if (!isAuthenticated) { setLocation(`/login?from=/facts/${fact.id}`); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  const handleShare = async () => {
    if (!fact) return;
    const url = `${window.location.origin}/facts/${fact.id}`;
    if (navigator.share) {
      await navigator.share({ url }).catch(() => null);
    } else {
      await navigator.clipboard.writeText(url).catch(() => null);
    }
  };

  return (
    <div
      className="rounded-[32px] relative overflow-hidden border border-primary/20"
      style={{ background: "linear-gradient(145deg, hsl(var(--card)) 0%, rgba(249,115,22,0.06) 100%)", boxShadow: "0 0 60px rgba(249,115,22,0.10), inset 0 1px 0 rgba(255,255,255,0.07)" }}
    >
      {/* Header row */}
      <div className="px-10 pt-8 pb-0 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-bold tracking-[0.2em] text-primary uppercase font-display">
          <Flame className="w-3.5 h-3.5" /> Random Fact
        </span>
        <button
          onClick={onShuffle}
          disabled={isShuffling}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-full text-[12px] font-display font-bold uppercase tracking-[0.12em] hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-60 shadow-[0_0_20px_rgba(249,115,22,0.4)]"
        >
          {isShuffling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />}
          Next Random Fact
        </button>
      </div>

      {/* Fact text */}
      <div className="px-10 pt-7 pb-6 min-h-[9rem]">
        <AnimatePresence mode="wait" initial={false}>
          {fact ? (
            <motion.h2
              key={swapKey}
              initial={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : -10 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
              className="font-display font-bold text-[56px] leading-[0.93] uppercase tracking-tight"
              style={{ textWrap: "pretty" } as React.CSSProperties}
            >
              <Link href={`/facts/${fact.id}`} className="hover:opacity-80 transition-opacity block">
                <HeroHeadline rendered={rendered} name={name} />
              </Link>
            </motion.h2>
          ) : (
            <motion.div key="skeleton" className="space-y-4 pt-2" aria-hidden="true">
              <div className="h-12 w-11/12 rounded-xl bg-secondary/80 animate-pulse" />
              <div className="h-12 w-3/4 rounded-xl bg-secondary/80 animate-pulse" />
              <div className="h-12 w-1/2 rounded-xl bg-secondary/60 animate-pulse" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Hashtags */}
      <AnimatePresence>
        {fact && fact.hashtags.length > 0 && (
          <motion.div
            key={`tags-${fact.id}`}
            initial={{ opacity: prefersReducedMotion ? 1 : 0 }}
            animate={{ opacity: 1 }}
            className="px-10 pb-6 flex flex-wrap gap-2"
          >
            {fact.hashtags.map(tag => (
              <Link
                key={tag}
                href={`/search?q=%23${tag}`}
                className="text-[12px] font-bold font-display tracking-wide text-primary/80 hover:text-primary bg-primary/10 px-3 py-1.5 rounded-full uppercase transition-colors"
              >
                #{tag}
              </Link>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer: engagement + CTAs */}
      <div className="px-10 pb-8 pt-4 border-t border-primary/15 flex items-center justify-between min-h-[60px]">
        <div className="flex items-center gap-5">
          <button
            onClick={() => handleRate("up")}
            disabled={rateFact.isPending || !fact}
            className={cn("flex items-center gap-2 transition-colors text-[13px] font-bold", fact?.userRating === "up" ? "text-primary" : "text-muted-foreground hover:text-primary")}
          >
            <ThumbsUp className={cn("w-5 h-5", fact?.userRating === "up" && "fill-current")} />
            {fact?.upvotes ?? 0}
          </button>
          <button
            onClick={() => handleRate("down")}
            disabled={rateFact.isPending || !fact}
            className={cn("flex items-center gap-2 transition-colors text-[13px] font-bold", fact?.userRating === "down" ? "text-destructive" : "text-muted-foreground hover:text-destructive")}
          >
            <ThumbsDown className={cn("w-5 h-5", fact?.userRating === "down" && "fill-current")} />
            {fact?.downvotes ?? 0}
          </button>
          {fact && (
            <Link href={`/facts/${fact.id}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-[13px] font-bold">
              <MessageSquare className="w-5 h-5" />
              {fact.commentCount}
            </Link>
          )}
          <button onClick={handleShare} disabled={!fact} className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {fact && onMakeMeme && (
            <motion.button
              key={`meme-${fact.id}`}
              initial={{ opacity: prefersReducedMotion ? 1 : 0, scale: prefersReducedMotion ? 1 : 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: prefersReducedMotion ? 1 : 0, scale: prefersReducedMotion ? 1 : 0.96 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.18 }}
              onClick={() => onMakeMeme(fact.id)}
              className="h-[44px] px-7 bg-secondary border border-border text-foreground rounded-[12px] font-display font-bold text-[13px] uppercase tracking-[0.1em] hover:border-primary/50 hover:text-primary transition-colors"
            >
              Make a meme
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Full-screen cold-visitor hero for mobile — shows the teaser fact with a
// demo name, then a bottom-panel "YOUR TURN." name capture form.
function ColdMobileHero({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100svh - 56px)" }}>
      {/* ── Hero: teaser fact with demo name ──────────────────────── */}
      <div className="flex-1 px-5 pt-8 pb-6 flex flex-col justify-center">
        <div className="flex items-center gap-2 mb-5">
          <span className="w-5 h-px bg-muted-foreground/40" />
          <span className="text-[10px] font-bold tracking-[0.2em] text-muted-foreground uppercase font-display">
            About {DEMO_NAME}
          </span>
          <span className="w-5 h-px bg-muted-foreground/40" />
        </div>

        <h2 className="font-display font-bold uppercase tracking-tight leading-[0.95] text-foreground"
          style={{ fontSize: "clamp(36px, 10vw, 52px)" }}>
          <HeroHeadline rendered={COLD_DEMO_RENDERED} name={DEMO_NAME} />
        </h2>

        <button
          type="button"
          onClick={() => inputRef.current?.focus()}
          className="mt-8 self-start text-sm italic text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          Enough about {DEMO_NAME}.
        </button>
      </div>

      {/* ── Bottom panel: name capture ─────────────────────────────── */}
      <div className="bg-card border-t border-border rounded-t-[24px] px-5 pt-5 pb-24 shadow-[0_-8px_32px_rgba(0,0,0,0.4)]">
        <div className="w-10 h-1 bg-border rounded-full mx-auto mb-5" />

        <h3 className="font-display font-bold text-[22px] uppercase tracking-tight text-foreground mb-1">
          Your turn.
        </h3>
        <p className="text-[13px] text-muted-foreground mb-4">
          Add your name. Every fact becomes about you.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Your name"
            maxLength={100}
            autoComplete="given-name"
            className="w-full h-[52px] px-4 bg-background border border-border rounded-[12px] text-[15px] font-medium text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/40"
          />
          <button
            type="submit"
            disabled={!value.trim()}
            className="w-full h-[52px] bg-primary text-white rounded-[12px] font-display font-bold text-[13px] uppercase tracking-[0.12em] hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(249,115,22,0.5)]"
          >
            <Flame className="w-4 h-4" /> Hype me
          </button>
        </form>

        <p className="text-center text-[11px] text-muted-foreground/40 mt-4">
          Stored on this device · No account
        </p>
      </div>
    </div>
  );
}

// Bottom-sheet that slides up after name entry to collect pronouns.
// The AI/lookup inference pre-selects the most likely option so most
// users just tap confirm once.
// Three facts that together exercise all major pronoun forms so the user sees
// subject ({Subj}), possessive ({Poss}), and reflexive ({REFL}) in the preview.
const PRONOUN_PREVIEW_FACTS = [
  "{NAME} {does|do} not negotiate. {Subj} {dictates|dictate}.",
  "{NAME}'s word {is|are} law. {Poss} decisions are final.",
  "{NAME} taught {REFL} 14 languages. {Subj} called it nothing.",
];

const PRESET_LABELS: Record<string, string> = {
  "he/him":    "He / Him",
  "she/her":   "She / Her",
  "they/them": "They / Them",
};

const INPUT_CLASS =
  "w-full bg-secondary border border-border rounded-[8px] px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/60";

/** Highlight all occurrences of `name` in orange within a rendered sentence. */
function HighlightName({ text, name }: { text: string; name: string }) {
  if (!name) return <>{text}</>;
  const parts = text.split(name);
  return (
    <>
      {parts.map((p, i) =>
        i < parts.length - 1
          ? <span key={i}>{p}<span className="text-primary">{name}</span></span>
          : <span key={i}>{p}</span>
      )}
    </>
  );
}

function PronounsOnboardingSheet({
  name,
  onConfirm,
  onSkip,
}: {
  name: string;
  onConfirm: (pronouns: string) => void;
  onSkip: () => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const inferred = inferPronounsFromName(name) ?? DEFAULT_PRONOUNS;
  const [selected, setSelected]   = useState<string>(inferred);
  const [customOpen, setCustomOpen] = useState(false);

  // Custom pronoun field state — initialised from `selected` if it's already
  // a pipe-delimited value, otherwise blank (user starts from scratch).
  const [custom, setCustom] = useState<CustomPronounSet>(() => {
    if (isCustomPronouns(inferred)) return parseCustom(inferred) ?? { ...EMPTY_CUSTOM };
    return { ...EMPTY_CUSTOM };
  });

  const isCustomMode = customOpen;

  function handlePreset(p: string) {
    setSelected(p);
    setCustomOpen(false);
  }

  function openCustom() {
    setCustomOpen(true);
    // If switching from a preset, serialise whatever is in custom state
    // (may be empty — that's fine, user fills it in).
    setSelected(serializeCustom(custom));
  }

  function updateCustomField(field: keyof CustomPronounSet, val: string | boolean) {
    const next = { ...custom, [field]: val };
    setCustom(next);
    setSelected(serializeCustom(next));
  }

  function handleConfirm() {
    onConfirm(selected);
  }

  // Is the confirm button valid? Custom requires all 5 fields filled.
  const confirmEnabled = isCustomMode
    ? !!(custom.subj.trim() && custom.obj.trim() && custom.poss.trim() && custom.possPro.trim() && custom.refl.trim())
    : true;

  return (
    <div className="fixed inset-0 z-[110] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onSkip} />

      <motion.div
        initial={prefersReducedMotion ? false : { y: "100%" }}
        animate={prefersReducedMotion ? {} : { y: 0 }}
        exit={prefersReducedMotion ? {} : { y: "100%" }}
        transition={prefersReducedMotion ? { duration: 0 } : { type: "spring", damping: 30, stiffness: 280 }}
        className="relative z-10 bg-card rounded-t-[24px] shadow-[0_-20px_60px_rgba(0,0,0,0.6)]"
      >
        <div className="flex justify-center pt-3 mb-4">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Scrollable body so long custom forms don't clip on small screens */}
        <div className="px-5 pb-10 max-h-[85svh] overflow-y-auto">
          <h3 className="font-display font-bold text-[22px] uppercase tracking-tight text-foreground mb-1">
            One more thing.
          </h3>
          <p className="text-[13px] text-muted-foreground mb-5">
            Which pronouns should we use for{" "}
            <span className="text-foreground font-medium">{name}</span>?
          </p>

          {/* ── Three live previews ───────────────────────── */}
          <div className="space-y-2 mb-5">
            {PRONOUN_PREVIEW_FACTS.map((tpl, i) => {
              const rendered = renderFact(tpl, name, selected);
              return (
                <div key={i} className="rounded-[12px] bg-background border border-border px-4 py-2.5">
                  <p className="font-display font-bold text-[15px] uppercase leading-snug text-foreground">
                    <HighlightName text={rendered} name={name} />
                  </p>
                </div>
              );
            })}
          </div>

          {/* ── Preset chips ──────────────────────────────── */}
          <div className="flex gap-2 mb-3">
            {PRONOUN_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => handlePreset(p)}
                className={`flex-1 py-3 rounded-[12px] border text-[13px] font-bold font-display uppercase tracking-wide transition-colors ${
                  !isCustomMode && selected === p
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          {/* ── Custom pronouns expander ──────────────────── */}
          <button
            type="button"
            onClick={() => isCustomMode ? handlePreset(inferred) : openCustom()}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors mb-3 font-medium"
          >
            {isCustomMode ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {isCustomMode ? "Hide custom pronouns" : "Use custom pronouns"}
          </button>

          <AnimatePresence>
            {isCustomMode && (
              <motion.div
                initial={{ height: prefersReducedMotion ? "auto" : 0, opacity: prefersReducedMotion ? 1 : 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: prefersReducedMotion ? "auto" : 0, opacity: prefersReducedMotion ? 1 : 0 }}
                transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
                className="overflow-hidden mb-4"
              >
                <div className="p-3 border border-border rounded-[12px] bg-secondary/40 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">Subject</label>
                      <input type="text" value={custom.subj} onChange={(e) => updateCustomField("subj", e.target.value)}
                        placeholder="xe, fae, ey…" maxLength={15} className={INPUT_CLASS} />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">Object</label>
                      <input type="text" value={custom.obj} onChange={(e) => updateCustomField("obj", e.target.value)}
                        placeholder="xem, faer, em…" maxLength={15} className={INPUT_CLASS} />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">Possessive adj.</label>
                      <input type="text" value={custom.poss} onChange={(e) => updateCustomField("poss", e.target.value)}
                        placeholder="xyr, faer, eir…" maxLength={15} className={INPUT_CLASS} />
                      <p className="text-[10px] text-muted-foreground mt-0.5">"xyr book"</p>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">Possessive pro.</label>
                      <input type="text" value={custom.possPro} onChange={(e) => updateCustomField("possPro", e.target.value)}
                        placeholder="xyrs, faers, eirs…" maxLength={15} className={INPUT_CLASS} />
                      <p className="text-[10px] text-muted-foreground mt-0.5">"the book is xyrs"</p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">Reflexive</label>
                    <input type="text" value={custom.refl} onChange={(e) => updateCustomField("refl", e.target.value)}
                      placeholder="xemself, faerself, emself…" maxLength={20} className={INPUT_CLASS} />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">Verb form</label>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => updateCustomField("plural", false)}
                        className={`flex-1 py-1.5 rounded-[8px] border text-xs font-medium transition-colors ${!custom.plural ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}>
                        singular <span className="opacity-60 font-normal">(xe doesn't)</span>
                      </button>
                      <button type="button" onClick={() => updateCustomField("plural", true)}
                        className={`flex-1 py-1.5 rounded-[8px] border text-xs font-medium transition-colors ${custom.plural ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}>
                        plural <span className="opacity-60 font-normal">(they don't)</span>
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Confirm / skip ───────────────────────────── */}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!confirmEnabled}
            className="w-full h-[52px] bg-primary text-white rounded-[12px] font-display font-bold text-[13px] uppercase tracking-[0.12em] hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(249,115,22,0.4)]"
          >
            <Flame className="w-4 h-4" /> Looks right
          </button>

          <p className="text-center text-[11px] text-muted-foreground/50 mt-3">
            <button
              type="button"
              onClick={onSkip}
              className="underline underline-offset-2 hover:text-muted-foreground transition-colors"
            >
              skip for now
            </button>
            {" · "}you can always change this later
          </p>
        </div>
      </motion.div>
    </div>
  );
}

// Desktop inline name input (kept for the desktop cold card)
function InlineNameInput({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type your first name…"
        maxLength={100}
        autoComplete="given-name"
        className="flex-1 h-12 px-4 bg-secondary border border-border rounded-[12px] text-[15px] font-medium text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="h-12 px-5 bg-primary text-white rounded-[12px] font-display font-bold text-[12px] uppercase tracking-[0.12em] hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Hype me
      </button>
    </form>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const [filterMode, setFilterMode] = useState<FilterMode>("default");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showHashtagRail, setShowHashtagRail] = useState(false);
  const { name, pronouns, setName, setPronouns } = usePersonName();
  const prefersReducedMotion = useReducedMotion();

  // Two-step cold onboarding: capture name first, then show pronouns sheet.
  const [pendingName, setPendingName] = useState<string | null>(null);

  function handleNameSubmit(submittedName: string) {
    setPendingName(submittedName);
  }

  function handlePronounsConfirm(chosenPronouns: string) {
    if (!pendingName) return;
    setName(pendingName);
    setPronouns(chosenPronouns);
    setPendingName(null);
  }

  function handlePronounsSkip() {
    if (!pendingName) return;
    setName(pendingName);
    // leave pronouns unchanged — the inferred default or whatever was set before
    setPendingName(null);
  }


  // Cold visitor = no stored name AND no share-link override.  In that state
  // the hero shows a placeholder fact + inline name input instead of querying
  // a real hero.  As soon as a name is set we flip to warm mode.
  const isCold = !name && !SHARE_LINK_ACTIVE;
  const { fact: heroFact, isLoading: heroLoading, shuffle: shuffleHero } = useHeroFact();

  const heroRendered = useMemo(() => {
    if (isCold) return renderFact(COLD_TEASER_FACT, "", pronouns);
    if (!heroFact) return "";
    return renderFact(heroFact.text, name, pronouns);
  }, [isCold, heroFact, name, pronouns]);

  const primaryTag = selectedTags[0] ?? undefined;

  const { data, isLoading, error } = useListFacts(
    filterMode === "hall-of-fame"
      ? { sort: "top", limit: 20 }
      : filterMode === "hashtags" && primaryTag
      ? { hashtag: primaryTag, sort: "newest", limit: 100 }
      : { sort: "newest", limit: 20 },
  );

  const { data: hashtagData, isLoading: hashtagsLoading } = useListHashtags(
    { limit: 30 },
    { query: { queryKey: getListHashtagsQueryKey({ limit: 30 }), staleTime: 60_000 } },
  );

  const filteredFacts = useMemo(() => {
    if (!data?.facts) return [];
    if (filterMode !== "hashtags" || selectedTags.length <= 1) return data.facts;
    return data.facts.filter(fact =>
      selectedTags.every(tag => fact.hashtags.includes(tag))
    );
  }, [data?.facts, filterMode, selectedTags]);

  const toggleTag = (tagName: string) => {
    setFilterMode("hashtags");
    setSelectedTags(prev =>
      prev.includes(tagName) ? prev.filter(t => t !== tagName) : [...prev, tagName]
    );
  };

  const isLoaded = !isLoading;
  const showRank = filterMode === "hall-of-fame";

  return (
    <Layout>
      {/* ── MOBILE: Hashtag rail (always-visible, sticky) ─────────────── */}
      <div className="md:hidden sticky top-14 z-30 bg-background/95 backdrop-blur border-b border-border">
        <AnimatePresence>
          {showHashtagRail && (
            <motion.div
              key="rail"
              initial={{ height: prefersReducedMotion ? "auto" : 0, opacity: prefersReducedMotion ? 1 : 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: prefersReducedMotion ? "auto" : 0, opacity: prefersReducedMotion ? 1 : 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.18 }}
              className="overflow-hidden"
            >
              {hashtagsLoading ? (
                <div className="flex gap-2 px-4 py-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-8 w-20 rounded-full bg-card animate-pulse flex-shrink-0" />
                  ))}
                </div>
              ) : (
                <HashtagRail
                  hashtags={hashtagData?.hashtags ?? []}
                  selectedTags={selectedTags}
                  onToggle={toggleTag}
                  onForYou={() => { setFilterMode("default"); setSelectedTags([]); }}
                  isForYou={filterMode === "default"}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-2 px-4 py-2">
          <button
            onClick={() => {
              const next = !showHashtagRail;
              setShowHashtagRail(next);
              if (!next) { setFilterMode("default"); setSelectedTags([]); }
              else setFilterMode("hashtags");
            }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-colors",
              filterMode === "hashtags"
                ? "bg-primary text-white"
                : "bg-card border border-border text-muted-foreground"
            )}
          >
            # Tags
          </button>
          <div className="flex-1" />
          <button
            onClick={() => { setFilterMode("default"); setSelectedTags([]); setShowHashtagRail(false); }}
            className={cn(
              "text-xs font-bold uppercase tracking-wide transition-colors px-3 py-1.5 rounded-full",
              filterMode === "default" ? "text-foreground" : "text-muted-foreground"
            )}
          >
            Latest
          </button>
        </div>
      </div>

      {/* ── DESKTOP: Sticky hashtag rail ─────────────────────────── */}
      <div className="hidden md:block sticky top-16 z-30 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-[1120px] mx-auto">
          {hashtagsLoading ? (
            <div className="flex gap-2 px-4 py-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-9 w-24 rounded-full bg-card animate-pulse flex-shrink-0" />
              ))}
            </div>
          ) : (
            <HashtagRail
              hashtags={hashtagData?.hashtags ?? []}
              selectedTags={selectedTags}
              onToggle={toggleTag}
              onForYou={() => { setFilterMode("default"); setSelectedTags([]); }}
              isForYou={filterMode === "default"}
            />
          )}
        </div>
      </div>

      {/* ── DESKTOP: Hero billboard (only in default mode) ────────── */}
      {filterMode === "default" && (
        <div className="hidden md:block pt-6 pb-2">
          <div className="max-w-[1120px] mx-auto px-6">
            {isCold ? (
              <div className="rounded-[32px] bg-card border border-border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] px-10 py-9">
                <div className="flex items-center gap-2 mb-3 text-[11px] font-bold tracking-[0.18em] text-muted-foreground uppercase font-display">
                  <span className="w-5 h-px bg-muted-foreground/40" />
                  ABOUT YOU
                </div>
                <h2
                  className="font-display font-bold text-[52px] leading-[0.96] uppercase tracking-tight mb-8 text-foreground"
                  style={{ textWrap: "pretty" } as React.CSSProperties}
                >
                  {heroRendered.split("___").map((p, i, arr) =>
                    i < arr.length - 1
                      ? <span key={i}>{p}<span className="text-primary">___</span></span>
                      : <span key={i}>{p}</span>
                  )}
                </h2>
                <p className="text-[14px] text-muted-foreground mb-5">Type your name and every fact in the database becomes about you.</p>
                <div className="max-w-[420px]">
                  <InlineNameInput onSubmit={setName} />
                </div>
              </div>
            ) : (
              <DesktopHeroBillboard
                fact={heroFact}
                rendered={heroRendered}
                name={name}
                onShuffle={shuffleHero}
                isShuffling={heroLoading}
                onMakeMeme={(factId) => setLocation(`/facts/${factId}`)}
              />
            )}
          </div>
        </div>
      )}

      {/* ── MOBILE: Hero billboard ────────────────────────────── */}
      {filterMode === "default" && (
        <div className="md:hidden">
          {isCold ? (
            <ColdMobileHero onSubmit={handleNameSubmit} />
          ) : (
            <div className="pt-3">
              <HeroBillboardMobile
                fact={heroFact}
                rendered={heroRendered}
                name={name}
                onShuffle={shuffleHero}
                isShuffling={heroLoading}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Fact feed ─────────────────────────────────────────── */}
      <section className="max-w-[1120px] mx-auto px-4 md:px-6 py-4 md:py-6">
        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-48 md:h-64 bg-card rounded-[20px] border border-border" />
            ))}
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 border-2 border-destructive p-8 text-center rounded-[20px]">
            <p className="text-destructive font-bold text-xl uppercase">Error loading facts. {name || "Someone"} destroyed the server.</p>
          </div>
        )}

        {filterMode === "hashtags" && selectedTags.length === 0 && isLoaded && !error && (
          <div className="text-center py-20 bg-card border border-border rounded-[20px]">
            <p className="text-muted-foreground text-lg font-bold uppercase">Pick a hashtag above to filter facts.</p>
          </div>
        )}

        {isLoaded && !error && (filterMode !== "hashtags" || selectedTags.length > 0) && (
          filteredFacts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
              {filteredFacts.map((fact, idx) => (
                <FactCard
                  key={fact.id}
                  fact={fact}
                  rank={idx + 1}
                  showRank={showRank}
                  index={idx}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-12 text-lg">No facts found. Better start running.</p>
          )
        )}

        {/* Desktop: trending tags strip at bottom */}
        {hashtagData?.hashtags && hashtagData.hashtags.length > 0 && (
          <div className="hidden md:block mt-8 rounded-[20px] bg-card border border-border p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <p className="text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase font-display mb-3">Trending Topics</p>
            <div className="flex flex-wrap gap-2">
              {hashtagData.hashtags.slice(0, 20).map(tag => (
                <button
                  key={tag.name}
                  onClick={() => toggleTag(tag.name)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-[12px] font-semibold transition-colors",
                    selectedTags.includes(tag.name)
                      ? "bg-primary text-white"
                      : "bg-background border border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                  )}
                >
                  #{tag.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Pronouns onboarding sheet (mobile cold flow) ──────── */}
      <AnimatePresence>
        {pendingName && (
          <PronounsOnboardingSheet
            name={pendingName}
            onConfirm={handlePronounsConfirm}
            onSkip={handlePronounsSkip}
          />
        )}
      </AnimatePresence>
    </Layout>
  );
}
