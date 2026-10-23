import { describe, expect, it } from "vitest";
import { upgradeDestination } from "./upgradeDestination";

// The meme page's remix builder opens on the photo step for everyone since the
// stock source went with Pexels (launch Phase 4, removal 6), so a signed-out
// visitor's locked state asks for a registration, not a plan.
describe("upgradeDestination", () => {
  it("sends a registration lock to the login page, which returns to the meme", () => {
    expect(upgradeDestination("registered", "/m/abc123?ref=share")).toEqual({
      href: "/login?from=%2Fm%2Fabc123%3Fref%3Dshare",
      fullPage: true,
    });
  });

  it("sends a Legendary lock to the plans", () => {
    expect(upgradeDestination("legendary", "/m/abc123")).toEqual({ href: "/pricing", fullPage: false });
  });
});
