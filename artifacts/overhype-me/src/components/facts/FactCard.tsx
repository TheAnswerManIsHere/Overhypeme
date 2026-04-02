import { useState, useCallback } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ThumbsUp, ThumbsDown, MessageSquare, RefreshCw } from "lucide-react";
import { FactSummary } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";

// ── Pexels image helpers ──────────────────────────────────────────────────────

interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male:    number[];
  female:  number[];
  neutral: number[];
}

type FactWithImages = FactSummary & { pexelsImages?: FactPexelsImages | null };

/** Maps the user's pronoun string to a Pexels gender variant. */
function pexelsVariant(pronouns: string): "male" | "female" | "neutral" {
  const subject = pronouns.split(/[/|]/)[0]?.toLowerCase() ?? "";
  if (subject === "he") return "male";
  if (subject === "she") return "female";
  return "neutral";
}

/** Constructs a Pexels CDN URL from a stored photo ID. */
function pexelsUrl(photoId: number, width = 800, height = 500): string {
  return `https://images.pexels.com/photos/${photoId}/pexels-photo-${photoId}.jpeg?auto=compress&cs=tinysrgb&w=${width}&h=${height}&fit=crop&dpr=1`;
}

const PREF_KEY = (factId: number) => `pref_img_${factId}`;

function loadStoredIndex(factId: number): number {
  try {
    const v = localStorage.getItem(PREF_KEY(factId));
    const n = parseInt(v ?? "", 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function saveStoredIndex(factId: number, index: number): void {
  try { localStorage.setItem(PREF_KEY(factId), String(index)); } catch { /* ignore */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FactCard({ fact, rank, showRank = false }: { fact: FactSummary, rank?: number, showRank?: boolean }) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated, login } = useAuth();
  const { name, pronouns } = usePersonName();

  const factWithImages = fact as FactWithImages;
  const images = factWithImages.pexelsImages ?? null;
  const variant = pexelsVariant(pronouns);
  const photoIds = images ? (images[variant] ?? []) : [];

  const [imgIndex, setImgIndex] = useState(() =>
    photoIds.length > 0 ? loadStoredIndex(fact.id) % photoIds.length : 0
  );

  const currentPhotoId = photoIds[imgIndex] ?? null;

  const handleRotate = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!photoIds.length) return;
    const next = (imgIndex + 1) % photoIds.length;
    setImgIndex(next);
    saveStoredIndex(fact.id, next);
  }, [imgIndex, photoIds, fact.id]);

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) { login(); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      className="relative group block bg-card border-2 border-border hover:border-primary/50 rounded-sm shadow-xl transition-all duration-300 overflow-hidden"
    >
      {/* Background image — visible only when photo IDs exist */}
      {currentPhotoId && (
        <div className="absolute inset-0 z-0" aria-hidden="true">
          <img
            src={pexelsUrl(currentPhotoId)}
            alt=""
            className="w-full h-full object-cover opacity-[0.12] transition-opacity duration-500"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/70 to-card/30" />
        </div>
      )}

      {/* Decorative corner accents */}
      <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary opacity-0 group-hover:opacity-100 transition-opacity translate-x-1 -translate-y-1 z-10" />
      <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary opacity-0 group-hover:opacity-100 transition-opacity -translate-x-1 translate-y-1 z-10" />

      {showRank && rank && (
        <div className="absolute -top-4 -left-4 w-10 h-10 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.4)] rotate-[-5deg] z-10">
          #{rank}
        </div>
      )}

      {/* Rotate button — only shown when images are available */}
      {photoIds.length > 1 && (
        <button
          onClick={handleRotate}
          title="Try another image"
          className="absolute top-3 right-3 z-10 p-1.5 rounded-sm bg-black/40 text-white/50 hover:text-primary hover:bg-black/60 transition-all opacity-0 group-hover:opacity-100"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      )}

      <div className="relative z-10 p-6 sm:p-8">
        <Link href={`/facts/${fact.id}`} className="block mb-6">
          <h3 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground leading-tight">
            "{renderFact(fact.text, name, pronouns)}"
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
      </div>
    </motion.div>
  );
}
