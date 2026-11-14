/**
 * Engines barrel — re-exports the catalogue and its types so call sites can
 * import everything from a single path. Engines live only here, in code
 * (decisions.md 2026-11-14); there is no engines table.
 */
export { ALL_ENGINES } from "./catalogue";
export { toEngineRecord, type Engine } from "./engineRecord";
export type {
  EngineDefinition,
  EngineKind,
  TierRequirement,
  ParamSchema,
  ParamSchemaEntry,
  ParamPredicate,
  ParamPrimitive,
  PriceModel,
  PriceSource,
  SizeOption,
  SizeVocabulary,
  TokenPriceComponent,
  WizardAspect,
} from "./types";
export { perCallBoundUsd, perImagePrice } from "./types";
