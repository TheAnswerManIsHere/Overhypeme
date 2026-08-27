import { useEffect, type RefObject } from "react";

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
 * SCOPED TO THE RENDERED CHAPTER, never `document`. The fragment comes from a
 * URL, so a global `getElementById` resolves it against the WHOLE admin shell
 * — the sidebar, the header, any widget a future admin screen adds. A chapter
 * heading slugged `search` or `overview` would then scroll to a control in the
 * chrome instead of the prose, and the shape of that bug (the page moves, just
 * to the wrong place) is one nobody reads as a fragment-resolution problem.
 * Confining the lookup to the container makes the collision impossible rather
 * than unlikely.
 *
 * @param hash    the fragment WITHOUT `#`, or "" for none
 * @param ready   false while the chapter's chunk is still loading; the effect
 *                re-runs when it flips, which is what makes a cold-loaded
 *                bookmark land rather than silently doing nothing
 * @param scopeRef the rendered chapter. Fragments resolve inside it, and it is
 *                 itself the scroll target when there is no fragment.
 */
export function useFragmentScroll(
  hash: string,
  ready: boolean,
  scopeRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!ready) return;

    if (!hash) {
      // A chapter opened without a fragment starts at the top — otherwise the
      // previous chapter's scroll position persists across navigation. The
      // container's own top IS that position, so this needs no sentinel
      // element (and therefore no second global id to collide with).
      scopeRef.current?.scrollIntoView({ block: "start" });
      return;
    }

    let cancelled = false;
    // The element usually exists by the time `ready` flips, but React commits
    // and the browser's paint are not the same tick — so retry briefly rather
    // than assuming one frame is enough, and give up rather than spinning.
    const deadline = Date.now() + 2000;

    const attempt = (): void => {
      if (cancelled) return;
      const el = findById(scopeRef.current, hash);
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
      if (Date.now() < deadline) requestAnimationFrame(attempt);
    };

    requestAnimationFrame(attempt);
    return () => { cancelled = true; };
  }, [hash, ready, scopeRef]);
}

/**
 * `getElementById` restricted to a subtree.
 *
 * Compared by PROPERTY rather than by building a `#id` selector: heading ids
 * are slugged from prose and can hold characters a CSS selector treats as
 * syntax, where `querySelector` throws instead of returning null — turning a
 * missing anchor into a crash. Matching `el.id` needs no escaping at all.
 */
function findById(scope: HTMLElement | null, id: string): HTMLElement | null {
  if (!scope) return null;
  if (scope.id === id) return scope;
  for (const el of scope.querySelectorAll<HTMLElement>("[id]")) {
    if (el.id === id) return el;
  }
  return null;
}

/**
 * The current `#fragment` without its `#`, percent-DECODED.
 *
 * Browsers expose a non-ASCII fragment percent-encoded (`#caf%C3%A9`), while
 * the generated element id holds the decoded text (`café`) — so a raw
 * `getElementById` on the encoded form silently finds nothing and the page
 * never scrolls. `decodeURIComponent` throws on a malformed sequence, which a
 * hand-edited URL can produce, so fall back to the raw value rather than
 * letting a bad bookmark take the page down.
 */
export function currentHash(): string {
  if (typeof window === "undefined") return "";
  const raw = window.location.hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
