import { ShoppingBag, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { trackEvent } from "@/lib/analytics";
import { buildZazzleUrl, trackAffiliateClick } from "@/lib/affiliate";

interface MerchButtonsProps {
  sourceType: "fact" | "meme";
  sourceId: string | number;
  text: string;
  imageUrl?: string;
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  function handleZazzle() {
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });

    const absoluteImageUrl = imageUrl
      ? (imageUrl.startsWith("http") ? imageUrl : `${window.location.origin}${imageUrl}`)
      : undefined;

    const url = buildZazzleUrl(text, absoluteImageUrl);
    window.open(url, "_blank");

    trackAffiliateClick(sourceType, sourceId, "zazzle", text, absoluteImageUrl);
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <ShoppingBag className="w-3.5 h-3.5" />
        <span>Make merch:</span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleZazzle}
        className="gap-1.5 text-xs h-8"
      >
        <ExternalLink className="w-3 h-3" />
        Zazzle
      </Button>
    </div>
  );
}
