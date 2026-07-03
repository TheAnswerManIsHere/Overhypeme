/** FactEnrichmentVersionHistory — read-only history labels (never raw version_no). */

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  FactEnrichmentVersionHistory,
  type EnrichmentVersionInfo,
} from "@/components/admin/FactEnrichmentVersionHistory";

const INFO: EnrichmentVersionInfo = {
  current: { hasEnrichment: true, enrichmentStatus: "ok", hasOverrides: true },
  inFlight: { candidateVersionId: 12, reviewId: 34 },
  versions: [
    {
      id: 12, versionNo: 3, status: "candidate", source: "refresh_candidate", sourceReviewId: 34,
      note: null, createdBy: "admin-1", createdAt: "2026-07-03T01:00:00Z",
      promotedAt: null, supersededAt: null, rejectedAt: null, enrichmentReady: false,
    },
    {
      id: 11, versionNo: 2, status: "promoted", source: "refresh_candidate", sourceReviewId: 30,
      note: null, createdBy: "admin-1", createdAt: "2026-07-02T01:00:00Z",
      promotedAt: "2026-07-02T02:00:00Z", supersededAt: null, rejectedAt: null, enrichmentReady: true,
    },
    {
      id: 10, versionNo: 1, status: "superseded", source: "prior_active_snapshot", sourceReviewId: 30,
      note: null, createdBy: null, createdAt: "2026-07-02T01:59:00Z",
      promotedAt: null, supersededAt: "2026-07-02T02:00:00Z", rejectedAt: null, enrichmentReady: true,
    },
    {
      id: 9, versionNo: 0, status: "rejected", source: "refresh_candidate", sourceReviewId: 28,
      note: null, createdBy: "admin-1", createdAt: "2026-07-01T01:00:00Z",
      promotedAt: null, supersededAt: null, rejectedAt: "2026-07-01T02:00:00Z", enrichmentReady: true,
    },
  ],
};

function open() {
  fireEvent.click(screen.getByText(/Enrichment Version History/i));
}

describe("FactEnrichmentVersionHistory", () => {
  it("renders human labels for current / candidate / promoted / superseded / rejected", () => {
    render(<FactEnrichmentVersionHistory info={INFO} />);
    open();
    expect(screen.getByTestId("version-current").textContent).toContain("Current active");
    expect(screen.getByTestId("version-current").textContent).toContain("manually overridden");
    expect(screen.getByTestId("version-row-candidate").textContent).toMatch(/In review — refresh from .*classifying/);
    expect(screen.getByTestId("version-row-promoted").textContent).toMatch(/Promoted refresh from/);
    expect(screen.getByTestId("version-row-superseded").textContent).toMatch(/Previous active \(archived/);
    expect(screen.getByTestId("version-row-rejected").textContent).toMatch(/Rejected refresh from/);
    // A candidate row links to the moderation queue by review number.
    expect(screen.getByText("Review #34").getAttribute("href")).toBe("/admin/moderation");
  });

  it("shows the no-history empty state", () => {
    render(
      <FactEnrichmentVersionHistory
        info={{ current: { hasEnrichment: true, enrichmentStatus: "ok", hasOverrides: false }, inFlight: null, versions: [] }}
      />,
    );
    open();
    expect(screen.getByText(/never been sent back to review/i)).toBeTruthy();
  });
});
