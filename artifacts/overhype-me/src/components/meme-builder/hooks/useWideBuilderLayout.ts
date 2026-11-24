/**
 * Whether the meme builder lays its preview and controls side by side
 * (Issue #850). Chosen by the space on screen, never by device type: at
 * 1024 px wide or more, in either orientation, the builder uses two columns;
 * anything narrower (a phone, an ordinary iPad in portrait, a narrow window)
 * keeps the stacked layout.
 *
 * Deliberately not `useDesktopModality`, which calls a touch tablet "mobile"
 * whatever its size: an iPad in landscape has the room, so it gets the wide
 * layout.
 */
import { useEffect, useState } from "react";

export const WIDE_BUILDER_MIN_WIDTH_PX = 1024;
const QUERY = `(min-width: ${WIDE_BUILDER_MIN_WIDTH_PX}px)`;

function readNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

export function useWideBuilderLayout(): boolean {
  const [wide, setWide] = useState<boolean>(readNow);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setWide(e.matches);
    setWide(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return wide;
}
