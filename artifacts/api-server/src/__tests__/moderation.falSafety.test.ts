/**
 * Unit tests for the fal.ai built-in safety helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyFalSafetyTolerance,
  modelAcceptsSafetyTolerance,
  assertNoFalNsfwConcepts,
  FalSafetyTriggeredError,
} from "../lib/moderation/falSafety.js";

describe("moderation/falSafety", () => {
  describe("applyFalSafetyTolerance", () => {
    it("sets safety_tolerance on whitelisted FLUX text-to-image models", async () => {
      const input: Record<string, unknown> = {};
      await applyFalSafetyTolerance(input, "fal-ai/flux-pro/v1.1");
      assert.equal(typeof input["safety_tolerance"], "string");
    });
    it("does NOT set the field on unsupported models (e.g. PuLID)", async () => {
      const input: Record<string, unknown> = {};
      await applyFalSafetyTolerance(input, "fal-ai/flux-pulid");
      assert.equal("safety_tolerance" in input, false);
    });
    it("does not overwrite a caller-set safety_tolerance", async () => {
      const input: Record<string, unknown> = { safety_tolerance: "5" };
      await applyFalSafetyTolerance(input, "fal-ai/flux-pro/v1.1");
      assert.equal(input["safety_tolerance"], "5");
    });
    it("modelAcceptsSafetyTolerance covers the published whitelist", () => {
      assert.equal(modelAcceptsSafetyTolerance("fal-ai/flux-pro/v1.1"), true);
      assert.equal(modelAcceptsSafetyTolerance("fal-ai/flux-pulid"), false);
      assert.equal(modelAcceptsSafetyTolerance("fal-ai/ip-adapter-face-id-plus"), false);
    });
  });

  describe("assertNoFalNsfwConcepts", () => {
    it("passes a clean response", () => {
      const ok = { data: { has_nsfw_concepts: [false, false] } };
      assertNoFalNsfwConcepts(ok, "fal-ai/flux-pro/v1.1");
    });
    it("throws when has_nsfw_concepts contains true", () => {
      const tripped = { data: { has_nsfw_concepts: [false, true] } };
      assert.throws(() => assertNoFalNsfwConcepts(tripped, "fal-ai/flux-pro/v1.1"), FalSafetyTriggeredError);
    });
    it("throws when top-level has_nsfw_concepts is a true bool (video shape)", () => {
      const tripped = { data: { has_nsfw_concepts: true } };
      assert.throws(() => assertNoFalNsfwConcepts(tripped, "fal-ai/some-video"), FalSafetyTriggeredError);
    });
    it("throws when an image entry has has_nsfw_concepts: true (legacy shape)", () => {
      const tripped = { data: { images: [{ url: "u", has_nsfw_concepts: true }] } };
      assert.throws(() => assertNoFalNsfwConcepts(tripped, "fal-ai/flux-pro"), FalSafetyTriggeredError);
    });
    it("is a no-op for unrecognised shapes", () => {
      assertNoFalNsfwConcepts(null, "x");
      assertNoFalNsfwConcepts({}, "x");
      assertNoFalNsfwConcepts({ data: { something_else: true } }, "x");
    });
  });
});
