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
  const { user } = useAuth();
  const pushed = useRef(false);

  const pubId = import.meta.env.VITE_ADSENSE_PUBLISHER_ID as string | undefined;
  const isPremium =
    user != null &&
    "membershipTier" in user &&
    (user as { membershipTier?: string }).membershipTier === "premium";
  const shouldShow = Boolean(pubId) && !isPremium;

  useEffect(() => {
    if (!shouldShow) return;
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
