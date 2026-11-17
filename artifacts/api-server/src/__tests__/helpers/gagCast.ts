// A gag save carries a cast read from its own scene (plan
// docs/plans/PLAN_GAG_DIRECT_RENDER.md, C and F). Tests that save a gag stamp
// one here: an entry for every bubble speaker, as extraction would bind them,
// and the marker keyed to the content's scene and speakers.
import {
  activeBubbleSpeakers,
  castSourceKey,
  type GagCastEntry,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

export function withCast<T extends Partial<VisualPromptStrategyOverride>>(content: T, extra: GagCastEntry[] = []): T {
  const speakers = activeBubbleSpeakers(content.bubbles ?? []);
  const cast: GagCastEntry[] = [
    ...speakers.map((label) => ({ label, description: `the ${label} in the scene` })),
    ...extra.filter((e) => !speakers.some((s) => s.toLowerCase() === e.label.toLowerCase())),
  ];
  return {
    ...content,
    cast,
    castExtraction: {
      promptVersion: "test",
      extractedAt: "2026-11-17T00:00:00.000Z",
      sourceKey: castSourceKey(content.coreSceneOverride, content.bubbles ?? []),
    },
  };
}
