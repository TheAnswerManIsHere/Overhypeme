/**
 * #686 — a generation refusal must reach the user as a sentence, never as the
 * server's machine code.
 */
import { describe, it, expect } from "vitest";
import { generationErrorMessage } from "@/lib/generation-errors";

const FALLBACK = "Generation failed. Please try again.";

describe("generationErrorMessage", () => {
  it("turns style_invalid into a plain 'style unavailable' message", () => {
    const msg = generationErrorMessage("style_invalid", FALLBACK);
    expect(msg).toMatch(/style/i);
    expect(msg).toMatch(/unavailable|isn't available|not available/i);
    expect(msg).not.toContain("style_invalid");
  });

  it("never shows any other machine code: identifier-shaped strings become the fallback", () => {
    for (const code of [
      "generate_v2_failed",
      "fact_template_unresolved",
      "fact_enrichment_invalid",
      "human_i2i_requires_usable_face",
      "upload_not_found",
      "BUDGET_EXCEEDED",
    ]) {
      expect(generationErrorMessage(code, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("passes a readable server sentence through unchanged", () => {
    const sentence = "You have reached your image storage limit. Delete some of your existing AI backgrounds or uploaded images to generate new ones.";
    expect(generationErrorMessage(sentence, FALLBACK)).toBe(sentence);
    expect(generationErrorMessage("Fact not found", FALLBACK)).toBe("Fact not found");
  });

  it("uses the fallback when there is no error string", () => {
    expect(generationErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    expect(generationErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(generationErrorMessage("", FALLBACK)).toBe(FALLBACK);
  });
});
