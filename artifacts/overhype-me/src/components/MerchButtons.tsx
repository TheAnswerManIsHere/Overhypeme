import { ShoppingBag, ExternalLink } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { buildZazzleUrl, trackAffiliateClick } from "@/lib/affiliate";

interface MerchButtonsProps {
  sourceType: "fact" | "meme";
  sourceId: string | number;
  text: string;
  imageUrl?: string;
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  const isMeme = sourceType === "meme";

  const href = isMeme
    ? `/api/memes/${sourceId}/zazzle-redirect`
    : buildZazzleUrl(imageUrl);

  function handleClick() {
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });
    trackAffiliateClick(sourceType, sourceId, "zazzle", text, imageUrl);
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <ShoppingBag className="w-3.5 h-3.5" />
        <span>Make merch:</span>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={handleClick}
        className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground font-medium transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        Zazzle
      </a>
    </div>
  );
}
