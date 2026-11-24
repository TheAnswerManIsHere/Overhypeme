/**
 * Launch Phase 14, increment 2: the analytics notice shows once per browser and
 * links to the Privacy page; monitoring receives the account id only; no
 * typeface is fetched from a third party.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("wouter", () => ({
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import { AnalyticsNotice, ANALYTICS_NOTICE_KEY } from "../AnalyticsNotice";
import { sentryUserFor } from "@/lib/sentry";

describe("AnalyticsNotice", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows on a first visit, links to the Privacy page, and stays closed once dismissed", () => {
    const { unmount } = render(<AnalyticsNotice />);
    expect(screen.getByTestId("analytics-notice")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("analytics-notice")).toBeNull();
    expect(window.localStorage.getItem(ANALYTICS_NOTICE_KEY)).toBe("seen");
    unmount();
    render(<AnalyticsNotice />);
    expect(screen.queryByTestId("analytics-notice")).toBeNull();
  });
});

describe("what leaves the browser", () => {
  it("monitoring receives the account id and nothing else", () => {
    const user = { id: "u1", email: "alex@example.com", firstName: "Alex", displayName: "Alex Franklin" };
    expect(sentryUserFor(user)).toEqual({ id: "u1" });
    expect(sentryUserFor(null)).toBeNull();
    expect(sentryUserFor({ id: null })).toBeNull();
  });

  // That recordings mask all text is pinned in src/lib/sentry.test.ts.
  it("no typeface is loaded from Google", () => {
    const root = resolve(__dirname, "../../../..");
    for (const file of ["index.html", "src/index.css"]) {
      expect(readFileSync(resolve(root, file), "utf8")).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });
});

// Launch Phase 16, increment 3 (amendment 2): the notice and the Privacy page
// name exactly the providers the network log shows, and no recordings.
describe("the disclosures match what is sent", () => {
  it("the notice names Google Analytics, PostHog and Sentry, and says no recordings are made of the page", () => {
    window.localStorage.clear();
    render(<AnalyticsNotice />);
    const text = screen.getByTestId("analytics-notice").textContent ?? "";
    expect(text).toContain("Google Analytics and PostHog");
    expect(text).toContain("without sending them the names you type or what you search for");
    expect(text).toContain("We use Sentry to find problems");
    expect(text).not.toMatch(/record/i);
    expect(ANALYTICS_NOTICE_KEY).toBe("overhype.analyticsNotice.v2");
  });

  it("the Privacy page lists PostHog and no longer describes recordings of visits", async () => {
    const { html } = await import("@/generated/legal/privacy");
    expect(html).toContain("<td>PostHog</td>");
    expect(html).toContain("Our analytics providers, Google Analytics and PostHog");
    expect(html).not.toMatch(/recordings? of some visits|records some visits/);
  });
});
