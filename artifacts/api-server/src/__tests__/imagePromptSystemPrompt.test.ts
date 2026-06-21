/**
 * Unit tests for composeImagePromptSystemPrompt — the admin-config-proof,
 * idempotent append of the non-configurable platform hard rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  composeImagePromptSystemPrompt,
  IMAGE_PROMPT_PLATFORM_HARD_RULES_MARKER,
  FACT_IMAGE_PROMPT_SYSTEM_DEFAULT,
} from "../lib/imagePromptConfig.js";

describe("composeImagePromptSystemPrompt", () => {
  it("appends the platform hard rules to a stale/admin-configured base prompt", () => {
    const composed = composeImagePromptSystemPrompt("OLD ADMIN PROMPT with no platform rules.");
    assert.match(composed, new RegExp(IMAGE_PROMPT_PLATFORM_HARD_RULES_MARKER.replace(/[()]/g, "\\$&")));
    assert.match(composed, /do not omit the bodies, casualties, or death the fact calls for/i);
  });

  it("is idempotent — never duplicates the block when the marker is already present", () => {
    const once = composeImagePromptSystemPrompt("base prompt");
    const twice = composeImagePromptSystemPrompt(once);
    assert.equal(once, twice);
    const occurrences = twice.split(IMAGE_PROMPT_PLATFORM_HARD_RULES_MARKER).length - 1;
    assert.equal(occurrences, 1);
  });

  it("states the gratuitous-gore boundary without forbidding bodies/blood/casualties", () => {
    const composed = composeImagePromptSystemPrompt(FACT_IMAGE_PROMPT_SYSTEM_DEFAULT);
    assert.match(composed, /gratuitous gore/i);
    assert.doesNotMatch(composed, /no gore\b/i);
    assert.doesNotMatch(composed, /no blood\b/i);
    // The marker text mentions "no bodies" only as something NOT to invent;
    // ensure we are not instructing the model to avoid bodies.
    assert.doesNotMatch(composed, /avoid (?:depicting )?bodies/i);
  });
});
