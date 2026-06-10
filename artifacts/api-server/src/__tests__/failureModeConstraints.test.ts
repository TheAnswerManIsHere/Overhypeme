/**
 * Unit tests for the reusable failure-mode constraint registry.
 *
 * Pure — keyed only off normalized data (frame + modifiers + secondary-character
 * presence). These verify the CONSERVATIVE emission rules from the role/action
 * hardening plan: soft role-preservation whenever secondary characters exist;
 * the STRONG sole-agent line and the active-action line ONLY on a reliable
 * active/direct-action frame; soft focus/relationship packs for crowd / causal /
 * object-reversal facts; and never a global duplicate ban.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  failureModeConstraints,
  isActiveActionFrame,
} from "../lib/imagePrompt/compilers/failureModeConstraints.js";

function joined(input: Parameters<typeof failureModeConstraints>[0]): string {
  return failureModeConstraints(input).join(" ").toLowerCase();
}

describe("isActiveActionFrame", () => {
  it("treats direct/in/mid-action frames as active", () => {
    for (const f of ["direct_action", "in_action", "mid-action", "action_shot", "direct action"]) {
      assert.equal(isActiveActionFrame(f), true, f);
    }
  });

  it("does NOT treat aftermath / symbolic / ceremony frames as active", () => {
    for (const f of ["implied_aftermath", "symbolic_language_break", "social_ceremony", "domestic_command", "", "target_reaction"]) {
      assert.equal(isActiveActionFrame(f), false, f);
    }
  });
});

describe("failureModeConstraints — role binding", () => {
  it("emits the soft role-preservation line when secondary characters exist", () => {
    const out = joined({ selectedFrame: "implied_aftermath", modifiers: [], hasSecondaryCharacters: true, subjectName: "David" });
    assert.match(out, /keep each named character in their stated visual role/);
    assert.match(out, /do not swap david's role with a secondary character/);
    // No strong sole-agent line on a non-active frame.
    assert.doesNotMatch(out, /only david performs the central action/);
  });

  it("adds the STRONG sole-agent line only on a reliable active-action frame", () => {
    const out = joined({ selectedFrame: "direct_action", modifiers: [], hasSecondaryCharacters: true, subjectName: "David" });
    assert.match(out, /only david performs the central action/);
  });

  it("emits no role-preservation line when there are no secondary characters", () => {
    const out = joined({ selectedFrame: "direct_action", modifiers: [], hasSecondaryCharacters: false, subjectName: "David" });
    assert.doesNotMatch(out, /keep each named character/);
    assert.doesNotMatch(out, /only david performs the central action/);
  });
});

describe("failureModeConstraints — active-action emphasis", () => {
  it("emits for a solo subject on an active-action frame (no secondary chars needed)", () => {
    const out = joined({ selectedFrame: "direct_action", modifiers: [], hasSecondaryCharacters: false, subjectName: "David" });
    assert.match(out, /show david actively performing the central action, not posing or passively present/);
  });

  it("does NOT emit on an aftermath / symbolic frame", () => {
    const out = joined({ selectedFrame: "implied_aftermath", modifiers: [], hasSecondaryCharacters: false, subjectName: "David" });
    assert.doesNotMatch(out, /actively performing the central action/);
  });
});

describe("failureModeConstraints — soft modifier packs", () => {
  it("crowd_reaction keeps the subject focal without asserting sole-agent", () => {
    const out = joined({ selectedFrame: "implied_aftermath", modifiers: ["crowd_reaction"], hasSecondaryCharacters: false, subjectName: "David" });
    assert.match(out, /the crowd reacts to and supports david rather than replacing david/);
    assert.doesNotMatch(out, /only david performs the central action/);
  });

  it("clear_causal_relationship asks for a legible cause↔effect", () => {
    const out = joined({ selectedFrame: "implied_aftermath", modifiers: ["clear_causal_relationship"], hasSecondaryCharacters: false, subjectName: "David" });
    assert.match(out, /show the cause and its effect together in the frame/);
  });

  it("subject_object_reversal keeps the subject from becoming a bystander", () => {
    const out = joined({ selectedFrame: "implied_aftermath", modifiers: ["subject_object_reversal"], hasSecondaryCharacters: false, subjectName: "David" });
    assert.match(out, /do not render david as a separate, uninvolved bystander/);
  });

  it("never emits a global duplicate ban", () => {
    const out = joined({ selectedFrame: "direct_action", modifiers: ["crowd_reaction", "clear_causal_relationship"], hasSecondaryCharacters: true, subjectName: "David" });
    assert.doesNotMatch(out, /duplicate|clone|mirror/);
  });

  it("falls back to 'the subject' when no name is known", () => {
    const out = joined({ selectedFrame: "direct_action", modifiers: [], hasSecondaryCharacters: false, subjectName: "" });
    assert.match(out, /show the subject actively performing/);
  });
});
