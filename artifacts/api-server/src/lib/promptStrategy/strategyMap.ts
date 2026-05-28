/**
 * Per-archetype visual strategy map (Phase 2A scaffold).
 *
 * The visual-preview generator (Phase 2A) and the future render-time prompt
 * generator (Phase 2) MUST consume an entry from this map — they may not
 * infer visual strategy from taxonomy alone. The structure + wiring live
 * here; the per-archetype CONTENT (strategy text, frames, subtype guidance,
 * visualization examples) is intentionally stubbed and authored by David
 * (or the Phase 2 work). Until content lands, preview output will be
 * intentionally thin — that's expected.
 */

import type { PrimaryArchetype, FactEnrichment } from "@workspace/api-zod";
import { PRIMARY_ARCHETYPES, subtypesForArchetype } from "@workspace/api-zod";
import type { ArchetypeStrategyEntry, SelectedStrategy } from "./types";

const STUB_FRAME = { id: "default", description: "TODO: author the default compositional frame for this archetype." };
const STUB_STRATEGY =
  "TODO: author the visual strategy for this archetype (how to stage the joke, what to emphasize, what to avoid).";

/**
 * One stub entry per archetype. Each gets a single default frame so the
 * selector always returns a well-formed `SelectedStrategy`.
 */
function buildStubMap(): Record<PrimaryArchetype, ArchetypeStrategyEntry> {
  const map = {} as Record<PrimaryArchetype, ArchetypeStrategyEntry>;
  for (const archetype of PRIMARY_ARCHETYPES) {
    map[archetype] = {
      archetype,
      strategy: STUB_STRATEGY,
      frames: [STUB_FRAME],
      subtypeGuidance: {},
      visualizationExamples: [],
    };
  }
  return map;
}

export const STRATEGY_MAP: Record<PrimaryArchetype, ArchetypeStrategyEntry> = buildStubMap();

/**
 * Select the strategy entry that the preview generator must use for a given
 * enrichment. Returns the archetype's strategy, the subtype's guidance (or a
 * "no subtype guidance authored yet" marker), and a chosen frame (the first
 * defined frame; deterministic).
 */
export function selectStrategyEntry(enrichment: FactEnrichment): SelectedStrategy {
  const entry = STRATEGY_MAP[enrichment.primaryArchetype];
  const subtypeGuidance =
    entry.subtypeGuidance[enrichment.subtype] ??
    `TODO: author per-subtype guidance for ${enrichment.subtype} (allowed subtypes for ${enrichment.primaryArchetype}: ${subtypesForArchetype(enrichment.primaryArchetype).join(", ")}).`;
  const frame = entry.frames[0] ?? STUB_FRAME;
  return {
    archetype: entry.archetype,
    strategy: entry.strategy,
    subtypeGuidance,
    frame,
    visualizationExamples: entry.visualizationExamples,
  };
}

/**
 * Serialize a SelectedStrategy for inclusion in a generator prompt. The model
 * sees this verbatim and is told to APPLY the strategy (not reason from
 * taxonomy alone).
 */
export function serializeStrategyForPrompt(selected: SelectedStrategy): string {
  const examples = selected.visualizationExamples.length
    ? selected.visualizationExamples
        .map((ex, i) => `  ${i + 1}. Fact: ${ex.factExample}\n     Scene idea: ${ex.sceneIdea}`)
        .join("\n")
    : "  (none authored yet)";
  return [
    `Archetype: ${selected.archetype}`,
    `Authored strategy: ${selected.strategy}`,
    `Selected frame [${selected.frame.id}]: ${selected.frame.description}`,
    `Subtype guidance: ${selected.subtypeGuidance}`,
    `Visualization examples:`,
    examples,
  ].join("\n");
}
