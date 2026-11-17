/**
 * The two requests of the gag-writer blind check (plan
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1A), kept here so they are
 * tested beside the request builder. The runner is
 * scripts/gag-writer-blind-check.ts.
 *
 * - "today":   the request exactly as the product sends it now;
 * - "reduced": the classification's meanings and mechanism left out, the
 *              meanings appended to the humor note instead.
 * Everything else is identical, so the check measures the inputs alone.
 */

import { resolveRenderPolicy, type FactEnrichment } from "@workspace/api-zod";
import { referenceMeaningLines, type GenerateVisualConceptsInput } from "./generator";

export type Arm = "today" | "reduced";

/** The note the reduced arm is given: the approved note, then what the references mean. */
export function noteWithMeanings(note: string, enrichment: FactEnrichment): string {
  const meanings = referenceMeaningLines(enrichment);
  const trimmed = note.trim();
  return meanings.length ? `${trimmed}\n\nWhat the references mean:\n${meanings.join("\n")}` : trimmed;
}

export function armInputs(factText: string, enrichment: FactEnrichment, rawNote: string): Record<Arm, GenerateVisualConceptsInput> {
  const note = rawNote.trim();
  const base = {
    factText,
    enrichment,
    renderPolicy: resolveRenderPolicy(enrichment),
    existingGags: [],
    draft: null,
  };
  return {
    today: { ...base, humorNote: note, classification: "include" },
    reduced: { ...base, humorNote: noteWithMeanings(note, enrichment), classification: "omit" },
  };
}

