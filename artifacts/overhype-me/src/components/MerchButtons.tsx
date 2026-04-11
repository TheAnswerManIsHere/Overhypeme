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
  const absoluteImageUrl = imageUrl
    ? (imageUrl.startsWith("http") ? imageUrl : `${window.location.origin}${imageUrl}`)
    : undefined;

  const zazzleUrl = buildZazzleUrl(text, absoluteImageUrl);

  function handleClick() {
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });
    trackAffiliateClick(sourceType, sourceId, "zazzle", text, absoluteImageUrl);
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <ShoppingBag className="w-3.5 h-3.5" />
        <span>Make merch:</span>
      </div>
      <a
        href={zazzleUrl}
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
