/** RefreshReviewBadge — pure render (EnrichmentStalenessBadge pattern). */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RefreshReviewBadge } from "@/components/admin/RefreshReviewBadge";

describe("RefreshReviewBadge", () => {
  it("renders the refresh label with the explanatory tooltip", () => {
    render(<RefreshReviewBadge />);
    const badge = screen.getByTestId("refresh-review-badge");
    expect(badge.textContent).toContain("Refresh review");
    expect(badge.getAttribute("title")).toMatch(/rejecting keeps the live fact exactly as it is/i);
  });
});
