// Regression: the moderation test render must sample a subject NAME (and
// pronouns) that match the fallback gender the engine is told to generate —
// otherwise a "female protagonist" render samples "David Franklin … his pants".
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FactEnrichment } from "@workspace/api-zod";
import { resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";

const ENRICHMENT = {} as FactEnrichment; // unused on the t2i no-style path

function t2iControls(fallbackSubjectGender: "male" | "female" | "neutral") {
  return {
    subjectRenderMode: "t2i_fallback" as const,
    renderControls: { fallbackSubjectGender },
  };
}

describe("resolveRenderReviewInput — gender-matched sample subject", () => {
  it("female → Susan Franklin / she-her", async () => {
    const out = await resolveRenderReviewInput("{NAME} dances in {NAME_POSSESSIVE} pants.", ENRICHMENT, t2iControls("female"));
    assert.equal(out.renderedSubject.name, "Susan Franklin");
    assert.equal(out.renderedSubject.pronouns, "she/her");
    assert.equal(out.renderedFactText, "Susan Franklin dances in Susan Franklin's pants.");
  });

  it("neutral → Alex Franklin / they-them", async () => {
    const out = await resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, t2iControls("neutral"));
    assert.equal(out.renderedSubject.name, "Alex Franklin");
    assert.equal(out.renderedSubject.pronouns, "they/them");
  });

  it("male → David Franklin / he-him (historical default)", async () => {
    const out = await resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, t2iControls("male"));
    assert.equal(out.renderedSubject.name, "David Franklin");
    assert.equal(out.renderedSubject.pronouns, "he/him");
  });

  it("an explicit previewName still overrides the gender default", async () => {
    const out = await resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, {
      ...t2iControls("female"),
      previewName: "M.C. Hammer",
    });
    assert.equal(out.renderedSubject.name, "M.C. Hammer");
  });
});
