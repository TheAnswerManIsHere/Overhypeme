import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsPageLocation, trackPageView } from "./analytics";

describe("what Google Analytics is told about a page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete window.gtag;
  });

  it("filters a share link's name and pronouns and a search's words out of the address", () => {
    const out = new URL(analyticsPageLocation("https://overhype.me/facts/7?displayName=Alice&pronouns=she%2Fher&utm_source=x"));
    expect(out.searchParams.get("displayName")).toBe("[Filtered]");
    expect(out.searchParams.get("pronouns")).toBe("[Filtered]");
    expect(out.searchParams.get("utm_source")).toBe("x");
    expect(analyticsPageLocation("https://overhype.me/search?q=Alice")).not.toContain("Alice");
  });

  it("a page view sends the cleaned address, for the view and for later events", () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST");
    const gtag = vi.fn();
    window.gtag = gtag;
    window.history.replaceState(null, "", "/facts/7?displayName=Alice&pronouns=she%2Fher");
    trackPageView("/facts/7");
    const sent = JSON.stringify(gtag.mock.calls);
    expect(sent).not.toContain("Alice");
    expect(gtag).toHaveBeenCalledWith("set", { page_location: expect.stringContaining("/facts/7") });
    expect(gtag).toHaveBeenCalledWith("config", "G-TEST", expect.objectContaining({ page_location: expect.stringContaining("displayName=%5BFiltered%5D") }));
    window.history.replaceState(null, "", "/");
  });
});
