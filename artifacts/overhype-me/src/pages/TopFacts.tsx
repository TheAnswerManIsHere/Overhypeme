import { useState } from "react";
import { useListFacts } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { cn } from "@/components/ui/Button";
import { Flame } from "lucide-react";

type Period = "week" | "month" | "all";

const PERIOD_LABELS: Record<Period, string> = {
  week: "This week",
  month: "This month",
  all: "All time",
};

export default function TopFacts() {
  const [period, setPeriod] = useState<Period>("week");

  const { data, isLoading } = useListFacts({ sort: "top", limit: 20 });
  const facts = data?.facts ?? [];

  const [topFact, ...restFacts] = facts;

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-6 md:py-12">
        {/* Header */}
        <div className="mb-6 md:mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Flame className="w-5 h-5 text-primary" />
            <span className="text-xs font-bold tracking-[0.18em] text-primary uppercase font-display">🔥 Top Facts</span>
          </div>
          <h1 className="font-display font-bold text-3xl md:text-6xl uppercase tracking-tight leading-none mb-3">
            The facts <span className="text-primary">everyone's</span> memeing.
          </h1>
          <p className="text-sm md:text-base text-muted-foreground">
            Pick any fact. Make it about you. Wear it.
          </p>
        </div>

        {/* Period filter pills */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
          {(Object.keys(PERIOD_LABELS) as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors",
                period === p
                  ? "bg-foreground text-background"
                  : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
              )}
            >
              {period === p && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
              {PERIOD_LABELS[p]}
            </button>
          ))}
          <div className="w-px h-8 bg-border self-center mx-1" />
          <button className="flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold bg-card border border-border text-muted-foreground hover:text-foreground transition-colors">
            #cosmic
          </button>
          <button className="flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold bg-card border border-border text-muted-foreground hover:text-foreground transition-colors">
            #origin
          </button>
          <button className="flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold bg-card border border-border text-muted-foreground hover:text-foreground transition-colors">
            #legendary
          </button>
        </div>

        {isLoading && (
          <div className="space-y-4 animate-pulse">
            <div className="h-48 rounded-[20px] bg-card border border-border" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-36 rounded-[20px] bg-card border border-border" />
              ))}
            </div>
          </div>
        )}

        {!isLoading && facts.length > 0 && (
          <>
            {/* #1 — featured hero card. Same FactCard primitive as the
                feed/detail/variant pages; the period label + hypes count
                ride in the headerSlot, rank shows as the corner badge. */}
            {topFact && (
              <div className="mb-5">
                <FactCard
                  fact={topFact}
                  size="hero"
                  rank={1}
                  showRank
                  headerSlot={
                    <div className="flex justify-end mb-2 md:mb-4">
                      <div className="text-right">
                        <p className="text-xs font-bold tracking-[0.14em] text-primary uppercase font-display">#1 {PERIOD_LABELS[period]}</p>
                        <p className="text-[11px] text-muted-foreground">
                          <strong className="text-foreground">{(topFact.upvotes / 1000).toFixed(1)}k</strong> hypes
                        </p>
                      </div>
                    </div>
                  }
                />
              </div>
            )}

            {/* Section label */}
            {restFacts.length > 0 && (
              <div className="flex items-baseline justify-between mb-3 mt-8">
                <p className="text-xs font-bold tracking-[0.16em] text-muted-foreground uppercase font-display">
                  Also moving fast
                </p>
                <p className="text-xs text-muted-foreground">
                  {facts.length} facts total →
                </p>
              </div>
            )}

            {/* Ranks #2–4 — same FactCard with rank prop. Layout grid
                is single-column to keep them visually subordinate to #1. */}
            {restFacts.slice(0, 3).length > 0 && (
              <div className="grid grid-cols-1 gap-4 mb-6">
                {restFacts.slice(0, 3).map((fact, i) => (
                  <FactCard key={fact.id} fact={fact} rank={i + 2} showRank />
                ))}
              </div>
            )}

            {/* #5+ grid */}
            {restFacts.length > 3 && (
              <>
                <p className="text-xs font-bold tracking-[0.16em] text-muted-foreground uppercase font-display mb-3">
                  More legends
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {restFacts.slice(3).map((fact, i) => (
                    <FactCard key={fact.id} fact={fact} rank={i + 5} showRank />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {!isLoading && facts.length === 0 && (
          <div className="text-center py-20 bg-card rounded-[20px] border border-border">
            <p className="text-muted-foreground font-bold uppercase">No facts yet. Be the first legend.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}
