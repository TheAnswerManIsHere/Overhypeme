import { useState } from "react";
import { useLocation } from "wouter";
import { useListFacts } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";
import { cn } from "@/components/ui/Button";
import { Flame } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

type Period = "week" | "month" | "all";

const PERIOD_LABELS: Record<Period, string> = {
  week: "This week",
  month: "This month",
  all: "All time",
};

export default function TopFacts() {
  const [period, setPeriod] = useState<Period>("week");
  const [, setLocation] = useLocation();
  const { name, pronouns } = usePersonName();
  const prefersReducedMotion = useReducedMotion();

  const { data, isLoading } = useListFacts({ sort: "top", limit: 20 });
  const facts = data?.facts ?? [];

  const [topFact, ...restFacts] = facts;

  const renderBillboard = (text: string) => {
    const rendered = renderFact(text, name, pronouns);
    const parts = rendered.split(name);
    return parts.map((p, i) =>
      i < parts.length - 1 ? (
        <span key={i}>{p}<span className="text-primary">{name}</span></span>
      ) : (
        <span key={i}>{p}</span>
      )
    );
  };

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
            {/* #1 — featured hero card */}
            {topFact && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-[20px] bg-card shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border border-border p-5 md:p-8 mb-5"
              >
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center font-display font-bold text-base text-white">1</div>
                  <div>
                    <p className="text-xs font-bold tracking-[0.14em] text-primary uppercase font-display">#1 {PERIOD_LABELS[period]}</p>
                    <p className="text-[11px] text-muted-foreground">
                      <strong className="text-foreground">{(topFact.upvotes / 1000).toFixed(1)}k</strong> hypes
                    </p>
                  </div>
                </div>

                <h2 className="font-display font-bold text-2xl md:text-4xl uppercase tracking-tight leading-[1.05] mb-6">
                  {renderBillboard(topFact.text)}
                </h2>

                <button
                  onClick={() => setLocation(`/facts/${topFact.id}`)}
                  className="w-full h-12 bg-primary text-white rounded-[12px] font-display font-bold text-sm uppercase tracking-wider hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                >
                  Make a meme of this →
                </button>
              </motion.div>
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

            {/* Ranks #2–4 compact */}
            <div className="space-y-3 mb-6">
              {restFacts.slice(0, 3).map((fact, i) => {
                const rendered = renderFact(fact.text, name, pronouns);
                const parts = rendered.split(name);
                return (
                  <motion.div
                    key={fact.id}
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={prefersReducedMotion ? { duration: 0 } : { delay: i * 0.05 }}
                    onClick={() => setLocation(`/facts/${fact.id}`)}
                    className="rounded-[16px] bg-card border border-border p-4 flex items-center gap-4 cursor-pointer hover:border-primary/40 transition-colors"
                  >
                    <div className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center font-display font-bold text-sm text-muted-foreground flex-shrink-0">
                      {i + 2}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-display font-bold text-sm uppercase tracking-tight leading-tight line-clamp-2">
                        {parts.map((p, j) =>
                          j < parts.length - 1
                            ? <span key={j}>{p}<span className="text-primary">{name}</span></span>
                            : <span key={j}>{p}</span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {(fact.upvotes / 1000).toFixed(1)}k hypes
                      </p>
                    </div>
                    <span className="text-muted-foreground text-lg flex-shrink-0">›</span>
                  </motion.div>
                );
              })}
            </div>

            {/* #5+ grid */}
            {restFacts.length > 3 && (
              <>
                <p className="text-xs font-bold tracking-[0.16em] text-muted-foreground uppercase font-display mb-3">
                  More legends
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {restFacts.slice(3).map((fact, i) => (
                    <FactCard key={fact.id} fact={fact} rank={i + 5} showRank={true} />
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
