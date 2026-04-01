import { Link } from "wouter";
import { motion } from "framer-motion";
import { ThumbsUp, ThumbsDown, MessageSquare, ExternalLink as LinkIcon } from "lucide-react";
import { FactSummary } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";

export function FactCard({ fact, rank, showRank = false }: { fact: FactSummary, rank?: number, showRank?: boolean }) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated, login } = useAuth();
  const { name, pronounSubject, pronounObject } = usePersonName();

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) {
      login();
      return;
    }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      className="relative group block bg-card border-2 border-border hover:border-primary/50 p-6 sm:p-8 rounded-sm shadow-xl transition-all duration-300"
    >
      {/* Decorative corner accent */}
      <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary opacity-0 group-hover:opacity-100 transition-opacity translate-x-1 -translate-y-1" />
      <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary opacity-0 group-hover:opacity-100 transition-opacity -translate-x-1 translate-y-1" />

      {showRank && rank && (
        <div className="absolute -top-4 -left-4 w-10 h-10 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.4)] rotate-[-5deg]">
          #{rank}
        </div>
      )}

      <Link href={`/facts/${fact.id}`} className="block mb-6">
        <h3 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground leading-tight">
          "{renderFact(fact.text, name, pronounSubject, pronounObject)}"
        </h3>
      </Link>

      <div className="flex flex-wrap gap-2 mb-8">
        {fact.hashtags.map(tag => (
          <Link key={tag} href={`/search?q=%23${tag}`} className="text-xs font-bold font-display tracking-wider text-muted-foreground hover:text-primary transition-colors bg-secondary px-3 py-1 rounded-sm uppercase">
            #{tag}
          </Link>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <div className="flex items-center gap-1">
          <button 
            onClick={() => handleRate("up")}
            disabled={rateFact.isPending}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-sm transition-colors font-bold text-sm",
              fact.userRating === "up" ? "text-primary bg-primary/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
          >
            <ThumbsUp className={cn("w-5 h-5", fact.userRating === "up" && "fill-current")} />
            {fact.upvotes}
          </button>
          
          <button 
            onClick={() => handleRate("down")}
            disabled={rateFact.isPending}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-sm transition-colors font-bold text-sm",
              fact.userRating === "down" ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
          >
            <ThumbsDown className={cn("w-5 h-5", fact.userRating === "down" && "fill-current")} />
            {fact.downvotes}
          </button>
        </div>

        <Link href={`/facts/${fact.id}`} className="flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors text-sm font-bold px-3 py-2 rounded-sm hover:bg-secondary">
          <MessageSquare className="w-5 h-5" />
          {fact.commentCount} <span className="hidden sm:inline">COMMENTS</span>
        </Link>
      </div>
    </motion.div>
  );
}
