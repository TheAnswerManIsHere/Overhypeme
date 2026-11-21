/**
 * The shape of a stored `facts.last_processed_signature` and of a legacy
 * `fact_enrichment_versions.signature`. The processing signature and its
 * staleness reading were removed with Taxonomy Health (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, 2A): nothing writes or reads the value any
 * more. The shape stays only so the database's column type and the legacy
 * fixture's scrubber can describe the rows that still hold one, and leaves with
 * the columns (increment 2.1c).
 */

import { z } from "zod";

export interface ProcessingSignature {
  engineRevision: number;
  taxonomyVersion: string;
  classificationVersion: string;
  imagePromptGenerationVersion: string;
  visualStrategyVersion: string;
}

/** Validates a stored `last_processed_signature` / candidate `signature` blob. */
export const processingSignatureSchema = z.object({
  engineRevision: z.number().int(),
  taxonomyVersion: z.string(),
  classificationVersion: z.string(),
  imagePromptGenerationVersion: z.string(),
  visualStrategyVersion: z.string(),
});
