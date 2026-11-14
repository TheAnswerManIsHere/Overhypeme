/**
 * An engine's code definition as an `engines` row. Its own module so that
 * both reconciliation and the engine interpreter's effective definition can
 * use it without importing each other.
 */

import type { InsertEngine } from "@workspace/db/schema";
import type { EngineDefinition } from "./types";

/** Full row insert — includes both refreshed and preserved fields. */
export function codeDefinitionToRow(def: EngineDefinition): InsertEngine {
  return {
    id: def.id,
    provider: def.provider,
    endpointId: def.endpointId,
    label: def.label,
    description: def.description,
    kind: def.kind,
    tierRequirement: def.tierRequirement,
    isDefault: def.isDefault,
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
    defaultMaxTokens: def.defaultMaxTokens,
    defaultReasoningEffort: def.defaultReasoningEffort ?? null,
    // Image routing and costing (0123). Code-owned: refreshed every boot.
    // `retired` is deliberately absent: a migration sets it, and nothing in
    // code may clear it.
    imageMode: def.imageMode ?? null,
    family: def.family ?? null,
    sizeVocabulary: def.sizeVocabulary ?? null,
    priceModel: def.priceModel ?? null,
    deletedAt: null,
  };
}
