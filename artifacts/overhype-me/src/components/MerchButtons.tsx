import { ShoppingBag, ExternalLink } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { trackAffiliateClick } from "@/lib/affiliate";

interface MerchButtonsProps {
  sourceType: "fact" | "meme";
  sourceId: string | number;
  text: string;
  imageUrl?: string;
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  const isMeme = sourceType === "meme";

  const href = isMeme
    ? `/api/memes/${sourceId}/zazzle-redirect?returnUrl=${encodeURIComponent(window.location.href)}`
    : undefined;

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });

    if (isMeme) {
      trackAffiliateClick(sourceType, sourceId, "zazzle", text, imageUrl);
      return;
    }

    e.preventDefault();

    const popup = window.open("about:blank", "_blank", "noreferrer");

    fetch("/api/affiliate/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        sourceType,
        sourceId: String(sourceId),
        destination: "zazzle",
        text,
        imageUrl,
        returnUrl: window.location.href,
      }),
    })
      .then((r) => r.json())
      .then((data: { url?: string }) => {
        if (data.url && popup) {
          popup.location.href = data.url;
        } else if (data.url) {
          window.location.assign(data.url);
        } else {
          popup?.close();
        }
      })
      .catch(() => {
        popup?.close();
      });
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <ShoppingBag className="w-3.5 h-3.5" />
        <span>Make merch:</span>
      </div>
      <a
        href={href ?? "#"}
        target={isMeme ? "_blank" : undefined}
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
