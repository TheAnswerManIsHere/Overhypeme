import { useListFacts, useListHashtags } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { AdSlot } from "@/components/AdSlot";
import { Search } from "lucide-react";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePersonName } from "@/hooks/use-person-name";
import { cn } from "@/components/ui/Button";

type FilterMode = "default" | "hall-of-fame" | "hashtags";

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");
  const [, setLocation] = useLocation();
  const [filterMode, setFilterMode] = useState<FilterMode>("default");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const { name } = usePersonName();

  const primaryTag = selectedTags[0] ?? undefined;

  const { data, isLoading, error } = useListFacts(
    filterMode === "hall-of-fame"
      ? { sort: "top", limit: 20 }
      : filterMode === "hashtags" && primaryTag
      ? { hashtag: primaryTag, sort: "newest", limit: 100 }
      : { sort: "newest", limit: 20 },
  );

  const { data: hashtagData, isLoading: hashtagsLoading } = useListHashtags(
    { limit: 100 },
    { query: { enabled: filterMode === "hashtags" } },
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

  const handleHallOfFame = () => {
    setFilterMode("hall-of-fame");
    setSelectedTags([]);
  };

  const handleHashtags = () => {
    setFilterMode("hashtags");
  };

  const toggleTag = (tagName: string) => {
    setSelectedTags(prev => {
      if (prev.includes(tagName)) {
        return prev.filter(t => t !== tagName);
      }
      return [...prev, tagName];
    });
  };

  const isLoaded = !isLoading;
  const showRank = filterMode === "hall-of-fame";

  return (
    <Layout>
      {/* Hero Section */}
      <section className="relative pt-24 pb-10 md:pt-32 md:pb-14 overflow-hidden border-b-4 border-primary">
        <div className="absolute inset-0 z-0">
          <img 
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`} 
            alt="Hero Action Background" 
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
            The Universe Doesn't Expand. <br/>
            <span className="text-primary block mt-2 transform -skew-x-6 drop-shadow-[0_0_30px_rgba(249,115,22,0.8)]">{name} Pushes It.</span>
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 font-medium"
          >
            The ultimate personalized facts database. Set your name above — every fact becomes yours.
          </motion.p>

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
                placeholder="Find a fact..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-14 pl-12 pr-4 bg-background/80 backdrop-blur border-2 border-border focus:border-primary text-lg font-bold rounded-sm outline-none transition-colors shadow-2xl"
              />
            </div>
            <Button type="submit" size="lg" className="shrink-0 w-full sm:w-auto">
              SEARCH
            </Button>
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
              onClick={handleHallOfFame}
            >
              🏆 HALL OF FAME
            </Button>
            <Button
              variant={filterMode === "hashtags" ? "primary" : "outline"}
              size="lg"
              className="gap-2"
              onClick={handleHashtags}
            >
              # HASHTAGS
            </Button>
          </motion.div>

          {/* Hashtag Picker */}
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
                {hashtagsLoading && (
                  <div className="flex gap-3 overflow-x-auto pb-2 justify-center flex-wrap">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className="h-9 w-24 bg-card/50 border-2 border-border rounded-sm animate-pulse shrink-0" />
                    ))}
                  </div>
                )}
                {!hashtagsLoading && hashtagData?.hashtags && hashtagData.hashtags.length > 0 && (
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
                              ? "bg-primary border-primary text-primary-foreground"
                              : "bg-card/50 border-border hover:border-primary hover:bg-primary/10 text-foreground"
                          )}
                        >
                          <span className={cn(isSelected ? "text-primary-foreground" : "text-primary")}>#</span>
                          <span>{tag.name}</span>
                          <span className={cn("ml-0.5 text-xs", isSelected ? "text-primary-foreground/70" : "text-muted-foreground")}>
                            {tag.factCount}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {!hashtagsLoading && (!hashtagData?.hashtags || hashtagData.hashtags.length === 0) && (
                  <p className="text-muted-foreground text-sm mt-2">No hashtags yet.</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      {/* Unified Fact Grid */}
      <section className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-end justify-between mb-6 border-b-2 border-border pb-4">
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
                  {selectedTags.length > 0
                    ? selectedTags.map(t => `#${t}`).join(" + ")
                    : "HASHTAGS"}
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-pulse">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="h-64 bg-card border-2 border-border rounded-sm" />
                ))}
              </div>
            )}

            {error && (
              <div className="bg-destructive/10 border-2 border-destructive p-8 text-center rounded-sm">
                <p className="text-destructive font-bold text-xl uppercase">Error loading facts. {name} destroyed the server.</p>
              </div>
            )}

            {filterMode === "hashtags" && selectedTags.length === 0 && isLoaded && !error && (
              <div className="text-center py-20 bg-card border-2 border-dashed border-border rounded-sm">
                <p className="text-muted-foreground text-lg font-bold uppercase">Pick a hashtag above to filter facts.</p>
              </div>
            )}

            {isLoaded && !error && (filterMode !== "hashtags" || selectedTags.length > 0) && (
              <>
                {filteredFacts.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-12">
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
                )}
              </>
            )}
          </div>

          {/* Sidebar ad */}
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
