import { useState, useRef, useLayoutEffect, useCallback, useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { FactSummary } from "@workspace/api-client-react";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { FactComments } from "./FactComments";
import { FactActionCluster } from "./FactActionCluster";
import { HighlightedFactText } from "./HighlightedFactText";
import { useFactExpansion } from "@/contexts/fact-expansion-context";

type Size = "feed" | "hero" | "detail" | "variant";

export function FactCard({
  fact,
  rank,
  showRank = false,
  size = "feed",
  headerSlot,
  actionsSlot,
  onCommentClick,
}: {
  fact: FactSummary;
  rank?: number;
  showRank?: boolean;
  /** Visual scale + chrome.
      - `feed`: default card in feeds/grids.
      - `hero`: glow gradient + larger text; used for the random-fact billboard.
      - `detail`: the fact's own page — h1 headline, no Link wrap, larger padding.
      - `variant`: alternate-phrasing card — left rail border, custom actions slot. */
  size?: Size;
  /** Optional content rendered above the body. Used by the hero for the
      Random Fact badge + shuffle button, by TopFacts #1 for the period
      label, and by variants for the use-case pill. */
  headerSlot?: ReactNode;
  /** Replaces the default FactActionCluster row entirely. Used by variant
      cards to render their bespoke MAKE MEME / MAKE VIDEO controls. */
  actionsSlot?: ReactNode;
  /** When provided, the comment icon in the default action cluster calls
      this instead of toggling inline expansion. Used by the detail page
      to scroll to its full comments section below the fold. */
  onCommentClick?: () => void;
  index?: number;
}) {
  const { name, pronouns } = usePersonName();
  const isHero = size === "hero";
  const isDetail = size === "detail";
  const isVariant = size === "variant";
  // Detail/variant pages render their own full-fidelity comment surfaces
  // below the card, so the inline-expand affordance is suppressed there.
  const inlineExpansionEnabled = !isDetail && !isVariant;

  // Hero uses a card-local expansion state so toggling its comments
  // doesn't bleed into a feed copy of the same fact (which would otherwise
  // cause the feed-side card to expand below the hero — confusing UX).
  // Feed cards use the shared context so the inline expansion survives
  // re-renders and so reflowing the feed doesn't lose your draft.
  const sharedExpansion = useFactExpansion();
  const [localExpanded, setLocalExpanded] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const expanded = isHero ? localExpanded : sharedExpansion.isExpanded(fact.id);
  const toggle = isHero ? () => setLocalExpanded((v) => !v) : () => sharedExpansion.toggle(fact.id);
  const collapse = isHero ? () => setLocalExpanded(false) : () => sharedExpansion.collapse(fact.id);
  const getDraft = isHero ? () => localDraft : () => sharedExpansion.getDraft(fact.id);
  const setDraft = isHero
    ? (text: string) => setLocalDraft(text)
    : (text: string) => sharedExpansion.setDraft(fact.id, text);

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
      collapse();
    }
  }, [expanded, collapse]);

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

  // Opacity is driven via inline style (and matched by framer-motion's
  // animate prop) so React's first paint already carries the correct
  // value. iOS Safari was flashing the card at opacity 1 before
  // framer-motion's `initial` prop had a chance to apply, because the
  // inline-style hand-off and the animation system were racing on the
  // first frame.
  return (
    <motion.div
      ref={cardRef}
      animate={{ opacity: show ? 1 : 0 }}
      transition={instant ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
      whileHover={isHero || prefersReducedMotion ? undefined : { y: -3 }}
      onKeyDown={handleEscape}
      className={cn(
        // transition-colors only — letting transition-all win would
        // conflict with framer-motion's opacity animation on iOS Safari
        // and cause the load-in flash.
        "relative group block transition-colors duration-300 overflow-hidden",
        isHero && "rounded-[24px] md:rounded-[32px] border border-primary/25",
        isDetail && "bg-card rounded-2xl border border-border shadow-lg",
        isVariant && "bg-card rounded-sm border-l-4 border-y border-r border-primary/60 shadow-lg",
        !isHero && !isDetail && !isVariant && cn(
          "bg-card rounded-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border",
          expanded ? "border-primary/25" : "border-border hover:border-primary/40",
        ),
      )}
      style={{
        opacity: show ? 1 : 0,
        ...(isHero ? {
          background: "linear-gradient(145deg, hsl(var(--card)) 0%, rgba(249,115,22,0.07) 100%)",
          boxShadow: "0 0 60px rgba(249,115,22,0.10), inset 0 1px 0 rgba(255,255,255,0.07)",
        } : {}),
      }}
    >
      {showRank && rank && (
        <div
          className={cn(
            "absolute top-0 left-0 min-w-[2.5rem] h-10 px-2 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center z-10 rounded-br-[12px]",
            isHero ? "rounded-tl-[24px] md:rounded-tl-[32px]" : "rounded-tl-[20px]",
          )}
        >
          #{rank}
        </div>
      )}

      {headerSlot && (
        <div className={cn(
          "relative z-10",
          isHero ? "px-5 md:px-10 pt-5 md:pt-8" : "px-5 sm:px-6 pt-5",
          (isDetail || isVariant) && "px-6 md:px-8 pt-6 md:pt-8",
          showRank && rank && "pl-14 sm:pl-16",
        )}>
          {headerSlot}
        </div>
      )}

      <div className={cn(
        "relative z-10",
        isHero && "p-5 md:px-10 md:py-7",
        (isDetail || isVariant) && "p-6 md:p-8",
        !isHero && !isDetail && !isVariant && "p-5 sm:p-6",
        showRank && rank && !headerSlot && "pt-14 sm:pt-14",
      )}>
        {/* Fact text — feed/hero/variant link to the detail page; on the
            detail page itself we're already there, so we render plain text. */}
        {isDetail ? (
          <h1 className="text-2xl md:text-3xl font-display font-bold text-foreground leading-tight uppercase tracking-tight mb-4">
            {'"'}<HighlightedFactText template={fact.text} name={name} pronouns={pronouns} />{'"'}
          </h1>
        ) : (
          <Link href={`/facts/${fact.id}`} className="block w-full text-left mb-4 hover:opacity-90 transition-opacity">
            {isHero ? (
              <h2 className="font-display font-bold text-foreground leading-[0.95] uppercase tracking-tight" style={{ fontSize: "clamp(28px, 6.5vw, 56px)", textWrap: "pretty" } as React.CSSProperties}>
                {'"'}<HighlightedFactText template={fact.text} name={name} pronouns={pronouns} />{'"'}
              </h2>
            ) : isVariant ? (
              <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground leading-tight uppercase tracking-tight">
                {'"'}<HighlightedFactText template={fact.text} name={name} pronouns={pronouns} />{'"'}
              </h2>
            ) : (
              <h3 className="text-lg sm:text-xl md:text-2xl font-display font-bold text-foreground leading-tight uppercase tracking-tight">
                {'"'}<HighlightedFactText template={fact.text} name={name} pronouns={pronouns} />{'"'}
              </h3>
            )}
          </Link>
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
          {actionsSlot ?? (
            <FactActionCluster
              fact={{ ...fact, commentCount: fact.commentCount + commentCountDelta }}
              onCommentClick={onCommentClick ?? toggle}
              size={isHero ? "lg" : isDetail ? "md" : "sm"}
              commentAriaExpanded={!onCommentClick && inlineExpansionEnabled ? expanded : undefined}
              commentAriaControls={!onCommentClick && inlineExpansionEnabled ? commentsRegionId : undefined}
            />
          )}
        </div>

        {/* Inline expansion */}
        {inlineExpansionEnabled && (
          <AnimatePresence>
            {expanded && (
              <FactComments
                fact={fact}
                variant="feed"
                name={name}
                draft={getDraft()}
                onDraftChange={setDraft}
                onCommentSubmit={() => setCommentCountDelta(d => d + 1)}
                onCommentError={() => setCommentCountDelta(d => Math.max(0, d - 1))}
              />
            )}
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}
