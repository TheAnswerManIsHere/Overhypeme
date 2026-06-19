import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { EnrichmentStalenessBadge } from "@/components/admin/EnrichmentEditor";
import { currentTaxonomyVersions } from "@workspace/api-zod";

const live = currentTaxonomyVersions();

describe("EnrichmentStalenessBadge", () => {
  it("shows 'up to date' when the stored classification version matches current", () => {
    render(
      <EnrichmentStalenessBadge
        e={{ classificationPromptVersion: live.classificationPromptVersion}}
      />,
    );
    const badge = screen.getByTestId("enrichment-staleness");
    expect(badge.getAttribute("data-stale")).toBe("false");
    expect(badge.textContent).toMatch(/up to date/i);
  });

  it("shows a stale badge with a stored→current diff when the version is old", () => {
    render(
      <EnrichmentStalenessBadge
        e={{ classificationPromptVersion: "v0-ancient"}}
      />,
    );
    const badge = screen.getByTestId("enrichment-staleness");
    expect(badge.getAttribute("data-stale")).toBe("true");
    expect(badge.textContent).toMatch(/stale/i);
    expect(badge.textContent).toContain("v0-ancient");
    expect(badge.textContent).toContain(live.classificationPromptVersion);
  });

  it("labels an unversioned (pre-versioning) enrichment as stale", () => {
    render(<EnrichmentStalenessBadge e={{ classificationPromptVersion: undefined}} />);
    const badge = screen.getByTestId("enrichment-staleness");
    expect(badge.getAttribute("data-stale")).toBe("true");
    expect(badge.textContent).toMatch(/unversioned/i);
  });

  it("does not show the visual-plan line when no plan exists, even if old enrichment", () => {
    render(<EnrichmentStalenessBadge e={{ classificationPromptVersion: "v0"}} />);
    const badge = screen.getByTestId("enrichment-staleness");
    // Only the taxonomy-enrichment row, no "Visual plan:" line.
    expect(badge.textContent).not.toMatch(/Visual plan:/i);
  });
});
