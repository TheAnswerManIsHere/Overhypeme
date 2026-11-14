/**
 * An engine as the rest of the server reads it: its code definition, in the
 * flat shape the old `engines` table row had, so readers keep their field
 * names. There is no table any more (decisions.md 2026-11-14, AI call
 * settings live in code); this record is built from the catalogue and is the
 * only copy.
 */

import type { EngineDefinition } from "./types";

export interface Engine {
  id: string;
  provider: string;
  endpointId: string;
  label: string;
  description: string;
  kind: string;
  tierRequirement: string;
  isActive: boolean;
  sortOrder: number;
  allowedResolutions: unknown;
  defaultResolution: string | null;
  allowedAspectRatios: unknown;
  defaultAspectRatio: string | null;
  paramSchema: unknown;
  /** Decimal string, as the column was. */
  estimatedCostUsdPerCall: string | null;
  expectedRunMs: number;
  featureFlagRequired: string | null;
  /** Decimal string, as the column was. */
  defaultTemperature: string | null;
  defaultMaxTokens: number | null;
  defaultReasoningEffort: string | null;
  imageMode: string | null;
  family: string | null;
  sizeVocabulary: unknown;
  priceModel: unknown;
}

/** The engine record for a code definition. */
export function toEngineRecord(def: EngineDefinition): Engine {
  return {
    id: def.id,
    provider: def.provider,
    endpointId: def.endpointId,
    label: def.label,
    description: def.description,
    kind: def.kind,
    tierRequirement: def.tierRequirement,
    isActive: def.isActive,
    sortOrder: def.sortOrder,
    allowedResolutions: def.allowedResolutions,
    defaultResolution: def.defaultResolution,
    allowedAspectRatios: def.allowedAspectRatios,
    defaultAspectRatio: def.defaultAspectRatio,
    paramSchema: def.paramSchema,
    estimatedCostUsdPerCall:
      def.estimatedCostUsdPerCall != null ? String(def.estimatedCostUsdPerCall) : null,
    expectedRunMs: def.expectedRunMs,
    featureFlagRequired: def.featureFlagRequired,
    defaultTemperature:
      def.defaultTemperature != null ? String(def.defaultTemperature) : null,
    defaultMaxTokens: def.defaultMaxTokens ?? null,
    defaultReasoningEffort: def.defaultReasoningEffort ?? null,
    imageMode: def.imageMode ?? null,
    family: def.family ?? null,
    sizeVocabulary: def.sizeVocabulary ?? null,
    priceModel: def.priceModel ?? null,
  };
}
