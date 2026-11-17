/**
 * @purpose Reads a gag draft's cast for the editor before anything is stored: the fact's character labels plus one cast extraction on the utility model.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, F: preparing a draft is the
 * tokenize step with cast extraction added, run on the draft and storing
 * nothing. The save then carries the cast and the server checks it was read
 * from that content (`assertGagCast`).
 */
import { eq, sql } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import type { FactEnrichment, GagCastBody, GagCastView } from "@workspace/api-zod";
import { extractCast, type CastExtractionInput, type CastExtractionResult } from "./castExtraction";

let castExtractor: (input: CastExtractionInput) => Promise<CastExtractionResult> = extractCast;
/** Test seam: replace the model call. Returns the restore function. */
export function __setDraftCastExtractorForTest(fn: typeof castExtractor): () => void {
  const prev = castExtractor;
  castExtractor = fn;
  return () => { castExtractor = prev; };
}

export class CastPreparationError extends Error {
  constructor(public readonly code: "FACT_NOT_FOUND" | "CAST_FAILED", message: string, public readonly status: number) {
    super(message);
    this.name = "CastPreparationError";
  }
}

/** The fact's character labels: naming hints for extraction, never characters to add. */
export async function factCharacterLabels(factId: number): Promise<string[] | null> {
  // Only the characters, not the whole enrichment blob.
  const [fact] = await db.select({ characters: sql<FactEnrichment["characters"] | null>`${factsTable.enrichment} -> 'characters'` })
    .from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!fact) return null;
  return (fact.characters ?? []).map((c) => c.label).filter((l) => l.trim());
}

export async function prepareDraftCast(factId: number, body: GagCastBody): Promise<GagCastView> {
  const labels = await factCharacterLabels(factId);
  if (labels == null) throw new CastPreparationError("FACT_NOT_FOUND", `Fact ${factId} not found.`, 404);
  let result: CastExtractionResult;
  try {
    result = await castExtractor({ scene: body.scene, bubbles: body.bubbles, factCharacterLabels: labels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CastPreparationError("CAST_FAILED", `Reading who is in the scene failed: ${msg}`, 502);
  }
  return { cast: result.cast, castExtraction: result.extraction, unboundSpeakers: result.unboundSpeakers };
}
