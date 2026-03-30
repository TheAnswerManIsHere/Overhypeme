import { useState } from "react";
import { ShoppingBag, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { trackEvent } from "@/lib/analytics";

interface MerchButtonsProps {
  sourceType: "fact" | "meme";
  sourceId: string | number;
  text: string;
  imageUrl?: string;
}

async function logClickAndRedirect(
  sourceType: "fact" | "meme",
  sourceId: string | number,
  destination: "zazzle" | "cafepress",
  text: string,
  imageUrl?: string,
) {
  try {
    const resp = await fetch("/api/affiliate/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sourceType, sourceId: String(sourceId), destination, text, imageUrl }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { url?: string };
      if (data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
        return;
      }
    }
  } catch {
    // Fall through to fallback
  }
  // Fallback: open Zazzle/CafePress search directly
  const encoded = encodeURIComponent(text.slice(0, 100));
  const fallback =
    destination === "zazzle"
      ? `https://www.zazzle.com/s/${encoded}`
      : `https://www.cafepress.com/shop/search?q=${encoded}`;
  window.open(fallback, "_blank", "noopener,noreferrer");
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  const [loadingZazzle, setLoadingZazzle] = useState(false);
  const [loadingCafe, setLoadingCafe] = useState(false);

  async function handleZazzle() {
    setLoadingZazzle(true);
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });
    await logClickAndRedirect(sourceType, sourceId, "zazzle", text, imageUrl);
    setLoadingZazzle(false);
  }

  async function handleCafePress() {
    setLoadingCafe(true);
    trackEvent("affiliate_click", { destination: "cafepress", source_type: sourceType });
    await logClickAndRedirect(sourceType, sourceId, "cafepress", text, imageUrl);
    setLoadingCafe(false);
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
        disabled={loadingZazzle}
        className="gap-1.5 text-xs h-8"
      >
        {loadingZazzle ? "Opening…" : (
          <>
            <ExternalLink className="w-3 h-3" />
            Zazzle
          </>
        )}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={handleCafePress}
        disabled={loadingCafe}
        className="gap-1.5 text-xs h-8"
      >
        {loadingCafe ? "Opening…" : (
          <>
            <ExternalLink className="w-3 h-3" />
            CafePress
          </>
        )}
      </Button>
    </div>
  );
}
