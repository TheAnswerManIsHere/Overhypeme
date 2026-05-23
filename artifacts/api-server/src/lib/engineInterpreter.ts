import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { enginesTable, type Engine } from "@workspace/db/schema";
import { logger } from "./logger.js";

/**
 * Data-driven engine interpreter.
 *
 * Replaces the legacy per-model `buildFalInput` switch in routes/videos.ts.
 * Each engine row in the `engines` table carries a `paramSchema` JSONB blob
 * describing how pipeline-level parameters (motionPrompt, durationSec,
 * aspectRatio, etc.) map onto the model's actual fal.ai input shape.
 *
 * Supported parameter primitives:
 *   - "string"      — String(value)
 *   - "int"         — Math.round(Number(value))
 *   - "stringInt"   — String(Math.round(Number(value)))  (Kling wants "5" not 5)
 *   - "boolean"     — Boolean(value)
 *   - "float"       — Number(value)
 *   - "stringArray" — wraps a scalar into [scalar]; passes arrays through
 *                     (Nano Banana Pro wants `image_urls: [url]`)
 *
 * Per-entry validation and conditional inclusion:
 *   - `enum`         — declared values array; rejects unknown values with
 *                       InvalidEngineParamError before reaching fal
 *   - `range`        — {min, max} for numerics; "clamp" (default) silently
 *                       constrains, "throw" raises InvalidEngineParamError
 *   - `includeWhen`  — predicate object on other pipeline-level fields;
 *                       when false the param is dropped (key not emitted)
 *   - `map`          — substitution table (any type) applied before
 *                       enum/range/coerce (e.g. wizard "landscape" → fal "16:9")
 *
 * Unknown types throw UnknownParamTypeError so adding a new engine that
 * needs a new primitive surfaces immediately rather than silently passing
 * the raw value through.
 */

// ────────────────────────────────────────────────────────────────────────────
// ParamSchema shape (matches lib/db/src/schema/engines.ts JSONDB comment)
// ────────────────────────────────────────────────────────────────────────────

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
  | "stringArray";

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

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

export class MissingRequiredParamError extends Error {
  readonly engineId: string;
  readonly paramName: string;
  readonly fromKey: string;
  constructor(engineId: string, paramName: string, fromKey: string) {
    super(
      `Engine "${engineId}" requires parameter "${paramName}" (from "${fromKey}") but no value was provided`,
    );
    this.name = "MissingRequiredParamError";
    this.engineId = engineId;
    this.paramName = paramName;
    this.fromKey = fromKey;
  }
}

export class UnknownParamTypeError extends Error {
  readonly engineId: string;
  readonly paramName: string;
  readonly type: string;
  constructor(engineId: string, paramName: string, type: string) {
    super(
      `Engine "${engineId}" parameter "${paramName}" uses unknown type "${type}". ` +
        `Supported: string, int, stringInt, boolean, float, stringArray.`,
    );
    this.name = "UnknownParamTypeError";
    this.engineId = engineId;
    this.paramName = paramName;
    this.type = type;
  }
}

export class InvalidEngineParamError extends Error {
  readonly engineId: string;
  readonly paramName: string;
  readonly reason: string;
  readonly value: unknown;
  constructor(engineId: string, paramName: string, reason: string, value: unknown) {
    super(
      `Engine "${engineId}" parameter "${paramName}" failed validation: ${reason} (value=${JSON.stringify(value)})`,
    );
    this.name = "InvalidEngineParamError";
    this.engineId = engineId;
    this.paramName = paramName;
    this.reason = reason;
    this.value = value;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory cache (60s TTL)
// ────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const engineByIdCache = new Map<string, CacheEntry<Engine | null>>();
const defaultByKindCache = new Map<string, CacheEntry<Engine>>();
const activeByKindCache = new Map<string, CacheEntry<Engine[]>>();

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test/admin hook — clears all in-memory engine caches. */
export function clearEngineCaches(): void {
  engineByIdCache.clear();
  defaultByKindCache.clear();
  activeByKindCache.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// Loaders
// ────────────────────────────────────────────────────────────────────────────

/** Fetches an engine row by id. Cached. Returns null when not found. */
export async function loadEngine(id: string): Promise<Engine | null> {
  const cached = getCached(engineByIdCache, id);
  if (cached !== undefined) return cached;

  const [row] = await db
    .select()
    .from(enginesTable)
    .where(eq(enginesTable.id, id))
    .limit(1);
  const value = row ?? null;
  setCached(engineByIdCache, id, value);
  return value;
}

/** Fetches the default engine for a kind. Throws if no active default exists. */
export async function loadDefaultEngine(
  kind: "image" | "video" | "utility",
): Promise<Engine> {
  const cached = getCached(defaultByKindCache, kind);
  if (cached) return cached;

  const [row] = await db
    .select()
    .from(enginesTable)
    .where(
      and(
        eq(enginesTable.kind, kind),
        eq(enginesTable.isDefault, true),
        eq(enginesTable.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(`No active default engine found for kind="${kind}"`);
  }
  setCached(defaultByKindCache, kind, row);
  return row;
}

export interface LoadActiveEnginesOpts {
  /**
   * Predicate the caller supplies to test whether the requesting user has
   * a feature flag enabled. The interpreter never reads from a user-flag
   * source itself — callers (route handlers) wire it up.
   */
  userHasFlag?: (flag: string) => boolean;
}

/**
 * Returns active engines for a kind, filtered by feature-flag visibility.
 *
 * An engine is included when:
 *   - isActive = true, AND
 *   - featureFlagRequired is null, OR
 *   - the supplied predicate returns true for that flag, OR
 *   - the engine is the default for its kind (defaults are always visible)
 */
export async function loadActiveEngines(
  kind: "image" | "video" | "utility",
  opts: LoadActiveEnginesOpts = {},
): Promise<Engine[]> {
  let rows = getCached(activeByKindCache, kind);
  if (!rows) {
    rows = await db
      .select()
      .from(enginesTable)
      .where(and(eq(enginesTable.kind, kind), eq(enginesTable.isActive, true)));
    setCached(activeByKindCache, kind, rows);
  }

  const { userHasFlag } = opts;
  return rows.filter((engine) => {
    if (engine.isDefault) return true;
    if (!engine.featureFlagRequired) return true;
    if (!userHasFlag) return false;
    return userHasFlag(engine.featureFlagRequired);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Interpreter
// ────────────────────────────────────────────────────────────────────────────

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function coerce(
  type: ParamPrimitive,
  value: unknown,
  engineId: string,
  paramName: string,
): unknown {
  switch (type) {
    case "string":
      return String(value);
    case "int":
      return Math.round(Number(value));
    case "stringInt":
      return String(Math.round(Number(value)));
    case "boolean":
      return Boolean(value);
    case "float":
      return Number(value);
    case "stringArray":
      return Array.isArray(value) ? value.map(String) : [String(value)];
    default: {
      // Exhaustive check — anything else throws.
      throw new UnknownParamTypeError(engineId, paramName, String(type));
    }
  }
}

/** Evaluates a predicate against the pipeline params object. */
function evalPredicate(
  predicate: ParamPredicate,
  params: Record<string, unknown>,
): boolean {
  if (predicate.any && predicate.any.length > 0) {
    return predicate.any.some((p) => evalPredicate(p, params));
  }
  if (!predicate.field) return true;
  const value = params[predicate.field];
  if (predicate.present !== undefined) {
    const isPresent = !isEmpty(value);
    if (isPresent !== predicate.present) return false;
  }
  if (predicate.equals !== undefined && value !== predicate.equals) return false;
  if (predicate.notEquals !== undefined && value === predicate.notEquals) return false;
  if (predicate.oneOf !== undefined && !predicate.oneOf.includes(value)) return false;
  if (predicate.greaterThan !== undefined) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= predicate.greaterThan) return false;
  }
  if (predicate.lessThan !== undefined) {
    const n = Number(value);
    if (!Number.isFinite(n) || n >= predicate.lessThan) return false;
  }
  return true;
}

/**
 * Validates a resolved (post-map, post-coerce) value against the entry's
 * `enum` and `range` declarations. Throws InvalidEngineParamError on a
 * miss. Range with `policy: "clamp"` mutates the value to fit; returns the
 * possibly-clamped value.
 */
function validateAndConstrain(
  engineId: string,
  entry: ParamSchemaEntry,
  coerced: unknown,
): unknown {
  // enum check — must match strictly after coercion.
  if (entry.enum && entry.enum.length > 0) {
    const match = entry.enum.some((allowed) => allowed === coerced);
    if (!match) {
      throw new InvalidEngineParamError(
        engineId,
        entry.name,
        `value not in declared enum [${entry.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
        coerced,
      );
    }
  }
  // range check — only meaningful for numerics.
  if (entry.range && typeof coerced === "number" && Number.isFinite(coerced)) {
    const { min, max, policy = "clamp" } = entry.range;
    if (min !== undefined && coerced < min) {
      if (policy === "throw") {
        throw new InvalidEngineParamError(
          engineId,
          entry.name,
          `value ${coerced} below min ${min}`,
          coerced,
        );
      }
      return min;
    }
    if (max !== undefined && coerced > max) {
      if (policy === "throw") {
        throw new InvalidEngineParamError(
          engineId,
          entry.name,
          `value ${coerced} above max ${max}`,
          coerced,
        );
      }
      return max;
    }
  }
  return coerced;
}

/**
 * Walks engine.paramSchema and builds the fal.subscribe input object from
 * pipeline-level params.
 *
 * Rules per entry:
 *   1. Read pipelineParams[entry.from].
 *   2. If `map` is present, substitute via map[value] when defined.
 *   3. If value is undefined/null/empty AND a default exists → use default.
 *   4. If value is still undefined/null/empty:
 *        - required → throw MissingRequiredParamError
 *        - otherwise skip the entry entirely (do not emit the key)
 *   5. Coerce by `type` and emit under `entry.name`.
 *
 * Static params (engine.paramSchema.static) are merged in as-is.
 */
export function buildEngineInput(
  engine: Engine,
  pipelineParams: Record<string, unknown>,
): Record<string, unknown> {
  const schema = engine.paramSchema as unknown as ParamSchema | null;
  if (!schema || !Array.isArray(schema.params)) {
    throw new Error(
      `Engine "${engine.id}" has malformed paramSchema (expected {params: []})`,
    );
  }

  const out: Record<string, unknown> = {};

  for (const entry of schema.params) {
    if (!entry || typeof entry.name !== "string" || typeof entry.from !== "string") {
      logger.warn(
        { engineId: engine.id, entry },
        "[engineInterpreter] Skipping malformed paramSchema entry",
      );
      continue;
    }

    // Step 0: conditional inclusion. If the predicate fails, drop the
    // entry entirely — the key is not emitted regardless of defaults.
    if (entry.includeWhen && !evalPredicate(entry.includeWhen, pipelineParams)) {
      continue;
    }

    const raw = pipelineParams[entry.from];

    // Step 2: optional map substitution. The map may translate to a falsy
    // value intentionally, so we only substitute when the key is present.
    let mapped: unknown = raw;
    if (entry.map && raw !== undefined && raw !== null) {
      const key = String(raw);
      if (Object.prototype.hasOwnProperty.call(entry.map, key)) {
        mapped = entry.map[key];
      }
    }

    // Step 3: default fallback.
    let resolved: unknown = mapped;
    if (isEmpty(resolved) && entry.default !== undefined) {
      resolved = entry.default;
    }

    // Step 4: required / skip.
    if (isEmpty(resolved)) {
      if (entry.required) {
        throw new MissingRequiredParamError(engine.id, entry.name, entry.from);
      }
      continue;
    }

    // Step 5: coerce + validate + emit.
    const coerced = coerce(entry.type, resolved, engine.id, entry.name);
    out[entry.name] = validateAndConstrain(engine.id, entry, coerced);
  }

  // Merge static params last so they always win against accidental overrides.
  if (schema.static && typeof schema.static === "object") {
    Object.assign(out, schema.static);
  }

  return out;
}
