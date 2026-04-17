import { useListHashtags, useListFacts, getListFactsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Button } from "@/components/ui/Button";
import { Hash, ArrowLeft } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { motion, AnimatePresence } from "framer-motion";

export default function Hashtags() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const selectedHashtag = params.get("tag") || null;

  const { data: hashtagData, isLoading: hashtagsLoading } = useListHashtags({ limit: 100 });

  const { data: factsData, isLoading: factsLoading } = useListFacts(
    { hashtag: selectedHashtag ?? undefined, sort: "newest" },
    { query: { queryKey: getListFactsQueryKey({ hashtag: selectedHashtag ?? undefined, sort: "newest" }), enabled: !!selectedHashtag } },
  );

  const selectTag = (name: string) => {
    setLocation(`/hashtags?tag=${encodeURIComponent(name)}`);
  };

  const clearTag = () => {
    setLocation("/hashtags");
  };

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="mb-10 border-b-2 border-border pb-6">
          <div className="flex items-center gap-3 mb-2">
            {selectedHashtag && (
              <Button
                variant="ghost"
                size="icon"
                onClick={clearTag}
                title="Back to all hashtags"
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
            )}
            <Hash className="w-8 h-8 text-primary" />
            <h1 className="text-4xl font-display uppercase tracking-widest text-foreground">
              {selectedHashtag ? `#${selectedHashtag}` : "Hashtags"}
            </h1>
          </div>
          {!selectedHashtag && (
            <p className="text-muted-foreground font-medium ml-11">
              Browse facts by topic — sorted by most used.
            </p>
          )}
        </div>

        <AnimatePresence mode="wait">
          {!selectedHashtag ? (
            <motion.div
              key="hashtag-list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {hashtagsLoading && (
                <div className="flex flex-wrap gap-3">
                  {Array.from({ length: 16 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-10 w-28 bg-card border-2 border-border rounded-sm animate-pulse"
                    />
                  ))}
                </div>
              )}

              {!hashtagsLoading && hashtagData?.hashtags && hashtagData.hashtags.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {hashtagData.hashtags.map((tag) => (
                    <button
                      key={tag.id}
                      onClick={() => selectTag(tag.name)}
                      className="group flex items-center gap-2 px-4 py-2 bg-card border-2 border-border hover:border-primary hover:bg-primary/10 transition-colors rounded-sm font-bold text-sm uppercase tracking-wide cursor-pointer"
                    >
                      <span className="text-primary">#</span>
                      <span>{tag.name}</span>
                      <span className="ml-1 text-xs text-muted-foreground group-hover:text-primary transition-colors">
                        {tag.factCount}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {!hashtagsLoading && (!hashtagData?.hashtags || hashtagData.hashtags.length === 0) && (
                <div className="text-center py-20 bg-card border-2 border-dashed border-border rounded-sm">
                  <Hash className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                  <h3 className="text-2xl font-display uppercase text-muted-foreground">No hashtags yet</h3>
                  <p className="text-muted-foreground/80 mt-2">Submit some facts to get the tags rolling.</p>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key={`facts-${selectedHashtag}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="border-b-2 border-border pb-4 mb-8 flex justify-between items-end">
                <h2 className="text-xl font-display text-muted-foreground uppercase">
                  {factsLoading ? "Loading..." : `${factsData?.total ?? 0} Facts`}
                </h2>
              </div>

              {factsLoading && (
                <div className="space-y-6">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-40 bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              )}

              {!factsLoading && factsData?.facts && factsData.facts.length > 0 && (
                <div className="space-y-6">
                  {factsData.facts.map((fact) => (
                    <FactCard key={fact.id} fact={fact} />
                  ))}
                </div>
              )}

              {!factsLoading && (!factsData?.facts || factsData.facts.length === 0) && (
                <div className="text-center py-20 bg-card border-2 border-dashed border-border rounded-sm">
                  <Hash className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                  <h3 className="text-2xl font-display uppercase text-muted-foreground">No facts found</h3>
                  <p className="text-muted-foreground/80 mt-2">No facts tagged with #{selectedHashtag}.</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Layout>
  );
}
