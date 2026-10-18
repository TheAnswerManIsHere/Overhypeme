import { useListFacts, useListHashtags, getListHashtagsQueryKey, type FactSummary } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { FactComments } from "@/components/facts/FactComments";
import { HighlightedFactText } from "@/components/facts/HighlightedFactText";
import { Layout } from "@/components/layout/Layout";
import { Flame, Loader2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { usePersonName, DEFAULT_PRONOUNS } from "@/hooks/use-person-name";
import { useHeroFact } from "@/hooks/use-hero-fact";
import { cn } from "@/components/ui/Button";

type FilterMode = "default" | "top-facts" | "hashtags";

// Placeholder fact used in the cold-visitor hero before they've typed a name.
const COLD_TEASER_FACT = "The universe doesn't expand. {NAME} pushes it.";

// Sample name shown in the cold-visitor hero so visitors immediately see
// the personalisation — the name renders in orange just like their own will.
const DEMO_NAME = "David Franklin";

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


// Hero billboard — single component for warm-visitor desktop + mobile.
// Retains its distinctive glow chrome but is otherwise a FactCard size="hero"
// so the action cluster, comment expansion, and share button all flow from
// the same shared code path as the feed and detail pages.
function Hero({
  fact,
  onShuffle,
  isShuffling,
}: {
  fact: FactSummary | null;
  onShuffle: () => void;
  isShuffling: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();

  if (!fact) {
    return (
      <div
        className="rounded-[24px] md:rounded-[32px] relative overflow-hidden border border-primary/25"
        style={{
          background: "linear-gradient(145deg, hsl(var(--card)) 0%, rgba(249,115,22,0.07) 100%)",
          boxShadow: "0 0 60px rgba(249,115,22,0.10), inset 0 1px 0 rgba(255,255,255,0.07)",
        }}
        aria-hidden="true"
      >
        <div className="p-5 md:px-10 md:py-8 space-y-4">
          <div className="h-3 w-24 bg-secondary/80 animate-pulse rounded-full" />
          <div className="h-9 w-11/12 bg-secondary/80 animate-pulse rounded-xl" />
          <div className="h-9 w-3/4 bg-secondary/80 animate-pulse rounded-xl" />
          <div className="h-9 w-1/2 bg-secondary/60 animate-pulse rounded-xl" />
        </div>
      </div>
    );
  }

  const headerSlot = (
    <div className="flex items-center justify-between mb-2 md:mb-4 gap-3">
      <span className="flex items-center gap-1.5 text-[10px] md:text-[11px] font-bold tracking-[0.2em] text-primary uppercase font-display">
        <Flame className="w-3 h-3 md:w-3.5 md:h-3.5" /> Random Fact
      </span>
      <button
        onClick={onShuffle}
        disabled={isShuffling}
        className="flex items-center gap-1.5 md:gap-2 px-3 md:px-5 py-1.5 md:py-2.5 bg-secondary border border-border text-foreground rounded-full text-[11px] md:text-[12px] font-display font-bold uppercase tracking-[0.1em] md:tracking-[0.12em] hover:border-primary/50 hover:text-primary active:scale-95 transition-all disabled:opacity-60"
      >
        {isShuffling ? <Loader2 className="w-3 h-3 md:w-3.5 md:h-3.5 animate-spin" /> : <Flame className="w-3 h-3 md:w-3.5 md:h-3.5" />}
        Next Random Fact
      </button>
    </div>
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={fact.id}
        initial={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : -8 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
      >
        <FactCard fact={fact} size="hero" headerSlot={headerSlot} />
      </motion.div>
    </AnimatePresence>
  );
}


// Full-screen cold-visitor hero for mobile: the teaser fact with a demo name.
// The identity sheet asks for the visitor's own name over it (#719).
function ColdMobileHero() {
  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100svh - 56px)" }}>
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
          <HighlightedFactText template={COLD_TEASER_FACT} name={DEMO_NAME} pronouns={DEFAULT_PRONOUNS} />
        </h2>
      </div>
    </div>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const [filterMode, setFilterMode] = useState<FilterMode>("default");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showHashtagRail, setShowHashtagRail] = useState(false);
  const { name } = usePersonName();
  const prefersReducedMotion = useReducedMotion();

  // Cold visitor = no name yet. The hero shows a placeholder fact while the
  // identity sheet asks; as soon as a name is set we flip to warm mode.
  const isCold = !name;
  const { fact: heroFact, isLoading: heroLoading, shuffle: shuffleHero } = useHeroFact();

  const primaryTag = selectedTags[0] ?? undefined;

  const { data, isLoading, error } = useListFacts(
    filterMode === "top-facts"
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
  const showRank = filterMode === "top-facts";

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
                  About {DEMO_NAME}
                </div>
                <h2
                  className="font-display font-bold text-[52px] leading-[0.96] uppercase tracking-tight mb-8 text-foreground"
                  style={{ textWrap: "pretty" } as React.CSSProperties}
                >
                  <HighlightedFactText template={COLD_TEASER_FACT} name={DEMO_NAME} pronouns={DEFAULT_PRONOUNS} />
                </h2>
              </div>
            ) : (
              <Hero
                fact={heroFact}
                onShuffle={shuffleHero}
                isShuffling={heroLoading}
              />
            )}
          </div>
        </div>
      )}

      {/* ── MOBILE: Hero billboard ────────────────────────────── */}
      {filterMode === "default" && (
        <div className="md:hidden">
          {isCold ? (
            <ColdMobileHero />
          ) : (
            <div className="px-4 pb-4 pt-3">
              <Hero
                fact={heroFact}
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

    </Layout>
  );
}
