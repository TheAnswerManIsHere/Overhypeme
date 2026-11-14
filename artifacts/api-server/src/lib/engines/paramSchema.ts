/**
 * The engine parameter-schema types, read by the interpreter
 * (engineInterpreter.ts) and declared by every engine definition. A module of
 * their own, so neither side imports the other for them.
 */

export type ParamPrimitive =
  | "string"
  | "int"
  | "stringInt"
  | "boolean"
  | "float"
  /**
   * Wraps a scalar string into a single-element array, or passes an array
   * through unchanged. Needed for engines like Nano Banana Pro whose
   * `image_urls` input is an array even when only one reference is sent.
   */
  | "stringArray"
  /**
   * Parses "WxH" into `{ width, height }` for endpoints that take a size as
   * a pixel object (launch Phase 8's GPT Image 2.5 and Seedream 5.0 Pro).
   * Declare no `enum` on such an entry: the emitted value is an object.
   */
  | "dimensions";

/**
 * Tiny predicate language used by `includeWhen`. Evaluates against the
 * raw pipeline params object. Two shapes:
 *   - `{ field: "engineMode", equals: "custom" }`
 *   - `{ field: "videoLengthSeconds", greaterThan: 5 }`
 *   - `{ field: "renderedFactText", present: true }`
 *
 * Multiple conditions in the same object are AND-ed. Use a top-level `any`
 * key with an array of predicates for OR semantics.
 */
export interface ParamPredicate {
  field?: string;
  equals?: unknown;
  notEquals?: unknown;
  oneOf?: unknown[];
  greaterThan?: number;
  lessThan?: number;
  /** True when the field is defined AND non-empty. */
  present?: boolean;
  /** OR-of any sub-predicate. */
  any?: ParamPredicate[];
}

export interface ParamSchemaEntry {
  /** Output key on the final fal input object. */
  name: string;
  /** Pipeline-level key to read from. */
  from: string;
  /** Coercion primitive. */
  type: ParamPrimitive;
  /** Optional substitution table applied before validation/coercion. */
  map?: Record<string, unknown>;
  /**
   * Declared accepted values for this param. After map substitution, the
   * resolved value must be `===` one of these; otherwise we throw
   * InvalidEngineParamError before calling fal. Use to catch the "Veo
   * doesn't accept generate_audio" class of bug.
   */
  enum?: unknown[];
  /**
   * Numeric range. `policy: "clamp"` (default) silently constrains; "throw"
   * raises InvalidEngineParamError. No effect for non-numeric types.
   */
  range?: { min?: number; max?: number; policy?: "clamp" | "throw" };
  /**
   * When set, the param is only emitted if the predicate evaluates true
   * against the full pipeline params object. Use for conditional fields
   * like "only send voice_text when Kling voice control is enabled."
   */
  includeWhen?: ParamPredicate;
  /** Fallback value when the pipeline value is undefined/null/empty. */
  default?: unknown;
  /** When true and no value resolves, throws MissingRequiredParamError. */
  required?: boolean;
}

export interface ParamSchema {
  params: ParamSchemaEntry[];
  /** Static params merged into the final input as-is. */
  static?: Record<string, unknown>;
}
