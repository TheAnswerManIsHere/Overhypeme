import { describe, it, expect } from "vitest";
import { buildVideoJobPayload } from "../util/saveVideoMemePayload";

describe("buildVideoJobPayload", () => {
  const BASE = {
    factId: 42,
    sourceImagePath: "/objects/uploads/abc.jpg",
    lookStyleId: "cinematic",
    motionPresetId: "slow-push",
    videoEngineId: "xai/grok-imagine-video/image-to-video",
    engineMode: "normal",
    lengthSeconds: 6,
    resolution: "480p",
    aspectRatio: "portrait" as const,
  };

  it("includes lookStyleId for stylize-then-video", () => {
    const out = buildVideoJobPayload({ ...BASE, sourceMode: "stylize-then-video" });
    expect(out.sourceMode).toBe("stylize-then-video");
    expect(out.lookStyleId).toBe("cinematic");
    expect(out.sourceImagePath).toBe("/objects/uploads/abc.jpg");
  });

  it("omits lookStyleId for use-photo-as-is", () => {
    const out = buildVideoJobPayload({ ...BASE, sourceMode: "use-photo-as-is" });
    expect(out.sourceMode).toBe("use-photo-as-is");
    expect(out.lookStyleId).toBeUndefined();
  });

  it("keeps lookStyleId for use-existing-ai-image", () => {
    const out = buildVideoJobPayload({ ...BASE, sourceMode: "use-existing-ai-image" });
    expect(out.sourceMode).toBe("use-existing-ai-image");
    expect(out.lookStyleId).toBe("cinematic");
  });

  it("includes customModePrompt only when engineMode === 'custom'", () => {
    const withoutCustom = buildVideoJobPayload({
      ...BASE,
      sourceMode: "stylize-then-video",
      customModePrompt: "handheld",
    });
    expect(withoutCustom.customModePrompt).toBeUndefined();

    const withCustom = buildVideoJobPayload({
      ...BASE,
      sourceMode: "stylize-then-video",
      engineMode: "custom",
      customModePrompt: "  handheld camera  ",
    });
    expect(withCustom.customModePrompt).toBe("handheld camera");
  });

  it("omits an empty customModePrompt even in custom mode", () => {
    const out = buildVideoJobPayload({
      ...BASE,
      sourceMode: "stylize-then-video",
      engineMode: "custom",
      customModePrompt: "   ",
    });
    expect(out.customModePrompt).toBeUndefined();
  });

  it("includes trimmed name and pronouns when present", () => {
    const out = buildVideoJobPayload({
      ...BASE,
      sourceMode: "stylize-then-video",
      name: "  Quinn  ",
      pronouns: "they/them",
    });
    expect(out.name).toBe("Quinn");
    expect(out.pronouns).toBe("they/them");
  });

  it("omits empty/missing optional fields", () => {
    const out = buildVideoJobPayload({
      factId: 1,
      sourceMode: "use-photo-as-is",
      sourceImagePath: "/objects/x.jpg",
      lengthSeconds: 6,
      resolution: "480p",
      aspectRatio: "portrait",
    });
    expect(out.lookStyleId).toBeUndefined();
    expect(out.motionPresetId).toBeUndefined();
    expect(out.engineMode).toBeUndefined();
    expect(out.customModePrompt).toBeUndefined();
    expect(out.name).toBeUndefined();
    expect(out.pronouns).toBeUndefined();
  });

  it("includes motionPresetId only when truthy", () => {
    const noMotion = buildVideoJobPayload({
      ...BASE,
      sourceMode: "stylize-then-video",
      motionPresetId: null,
    });
    expect(noMotion.motionPresetId).toBeUndefined();
  });
});
