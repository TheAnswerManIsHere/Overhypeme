import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { FactVisualReviewGrid } from "./FactVisualReviewGrid";
import type { FactEnrichment, RenderScenarioGrid } from "@workspace/api-zod";

/**
 * Covers the Step-2 grid's `reloadKey` contract: the moderation modal bumps it
 * after saving Advanced-Options enrichment so the grid re-fetches and tiles
 * recompute staleness against the freshly-saved staging-fact enrichment. The
 * poll loop is idle once tiles are terminal, so this nudge is what surfaces the
 * stale state.
 */

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "legendary", "earth"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

// A grid whose single tile is terminal (done) → the hook's poll loop stays idle,
// so any re-fetch must come from the reloadKey nudge, not polling.
function terminalGrid(stale: boolean): RenderScenarioGrid {
  return {
    reviewId: 7,
    cards: [
      {
        key: "generic_t2i",
        label: "Generic (t2i)",
        purpose: "p",
        referenceIdentityType: null,
        required: true,
        status: "done",
        stale,
        latestAttemptId: 1,
        imageUrl: "/img.png",
        message: null,
        applicability: null,
      },
    ],
    tally: { requested: 1, done: 1, rendering: 0, queued: 0, failed: 0, blocked: 0, skipped: 0, stale: stale ? 1 : 0 },
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe("FactVisualReviewGrid reloadKey", () => {
  it("re-fetches the grid when reloadKey changes (surfaces post-save staleness)", async () => {
    const getCalls: string[] = [];
    // First GET: not stale. Subsequent GETs: stale (simulating a saved enrichment).
    let getN = 0;
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const method = opts?.method ?? "GET";
      if (method === "GET" && String(url).includes("/render-scenarios")) {
        getCalls.push(String(url));
        getN += 1;
        return json(terminalGrid(getN > 1));
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FactVisualReviewGrid reviewId={7} enrichment={ENRICHMENT} reloadKey={0} />,
    );

    // Initial load resolves to a non-stale terminal grid; no stale tally shown.
    await screen.findByTestId("render-scenario-cards");
    expect(getCalls.length).toBe(1);
    expect(screen.queryByText(/stale/)).toBeNull();

    // Bump reloadKey as the modal does after a save → grid re-fetches.
    await act(async () => {
      rerender(<FactVisualReviewGrid reviewId={7} enrichment={ENRICHMENT} reloadKey={1} />);
    });

    expect(getCalls.length).toBe(2);
    // The re-fetch reports the tile as stale.
    await screen.findByText(/· 1 stale/);
  });
});
