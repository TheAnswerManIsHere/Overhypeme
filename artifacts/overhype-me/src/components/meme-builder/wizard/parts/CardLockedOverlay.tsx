/**
 * Tier-locked overlay for the Step 1 video card.
 *
 * Dims the underlying content (lock layered on top of the dimmed asset; the
 * card chrome — crown + gradient border — stays at full strength outside
 * this overlay).
 */

import { Lock } from "lucide-react";

export function CardLockedOverlay() {
  return (
    <>
      <div
        className="absolute inset-0 z-10 bg-black/55"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-white"
        data-testid="card-locked-overlay"
      >
        <Lock className="w-7 h-7 text-[#ffb347]" aria-hidden="true" />
        <span className="font-mono text-xs uppercase tracking-widest text-[#ffb347]">
          Go Legendary to unlock
        </span>
      </div>
    </>
  );
}
