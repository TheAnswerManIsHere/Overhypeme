import { useListFacts, useListHashtags, getListHashtagsQueryKey, type FactSummary } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { Layout } from "@/components/layout/Layout";
import { Flame, Shuffle } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePersonName, SHARE_LINK_ACTIVE } from "@/hooks/use-person-name";
import { useHeroFact } from "@/hooks/use-hero-fact";
import { cn } from "@/components/ui/Button";
import { renderFact } from "@/lib/render-fact";

type FilterMode = "default" | "hall-of-fame" | "hashtags";

// Placeholder fact used in the cold-visitor hero before they've typed a name.
// Renders with the {NAME} → "___" fallback so the sentence still scans and
// signals "fill me in".
const COLD_TEASER_FACT = "The universe doesn't expand. {NAME} pushes it.";

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

// Mobile billboard — single weighted-random fact with a shuffle button.
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
  const swapKey = fact ? `f-${fact.id}` : "loading";
  return (
    <div className="px-4 pb-4">
      <div className="rounded-[20px] bg-card shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] p-5 relative overflow-hidden">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center">
              <Flame className="w-3.5 h-3.5 text-primary" />
            </div>
            <div>
              <p className="text-[11px] font-bold tracking-[0.14em] text-primary uppercase font-display">Hall of Fame</p>
              <p className="text-[10px] text-muted-foreground">Random hype</p>
            </div>
          </div>
          <button
            onClick={onShuffle}
            disabled={isShuffling}
            className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50"
            aria-label="Shuffle hero fact"
          >
            <Shuffle className={cn("w-3.5 h-3.5 transition-transform", isShuffling && "animate-spin")} />
          </button>
        </div>

        <div className="min-h-[3.5rem] mb-5 relative">
          <AnimatePresence mode="wait" initial={false}>
            {fact ? (
              <motion.h2
                key={swapKey}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="font-display font-bold text-2xl uppercase tracking-tight leading-[1.05]"
              >
                <HeroHeadline rendered={rendered} name={name} />
              </motion.h2>
            ) : (
              <motion.div
                key="skeleton"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="space-y-2 pt-1"
                aria-hidden="true"
              >
                <div className="h-5 w-11/12 rounded bg-secondary animate-pulse" />
                <div className="h-5 w-3/4 rounded bg-secondary animate-pulse" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-4 pt-3 border-t border-border/50 text-muted-foreground text-[12px] font-semibold min-h-[1.25rem]">
          <AnimatePresence mode="wait" initial={false}>
            {fact ? (
              <motion.div
                key={`stats-${fact.id}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="flex items-center gap-4"
              >
                <span>{(fact.upvotes / 1000).toFixed(1)}k likes</span>
                <span className="text-border">·</span>
                <span>{fact.commentCount} comments</span>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// Desktop billboard — single hero with shuffle + make-meme CTAs.
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
  const swapKey = fact ? `f-${fact.id}` : "loading";
  return (
    <div className="rounded-[32px] bg-card border border-border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] px-10 py-9 relative overflow-hidden">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
            <Flame className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-primary uppercase font-display">Hall of Fame</p>
            <p className="text-[10px] text-muted-foreground">Random hype</p>
          </div>
        </div>
        <button
          onClick={onShuffle}
          disabled={isShuffling}
          className="h-9 px-3 rounded-full bg-secondary border border-border flex items-center gap-1.5 text-xs font-display font-bold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50"
        >
          <Shuffle className={cn("w-3.5 h-3.5 transition-transform", isShuffling && "animate-spin")} />
          Shuffle
        </button>
      </div>

      <div className="min-h-[6rem] mb-8 relative">
        <AnimatePresence mode="wait" initial={false}>
          {fact ? (
            <motion.h2
              key={swapKey}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="font-display font-bold text-[52px] leading-[0.96] uppercase tracking-tight"
              style={{ textWrap: "pretty" } as React.CSSProperties}
            >
              <HeroHeadline rendered={rendered} name={name} />
            </motion.h2>
          ) : (
            <motion.div
              key="skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-3 pt-2"
              aria-hidden="true"
            >
              <div className="h-10 w-11/12 rounded bg-secondary animate-pulse" />
              <div className="h-10 w-3/4 rounded bg-secondary animate-pulse" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-between pt-5 border-t border-border/50 min-h-[44px]">
        <div className="flex items-center gap-4 text-muted-foreground text-[13px] font-semibold">
          <AnimatePresence mode="wait" initial={false}>
            {fact ? (
              <motion.div
                key={`stats-${fact.id}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="flex items-center gap-4"
              >
                <span>{(fact.upvotes / 1000).toFixed(1)}k likes</span>
                <span className="text-border">·</span>
                <span>{fact.commentCount} comments</span>
              </motion.div>
            ) : (
              <motion.span
                key="loading-stats"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                Fresh hype loading…
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {fact && onMakeMeme && (
            <motion.button
              key={`meme-${fact.id}`}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              onClick={() => onMakeMeme(fact.id)}
              className="h-[44px] px-7 bg-primary text-white rounded-[12px] font-display font-bold text-[13px] uppercase tracking-[0.1em] hover:bg-primary/90 transition-colors"
            >
              Make a meme
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Inline name input shown on the cold-visitor home — replaces the auto-popping
// WelcomeModal on `/` so onboarding stays in-line with the hero.
function InlineNameInput({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        ref={inputRef}
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
  const { name, pronouns, setName } = usePersonName();

  // The mobile sticky filter strip is hidden on first paint and revealed once
  // the user has scrolled a bit (or interacted with a filter), so the very top
  // of the home view is just the wordmark + hero billboard.
  const [filterRailRevealed, setFilterRailRevealed] = useState(false);
  useEffect(() => {
    if (filterRailRevealed) return;
    function onScroll() {
      if (window.scrollY > 60) setFilterRailRevealed(true);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [filterRailRevealed]);

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
    setFilterRailRevealed(true);
    setSelectedTags(prev =>
      prev.includes(tagName) ? prev.filter(t => t !== tagName) : [...prev, tagName]
    );
  };

  const isLoaded = !isLoading;
  const showRank = filterMode === "hall-of-fame";

  return (
    <Layout>
      {/* ── MOBILE: Hashtag rail (toggleable, sticky, scroll-revealed) ─── */}
      <AnimatePresence initial={false}>
        {filterRailRevealed && (
          <motion.div
            key="mobile-filter-rail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="md:hidden sticky top-14 z-30 bg-background/95 backdrop-blur border-b border-border overflow-hidden"
          >
            <AnimatePresence>
              {showHashtagRail && (
                <motion.div
                  key="rail"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
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
                onClick={() => { setFilterMode("hall-of-fame"); setSelectedTags([]); setShowHashtagRail(false); }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-colors",
                  filterMode === "hall-of-fame"
                    ? "bg-primary text-white"
                    : "bg-card border border-border text-muted-foreground"
                )}
              >
                🏆 Hall of Fame
              </button>
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
          </motion.div>
        )}
      </AnimatePresence>

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
        <div className="md:hidden pt-3">
          {isCold ? (
            <div className="px-4 pb-4">
              <div className="rounded-[20px] bg-card shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] p-5">
                <div className="text-[10px] font-bold tracking-[0.16em] text-muted-foreground uppercase font-display mb-3">
                  About you
                </div>
                <h2 className="font-display font-bold text-2xl uppercase tracking-tight leading-[1.05] mb-5 min-h-[3.5rem]">
                  {heroRendered.split("___").map((p, i, arr) =>
                    i < arr.length - 1
                      ? <span key={i}>{p}<span className="text-primary">___</span></span>
                      : <span key={i}>{p}</span>
                  )}
                </h2>
                <p className="text-[12px] text-muted-foreground mb-3">Add your name. Every fact becomes about you.</p>
                <InlineNameInput onSubmit={setName} />
              </div>
            </div>
          ) : (
            <HeroBillboardMobile
              fact={heroFact}
              rendered={heroRendered}
              name={name}
              onShuffle={shuffleHero}
              isShuffling={heroLoading}
            />
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
    </Layout>
  );
}
