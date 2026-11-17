/** FactEnrichmentVersionHistory — read-only history labels (never raw version_no). */

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  FactEnrichmentVersionHistory,
  type EnrichmentVersionInfo,
} from "@/components/admin/FactEnrichmentVersionHistory";

const INFO: EnrichmentVersionInfo = {
  current: { hasEnrichment: true, enrichmentStatus: "ok", hasOverrides: true },
  versions: [
    {
      id: 11, versionNo: 2, status: "promoted", source: "refresh_candidate", sourceReviewId: 30,
      // No display name on file — falls back to email, never the raw user id.
      note: null, createdByDisplayName: null, createdByEmail: "admin@example.com", createdAt: "2026-07-02T01:00:00Z",
      promotedAt: "2026-07-02T02:00:00Z", supersededAt: null, rejectedAt: null, enrichmentReady: true,
    },
    {
      id: 10, versionNo: 1, status: "superseded", source: "prior_active_snapshot", sourceReviewId: 30,
      note: null, createdByDisplayName: null, createdByEmail: null, createdAt: "2026-07-02T01:59:00Z",
      promotedAt: null, supersededAt: "2026-07-02T02:00:00Z", rejectedAt: null, enrichmentReady: true,
    },
  ],
};

function open() {
  fireEvent.click(screen.getByText(/Enrichment Version History/i));
}

describe("FactEnrichmentVersionHistory", () => {
  it("renders human labels for current / promoted / superseded", () => {
    render(<FactEnrichmentVersionHistory info={INFO} />);
    open();
    expect(screen.getByTestId("version-current").textContent).toContain("Current active");
    expect(screen.getByTestId("version-current").textContent).toContain("manually overridden");
    expect(screen.getByTestId("version-row-promoted").textContent).toMatch(/Promoted refresh from/);
    expect(screen.getByTestId("version-row-superseded").textContent).toMatch(/Previous active \(archived/);
    // Actor attribution is always human-readable: display name, or email as a
    // fallback — never a raw user id, and never omitted when one is known.
    expect(screen.getByTestId("version-row-promoted").textContent).toContain("by admin@example.com");
    // No display name or email on file (e.g. a deleted user) — no actor shown at all.
    expect(screen.getByTestId("version-row-superseded").textContent).not.toMatch(/by /);
  });

  it("shows the no-history empty state", () => {
    render(
      <FactEnrichmentVersionHistory
        info={{ current: { hasEnrichment: true, enrichmentStatus: "ok", hasOverrides: false }, versions: [] }}
      />,
    );
    open();
    expect(screen.getByText(/No earlier classifications/i)).toBeTruthy();
  });
});
