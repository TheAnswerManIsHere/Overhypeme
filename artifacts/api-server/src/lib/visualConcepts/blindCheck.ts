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

/**
 * The note the reduced arm is given: the note, then what the references mean.
 * With no note it is the meanings alone, and with neither it is null.
 */
export function noteWithMeanings(note: string, enrichment: FactEnrichment): string | null {
  const meanings = referenceMeaningLines(enrichment);
  const parts = [note.trim(), meanings.length ? `What the references mean:\n${meanings.join("\n")}` : ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/** Both arms' inputs. An empty note means the fact has none: today's arm then sends no note. */
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
    today: { ...base, humorNote: note || null, classification: "include" },
    reduced: { ...base, humorNote: noteWithMeanings(note, enrichment), classification: "omit" },
  };
}

