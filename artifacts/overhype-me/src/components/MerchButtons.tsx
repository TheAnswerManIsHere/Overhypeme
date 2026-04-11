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
  destination: "zazzle",
  text: string,
  imageUrl?: string,
) {
  const absoluteImageUrl = imageUrl
    ? (imageUrl.startsWith("http") ? imageUrl : `${window.location.origin}${imageUrl}`)
    : undefined;
  try {
    const resp = await fetch("/api/affiliate/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sourceType, sourceId: String(sourceId), destination, text, imageUrl: absoluteImageUrl }),
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
  // Fallback: open Zazzle search directly
  const encoded = encodeURIComponent(text.slice(0, 100));
  const fallback = `https://www.zazzle.com/s/${encoded}`;
  window.open(fallback, "_blank", "noopener,noreferrer");
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  const [loadingZazzle, setLoadingZazzle] = useState(false);

  async function handleZazzle() {
    setLoadingZazzle(true);
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });
    await logClickAndRedirect(sourceType, sourceId, "zazzle", text, imageUrl);
    setLoadingZazzle(false);
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
    </div>
  );
}
