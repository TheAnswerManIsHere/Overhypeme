// Cast extraction (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, Proposed Design C):
// the one producer of a gag's cast. It binds, never renames; never invents a
// character; a failure throws and is never an empty cast; an empty list is a
// real result.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCastUserMessage,
  CastExtractionError,
  extractCastWithModel,
  normalizeCast,
} from "../lib/gags/castExtraction.js";

const reply = (cast: unknown) => async () => JSON.stringify({ cast });

describe("cast extraction", () => {
  it("reads the scene with the stand-in name and lists speakers and fact labels", () => {
    const msg = buildCastUserMessage({
      scene: "{NAME} drives {POSS} mom home.",
      bubbles: [{ entity: "mom", text: "Slow down!" }, { entity: "subject", text: "Nope." }],
      factCharacterLabels: ["mom"],
    });
    assert.equal(msg, 'SCENE: Alex drives their mom home.\nSPEAKERS: "mom"\nFACT CHARACTERS: "mom"');
  });

  it("binds a speaker under the bubble's exact string, never renaming the bubble", async () => {
    const bubbles = [{ entity: "Mom", text: "Slow down!" }];
    const result = await extractCastWithModel(
      { scene: "{NAME} drives; mom grips the dash.", bubbles },
      reply([{ label: "mom", description: "the older woman in the passenger seat" }]),
    );
    assert.deepEqual(result.cast, [{ label: "Mom", description: "the older woman in the passenger seat" }]);
    assert.deepEqual(result.unboundSpeakers, []);
    assert.deepEqual(bubbles, [{ entity: "Mom", text: "Slow down!" }]);
  });

  it("reports a speaker the scene does not show, and never invents it", async () => {
    const result = await extractCastWithModel(
      { scene: "{NAME} drives.", bubbles: [{ entity: "nurse", text: "Bye!" }] },
      reply([]),
    );
    assert.deepEqual(result.cast, []);
    assert.deepEqual(result.unboundSpeakers, ["nurse"]);
  });

  it("treats an empty list as a real result, stamped as extracted", async () => {
    const result = await extractCastWithModel({ scene: "{NAME} lifts a car.", bubbles: [] }, reply([]));
    assert.deepEqual(result.cast, []);
    assert.equal(result.extraction.promptVersion, "v1");
  });

  it("throws on unusable output and on an empty scene, never returning an empty cast", async () => {
    await assert.rejects(extractCastWithModel({ scene: "x", bubbles: [] }, async () => "not json"), CastExtractionError);
    await assert.rejects(extractCastWithModel({ scene: "x", bubbles: [] }, async () => "{}"), CastExtractionError);
    await assert.rejects(extractCastWithModel({ scene: " ", bubbles: [] }, reply([])), CastExtractionError);
  });

  it("drops the subject, tokens, duplicates and empty entries, and shortens descriptions", () => {
    const cast = normalizeCast({
      cast: [
        { label: "Alex", description: "the hero" },
        { label: "subject", description: "x" },
        { label: "{NAME}'s mom", description: "x" },
        { label: "bartender", description: "the man behind the bar polishing a glass while staring in disbelief at the scene unfolding before him at length" },
        { label: "Bartender", description: "again" },
        { label: "dog", description: "" },
      ],
    }, []);
    assert.equal(cast.length, 1);
    assert.equal(cast[0]!.label, "bartender");
    assert.ok(cast[0]!.description.length <= 80);
  });
});
