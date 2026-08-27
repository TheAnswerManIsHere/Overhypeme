import { useEffect, useRef } from "react";
import { useAuth } from "@workspace/replit-auth-web";

declare global {
  interface Window {
    adsbygoogle?: Array<Record<string, unknown>>;
  }
}

interface AdSlotProps {
  slot: string;
  format?: "auto" | "rectangle" | "horizontal" | "vertical";
  className?: string;
}

export function AdSlot({ slot, format = "auto", className = "" }: AdSlotProps) {
  const { can, isLoading } = useAuth();
  const pushed = useRef(false);

  const pubId = import.meta.env.VITE_ADSENSE_PUBLISHER_ID as string | undefined;
  // Told, not derived. The server owns whether this account sees ads.
  const adsFree = can("ads_free");

  // Wait until auth has resolved before deciding to show ads.
  // While loading, render nothing to avoid flashing ads to premium users.
  const shouldShow = !isLoading && Boolean(pubId) && !adsFree;

  useEffect(() => {
    if (!shouldShow) {
      // Reset the marker rather than just returning. `ads_free` can move while
      // the tab stays open — an operator toggling it off then back on for a
      // tier is two grid writes, no reload required. Without this, `pushed`
      // stays true from before the slot was hidden, the effect below never
      // re-fires when `shouldShow` flips back to true, and the <ins> element
      // is recreated but never pushed to AdSense — a permanently blank slot.
      pushed.current = false;
      return;
    }
    if (pushed.current) return;
    pushed.current = true;
    try {
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.push({});
    } catch {
      // AdSense not loaded
    }
  }, [shouldShow]);

  if (!shouldShow) return null;

  return (
    <div className={`ad-slot overflow-hidden ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={pubId}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive="true"
      />
    </div>
  );
}
