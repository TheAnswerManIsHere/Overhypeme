import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { MessageSquare, ThumbsUp, ThumbsDown, Flame } from "lucide-react";
import { FactSummary, useListComments, getListCommentsQueryKey } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";

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

function InlineExpansion({ fact, name }: { fact: FactSummary; name: string }) {
  const [, setLocation] = useLocation();

  const { data: commentsData } = useListComments(fact.id, { limit: 3 }, {
    query: { queryKey: getListCommentsQueryKey(fact.id, { limit: 3 }) }
  });

  const topComments = commentsData?.comments?.slice(0, 2) ?? [];

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
      className="mt-3 pt-4 border-t border-border/50"
    >
      {/* Top 2 comments */}
      {topComments.length > 0 && (
        <div className="space-y-3 mb-3">
          {topComments.map((c) => (
            <div key={c.id} className="flex gap-2.5">
              <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 text-xs font-bold font-display text-primary">
                {(c.authorName?.[0] ?? "?").toUpperCase()}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed pt-1.5">
                <span className="text-foreground font-semibold">{c.authorName ?? "Anonymous"}</span>{" "}{c.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* See all */}
      <Link
        href={`/facts/${fact.id}#comments`}
        className="block text-xs font-semibold text-muted-foreground hover:text-primary transition-colors mb-4"
      >
        See all {fact.commentCount} comments →
      </Link>

      {/* Reply teaser — tapping navigates to full page */}
      <div className="flex gap-2.5 items-center mb-4">
        <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 text-xs font-bold font-display text-primary">
          {name ? name[0].toUpperCase() : "?"}
        </div>
        <button
          onClick={() => setLocation(`/facts/${fact.id}#comments`)}
          className="flex-1 h-9 px-3.5 bg-secondary border border-border rounded-full text-sm text-muted-foreground text-left hover:border-primary/40 transition-colors"
        >
          Add a comment…
        </button>
      </div>

      {/* Make a meme — primary action */}
      <button
        onClick={() => setLocation(`/facts/${fact.id}/meme`)}
        className="w-full h-11 bg-primary text-white rounded-xl font-display font-bold text-sm tracking-widest uppercase flex items-center justify-center gap-2 hover:opacity-90 transition-opacity shadow-[0_4px_16px_rgba(255,101,0,0.25)]"
      >
        <Flame className="w-4 h-4" />
        Make a meme of this
      </button>

      {/* Open fact page — secondary */}
      <Link
        href={`/facts/${fact.id}`}
        className="block w-full text-center text-xs text-muted-foreground hover:text-primary transition-colors mt-2 py-1 font-medium"
      >
        Open fact page
      </Link>
    </motion.div>
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
  const { rateFact } = useAppMutations();
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { name, pronouns } = usePersonName();
  const [expanded, setExpanded] = useState(false);

  const handleRate = (e: React.MouseEvent, type: "up" | "down") => {
    e.stopPropagation();
    if (!isAuthenticated) { setLocation(`/login?from=/facts/${fact.id}`); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  const prefersReducedMotion = useReducedMotion();
  const staggerDelay = Math.min(index * 0.07, 0.35);

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0 }}
      whileInView={prefersReducedMotion ? undefined : { opacity: 1 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.4, ease: "easeOut", delay: staggerDelay }}
      whileHover={prefersReducedMotion ? undefined : { y: -3 }}
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
        <button onClick={() => setExpanded(v => !v)} className="block w-full text-left mb-4">
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
        <div className="flex items-center justify-between pt-3 border-t border-border/50">
          <div className="flex items-center gap-3">
            {/* Upvote pill with nested downvote — upvote is prominent, downvote is secondary */}
            <div className={cn(
              "inline-flex items-center rounded-full border h-8 transition-colors",
              fact.userRating === "up"
                ? "bg-primary/[0.14] border-primary text-primary"
                : "bg-secondary border-border/80 text-foreground"
            )}>
              <button
                onClick={(e) => handleRate(e, "up")}
                disabled={rateFact.isPending}
                className="flex items-center gap-1.5 pl-3 pr-2 h-full"
                title="Upvote"
              >
                <ThumbsUp className={cn("w-4 h-4", fact.userRating === "up" && "fill-current")} />
                <span className="text-xs font-bold">{fact.upvotes}</span>
              </button>
              <span className="w-px h-3.5 bg-border/80 flex-shrink-0" />
              <button
                onClick={(e) => handleRate(e, "down")}
                disabled={rateFact.isPending}
                className={cn(
                  "flex items-center px-2.5 h-full transition-colors",
                  fact.userRating === "down" ? "text-destructive" : "text-muted-foreground/60 hover:text-muted-foreground"
                )}
                title="Downvote"
              >
                <ThumbsDown className={cn("w-3.5 h-3.5", fact.userRating === "down" && "fill-current")} />
              </button>
            </div>

            {/* Comments — also toggles expand */}
            <button
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <MessageSquare className="w-5 h-5" />
              <span className="text-xs font-semibold">{fact.commentCount}</span>
            </button>
          </div>

          <button
            onClick={e => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Share"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {/* Inline expansion */}
        <AnimatePresence>
          {expanded && <InlineExpansion fact={fact} name={name} />}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
