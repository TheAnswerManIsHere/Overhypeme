import { useState, useRef, useLayoutEffect, useCallback, useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { FactSummary } from "@workspace/api-client-react";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";
import { FactComments } from "./FactComments";
import { FactActionCluster } from "./FactActionCluster";
import { useFactExpansion } from "@/contexts/fact-expansion-context";

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

type Size = "feed" | "hero";

export function FactCard({
  fact,
  rank,
  showRank = false,
  size = "feed",
  headerSlot,
}: {
  fact: FactSummary;
  rank?: number;
  showRank?: boolean;
  /** Visual scale + chrome. `feed` is the default; `hero` adds a glow
      gradient border, larger text, and a slot above the body for
      a "Random Fact" badge + "Next Random Fact" button. */
  size?: Size;
  /** Optional content rendered above the body — used by the hero
      to host the badge + shuffle button. */
  headerSlot?: ReactNode;
  index?: number;
}) {
  const { name, pronouns } = usePersonName();
  const { isExpanded, toggle, collapse, getDraft, setDraft } = useFactExpansion();
  const expanded = isExpanded(fact.id);
  const [commentCountDelta, setCommentCountDelta] = useState(0);
  const prevCommentCountRef = useRef(fact.commentCount);

  useEffect(() => {
    if (fact.commentCount > prevCommentCountRef.current) {
      // Server count advanced — it now includes the comment we were tracking
      // optimistically. Zero the delta so we don't double-count.
      setCommentCountDelta(0);
    }
    prevCommentCountRef.current = fact.commentCount;
  }, [fact.commentCount]);

  const handleEscape = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" && expanded) {
      collapse(fact.id);
    }
  }, [expanded, collapse, fact.id]);

  const cardRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const [show, setShow] = useState(false);
  const [instant, setInstant] = useState(false);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    if (prefersReducedMotion) {
      setInstant(true);
      setShow(true);
      return;
    }

    const { top, bottom } = el.getBoundingClientRect();
    if (top < window.innerHeight && bottom > 0) {
      setInstant(true);
      setShow(true);
      return;
    }

    let rafId = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          setShow(true);
        }
      },
      { threshold: 0.01 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commentsRegionId = `fact-${fact.id}-comments`;
  const isHero = size === "hero";

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: show ? 1 : 0 }}
      transition={instant ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
      whileHover={isHero || prefersReducedMotion ? undefined : { y: -3 }}
      onKeyDown={handleEscape}
      className={cn(
        "relative group block transition-all duration-300 overflow-hidden",
        isHero
          ? "rounded-[24px] md:rounded-[32px] border border-primary/25"
          : cn(
              "bg-card rounded-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border",
              expanded ? "border-primary/25" : "border-border hover:border-primary/40",
            ),
      )}
      style={isHero ? {
        background: "linear-gradient(145deg, hsl(var(--card)) 0%, rgba(249,115,22,0.07) 100%)",
        boxShadow: "0 0 60px rgba(249,115,22,0.10), inset 0 1px 0 rgba(255,255,255,0.07)",
      } : undefined}
    >
      {showRank && rank && !isHero && (
        <div className="absolute top-0 left-0 min-w-[2.5rem] h-10 px-2 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center z-10 rounded-tl-[20px] rounded-br-[12px]">
          #{rank}
        </div>
      )}

      {headerSlot && (
        <div className={cn("relative z-10", isHero ? "px-5 md:px-10 pt-5 md:pt-8" : "px-5 sm:px-6 pt-5")}>
          {headerSlot}
        </div>
      )}

      <div className={cn(
        "relative z-10",
        isHero ? "p-5 md:px-10 md:py-7" : "p-5 sm:p-6",
        showRank && rank && !isHero && "pt-14 sm:pt-14",
      )}>
        {/* Fact text — tap to expand on feed; on hero, links to detail */}
        {isHero ? (
          <Link href={`/facts/${fact.id}`} className="block w-full text-left mb-4 hover:opacity-90 transition-opacity">
            <h2 className="font-display font-bold text-foreground leading-[0.95] uppercase tracking-tight" style={{ fontSize: "clamp(28px, 6.5vw, 56px)", textWrap: "pretty" } as React.CSSProperties}>
              {'"'}<HighlightName text={renderFact(fact.text, name, pronouns)} name={name} />{'"'}
            </h2>
          </Link>
        ) : (
          <button onClick={() => toggle(fact.id)} className="block w-full text-left mb-4">
            <h3 className="text-lg sm:text-xl md:text-2xl font-display font-bold text-foreground leading-tight uppercase tracking-tight">
              {'"'}<HighlightName text={renderFact(fact.text, name, pronouns)} name={name} />{'"'}
            </h3>
          </button>
        )}

        {/* Hashtags */}
        {fact.hashtags.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5 mb-4", isHero && "gap-2 mb-5")}>
            {fact.hashtags.map(tag => (
              <Link
                key={tag}
                href={`/search?q=%23${tag}`}
                onClick={e => e.stopPropagation()}
                className={cn(
                  "font-semibold font-display tracking-wide transition-colors uppercase",
                  isHero
                    ? "text-[12px] text-primary/80 hover:text-primary bg-primary/10 px-3 py-1.5 rounded-full"
                    : "text-xs text-muted-foreground hover:text-primary bg-secondary/80 px-2.5 py-1 rounded-full",
                )}
              >
                #{tag}
              </Link>
            ))}
          </div>
        )}

        {/* Engagement row */}
        <div className={cn(
          "border-t",
          isHero ? "pt-4 border-primary/15" : "pt-3 border-border/50",
        )}>
          <FactActionCluster
            fact={{ ...fact, commentCount: fact.commentCount + commentCountDelta }}
            onCommentClick={() => toggle(fact.id)}
            size={isHero ? "lg" : "sm"}
            commentAriaExpanded={expanded}
            commentAriaControls={commentsRegionId}
          />
        </div>

        {/* Inline expansion */}
        <AnimatePresence>
          {expanded && (
            <FactComments
              fact={fact}
              variant="feed"
              name={name}
              draft={getDraft(fact.id)}
              onDraftChange={(text) => setDraft(fact.id, text)}
              onCommentSubmit={() => setCommentCountDelta(d => d + 1)}
              onCommentError={() => setCommentCountDelta(d => Math.max(0, d - 1))}
            />
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
