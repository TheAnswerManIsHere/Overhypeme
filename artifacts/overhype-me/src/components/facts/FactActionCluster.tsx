import { useState } from "react";
import { useLocation } from "wouter";
import { MessageSquare, ThumbsUp, ThumbsDown, Flame } from "lucide-react";
import { FactSummary } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { cn } from "@/components/ui/Button";
import { useToast } from "@/hooks/use-toast";

type Size = "sm" | "md" | "lg";

type Props = {
  fact: FactSummary;
  onCommentClick: () => void;
  size?: Size;
  /** ARIA attrs for the comment button — used by callers that toggle an
      inline expansion below the cluster. */
  commentAriaExpanded?: boolean;
  commentAriaControls?: string;
};

const SIZES: Record<Size, {
  pillH: string;
  pillUpPad: string;
  pillDownPad: string;
  pillIcon: string;
  countText: string;
  divH: string;
  iconLg: string;
  iconCount: string;
  ctaPad: string;
  ctaText: string;
  ctaIcon: string;
}> = {
  sm: {
    pillH: "h-8",
    pillUpPad: "pl-3 pr-2",
    pillDownPad: "px-2.5",
    pillIcon: "w-4 h-4",
    countText: "text-xs font-bold",
    divH: "h-3.5",
    iconLg: "w-5 h-5",
    iconCount: "text-xs font-semibold",
    ctaPad: "px-3 py-1.5",
    ctaText: "text-[11px]",
    ctaIcon: "w-3 h-3",
  },
  md: {
    pillH: "h-9",
    pillUpPad: "pl-4 pr-2.5",
    pillDownPad: "px-2.5",
    pillIcon: "w-4 h-4",
    countText: "text-sm font-bold",
    divH: "h-4",
    iconLg: "w-5 h-5",
    iconCount: "text-sm font-semibold",
    ctaPad: "px-3.5 py-2",
    ctaText: "text-[12px]",
    ctaIcon: "w-3.5 h-3.5",
  },
  lg: {
    pillH: "h-10",
    pillUpPad: "pl-3.5 pr-2.5",
    pillDownPad: "px-3",
    pillIcon: "w-5 h-5",
    countText: "text-sm font-bold",
    divH: "h-4",
    iconLg: "w-5 h-5",
    iconCount: "text-[13px] font-bold",
    ctaPad: "px-7 py-2.5",
    ctaText: "text-[13px]",
    ctaIcon: "w-4 h-4",
  },
};

export function FactActionCluster({ fact, onCommentClick, size = "sm", commentAriaExpanded, commentAriaControls }: Props) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const s = SIZES[size];

  // Local optimistic share count so the UI reflects taps even before the
  // POST resolves. Server is the source of truth on next page load.
  const [localShareDelta, setLocalShareDelta] = useState(0);
  const displayedShareCount = (fact.shareCount ?? 0) + localShareDelta;

  const handleRate = (e: React.MouseEvent, type: "up" | "down") => {
    e.stopPropagation();
    if (!isAuthenticated) { setLocation(`/login?from=/facts/${fact.id}`); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}/facts/${fact.id}`;
    if (navigator.share) {
      await navigator.share({ url }).catch(() => null);
    } else {
      const copied = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
      if (copied) toast({ title: "Link copied to clipboard", duration: 2000 });
    }
    // Fire-and-forget: increment server counter. Failure is silent — the
    // share itself already happened from the user's POV.
    setLocalShareDelta((d) => d + 1);
    void fetch(`/api/facts/${fact.id}/share`, { method: "POST", credentials: "include" }).catch(() => null);
  };

  const handleComment = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCommentClick();
  };

  const handleMakeMeme = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLocation(`/facts/${fact.id}/meme`);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {/* Vote pill (up + down combined) */}
        <div className={cn(
          "inline-flex items-center rounded-full border transition-colors",
          s.pillH,
          fact.userRating === "up"
            ? "bg-primary/[0.14] border-primary text-primary"
            : "bg-secondary border-border/80 text-foreground",
        )}>
          <button
            onClick={(e) => handleRate(e, "up")}
            disabled={rateFact.isPending}
            className={cn("flex items-center gap-1.5 h-full", s.pillUpPad)}
            title="Upvote"
          >
            <ThumbsUp className={cn(s.pillIcon, fact.userRating === "up" && "fill-current")} />
            <span className={s.countText}>{fact.upvotes}</span>
          </button>
          <span className={cn("w-px bg-border/80 flex-shrink-0", s.divH)} />
          <button
            onClick={(e) => handleRate(e, "down")}
            disabled={rateFact.isPending}
            className={cn(
              "flex items-center h-full transition-colors",
              s.pillDownPad,
              fact.userRating === "down" ? "text-destructive" : "text-muted-foreground/60 hover:text-muted-foreground",
            )}
            title="Downvote"
          >
            <ThumbsDown className={cn("w-3.5 h-3.5", fact.userRating === "down" && "fill-current")} />
          </button>
        </div>

        {/* Comments */}
        <button
          onClick={handleComment}
          aria-expanded={commentAriaExpanded}
          aria-controls={commentAriaControls}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          title="Comments"
        >
          <MessageSquare className={s.iconLg} />
          <span className={s.iconCount}>{fact.commentCount}</span>
        </button>

        {/* Share */}
        <button
          onClick={handleShare}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          title="Share"
        >
          <svg className={s.iconLg} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          {displayedShareCount > 0 && (
            <span className={s.iconCount}>{displayedShareCount}</span>
          )}
        </button>
      </div>

      {/* Make a Meme — primary CTA, right-aligned */}
      <button
        onClick={handleMakeMeme}
        className={cn(
          "flex-shrink-0 flex items-center gap-1.5 bg-primary text-white rounded-full font-display font-bold uppercase tracking-[0.1em] hover:bg-primary/90 active:scale-95 transition-all shadow-[0_0_12px_rgba(249,115,22,0.35)]",
          s.ctaPad,
          s.ctaText,
        )}
      >
        <Flame className={s.ctaIcon} />
        Make a Meme
      </button>
    </div>
  );
}
