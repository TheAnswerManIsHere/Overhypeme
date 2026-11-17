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
 *
 * What is judged is the gag writer's own words. The product converts each
 * scene and bubble line to tokens with a second model, which can fail or
 * reword a line (PR #1021 round 3); the comparison swaps the stand-in name
 * itself instead, and shows the ideas as the writer's reply gave them.
 */

import { candidateConceptsWireSchema, resolveRenderPolicy, type FactEnrichment } from "@workspace/api-zod";
import { referenceMeaningLines, STAND_IN_NAME, type GenerateVisualConceptsInput, type TokenizeFn } from "./generator";

export type Arm = "today" | "reduced";

const POSSESSIVE = new RegExp(`\\b${STAND_IN_NAME}'s\\b`, "g");
const NAME = new RegExp(`\\b${STAND_IN_NAME}\\b`, "g");

/** The comparison's name conversion: a plain swap, so no second model can fail or alter an idea. */
export const standInTokenize: TokenizeFn = async (text) => ({
  template: text.replace(POSSESSIVE, "{NAME_POSSESSIVE}").replace(NAME, "{NAME}"),
});

export interface WriterIdea {
  scene: string;
  bubbles: Array<{ type: string; entity: string; text: string }>;
}

/** The ideas exactly as the gag writer wrote them in a reply; null when the reply cannot be read. */
export function writerIdeas(raw: string | null): WriterIdea[] | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = candidateConceptsWireSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.concepts.map((c) => ({
    scene: c.sceneDescription,
    bubbles: c.bubbles.map((b) => ({ type: b.type, entity: b.entity, text: b.text })),
  }));
}

/** One idea as the judging sheet shows it: the writer's scene, then each bubble with words. */
export function ideaLines(idea: WriterIdea, n: number): string[] {
  const lines = [`**Idea ${n}.** ${idea.scene.trim()}`];
  for (const b of idea.bubbles) {
    if (!b.text.trim()) continue;
    lines.push(`- ${b.type} bubble, ${b.entity === "subject" ? STAND_IN_NAME : b.entity}: "${b.text.trim()}"`);
  }
  return lines;
}

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

