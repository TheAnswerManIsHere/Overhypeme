/**
 * Launch Phase 16, increment 3: one module feeds GA4 and PostHog, from a fixed
 * event and property list, with addresses sent as route patterns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { phInit, phCapture, phIdentify, phReset, phGetProperty, phRegisterForSession } = vi.hoisted(() => ({
  phRegisterForSession: vi.fn(),
  phInit: vi.fn(),
  phCapture: vi.fn(),
  phIdentify: vi.fn(),
  phReset: vi.fn(),
  phGetProperty: vi.fn(),
}));

vi.mock("posthog-js/dist/module.slim", () => ({
  default: { init: phInit, capture: phCapture, identify: phIdentify, reset: phReset, get_property: phGetProperty, register_for_session: phRegisterForSession },
}));

import {
  __resetAnalyticsForTests,
  cleanProperties,
  campaignQuery,
  cleanReferrer,
  identify,
  page,
  resetIdentity,
  routePattern,
  scrubPosthogEvent,
  startAnalytics,
  track,
  trackUpgradeOnce,
  trackPersonaliseOnce,
  forgetPersonalise,
} from "./analytics";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// PostHog loads on an idle callback (or a zero timeout), then imports: wait past both.
const flush = () => new Promise((r) => setTimeout(r, 20));

function gaCalls(): unknown[][] {
  return (window.dataLayer ?? []).map((args) => Array.from(args as ArrayLike<unknown>));
}

beforeEach(() => {
  __resetAnalyticsForTests();
  window.dataLayer = [];
  delete window.gtag;
  document.head.querySelectorAll("script[src*='googletagmanager']").forEach((s) => s.remove());
  phInit.mockClear();
  phCapture.mockClear();
  phIdentify.mockClear();
  phReset.mockClear();
  phGetProperty.mockReset();
  phRegisterForSession.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("addresses leave as route patterns", () => {
  it("drops the query, the fragment and every dynamic segment", () => {
    expect(routePattern("/facts/7?displayName=Alice&pronouns=she%2Fher#x")).toBe("/facts/:id");
    expect(routePattern("/facts/7/comments")).toBe("/facts/:id/:sub");
    expect(routePattern("/m/alice-is-great")).toBe("/m/:slug");
    expect(routePattern("/search?q=Alice")).toBe("/search");
    expect(routePattern("/reset-password?token=secret")).toBe("/reset-password");
    expect(routePattern("/privacy")).toBe("/privacy");
    expect(routePattern("/")).toBe("/");
  });

  it("every route the app defines has a pattern: a new route cannot silently report as '(other)'", () => {
    const app = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    const paths = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      const sample = path.replace(/\/:[a-zA-Z]+\?$/, "").replace(/:[a-zA-Z]+\??/g, "x1");
      expect(routePattern(sample), `App.tsx route ${path}`).not.toBe("/(other)");
    }
  });

  it("an unknown address can carry no text out", () => {
    expect(routePattern("/Alice-Smith")).toBe("/(other)");
    expect(routePattern("/facts/7/comments/extra")).toBe("/(other)");
  });

  it("a referrer is this site's pattern or another site's origin only", () => {
    expect(cleanReferrer(`${window.location.origin}/facts/9?displayName=Bob`)).toBe(`${window.location.origin}/facts/:id`);
    expect(cleanReferrer("https://mail.example.com/inbox/Alice?thread=1")).toBe("https://mail.example.com");
    expect(cleanReferrer("")).toBe("");
  });
});

describe("events carry only listed properties", () => {
  it("drops unknown keys and any plan that is not a code", () => {
    const sneaky = { method: "password", name: "Alice", plan: "Alice's plan" } as unknown as Parameters<typeof cleanProperties>[0];
    expect(cleanProperties(sneaky)).toEqual({ method: "password" });
    expect(cleanProperties({ plan: "legendary" })).toEqual({ plan: "legendary" });
  });
});

describe("with no vendor ID set at build", () => {
  it("loads nothing and sends nothing", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    startAnalytics();
    page("/facts/7");
    track("submit");
    await flush();
    expect(window.gtag).toBeUndefined();
    expect(gaCalls()).toEqual([]);
    expect(document.querySelector("script[src*='googletagmanager']")).toBeNull();
    expect(phInit).not.toHaveBeenCalled();
  });
});

describe("with one vendor set", () => {
  it("GA4 alone: GA4 receives the page view; PostHog is never loaded", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    startAnalytics();
    page("/search?q=Alice");
    track("submit");
    await flush();
    expect(gaCalls().filter((c) => c[0] === "event" && c[1] === "page_view")).toHaveLength(1);
    expect(gaCalls()).toContainEqual(["event", "submit", {}]);
    expect(phInit).not.toHaveBeenCalled();
    expect(JSON.stringify(gaCalls())).not.toContain("Alice");
  });

  it("PostHog alone: PostHog receives the page view; no Google script is added", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    startAnalytics();
    resetIdentity(); // the sign-in check answered: not signed in
    page("/search?q=Alice");
    track("submit");
    await flush();
    expect(window.gtag).toBeUndefined();
    expect(document.querySelector("script[src*='googletagmanager']")).toBeNull();
    expect(phCapture).toHaveBeenCalledWith("$pageview", { __page_pattern: "/search" });
    expect(phCapture).toHaveBeenCalledWith("submit", { __page_pattern: "/search" });
  });
});

describe("with both vendors set", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
  });

  it("starts both with their automatic collection off", async () => {
    window.history.replaceState(null, "", "/facts/7?displayName=Alice");
    startAnalytics();
    await flush();
    const config = gaCalls().find((c) => c[0] === "config")!;
    expect(config[1]).toBe("G-TEST123");
    expect(config[2]).toMatchObject({ send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
    expect(JSON.stringify(config)).not.toContain("Alice");
    expect(phInit).toHaveBeenCalledOnce();
    expect(phInit.mock.calls[0][1]).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      enable_heatmaps: false,
      capture_performance: false,
      api_host: "https://us.i.posthog.com",
    });
  });

  it("one page shown is one page view in each, as its pattern", async () => {
    startAnalytics();
    resetIdentity(); // the sign-in check answered: not signed in
    await flush();
    page("/facts/7?displayName=Alice&q=Bob");
    const views = gaCalls().filter((c) => c[0] === "event" && c[1] === "page_view");
    expect(views).toHaveLength(1);
    expect(phCapture).toHaveBeenCalledWith("$pageview", { __page_pattern: "/facts/:id" });
    const everything = JSON.stringify([gaCalls(), phCapture.mock.calls]);
    expect(everything).not.toContain("Alice");
    expect(everything).not.toContain("Bob");
  });

  it("a funnel event reaches both, under GA4's recommended name where there is one", async () => {
    startAnalytics();
    resetIdentity(); // the sign-in check answered: not signed in
    await flush();
    track("upgrade", { plan: "legendary" });
    track("sign_up", { method: "google" });
    expect(gaCalls()).toContainEqual(["event", "purchase", { plan: "legendary" }]);
    expect(gaCalls()).toContainEqual(["event", "sign_up", { method: "google" }]);
    expect(phCapture).toHaveBeenCalledWith("upgrade", { plan: "legendary", __page_pattern: "/" });
    expect(phCapture).toHaveBeenCalledWith("sign_up", { method: "google", __page_pattern: "/" });
  });

  it("an event before PostHog's code has loaded is sent once it has", async () => {
    startAnalytics();
    resetIdentity(); // the sign-in check answered: not signed in
    track("submit");
    expect(phCapture).not.toHaveBeenCalled();
    await flush();
    expect(phCapture).toHaveBeenCalledWith("submit", { __page_pattern: "/" });
  });

  it("a call queued before PostHog loads is filed under the page it was made on", async () => {
    startAnalytics();
    resetIdentity(); // the sign-in check answered: not signed in
    page("/search?q=Alice");
    page("/pricing");
    await flush();
    const searchView = phCapture.mock.calls.find((c) => c[0] === "$pageview" && c[1].__page_pattern === "/search")!;
    const sent = scrubPosthogEvent({ uuid: "u", event: "$pageview", properties: { ...searchView[1], $current_url: `${window.location.origin}/pricing`, $pathname: "/pricing" } } as never)!;
    expect(sent.properties.$pathname).toBe("/search");
    expect(sent.properties.$current_url).toBe(`${window.location.origin}/search`);
    expect(sent.properties.__page_pattern).toBeUndefined();
  });

  it("knows a member by internal id only, and forgets on sign-out", async () => {
    startAnalytics();
    await flush();
    identify("user-42");
    expect(phIdentify).toHaveBeenCalledWith("user-42");
    expect(gaCalls()).toContainEqual(["set", { user_id: "user-42" }]);
    phGetProperty.mockReturnValue("identified");
    resetIdentity();
    expect(phReset).toHaveBeenCalledOnce();
    expect(gaCalls()).toContainEqual(["set", { user_id: null }]);
  });

  it("a signed-out load forgets an identity left by an expired session", async () => {
    startAnalytics();
    await flush();
    phGetProperty.mockReturnValue("identified");
    resetIdentity();
    expect(phReset).toHaveBeenCalledOnce();
    phGetProperty.mockReturnValue("anonymous");
    resetIdentity();
    expect(phReset).toHaveBeenCalledOnce();
  });
});

describe("an upgrade is counted once per checkout", () => {
  it("counts a checkout session once in this browser, and nothing without a session id", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    window.localStorage.clear();
    startAnalytics();
    resetIdentity(); // the sign-in check answered: not signed in
    await flush();
    trackUpgradeOnce("cs_test_1");
    trackUpgradeOnce("cs_test_1");
    trackUpgradeOnce(null);
    expect(phCapture.mock.calls.filter((c) => c[0] === "upgrade")).toEqual([["upgrade", { plan: "legendary", __page_pattern: "/" }]]);
    trackUpgradeOnce("cs_test_2");
    expect(phCapture.mock.calls.filter((c) => c[0] === "upgrade")).toHaveLength(2);
  });
});

describe("PostHog sends nothing until it knows who is browsing", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
  });

  /** PostHog calls in the order they were made. */
  const phCallOrder: string[] = [];
  const order = () => phCallOrder;
  beforeEach(() => {
    phCallOrder.length = 0;
    phReset.mockImplementation(() => { phCallOrder.push("reset"); });
    phIdentify.mockImplementation((id: string) => { phCallOrder.push(`identify:${id}`); });
    phCapture.mockImplementation((e: string) => { phCallOrder.push(`capture:${e}`); });
  });
  afterEach(() => {
    phReset.mockReset();
    phIdentify.mockReset();
    phCapture.mockReset();
  });

  it("a returning visitor whose session lapsed: PostHog loads first, then the sign-in check answers signed out", async () => {
    phGetProperty.mockReturnValue("identified");
    startAnalytics();
    page("/");
    await flush(); // PostHog has loaded; the sign-in check has not answered
    expect(phCapture).not.toHaveBeenCalled();
    resetIdentity();
    expect(order()).toEqual(["reset", "capture:$pageview"]);
  });

  it("the sign-in check answers signed out before PostHog loads", async () => {
    phGetProperty.mockReturnValue("identified");
    startAnalytics();
    page("/");
    resetIdentity();
    expect(phCapture).not.toHaveBeenCalled();
    await flush();
    expect(order()).toEqual(["reset", "capture:$pageview"]);
  });

  it("a signed-in member: identified before the held page view is sent, in either order", async () => {
    startAnalytics();
    page("/");
    identify("user-7");
    await flush();
    expect(order()).toEqual(["identify:user-7", "capture:$pageview"]);
  });

  it("a failed sign-in check releases the hold as not signed in", async () => {
    // A failed first read leaves no user and stops loading, so the app calls
    // resetIdentity(), the same release as a signed-out answer.
    phGetProperty.mockReturnValue("anonymous");
    startAnalytics();
    page("/search");
    await flush();
    resetIdentity();
    expect(order()).toEqual(["capture:$pageview"]);
  });

  it("a sign-in check that never answers sends nothing to PostHog; Google Analytics is not held", async () => {
    startAnalytics();
    page("/");
    await flush();
    expect(phCapture).not.toHaveBeenCalled();
    expect(gaCalls().filter((c) => c[0] === "event" && c[1] === "page_view")).toHaveLength(1);
  });

  it("an identity decided before analytics started is applied at start, so the hold is released", async () => {
    identify("user-9");
    startAnalytics();
    page("/");
    await flush();
    expect(order()).toEqual(["identify:user-9", "capture:$pageview"]);
  });
});

describe("Google Analytics page fields live at one scope", () => {
  it("are set globally before config, and config carries none, so later events take the current page", () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    window.history.replaceState(null, "", "/facts/7?displayName=Alice");
    startAnalytics();
    const calls = gaCalls();
    const firstSet = calls.findIndex((c) => c[0] === "set");
    const config = calls.findIndex((c) => c[0] === "config");
    expect(firstSet).toBeGreaterThanOrEqual(0);
    expect(firstSet).toBeLessThan(config);
    expect(calls[firstSet][1]).toMatchObject({ page_location: `${window.location.origin}/facts/:id`, page_title: "/facts/:id" });
    expect(Object.keys(calls[config][2] as object)).not.toEqual(expect.arrayContaining(["page_location"]));
    expect(calls[config][2]).not.toHaveProperty("page_title");
    expect(calls[config][2]).not.toHaveProperty("page_referrer");
    page("/pricing");
    track("share", { platform: "copy_link" });
    const lastSet = [...gaCalls()].reverse().find((c) => c[0] === "set" && "page_title" in (c[1] as object));
    expect(lastSet?.[1]).toMatchObject({ page_title: "/pricing" });
    expect(JSON.stringify(gaCalls())).not.toContain("Alice");
  });
});

describe("personalise is counted once per browser", () => {
  it("the first name save counts; set-up re-saving it counts nothing; forgetting the browser counts again", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    window.localStorage.clear();
    startAnalytics();
    resetIdentity();
    await flush();
    trackPersonaliseOnce(); // the name sheet
    trackPersonaliseOnce(); // account set-up re-saving the same name
    expect(phCapture.mock.calls.filter((c) => c[0] === "personalise")).toHaveLength(1);
    resetIdentity(); // a signed-out page load does not clear the mark
    trackPersonaliseOnce();
    expect(phCapture.mock.calls.filter((c) => c[0] === "personalise")).toHaveLength(1);
    forgetPersonalise(); // sign-out: the browser forgets the visitor
    trackPersonaliseOnce();
    expect(phCapture.mock.calls.filter((c) => c[0] === "personalise")).toHaveLength(2);
  });
});

describe("what PostHog adds by itself is scrubbed before sending", () => {
  it("replaces its URL properties and drops titles and element chains", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    startAnalytics();
    await flush();
    page("/m/alice-is-great");
    const out = scrubPosthogEvent({
      uuid: "u",
      event: "submit",
      properties: {
        $current_url: "https://overhype.me/m/alice-is-great?displayName=Alice",
        $pathname: "/m/alice-is-great",
        $referrer: "https://overhype.me/search?q=Alice",
        $title: "Alice is great",
        $elements_chain: "a:text=\"Alice\"",
        $browser: "Chrome",
        $session_entry_url: "https://overhype.me/facts/1?displayName=Alice",
        $session_entry_pathname: "/facts/1",
        some_future_url: "https://elsewhere.example/Alice?x=1",
      },
      $set_once: { $initial_current_url: "https://overhype.me/facts/1?displayName=Alice", $initial_referrer: "https://x.example/Alice" },
    } as never)!;
    const text = JSON.stringify(out);
    expect(text).not.toContain("Alice");
    expect(out.properties.$current_url).toBe(`${window.location.origin}/m/:slug`);
    expect(out.properties.$browser).toBe("Chrome");
    expect(out.properties.$session_entry_pathname).toBe("/facts/:id");
    expect(out.properties.some_future_url).toBe("https://elsewhere.example");
  });
});

describe("a landing address's campaign tags reach GA4 (fix after PR #1059)", () => {
  it("keeps only the listed tags, and only code-shaped values", () => {
    expect(campaignQuery("?utm_source=newsletter&utm_medium=email&utm_campaign=launch-week&displayName=Alice&gclid=abc"))
      .toBe("?utm_source=newsletter&utm_medium=email&utm_campaign=launch-week");
    expect(campaignQuery("?utm_term=Alice%20Smith&utm_content=alice%40example.com&utm_id=spring_2027")).toBe("?utm_id=spring_2027");
    expect(campaignQuery("?utm_source=" + "a".repeat(101))).toBe("");
    expect(campaignQuery("?q=Alice")).toBe("");
    expect(campaignQuery("")).toBe("");
  });

  it("the landing page view carries them, and the page after it does not", () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    window.history.replaceState(null, "", "/facts/7?displayName=Alice&utm_source=newsletter&utm_campaign=launch-week&utm_term=Alice%20Smith");
    startAnalytics();
    const landing = `${window.location.origin}/facts/:id?utm_source=newsletter&utm_campaign=launch-week`;
    // Before config, so even a hit sent before the first page view is attributed.
    expect(gaCalls().find((c) => c[0] === "set")).toEqual(["set", expect.objectContaining({ page_location: landing })]);
    page("/facts/7");
    expect(gaCalls()).toContainEqual(["event", "page_view", { page_location: landing, page_title: "/facts/:id" }]);
    page("/pricing");
    expect(gaCalls()).toContainEqual(["event", "page_view", { page_location: `${window.location.origin}/pricing`, page_title: "/pricing" }]);
    expect(gaCalls().at(-2)).toEqual(["set", expect.objectContaining({ page_location: `${window.location.origin}/pricing` })]);
    expect(JSON.stringify(gaCalls())).not.toContain("Alice");
  });

  it("the tags are those of the address the page loaded with, not of a later one", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    window.history.replaceState(null, "", "/?utm_source=newsletter");
    vi.resetModules();
    const fresh = await import("./analytics");
    // The app moves on before analytics starts (Phase 14's admission check).
    window.history.replaceState(null, "", "/pricing");
    window.dataLayer = [];
    fresh.startAnalytics();
    fresh.page("/pricing");
    expect(gaCalls()).toContainEqual(["event", "page_view", { page_location: `${window.location.origin}/pricing?utm_source=newsletter`, page_title: "/pricing" }]);
    fresh.__resetAnalyticsForTests();
  });

  it("PostHog gets the landing tags for the session even after the visitor has moved on (owed after PR #1069)", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    window.history.replaceState(null, "", "/facts/7?utm_source=newsletter&utm_campaign=launch-week&utm_term=Alice%20Smith&displayName=Alice");
    vi.resetModules();
    const fresh = await import("./analytics");
    // The app moves on before analytics starts, and PostHog reads the address at each event.
    window.history.replaceState(null, "", "/pricing");
    fresh.startAnalytics();
    fresh.resetIdentity();
    fresh.page("/pricing");
    await flush();
    expect(phRegisterForSession).toHaveBeenCalledTimes(1);
    expect(phRegisterForSession).toHaveBeenCalledWith({ utm_source: "newsletter", utm_campaign: "launch-week" });
    // Registered before the queued page view is sent, so it carries them.
    expect(phRegisterForSession.mock.invocationCallOrder[0]).toBeLessThan(
      phCapture.mock.invocationCallOrder[phCapture.mock.calls.findIndex((c) => c[0] === "$pageview")]!,
    );
    fresh.__resetAnalyticsForTests();
  });

  it("PostHog registers nothing when the landing address had no clean tags", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test123");
    window.history.replaceState(null, "", "/?utm_term=Alice%20Smith");
    startAnalytics();
    resetIdentity();
    await flush();
    expect(phInit).toHaveBeenCalled();
    expect(phRegisterForSession).not.toHaveBeenCalled();
  });

  it("an address with no campaign tags sends the bare pattern", () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    window.history.replaceState(null, "", "/search?q=Alice");
    startAnalytics();
    page("/search?q=Alice");
    expect(gaCalls()).toContainEqual(["event", "page_view", { page_location: `${window.location.origin}/search`, page_title: "/search" }]);
  });

  it("PostHog keeps the campaign tags it reads only when their value passes the same check", () => {
    const event = {
      uuid: "1", event: "$pageview",
      properties: { utm_source: "newsletter", utm_term: "Alice Smith", __page_pattern: "/" },
      $set_once: { $initial_utm_source: "newsletter", $initial_utm_content: "alice@example.com" },
    } as unknown as Parameters<typeof scrubPosthogEvent>[0];
    const out = scrubPosthogEvent(event)!;
    expect(out.properties).toMatchObject({ utm_source: "newsletter" });
    expect(out.properties).not.toHaveProperty("utm_term");
    expect(out.$set_once).toEqual({ $initial_utm_source: "newsletter" });
  });
});
