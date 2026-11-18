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
    const user = { id: "u1", email: "sam@example.com", firstName: "Sam", displayName: "Sammy" };
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
