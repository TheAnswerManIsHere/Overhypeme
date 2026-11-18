/**
 * Launch Phase 16, increment 3: one module feeds GA4 and PostHog, from a fixed
 * event and property list, with addresses sent as route patterns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { phInit, phCapture, phIdentify, phReset, phGetProperty } = vi.hoisted(() => ({
  phInit: vi.fn(),
  phCapture: vi.fn(),
  phIdentify: vi.fn(),
  phReset: vi.fn(),
  phGetProperty: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: { init: phInit, capture: phCapture, identify: phIdentify, reset: phReset, get_property: phGetProperty },
}));

import {
  __resetAnalyticsForTests,
  cleanProperties,
  cleanReferrer,
  identify,
  page,
  resetIdentity,
  routePattern,
  scrubPosthogEvent,
  startAnalytics,
  track,
} from "./analytics";

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    page("/search?q=Alice");
    track("submit");
    await flush();
    expect(window.gtag).toBeUndefined();
    expect(document.querySelector("script[src*='googletagmanager']")).toBeNull();
    expect(phCapture).toHaveBeenCalledWith("$pageview", { $current_url: `${window.location.origin}/search`, $pathname: "/search" });
    expect(phCapture).toHaveBeenCalledWith("submit", {});
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
    await flush();
    page("/facts/7?displayName=Alice&q=Bob");
    const views = gaCalls().filter((c) => c[0] === "event" && c[1] === "page_view");
    expect(views).toHaveLength(1);
    expect(phCapture).toHaveBeenCalledWith("$pageview", { $current_url: `${window.location.origin}/facts/:id`, $pathname: "/facts/:id" });
    const everything = JSON.stringify([gaCalls(), phCapture.mock.calls]);
    expect(everything).not.toContain("Alice");
    expect(everything).not.toContain("Bob");
  });

  it("a funnel event reaches both, under GA4's recommended name where there is one", async () => {
    startAnalytics();
    await flush();
    track("upgrade", { plan: "legendary" });
    track("sign_up", { method: "google" });
    expect(gaCalls()).toContainEqual(["event", "purchase", { plan: "legendary" }]);
    expect(gaCalls()).toContainEqual(["event", "sign_up", { method: "google" }]);
    expect(phCapture).toHaveBeenCalledWith("upgrade", { plan: "legendary" });
    expect(phCapture).toHaveBeenCalledWith("sign_up", { method: "google" });
  });

  it("an event before PostHog's code has loaded is sent once it has", async () => {
    startAnalytics();
    track("submit");
    expect(phCapture).not.toHaveBeenCalled();
    await flush();
    expect(phCapture).toHaveBeenCalledWith("submit", {});
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
