/**
 * Premium "Legendary" chrome for the Step 1 video card: gold-orange gradient
 * ring around the card edge and a crown badge in the top-right corner.
 *
 * The chrome stays at full strength even when the inner content is dimmed
 * (locked / over budget) — it reads as "this is the premium thing" to the
 * user regardless of accessibility state.
 */

import type { ReactNode } from "react";
import { Crown } from "lucide-react";

interface Props {
  children: ReactNode;
}

export function VideoCardChrome({ children }: Props) {
  return (
    <div className="relative h-full w-full rounded-2xl p-[2px] bg-gradient-to-br from-[#ffb347] via-[#ff6b35] to-[#c2410c]">
      <div className="relative h-full w-full rounded-[14px] overflow-hidden bg-[#111]">
        {children}
        <div
          className="absolute top-3 right-3 z-20 flex items-center justify-center w-9 h-9 rounded-full bg-[#111]/80 border border-[#ffb347] text-[#ffb347] backdrop-blur"
          aria-hidden="true"
          data-testid="video-card-crown"
        >
          <Crown className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}
