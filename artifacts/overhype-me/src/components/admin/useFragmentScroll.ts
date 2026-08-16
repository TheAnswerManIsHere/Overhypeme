import { useEffect } from "react";

/**
 * Scroll a `#fragment` into view once its heading actually exists.
 *
 * Plain anchors cannot work on this surface, and the reasons compound:
 *
 *   1. LAZY MOUNT TIMING — chapters load as their own chunks, so the browser
 *      processes the fragment before the target heading exists. Nothing
 *      scrolls and nothing errors, so it looks like a styling bug.
 *   2. THE SCROLL CONTAINER IS NOT THE WINDOW — the admin shell is
 *      `fixed inset-0` and scrolling happens in an inner `overflow-auto`
 *      (AdminLayout). Anything that scrolls `window` moves nothing.
 *   3. AN EXISTING HANDLER RESETS SCROLL — App.tsx's `ScrollToTop` fires
 *      `window.scrollTo({top: 0})` on every location change. It is a no-op
 *      inside the admin shell today, but this must not depend on that staying
 *      true.
 *
 * `scrollIntoView` handles (2) natively — it scrolls whatever ancestor
 * actually scrolls — so the work here is (1) and (3): wait for the element,
 * and re-run on every navigation rather than only on mount.
 *
 * @param hash    the fragment WITHOUT `#`, or "" for none
 * @param ready   false while the chapter's chunk is still loading; the effect
 *                re-runs when it flips, which is what makes a cold-loaded
 *                bookmark land rather than silently doing nothing
 */
export function useFragmentScroll(hash: string, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;

    if (!hash) {
      // A chapter opened without a fragment starts at the top — otherwise the
      // previous chapter's scroll position persists across navigation.
      document.getElementById("admin-help-top")?.scrollIntoView({ block: "start" });
      return;
    }

    let cancelled = false;
    // The element usually exists by the time `ready` flips, but React commits
    // and the browser's paint are not the same tick — so retry briefly rather
    // than assuming one frame is enough, and give up rather than spinning.
    const deadline = Date.now() + 2000;

    const attempt = (): void => {
      if (cancelled) return;
      const el = document.getElementById(hash);
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
      if (Date.now() < deadline) requestAnimationFrame(attempt);
    };

    requestAnimationFrame(attempt);
    return () => { cancelled = true; };
  }, [hash, ready]);
}

/** The current `#fragment` without its `#`. Wouter's router ignores the hash. */
export function currentHash(): string {
  if (typeof window === "undefined") return "";
  return window.location.hash.replace(/^#/, "");
}
