/**
 * Detects whether the user is on a desktop *input modality* — a hover-capable
 * device with a fine pointer. This is NOT a viewport-width breakpoint.
 *
 * A 1200px-wide tablet with a touch pointer is mobile-modality. A 900px
 * resized window on a laptop with a mouse is desktop-modality. The picker
 * uses a grid for desktop-modality and a horizontal snap strip for everything
 * else.
 */
import { useEffect, useState } from "react";

const QUERY = "(hover: hover) and (pointer: fine)";

function readNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

export function useDesktopModality(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(readNow);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    // Some old browsers expose only addListener.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return isDesktop;
}
