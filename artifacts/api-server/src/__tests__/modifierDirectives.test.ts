/**
 * Unit tests for the fact-modifier → compiler-directive map. Pure, no IO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { modifierDirectives } from "../lib/imagePrompt/modifierDirectives.js";

describe("modifierDirectives", () => {
  it("returns nothing for an empty / non-visual modifier set", () => {
    assert.deepEqual(modifierDirectives([]), []);
    // Pure setting flags are intentionally not mapped to directives.
    assert.deepEqual(modifierDirectives(["office_setting", "domestic_setting"]), []);
  });

  it("maps high-impact visual modifiers to directive sentences", () => {
    const out = modifierDirectives(["face_prominent", "crowd_reaction"]);
    assert.equal(out.length, 2);
    assert.match(out.join(" ").toLowerCase(), /face prominently/);
    assert.match(out.join(" ").toLowerCase(), /crowd reacting/);
  });

  it("phrases policy-adjacent modifiers as presentation constraints", () => {
    const out = modifierDirectives(["avoid_gore"]).join(" ").toLowerCase();
    assert.match(out, /non-graphic/);
    assert.doesNotMatch(out, /reject|moderation|block/);
  });

  it("ignores unknown modifiers and preserves a stable order", () => {
    const out = modifierDirectives(["not_a_real_modifier", "full_body_needed", "face_prominent"]);
    // face_prominent is emitted before full_body_needed per the map's order.
    assert.equal(out.length, 2);
    assert.match(out[0]!.toLowerCase(), /face prominently/);
    assert.match(out[1]!.toLowerCase(), /full body/);
  });
});
