declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

export function trackPageView(path: string, title?: string) {
  const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
  if (!gaId || !window.gtag) return;
  window.gtag("config", gaId, {
    page_path: path,
    page_title: title,
  });
}

export function trackEvent(
  eventName: string,
  params?: Record<string, string | number | boolean>,
) {
  if (!window.gtag) return;
  window.gtag("event", eventName, params ?? {});
}

// ---------------------------------------------------------------------------
// Route visit counting — stored in localStorage so data persists across
// sessions and can inform which page chunks to prefetch.
// ---------------------------------------------------------------------------

const ROUTE_VISIT_KEY = "omh:route-visits";

/**
 * Maps an arbitrary URL path to a stable route key used for counting.
 * Dynamic segments (fact IDs, slugs, etc.) are collapsed so that
 * `/facts/123/comments` and `/facts/456` both count toward `facts`.
 * Admin routes are excluded — they are never prefetch candidates.
 */
export function normalizePathToRouteKey(path: string): string | null {
  const clean = path.split("?")[0].replace(/^\/+|\/+$/g, "");
  const [first] = clean.split("/");

  switch (first) {
    case "":        return "home";
    case "search":  return "search";
    case "facts":   return "facts";
    case "submit":  return "submit";
    case "profile": return "profile";
    case "onboard": return "onboard";
    case "activity":return "activity";
    case "meme":    return "meme";
    case "video":   return "video";
    case "pricing": return "pricing";
    case "login":   return "login";
    default:        return null; // admin, auth flows, redirects — skip
  }
}

/** Read the stored visit-count map from localStorage. */
export function getRouteVisitCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ROUTE_VISIT_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Increment the visit counter for the given path.
 * Silently ignores routes that have no route key (admin pages, etc.).
 */
export function trackRouteVisit(path: string): void {
  const key = normalizePathToRouteKey(path);
  if (!key) return;
  try {
    const counts = getRouteVisitCounts();
    counts[key] = (counts[key] ?? 0) + 1;
    localStorage.setItem(ROUTE_VISIT_KEY, JSON.stringify(counts));
  } catch {
    // localStorage may be unavailable (private browsing with storage blocked, etc.)
  }
  // Fire-and-forget: report to server so the global tally stays accurate.
  reportRouteVisitToServer(key);
}

/**
 * Sends a best-effort POST to the server to increment the server-side visit
 * counter for the given route key.  Failures are silently swallowed so that
 * analytics never blocks or breaks the UI.
 */
function reportRouteVisitToServer(routeKey: string): void {
  const base: string = import.meta.env.BASE_URL ?? "/";
  const url = `${base}api/route-stats`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route: routeKey }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Returns the top-N most-visited route keys, sorted descending by count.
 * Returns an empty array if no visit data has been recorded yet.
 */
export function getTopRoutes(n: number): string[] {
  const counts = getRouteVisitCounts();
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([key]) => key);
}

/**
 * Sends the current localStorage visit counts to the server so they are
 * aggregated across all users.  Fire-and-forget — failures are silently
 * ignored.  Should be called once per session (e.g. on browser idle after
 * page load).
 */
export function flushRouteStatsToServer(): void {
  try {
    const counts = getRouteVisitCounts();
    if (Object.keys(counts).length === 0) return;
    void fetch("/api/route-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counts }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // localStorage may be unavailable
  }
}
