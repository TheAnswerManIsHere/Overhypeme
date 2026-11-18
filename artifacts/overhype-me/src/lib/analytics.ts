/**
 * @purpose The only place the web app talks to Google Analytics 4 or PostHog (launch Phase 16, increment 3): one `track()` and one `page()` feed both, from a fixed funnel event list and a fixed property list; addresses go out as route patterns; vendor automatic collection is off. Also counts route visits locally for prefetching.
 * @subsystem public-site
 */
import { LEGAL_SLUGS } from "@/generated/legal";
import type { PostHog, CaptureResult } from "posthog-js";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

// ---------------------------------------------------------------------------
// The funnel. Each event fires once, on the confirmed outcome (plan Design B).
// ---------------------------------------------------------------------------

export type FunnelEvent =
  | "personalise"
  | "sign_up"
  | "verify"
  | "submit"
  | "meme_made"
  | "share"
  | "upgrade";

/**
 * The only properties an event may carry. Each is an enumerated value or an
 * opaque code, never a name, an email or free text.
 */
export type FunnelProperties = {
  /** How an account was created. */
  method?: "password" | "google" | "apple";
  /** Where a share went. */
  platform?: "twitter" | "web_share" | "copy_link" | "email";
  /** What was bought: a plan or pack code, never a description. */
  plan?: string;
};

const PLAN_CODE = /^[a-z0-9_-]{1,40}$/;

/** GA4's recommended names where one exists; ours otherwise. */
const GA_EVENT_NAME: Record<FunnelEvent, string> = {
  personalise: "personalise",
  sign_up: "sign_up",
  verify: "verify",
  submit: "submit",
  meme_made: "meme_made",
  share: "share",
  upgrade: "purchase",
};

/** Drops any key not on the list and any plan value that is not a code. */
export function cleanProperties(props: FunnelProperties | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!props) return out;
  if (props.method === "password" || props.method === "google" || props.method === "apple") out.method = props.method;
  if (props.platform === "twitter" || props.platform === "web_share" || props.platform === "copy_link" || props.platform === "email") {
    out.platform = props.platform;
  }
  if (typeof props.plan === "string" && PLAN_CODE.test(props.plan)) out.plan = props.plan;
  return out;
}

// ---------------------------------------------------------------------------
// Addresses: a route pattern, never the address bar.
// ---------------------------------------------------------------------------

const STATIC_ROUTES = new Set<string>([
  "/", "/search", "/submit", "/profile", "/onboard", "/check-email",
  "/account/deletion", "/account/suspended", "/top-facts", "/library",
  "/hall-of-fame", "/activity", "/pricing", "/login", "/forgot-password",
  "/reset-password", "/verify-email", "/admin",
  ...LEGAL_SLUGS.map((slug) => `/${slug}`),
]);

const DYNAMIC_ROUTES: Array<[RegExp, string]> = [
  [/^\/facts\/[^/]+\/[^/]+$/, "/facts/:id/:sub"],
  [/^\/facts\/[^/]+$/, "/facts/:id"],
  [/^\/m\/[^/]+$/, "/m/:slug"],
  [/^\/admin\/eval\/judge\/[^/]+$/, "/admin/eval/judge/:setId"],
  [/^\/admin\/help\/[^/]+$/, "/admin/help/:chapter"],
  [/^\/admin\/[a-z-]+(\/[a-z-]+)?$/, ""], // admin pages are fixed words: kept as they are
];

/**
 * The route pattern of a path: no query, no fragment, and every dynamic
 * segment replaced by its parameter name. An unknown path is "/(other)", so a
 * mistyped or crafted address can never carry text out.
 */
export function routePattern(path: string): string {
  const bare = (path.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  if (STATIC_ROUTES.has(bare)) return bare;
  for (const [re, pattern] of DYNAMIC_ROUTES) {
    if (re.test(bare)) return pattern || bare;
  }
  return "/(other)";
}

function patternUrl(pattern: string): string {
  return `${window.location.origin}${pattern}`;
}

/** Another site's origin is kept; an address on this site becomes its pattern. */
export function cleanReferrer(referrer: string): string {
  if (!referrer) return "";
  try {
    const url = new URL(referrer);
    if (url.origin === window.location.origin) return patternUrl(routePattern(url.pathname));
    return url.origin;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Vendors.
// ---------------------------------------------------------------------------

function gaId(): string | undefined {
  const id = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
  return id && /^G-[A-Z0-9]+$/.test(id) ? id : undefined;
}

function posthogKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  return key && /^phc_[A-Za-z0-9]+$/.test(key) ? key : undefined;
}

const POSTHOG_HOST = "https://us.i.posthog.com";

let started = false;
let currentPattern = "/";
let posthog: PostHog | null = null;
/** Calls made before PostHog's code has loaded, replayed once it has. */
let posthogQueue: Array<(ph: PostHog) => void> = [];

function withPosthog(fn: (ph: PostHog) => void): void {
  if (!posthogKey()) return;
  if (posthog) fn(posthog);
  else posthogQueue.push(fn);
}

/**
 * Every address-shaped property PostHog adds by itself leaves as a pattern.
 * Decided by the value, not by a list of property names, so a property a
 * future PostHog adds (as `$session_entry_url` was found to be, by the
 * outbound browser test) is covered too: any web address becomes this site's
 * route pattern or another site's origin, any pathname its pattern, and page
 * titles and clicked-element text are dropped.
 */
export function scrubPosthogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  const scrubBag = (bag: Record<string, unknown> | undefined) => {
    if (!bag) return;
    for (const key of Object.keys(bag)) {
      const lower = key.toLowerCase();
      const value = bag[key];
      if (lower.endsWith("title") || lower.endsWith("href") || lower === "$elements_chain" || lower === "$elements") {
        delete bag[key];
      } else if (lower === "$current_url") {
        bag[key] = patternUrl(currentPattern);
      } else if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        bag[key] = cleanReferrer(value);
      } else if (typeof value === "string" && lower.endsWith("pathname")) {
        bag[key] = routePattern(value);
      } else if (typeof value === "string" && lower.endsWith("url")) {
        bag[key] = value.startsWith("/") ? routePattern(value) : "";
      }
    }
  };
  scrubBag(event.properties as Record<string, unknown>);
  scrubBag(event.$set as Record<string, unknown> | undefined);
  scrubBag(event.$set_once as Record<string, unknown> | undefined);
  return event;
}

function startGa(id: string): void {
  window.dataLayer = window.dataLayer || [];
  // gtag must push the `arguments` object itself, not an array.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    page_location: patternUrl(currentPattern),
    page_title: currentPattern,
    page_referrer: cleanReferrer(document.referrer),
  });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
}

function startPosthog(key: string): void {
  void import("posthog-js").then(({ default: ph }) => {
    ph.init(key, {
      api_host: POSTHOG_HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      capture_performance: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      rageclick: false,
      enable_heatmaps: false,
      disable_surveys: true,
      disable_web_experiments: true,
      disable_product_tours: true,
      disable_conversations: true,
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      save_referrer: false,
      person_profiles: "identified_only",
      before_send: scrubPosthogEvent,
    });
    posthog = ph;
    const queued = posthogQueue;
    posthogQueue = [];
    for (const fn of queued) fn(ph);
  }).catch(() => {
    posthogQueue = [];
  });
}

/**
 * Starts both vendors, once. Called only from `startTelemetry` (lib/telemetry),
 * the single point Phase 14's visitor-admission check gates. A vendor whose ID
 * is not set at build loads nothing and sends nothing.
 */
export function startAnalytics(): void {
  if (started) return;
  started = true;
  currentPattern = routePattern(window.location.pathname);
  const id = gaId();
  if (id) startGa(id);
  const key = posthogKey();
  if (key) startPosthog(key);
}

/** One page shown: the only source of page views for either vendor. */
export function page(path: string): void {
  if (!started) return;
  currentPattern = routePattern(path);
  const location = patternUrl(currentPattern);
  if (gaId() && window.gtag) {
    // `set` carries the pattern into every later hit on this page.
    window.gtag("set", { page_location: location, page_title: currentPattern, page_referrer: cleanReferrer(document.referrer) });
    window.gtag("event", "page_view", { page_location: location, page_title: currentPattern });
  }
  withPosthog((ph) => ph.capture("$pageview", { $current_url: location, $pathname: currentPattern }));
}

/** One confirmed funnel outcome. */
export function track(event: FunnelEvent, props?: FunnelProperties): void {
  if (!started) return;
  const clean = cleanProperties(props);
  if (gaId() && window.gtag) window.gtag("event", GA_EVENT_NAME[event], clean);
  withPosthog((ph) => ph.capture(event, clean));
}

let identifiedAs: string | null = null;

/** A member signed in: known to both vendors by internal id only. */
export function identify(userId: string): void {
  if (!started || !userId || identifiedAs === userId) return;
  identifiedAs = userId;
  if (gaId() && window.gtag) window.gtag("set", { user_id: userId });
  withPosthog((ph) => ph.identify(userId));
}

/**
 * A member signed out, or this page load is signed out: both vendors forget
 * who it was. PostHog keeps an identity across visits, so a browser whose last
 * session ended by expiry (no sign-out click) is reset on its next signed-out
 * load too.
 */
export function resetIdentity(): void {
  if (!started) return;
  const wasIdentified = identifiedAs !== null;
  identifiedAs = null;
  if (wasIdentified && gaId() && window.gtag) window.gtag("set", { user_id: null });
  withPosthog((ph) => {
    if (ph.get_property("$user_state") === "identified") ph.reset();
  });
}

/** Test seam: forget module state between tests. */
export function __resetAnalyticsForTests(): void {
  started = false;
  currentPattern = "/";
  posthog = null;
  posthogQueue = [];
  identifiedAs = null;
}

// ---------------------------------------------------------------------------
// Route visit counting — stored in localStorage so data persists across
// sessions and can inform which page chunks to prefetch. Never sent anywhere.
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
    case "m":       return "meme";
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
