// The moderation test render's sample subject matches the reference photo it
// is drawn from: the wife's photo renders as Susan Franklin, she/her; every
// other photo as David Franklin, he/him. With no photo there is no render
// (compiler review, Phase 2: every picture starts from a photo).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FactEnrichment, ReferenceIdentityType } from "@workspace/api-zod";
import { NoUsablePhotoError, resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";
import { syntheticAnalysisForReference } from "../lib/reviewRenderScenarios";

const ENRICHMENT = {} as FactEnrichment; // unused on the no-style path

function fromReference(identityType: ReferenceIdentityType) {
  return {
    subjectRenderMode: identityType.startsWith("nonhuman") ? ("nonhuman_subject_i2i" as const) : ("human_identity_i2i" as const),
    sourceImageAnalysis: syntheticAnalysisForReference(identityType),
    referenceImageUrl: "https://example.com/ref.png",
    referenceIdentityType: identityType,
  };
}

describe("resolveRenderReviewInput — the sample subject follows the reference photo", () => {
  it("the wife's photo → Susan Franklin / she-her", async () => {
    const out = await resolveRenderReviewInput("{NAME} dances in {NAME_POSSESSIVE} pants.", ENRICHMENT, fromReference("female"));
    assert.equal(out.renderedSubject.name, "Susan Franklin");
    assert.equal(out.renderedSubject.pronouns, "she/her");
    assert.equal(out.renderedFactText, "Susan Franklin dances in Susan Franklin's pants.");
  });

  it("David's photo → David Franklin / he-him", async () => {
    const out = await resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, fromReference("male"));
    assert.equal(out.renderedSubject.name, "David Franklin");
    assert.equal(out.renderedSubject.pronouns, "he/him");
  });

  it("the cat's photo → David Franklin / he-him", async () => {
    const out = await resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, fromReference("nonhuman_animal"));
    assert.equal(out.renderedSubject.name, "David Franklin");
  });

  it("an explicit previewName still overrides the reference's default", async () => {
    const out = await resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, { ...fromReference("female"), previewName: "M.C. Hammer" });
    assert.equal(out.renderedSubject.name, "M.C. Hammer");
  });

  it("refuses a render with no photo, and the retired no-photo mode, naming why", async () => {
    await assert.rejects(resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, {}), (e: unknown) => e instanceof NoUsablePhotoError && /no photo was given/.test(e.message));
    await assert.rejects(
      resolveRenderReviewInput("{NAME} takes the stage.", ENRICHMENT, { ...fromReference("male"), subjectRenderMode: "t2i_fallback" }),
      NoUsablePhotoError,
    );
  });
});
