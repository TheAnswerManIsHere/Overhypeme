import { Link, useLocation } from "wouter";
import { motion, useReducedMotion } from "framer-motion";
import { MessageSquare, ThumbsUp, ThumbsDown } from "lucide-react";
import { FactSummary } from "@workspace/api-client-react";
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

export function FactCard({ fact, rank, showRank = false, index = 0 }: { fact: FactSummary, rank?: number, showRank?: boolean, index?: number }) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { name, pronouns } = usePersonName();

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) { setLocation(`/login?from=/facts/${fact.id}`); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  const prefersReducedMotion = useReducedMotion();
  const staggerDelay = Math.min(index * 0.07, 0.35);

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 28 }}
      whileInView={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.4, ease: "easeOut", delay: staggerDelay }}
      whileHover={prefersReducedMotion ? undefined : { y: -3 }}
      className="relative group block bg-card rounded-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border border-border hover:border-primary/40 transition-all duration-300 overflow-hidden"
    >
      {showRank && rank && (
        <div className="absolute top-0 left-0 min-w-[2.5rem] h-10 px-2 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center z-10 rounded-tl-[20px] rounded-br-[12px]">
          #{rank}
        </div>
      )}

      <div className={cn("relative z-10 p-5 sm:p-6", showRank && rank && "pt-14 sm:pt-14")}>
        {/* Fact text */}
        <Link href={`/facts/${fact.id}`} className="block mb-4">
          <h3 className="text-lg sm:text-xl md:text-2xl font-display font-bold text-foreground leading-tight uppercase tracking-tight">
            {'"'}<HighlightName text={renderFact(fact.text, name, pronouns)} name={name} />{'"'}
          </h3>
        </Link>

        {/* Hashtags */}
        {fact.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {fact.hashtags.map(tag => (
              <Link
                key={tag}
                href={`/search?q=%23${tag}`}
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
            <button
              onClick={() => handleRate("up")}
              disabled={rateFact.isPending}
              className={cn(
                "flex items-center gap-1.5 transition-colors",
                fact.userRating === "up" ? "text-primary" : "text-muted-foreground hover:text-primary"
              )}
            >
              <ThumbsUp className={cn("w-5 h-5", fact.userRating === "up" && "fill-current")} />
              <span className="text-xs font-semibold">{fact.upvotes}</span>
            </button>

            <button
              onClick={() => handleRate("down")}
              disabled={rateFact.isPending}
              className={cn(
                "flex items-center gap-1.5 transition-colors",
                fact.userRating === "down" ? "text-destructive" : "text-muted-foreground hover:text-destructive"
              )}
            >
              <ThumbsDown className={cn("w-5 h-5", fact.userRating === "down" && "fill-current")} />
              <span className="text-xs font-semibold">{fact.downvotes}</span>
            </button>

            <Link
              href={`/facts/${fact.id}`}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <MessageSquare className="w-5 h-5" />
              <span className="text-xs font-semibold">{fact.commentCount}</span>
            </Link>
          </div>

          <button className="text-muted-foreground hover:text-foreground transition-colors" title="Share">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
