import { useState } from "react";
import { ShoppingBag, ExternalLink, Loader2 } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { buildZazzleUrl, trackAffiliateClick } from "@/lib/affiliate";

interface MerchButtonsProps {
  sourceType: "fact" | "meme";
  sourceId: string | number;
  text: string;
  imageUrl?: string;
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  const [loading, setLoading] = useState(false);

  async function handleZazzleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (sourceType !== "meme" || !imageUrl) return;

    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch(`/api/memes/${sourceId}/zazzle-export`, {
        method: "POST",
        credentials: "include",
      });

      let publicImageUrl: string | undefined;
      if (res.ok) {
        const data = await res.json() as { url?: string };
        publicImageUrl = data.url;
      }

      trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });
      trackAffiliateClick(sourceType, sourceId, "zazzle", text, publicImageUrl);

      const url = buildZazzleUrl(publicImageUrl);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Fallback: open Zazzle without image
      const url = buildZazzleUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setLoading(false);
    }
  }

  const staticUrl = buildZazzleUrl();

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <ShoppingBag className="w-3.5 h-3.5" />
        <span>Make merch:</span>
      </div>
      <a
        href={staticUrl}
        target="_blank"
        rel="noreferrer"
        onClick={handleZazzleClick}
        className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground font-medium transition-colors"
        aria-disabled={loading}
        style={loading ? { pointerEvents: "none", opacity: 0.6 } : undefined}
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
        {loading ? "Preparing…" : "Zazzle"}
      </a>
    </div>
  );
}
