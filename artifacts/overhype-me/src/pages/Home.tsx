import { useListFacts, useListHashtags, getListHashtagsQueryKey } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { Layout } from "@/components/layout/Layout";
import { Flame } from "lucide-react";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePersonName } from "@/hooks/use-person-name";
import { cn } from "@/components/ui/Button";
import { renderFact } from "@/lib/render-fact";

type FilterMode = "default" | "hall-of-fame" | "hashtags";

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

// Mobile billboard
function HeroBillboard({ name, pronouns }: { name: string; pronouns: string }) {
  const { data } = useListFacts({ sort: "top", limit: 5 });
  const facts = data?.facts ?? [];
  const [idx, setIdx] = useState(0);

  if (!facts.length) return null;
  const fact = facts[idx];
  const rendered = renderFact(fact.text, name, pronouns);
  const parts = rendered.split(name);

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
              <p className="text-[10px] text-muted-foreground">#{idx + 1} today</p>
            </div>
          </div>
          <div className="flex gap-1">
            {facts.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className={cn(
                  "h-0.5 rounded-full transition-all",
                  i === idx ? "w-5 bg-primary" : "w-4 bg-border"
                )}
              />
            ))}
          </div>
        </div>

        <h2 className="font-display font-bold text-2xl uppercase tracking-tight leading-[1.05] mb-5">
          {parts.map((p, i) =>
            i < parts.length - 1 ? (
              <span key={i}>{p}<span className="text-primary">{name}</span></span>
            ) : (
              <span key={i}>{p}</span>
            )
          )}
        </h2>

        <div className="flex items-center justify-between pt-3 border-t border-border/50">
          <div className="flex items-center gap-4">
            <button className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              <span className="text-xs font-semibold">{(fact.upvotes / 1000).toFixed(1)}k</span>
            </button>
            <button className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
              </svg>
              <span className="text-xs font-semibold">{fact.commentCount}</span>
            </button>
          </div>
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// Desktop billboard card with carousel + CTAs
function DesktopHeroBillboard({
  name,
  pronouns,
  onMakeMeme,
}: {
  name: string;
  pronouns: string;
  onMakeMeme: (factId: number) => void;
}) {
  const { data } = useListFacts({ sort: "top", limit: 5 });
  const facts = data?.facts ?? [];
  const [idx, setIdx] = useState(0);

  if (!facts.length) return null;
  const fact = facts[idx];
  const rendered = renderFact(fact.text, name, pronouns);
  const parts = rendered.split(name);

  return (
    <div className="rounded-[32px] bg-card border border-border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] px-10 py-9 relative overflow-hidden">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
            <Flame className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-primary uppercase font-display">Hall of Fame</p>
            <p className="text-[10px] text-muted-foreground">#{idx + 1} most hyped</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {facts.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={cn(
                "h-1 rounded-full transition-all",
                i === idx ? "w-6 bg-primary" : "w-3.5 bg-border hover:bg-muted-foreground"
              )}
            />
          ))}
        </div>
      </div>

      <h2
        className="font-display font-bold text-[52px] leading-[0.96] uppercase tracking-tight mb-8"
        style={{ textWrap: "pretty" } as React.CSSProperties}
      >
        {parts.map((p, i) =>
          i < parts.length - 1
            ? <span key={i}>{p}<span className="text-primary">{name}</span></span>
            : <span key={i}>{p}</span>
        )}
      </h2>

      <div className="flex items-center justify-between pt-5 border-t border-border/50">
        <div className="flex items-center gap-4 text-muted-foreground text-[13px] font-semibold">
          <span>{(fact.upvotes / 1000).toFixed(1)}k likes</span>
          <span className="text-border">·</span>
          <span>{fact.commentCount} comments</span>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => onMakeMeme(fact.id)}
            className="h-[44px] px-7 bg-primary text-white rounded-[12px] font-display font-bold text-[13px] uppercase tracking-[0.1em] hover:bg-primary/90 transition-colors"
          >
            Make a meme
          </button>
          <button
            onClick={() => setIdx((idx + 1) % facts.length)}
            className="h-[44px] px-5 bg-background border border-border rounded-[12px] font-display font-bold text-[13px] uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const [filterMode, setFilterMode] = useState<FilterMode>("default");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showHashtagRail, setShowHashtagRail] = useState(false);
  const { name, pronouns } = usePersonName();

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
      {/* ── MOBILE: Hashtag rail (toggleable, sticky) ───────────── */}
      <div className="md:hidden sticky top-14 z-30 bg-background/95 backdrop-blur border-b border-border">
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
            <DesktopHeroBillboard
              name={name}
              pronouns={pronouns}
              onMakeMeme={(factId) => setLocation(`/facts/${factId}`)}
            />
          </div>
        </div>
      )}

      {/* ── MOBILE: Hero billboard ────────────────────────────── */}
      {filterMode === "default" && (
        <div className="md:hidden pt-3">
          <HeroBillboard name={name} pronouns={pronouns} />
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
            <p className="text-destructive font-bold text-xl uppercase">Error loading facts. {name} destroyed the server.</p>
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
