import { useState, useRef, useLayoutEffect, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { FactSummary } from "@workspace/api-client-react";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";
import { FactCardComments } from "./FactCardComments";
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

export function FactCard({
  fact,
  rank,
  showRank = false,
  index = 0,
}: {
  fact: FactSummary;
  rank?: number;
  showRank?: boolean;
  index?: number;
}) {
  const { name, pronouns } = usePersonName();
  const { isExpanded, toggle, collapse, getDraft, setDraft } = useFactExpansion();
  const expanded = isExpanded(fact.id);
  const [commentCountDelta, setCommentCountDelta] = useState(0);
  const prevCommentCountRef = useRef(fact.commentCount);

  useEffect(() => {
    const increase = fact.commentCount - prevCommentCountRef.current;
    if (increase > 0 && commentCountDelta > 0) {
      setCommentCountDelta(d => Math.max(0, d - increase));
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

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: show ? 1 : 0 }}
      transition={instant ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
      whileHover={prefersReducedMotion ? undefined : { y: -3 }}
      onKeyDown={handleEscape}
      className={cn(
        "relative group block bg-card rounded-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border transition-all duration-300 overflow-hidden",
        expanded ? "border-primary/25" : "border-border hover:border-primary/40"
      )}
    >
      {showRank && rank && (
        <div className="absolute top-0 left-0 min-w-[2.5rem] h-10 px-2 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center z-10 rounded-tl-[20px] rounded-br-[12px]">
          #{rank}
        </div>
      )}

      <div className={cn("relative z-10 p-5 sm:p-6", showRank && rank && "pt-14 sm:pt-14")}>
        {/* Fact text — tap to expand */}
        <button onClick={() => toggle(fact.id)} className="block w-full text-left mb-4">
          <h3 className="text-lg sm:text-xl md:text-2xl font-display font-bold text-foreground leading-tight uppercase tracking-tight">
            {'"'}<HighlightName text={renderFact(fact.text, name, pronouns)} name={name} />{'"'}
          </h3>
        </button>

        {/* Hashtags */}
        {fact.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {fact.hashtags.map(tag => (
              <Link
                key={tag}
                href={`/search?q=%23${tag}`}
                onClick={e => e.stopPropagation()}
                className="text-xs font-semibold font-display tracking-wide text-muted-foreground hover:text-primary transition-colors bg-secondary/80 px-2.5 py-1 rounded-full uppercase"
              >
                #{tag}
              </Link>
            ))}
          </div>
        )}

        {/* Engagement row */}
        <div className="pt-3 border-t border-border/50">
          <FactActionCluster
            fact={{ ...fact, commentCount: fact.commentCount + commentCountDelta }}
            onCommentClick={() => toggle(fact.id)}
            size="sm"
            commentAriaExpanded={expanded}
            commentAriaControls={commentsRegionId}
          />
        </div>

        {/* Inline expansion */}
        <AnimatePresence>
          {expanded && (
            <FactCardComments
              fact={fact}
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
