/**
 * Engines barrel — re-exports the catalogue, reconciler, and types so call
 * sites can import everything from a single path. The ALL_ENGINES array
 * itself lives in `catalogue.ts` to avoid a cycle with reconcile.ts (which
 * imports the array directly from catalogue.ts to keep the dependency
 * graph one-directional).
 */
export { ALL_ENGINES } from "./catalogue";
export { reconcileEngines } from "./reconcile";
export type {
  EngineDefinition,
  AudioHandling,
  EngineKind,
  TierRequirement,
  ParamSchema,
  ParamSchemaEntry,
  ParamPredicate,
  ParamPrimitive,
} from "./types";
export { ADMIN_EDITABLE_FIELDS, type AdminEditableField } from "./types";
