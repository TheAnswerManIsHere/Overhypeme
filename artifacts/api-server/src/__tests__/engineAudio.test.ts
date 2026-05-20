import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAudioHandling } from "../lib/engineAudio.js";
import type { Engine } from "@workspace/db/schema";

function engine(audioHandling: string): Engine {
  return { id: `e-${audioHandling}`, audioHandling } as unknown as Engine;
}

describe("applyAudioHandling", () => {
  const baseParams = { motionPrompt: "Slow cinematic zoom", imageUrl: "x" };

  it("prompt_cue: appends voiceover cue to motionPrompt", () => {
    const out = applyAudioHandling(engine("prompt_cue"), baseParams, "Hello, world!");
    assert.equal(
      out.motionPrompt,
      'Slow cinematic zoom\nVoiceover should say, "Hello, world!"',
    );
    assert.equal(out.imageUrl, "x");
  });

  it("native_lipsync: also appends voiceover cue to motionPrompt (Veo)", () => {
    const out = applyAudioHandling(engine("native_lipsync"), baseParams, "I said the thing");
    assert.equal(
      out.motionPrompt,
      'Slow cinematic zoom\nVoiceover should say, "I said the thing"',
    );
    // No dialogueText is added for native_lipsync — Veo reads from the prompt.
    assert.ok(!("dialogueText" in out));
  });

  it("voice_control: populates dialogueText for the interpreter, leaves prompt alone (Kling)", () => {
    const out = applyAudioHandling(engine("voice_control"), baseParams, "Hello, Kling");
    assert.equal(out.motionPrompt, "Slow cinematic zoom");
    assert.equal(out.dialogueText, "Hello, Kling");
  });

  it("native_audio_boolean: still appends voiceover cue (Seedance)", () => {
    const out = applyAudioHandling(engine("native_audio_boolean"), baseParams, "Seed says hi");
    assert.equal(
      out.motionPrompt,
      'Slow cinematic zoom\nVoiceover should say, "Seed says hi"',
    );
    assert.ok(!("dialogueText" in out));
  });

  it("none: returns params unchanged", () => {
    const out = applyAudioHandling(engine("none"), baseParams, "Will not be used");
    // Cue is dropped — engine has no audio surface.
    assert.equal(out.motionPrompt, "Slow cinematic zoom");
    assert.ok(!("dialogueText" in out));
  });

  it("null dialogueText: returns params unchanged (clone)", () => {
    const out = applyAudioHandling(engine("prompt_cue"), baseParams, null);
    assert.equal(out.motionPrompt, "Slow cinematic zoom");
    assert.notEqual(out, baseParams, "should return a new object, not the original");
  });

  it("empty dialogueText: returns params unchanged", () => {
    const out = applyAudioHandling(engine("prompt_cue"), baseParams, "");
    assert.equal(out.motionPrompt, "Slow cinematic zoom");
  });

  it("whitespace-only dialogueText: treated as empty", () => {
    const out = applyAudioHandling(engine("voice_control"), baseParams, "   ");
    assert.equal(out.motionPrompt, "Slow cinematic zoom");
    assert.ok(!("dialogueText" in out));
  });

  it("does not mutate the caller's params object", () => {
    const params = { motionPrompt: "Original" };
    const out = applyAudioHandling(engine("prompt_cue"), params, "x");
    assert.equal(params.motionPrompt, "Original");
    assert.notEqual(out.motionPrompt, params.motionPrompt);
  });

  it("trims dialogueText before embedding", () => {
    const out = applyAudioHandling(engine("voice_control"), baseParams, "  spaced  ");
    assert.equal(out.dialogueText, "spaced");
  });
});
