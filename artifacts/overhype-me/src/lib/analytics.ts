/**
 * @purpose The only place the web app talks to Google Analytics 4 or PostHog (launch Phase 16, increment 3): one `track()` and one `page()` feed both, from a fixed funnel event list and a fixed property list; addresses go out as route patterns; vendor automatic collection is off. Also counts route visits locally for prefetching.
 * @subsystem public-site
 */
import { LEGAL_SLUGS } from "@/generated/legal";
import type { PostHog, CaptureResult } from "posthog-js/dist/module.slim";

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

export const SIGN_UP_METHODS = ["password", "google", "apple"] as const;
export const SHARE_PLATFORMS = ["twitter", "web_share", "copy_link", "email"] as const;
export type SignUpMethod = (typeof SIGN_UP_METHODS)[number];
export type SharePlatform = (typeof SHARE_PLATFORMS)[number];

/**
 * The only properties an event may carry. Each is an enumerated value or an
 * opaque code, never a name, an email or free text.
 */
export type FunnelProperties = {
  /** How an account was created. */
  method?: SignUpMethod;
  /** Where a share went. */
  platform?: SharePlatform;
  /** What was bought: a plan or pack code, never a description. */
  plan?: string;
};

const PLAN_CODE = /^[a-z0-9_-]{1,40}$/;

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** GA4's recommended name where one exists; ours otherwise. */
function gaEventName(event: FunnelEvent): string {
  return event === "upgrade" ? "purchase" : event;
}

/** Drops any key not on the list and any plan value that is not a code. */
export function cleanProperties(props: FunnelProperties | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!props) return out;
  if (isOneOf(SIGN_UP_METHODS, props.method)) out.method = props.method;
  if (isOneOf(SHARE_PLATFORMS, props.platform)) out.platform = props.platform;
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
// Campaign tags: the one part of the landing address that goes to GA4.
// ---------------------------------------------------------------------------

/** The campaign tags GA4 reads from a page address; every other parameter is dropped. */
export const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"] as const;

/**
 * A campaign tag's value is a code a link's author chose ("newsletter",
 * "launch-week"): letters, digits, dot, underscore and hyphen, at most 100.
 * Anything else (a space, an "@", other punctuation) is dropped, so an email
 * address or a full name put in a hand-made link cannot leave the browser.
 */
const CAMPAIGN_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

export function isCleanCampaignValue(value: unknown): boolean {
  return typeof value === "string" && CAMPAIGN_VALUE.test(value);
}

/**
 * The campaign tags of an address's query, allowlisted by key and by value,
 * as a query string ("?utm_source=newsletter&utm_campaign=launch-week"), or
 * "" when there are none.
 */
export function campaignQuery(search: string): string {
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of CAMPAIGN_KEYS) {
    const value = params.get(key);
    if (value !== null && isCleanCampaignValue(value)) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
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
/** This visit's referrer as sent: computed once, since it cannot change in a single-page app. */
let referrer = "";
/**
 * The landing address's campaign tags, carried on the first page view's
 * address only (and every hit on that page), as on a site where only the
 * landing address has them: GA4 attributes the visit from its first hit.
 * Cleared once that page view is sent.
 */
let landingCampaign = "";
/**
 * The address's query as the page loaded, read when this module is first
 * evaluated (at startup, before the app can rewrite the address), so a start
 * that waits for something (Phase 14's admission check) still sees the
 * landing link's campaign tags. Null in tests after a reset: the current
 * address is read instead.
 */
let landingSearch: string | null = typeof window !== "undefined" ? window.location.search : null;
/** Each vendor is on only when its ID was set at build; decided once, at start. */
let gaOn = false;
let posthogOn = false;
let posthog: PostHog | null = null;
/**
 * PostHog sends nothing until two things are true: its code has loaded, and
 * the app has said who is browsing (the first `identify` or `resetIdentity`).
 * Until then identity calls and captures are held in two queues, and the
 * identity ones are applied first, so a visit is never sent under an identity
 * PostHog stored on an earlier visit (an expired session, a shared browser).
 * A failed sign-in check reaches `resetIdentity`, which releases the hold as
 * "not signed in"; a check that never answers leaves the visit unsent.
 */
let identityKnown = false;
let posthogIdentityQueue: Array<(ph: PostHog) => void> = [];
let posthogQueue: Array<(ph: PostHog) => void> = [];
/** An identity decision made before analytics started, applied at start. */
let identityBeforeStart: { userId: string | null } | undefined;

/** Carries the page a PostHog call was made on through to `before_send`. */
const PAGE_PATTERN = "__page_pattern";

/** A PostHog capture, stamped with the page it was made on. */
function capture(event: string, props: Record<string, string>): void {
  const madeOn = currentPattern;
  withPosthog((ph) => ph.capture(event, { ...props, [PAGE_PATTERN]: madeOn }));
}

function ga(...args: unknown[]): void {
  if (gaOn && window.gtag) window.gtag(...args);
}

function withPosthog(fn: (ph: PostHog) => void): void {
  if (!posthogOn) return;
  if (posthog && identityKnown) fn(posthog);
  else posthogQueue.push(fn);
}

/** An identity call: applied before any held capture is released. */
function withPosthogIdentity(fn: (ph: PostHog) => void): void {
  identityKnown = true;
  if (!posthogOn) return;
  if (posthog) fn(posthog);
  else posthogIdentityQueue.push(fn);
  flushPosthog();
}

function flushPosthog(): void {
  if (!posthog || !identityKnown) return;
  const ph = posthog;
  const identityCalls = posthogIdentityQueue;
  const captures = posthogQueue;
  posthogIdentityQueue = [];
  posthogQueue = [];
  for (const fn of identityCalls) fn(ph);
  for (const fn of captures) fn(ph);
}

/**
 * Every address-shaped property PostHog adds by itself leaves as a pattern.
 * Decided by the value, not by a list of property names, so a property a
 * future PostHog adds (as `$session_entry_url` was found to be, by the
 * outbound browser test) is covered too: any web address becomes this site's
 * route pattern or another site's origin, any pathname its pattern, and page
 * titles and clicked-element text are dropped. Campaign tags PostHog reads
 * from the address (`utm_source`, `$initial_utm_source`, …) keep only a value
 * that passes the same check GA4's do.
 */
export function scrubPosthogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  // The page the call was made on (see `capture`), not the page that is open
  // when PostHog sends it: a call queued before PostHog loaded would
  // otherwise be filed under a later page.
  const props = event.properties as Record<string, unknown>;
  const madeOn = typeof props?.[PAGE_PATTERN] === "string" ? (props[PAGE_PATTERN] as string) : currentPattern;
  if (props) delete props[PAGE_PATTERN];
  const scrubBag = (bag: Record<string, unknown> | undefined) => {
    if (!bag) return;
    for (const key of Object.keys(bag)) {
      const lower = key.toLowerCase();
      const value = bag[key];
      if (/(^|_)utm_/.test(lower)) {
        if (!isCleanCampaignValue(value)) delete bag[key];
      } else if (lower.endsWith("title") || lower.endsWith("href") || lower === "$elements_chain" || lower === "$elements") {
        delete bag[key];
      } else if (lower === "$current_url") {
        bag[key] = patternUrl(madeOn);
      } else if (lower === "$pathname") {
        bag[key] = madeOn;
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
  // The page fields live at one scope only, the global one, before `config`:
  // `config` would override every later `set` (Google's parameter precedence),
  // leaving events after an in-app navigation filed under the landing page.
  // Set before `config`, so the first hit already carries the pattern.
  window.gtag("set", { page_location: patternUrl(currentPattern) + landingCampaign, page_title: currentPattern, page_referrer: referrer });
  window.gtag("config", id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
}

/**
 * Loads PostHog's slim build (its core, without the bundled extensions this
 * configuration turns off) once the browser is idle, so it does not compete
 * with the first render; calls made before then are queued and replayed.
 */
function startPosthog(key: string): void {
  const load = () => void import("posthog-js/dist/module.slim").then(({ default: ph }) => {
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
    flushPosthog();
  }).catch(() => {
    posthogQueue = [];
    posthogIdentityQueue = [];
  });
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 0);
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
  referrer = cleanReferrer(document.referrer);
  landingCampaign = campaignQuery(landingSearch ?? window.location.search);
  landingSearch = null;
  const id = gaId();
  const key = posthogKey();
  gaOn = Boolean(id);
  posthogOn = Boolean(key);
  if (id) startGa(id);
  if (key) startPosthog(key);
  // Phase 14 will start analytics only once the visitor is admitted, which
  // can be after the app has learned who is browsing: apply that now, or
  // PostHog's hold would never be released.
  const before = identityBeforeStart;
  identityBeforeStart = undefined;
  if (before) {
    if (before.userId) identify(before.userId);
    else resetIdentity();
  }
}

/** One page shown: the only source of page views for either vendor. */
export function page(path: string): void {
  if (!started) return;
  currentPattern = routePattern(path);
  // GA4 only: PostHog reads the campaign tags from the address itself, and
  // `scrubPosthogEvent` holds them to the same check.
  const location = patternUrl(currentPattern) + landingCampaign;
  landingCampaign = "";
  // `set` carries the pattern into every later hit on this page.
  ga("set", { page_location: location, page_title: currentPattern, page_referrer: referrer });
  ga("event", "page_view", { page_location: location, page_title: currentPattern });
  capture("$pageview", {});
}

/** One confirmed funnel outcome. */
export function track(event: FunnelEvent, props?: FunnelProperties): void {
  if (!started) return;
  const clean = cleanProperties(props);
  ga("event", gaEventName(event), clean);
  capture(event, clean);
}

/** Local storage that never throws (private mode, blocked site data). */
const storageSafe = {
  get(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string): void { try { window.localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key: string): void { try { window.localStorage.removeItem(key); } catch { /* ignore */ } },
};

const UPGRADE_COUNTED_KEY = "overhype.analytics.upgradeCounted";

/**
 * The funnel's `upgrade`: counted once per completed checkout, keyed on
 * Stripe's checkout session id, so reopening the success address in this
 * browser (a bookmark, a second tab) never counts the same purchase twice;
 * one key holds the last session counted. A confirmation with no session id
 * (an old in-flight checkout, or the address typed by hand) is not counted:
 * an undercount is preferred to a double count.
 */
export function trackUpgradeOnce(checkoutSessionId: string | null): void {
  if (!checkoutSessionId) return;
  const storage = storageSafe;
  if (storage.get(UPGRADE_COUNTED_KEY) === checkoutSessionId) return;
  storage.set(UPGRADE_COUNTED_KEY, checkoutSessionId);
  track("upgrade", { plan: "legendary" });
}

const PERSONALISE_COUNTED_KEY = "overhype.analytics.personaliseCounted";

/**
 * The funnel's `personalise`: counted once per browser, the first time a
 * visitor's name is saved for rendering — in the name sheet, the name tag, or
 * account set-up when neither came first. Most visitors are asked for a name
 * on arrival and sign up later, so set-up re-saving that name must not count
 * it again. The mark is cleared only when the browser forgets the visitor
 * (`forgetPersonalise`, from sign-out), never by `resetIdentity`, which runs
 * on every signed-out page load.
 */
export function trackPersonaliseOnce(): void {
  const storage = storageSafe;
  if (storage.get(PERSONALISE_COUNTED_KEY)) return;
  storage.set(PERSONALISE_COUNTED_KEY, "1");
  track("personalise");
}

/** The browser forgot who this visitor is: their next name save counts again. */
export function forgetPersonalise(): void {
  storageSafe.remove(PERSONALISE_COUNTED_KEY);
}

let identifiedAs: string | null = null;

/** A member signed in: known to both vendors by internal id only. */
export function identify(userId: string): void {
  if (!userId) return;
  if (!started) {
    identityBeforeStart = { userId };
    return;
  }
  if (identifiedAs === userId && identityKnown) return;
  identifiedAs = userId;
  ga("set", { user_id: userId });
  withPosthogIdentity((ph) => ph.identify(userId));
}

/**
 * A member signed out, or this page load is signed out: both vendors forget
 * who it was. PostHog keeps an identity across visits, so a browser whose last
 * session ended by expiry (no sign-out click) is reset on its next signed-out
 * load too.
 */
export function resetIdentity(): void {
  if (!started) {
    identityBeforeStart = { userId: null };
    return;
  }
  const wasIdentified = identifiedAs !== null;
  identifiedAs = null;
  if (wasIdentified) ga("set", { user_id: null });
  withPosthogIdentity((ph) => {
    if (ph.get_property("$user_state") === "identified") ph.reset();
  });
}

/** Test seam: forget module state between tests. */
export function __resetAnalyticsForTests(): void {
  started = false;
  currentPattern = "/";
  referrer = "";
  landingCampaign = "";
  landingSearch = null;
  gaOn = false;
  posthogOn = false;
  posthog = null;
  posthogQueue = [];
  posthogIdentityQueue = [];
  identityKnown = false;
  identityBeforeStart = undefined;
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
