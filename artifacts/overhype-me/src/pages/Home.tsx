import { useListFacts, useListHashtags, getListHashtagsQueryKey } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { AdSlot } from "@/components/AdSlot";
import { Search, Flame } from "lucide-react";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePersonName } from "@/hooks/use-person-name";
import { cn } from "@/components/ui/Button";
import { renderFact } from "@/lib/render-fact";

type FilterMode = "default" | "hall-of-fame" | "hashtags";

// Horizontally scrollable hashtag filter rail
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

// Hero billboard — top-rated fact of the day
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

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");
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
    { query: { queryKey: getListHashtagsQueryKey({ limit: 30 }), enabled: showHashtagRail || filterMode === "hashtags", staleTime: 60_000 } },
  );

  const filteredFacts = useMemo(() => {
    if (!data?.facts) return [];
    if (filterMode !== "hashtags" || selectedTags.length <= 1) return data.facts;
    return data.facts.filter(fact =>
      selectedTags.every(tag => fact.hashtags.includes(tag))
    );
  }, [data?.facts, filterMode, selectedTags]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

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

        {/* Filter pill row */}
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
              filterMode === "default"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
          >
            Latest
          </button>
        </div>
      </div>

      {/* ── DESKTOP: Hero section ──────────────────────────────── */}
      <section className="hidden md:block relative pt-10 pb-10 md:pt-16 md:pb-14 overflow-hidden border-b-4 border-primary">
        <div className="absolute inset-0 z-0">
          <img
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`}
            alt=""
            className="w-full h-full object-cover opacity-40 mix-blend-luminosity grayscale contrast-150"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent" />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto px-4 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-5xl md:text-7xl lg:text-8xl font-display font-bold uppercase tracking-tight text-white drop-shadow-[0_5px_5px_rgba(0,0,0,1)] mb-6"
          >
            The Universe Doesn't Expand. <br />
            <span className="text-primary block mt-2 drop-shadow-[0_0_30px_rgba(249,115,22,0.8)]">{name} Pushes It.</span>
          </motion.h1>

          <motion.form
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3 }}
            onSubmit={handleSearch}
            className="max-w-2xl mx-auto flex flex-col sm:flex-row gap-4"
          >
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-muted-foreground" />
              <input
                type="text"
                placeholder="Find a fact…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full h-14 pl-12 pr-4 bg-background/80 backdrop-blur border-2 border-border focus:border-primary text-lg font-bold rounded-sm outline-none transition-colors shadow-2xl"
              />
            </div>
            <Button type="submit" size="lg" className="shrink-0 w-full sm:w-auto">SEARCH</Button>
          </motion.form>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="flex flex-col sm:flex-row gap-4 justify-center mt-6"
          >
            <Button
              variant={filterMode === "hall-of-fame" ? "primary" : "outline"}
              size="lg"
              className="gap-2"
              onClick={() => { setFilterMode("hall-of-fame"); setSelectedTags([]); }}
            >
              🏆 HALL OF FAME
            </Button>
            <Button
              variant={filterMode === "hashtags" ? "primary" : "outline"}
              size="lg"
              className="gap-2"
              onClick={() => setFilterMode("hashtags")}
            >
              # HASHTAGS
            </Button>
          </motion.div>

          <AnimatePresence>
            {filterMode === "hashtags" && (
              <motion.div
                key="hashtag-picker"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden mt-6"
              >
                {hashtagsLoading ? (
                  <div className="flex gap-3 overflow-x-auto pb-2 justify-center flex-wrap">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className="h-9 w-24 bg-card/50 border-2 border-border rounded-sm animate-pulse shrink-0" />
                    ))}
                  </div>
                ) : (
                  hashtagData?.hashtags && hashtagData.hashtags.length > 0 && (
                    <div className="flex gap-3 overflow-x-auto pb-2 justify-start sm:justify-center flex-wrap max-h-40 overflow-y-auto">
                      {hashtagData.hashtags.map(tag => {
                        const isSelected = selectedTags.includes(tag.name);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.name)}
                            className={cn(
                              "flex items-center gap-1.5 px-3 py-1.5 border-2 rounded-sm font-bold text-sm uppercase tracking-wide cursor-pointer shrink-0 transition-colors",
                              isSelected
                                ? "bg-primary border-primary text-white"
                                : "bg-card/50 border-border hover:border-primary hover:bg-primary/10 text-foreground"
                            )}
                          >
                            <span className={cn(isSelected ? "text-white" : "text-primary")}>#</span>
                            <span>{tag.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      {/* ── MOBILE: Hero billboard ────────────────────────────── */}
      {filterMode === "default" && (
        <div className="md:hidden pt-3">
          <HeroBillboard name={name} pronouns={pronouns} />
        </div>
      )}

      {/* ── Fact feed ─────────────────────────────────────────── */}
      <section className="max-w-7xl mx-auto px-4 py-4 md:py-8">
        {/* Desktop section header */}
        <div className="hidden md:flex items-end justify-between mb-6 border-b-2 border-border pb-4">
          <div>
            {filterMode === "hall-of-fame" && (
              <>
                <h2 className="text-4xl font-display text-foreground tracking-wide">THE HALL OF FAME</h2>
                <p className="text-primary font-bold mt-1 tracking-widest uppercase text-sm">Top Rated Facts</p>
              </>
            )}
            {filterMode === "hashtags" && (
              <>
                <h2 className="text-4xl font-display text-foreground tracking-wide">
                  {selectedTags.length > 0 ? selectedTags.map(t => `#${t}`).join(" + ") : "HASHTAGS"}
                </h2>
                <p className="text-primary font-bold mt-1 tracking-widest uppercase text-sm">
                  {selectedTags.length > 0 ? "Filtered Facts" : "Select a hashtag to filter"}
                </p>
              </>
            )}
            {filterMode === "default" && (
              <>
                <h2 className="text-4xl font-display text-foreground tracking-wide">LATEST FACTS</h2>
                <p className="text-primary font-bold mt-1 tracking-widest uppercase text-sm">Newest Entries</p>
              </>
            )}
          </div>
          <Button variant="outline" onClick={() => setLocation('/submit')} className="hidden sm:flex">
            SUBMIT A FACT
          </Button>
        </div>

        <div className="flex gap-8">
          <div className="flex-1 min-w-0">
            {isLoading && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 animate-pulse">
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-x-8 md:gap-y-12">
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
          </div>

          <aside className="hidden lg:block w-[160px] shrink-0">
            <div className="sticky top-24">
              <AdSlot
                slot={import.meta.env.VITE_ADSENSE_SLOT_HOME_SIDEBAR ?? "1122334455"}
                format="vertical"
              />
            </div>
          </aside>
        </div>
      </section>
    </Layout>
  );
}
