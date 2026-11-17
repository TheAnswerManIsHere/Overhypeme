/**
 * Taxonomy Health page — stale-for-reprocess row actions + header readout.
 *
 * A stale-for-reprocess row offers neither the direct Re-enrich (even when it
 * is ALSO stale_enrichment_version) nor a send-back, which was removed with
 * refresh reviews (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1H); and the header
 * renders the engine revision from the extended summary response.
 *
 * AdminLayout is stubbed to a passthrough so the test needs no auth provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  CLASSIFICATION_PROMPT_VERSION,
  type FactTaxonomyHealth,
  type TaxonomyHealthReviewFlags,
} from "@workspace/api-zod";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TaxonomyHealth from "./taxonomy-health";

const NO_FLAGS: TaxonomyHealthReviewFlags = {
  lowConfidence: false,
  questionableFit: false,
  rejectFit: false,
  adultRequiresReview: false,
  culturalReferenceNeedsResearch: false,
  semanticEntityNeedsReview: false,
  staleEnrichmentVersion: false,
  staleForReprocess: false,
  projectionMismatch: false,
  invalidEnrichment: false,
  missingCharacterList: false,
};

function makeHealth(
  factId: number,
  flags: Partial<TaxonomyHealthReviewFlags>,
  statuses: FactTaxonomyHealth["statuses"],
): FactTaxonomyHealth {
  return {
    factId,
    overallStatus: "healthy",
    statuses,
    issues: [{ code: "stale_for_reprocess", severity: "info", message: "Processed under an older engine revision.", recommendedAction: "none" }],
    reviewFlags: { ...NO_FLAGS, ...flags },
    summary: {
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      taxonomyConfidence: 0.9,
      overhypeFit: "strong",
      adultSuitability: "safe",
      taxonomyVersion: "v1",
      // Current so VersionDiff renders nothing (avoids depending on its output).
      classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
      visualStrategyVersion: "v2",
      enrichedAt: null,
      enrichedBy: "openai",
    },
  };
}

// Fact 1: overlapping — stale_for_reprocess AND stale_enrichment_version.
// Fact 2: stale_for_reprocess with a refresh already in flight.
const ROWS = [
  {
    factId: 1,
    factText: "Overlapping stale fact.",
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    overhypeFit: "strong",
    adultSuitability: "safe",
    taxonomyConfidence: 0.9,
    health: makeHealth(1, { staleForReprocess: true, staleEnrichmentVersion: true }, ["stale_for_reprocess", "stale_enrichment_version"]),
    updatedAt: null,
  },
];

function mockFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/summary")) {
      return new Response(
        JSON.stringify({
          totalFacts: 2, healthy: 2, missingEnrichment: 0, invalidEnrichment: 0,
          needsAdminReview: 0, staleEnrichmentVersion: 1, staleForReprocess: 2,
          projectionMismatch: 0, incompleteCulturalReferences: 0,
          semanticEntitiesNeedReview: 0, lowConfidence: 0, engineRevision: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // list
    return new Response(
      JSON.stringify({ rows: ROWS, total: ROWS.length, limit: 100, offset: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }));
}

function renderPage() {
  const { hook } = memoryLocation({ path: "/admin/taxonomy-health" });
  return render(<Router hook={hook}><TaxonomyHealth /></Router>);
}

beforeEach(() => mockFetch());
afterEach(() => vi.unstubAllGlobals());

describe("TaxonomyHealth — stale-for-reprocess rows", () => {
  it("renders the engine revision from the summary response", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("engine-revision").textContent).toContain("5"));
  });

  it("an overlapping stale row offers no direct Re-enrich and no send-back", async () => {
    renderPage();
    const row = await waitFor(() => {
      const cell = screen.getByText("Overlapping stale fact.").closest("tr");
      expect(cell).toBeTruthy();
      return cell as HTMLElement;
    });
    expect(within(row).queryByText("Re-enrich")).toBeNull();
    expect(within(row).queryByText(/send back/i)).toBeNull();
    expect(screen.queryByText(/send next 50/i)).toBeNull();
  });
});
