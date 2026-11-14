import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { enginesTable, type Engine } from "@workspace/db/schema";
import { logger } from "./logger.js";
import { ALL_ENGINES } from "./engines/catalogue";
import { codeDefinitionToRow } from "./engines/toRow";
import type { EngineDefinition } from "./engines/types";

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
 *   - "dimensions"  — "WxH" (e.g. "1024x1536") → { width, height }; for
 *                     endpoints whose size is a pixel object (GPT Image 2.5,
 *                     Seedream 5.0). Anything else throws.
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

// The parameter-schema types live in engines/paramSchema.ts, so that the
// engine definitions can use them without importing this module (which reads
// the catalogue: a cycle).
export type { ParamPrimitive, ParamPredicate, ParamSchema, ParamSchemaEntry } from "./engines/paramSchema";
import type { ParamPrimitive, ParamPredicate, ParamSchema, ParamSchemaEntry } from "./engines/paramSchema";

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

/** Test hook — clears the in-memory engine cache. */
export function clearEngineCaches(): void {
  engineByIdCache.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// The effective engine (plan `docs/plans/PLAN_AI_SETTINGS_IN_CODE.md`)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Every field that decides which engine a step uses or how its request is
 * built. They come from the code catalogue, never from the row: an engine
 * row's stored copy of any of them is ignored (decisions.md 2026-11-14, AI
 * call settings live in code). The row keeps availability, retirement and
 * deletion, tier and visibility, ordering, pricing and run-time hints, and
 * nothing writes the stored copies over, so a code revert restores the old
 * behaviour exactly.
 */
export const CODE_OWNED_CALL_FIELDS = [
  "provider",
  "endpointId",
  "kind",
  "family",
  "imageMode",
  "sizeVocabulary",
  "allowedResolutions",
  "defaultResolution",
  "allowedAspectRatios",
  "defaultAspectRatio",
  "paramSchema",
  "defaultTemperature",
  "defaultMaxTokens",
  "defaultReasoningEffort",
] as const satisfies readonly (keyof Engine)[];

/** Definitions a test registers for engines it creates; never set in production. */
const testDefinitions = new Map<string, EngineDefinition>();

/** Test hook: register a code definition for a test engine id (a clone of a catalogue engine). */
export function __registerEngineDefinitionForTest(def: EngineDefinition): void {
  testDefinitions.set(def.id, def);
  engineByIdCache.delete(def.id);
}

/** Every code definition: the catalogue, plus any a test registered. */
export function codeEngineDefinitions(): EngineDefinition[] {
  return testDefinitions.size ? [...ALL_ENGINES, ...testDefinitions.values()] : ALL_ENGINES;
}

const catalogueById = new Map(ALL_ENGINES.map((def) => [def.id, def]));

/** The code definition for an engine id, or undefined when the catalogue has none. */
export function codeEngineDefinition(id: string): EngineDefinition | undefined {
  return catalogueById.get(id) ?? testDefinitions.get(id);
}

/** The ids of every image engine with a code definition. */
export function codeImageEngineIds(): string[] {
  return codeEngineDefinitions().filter((d) => d.kind === "image").map((d) => d.id);
}

/**
 * An engine row with every call-shaping field taken from its code
 * definition, or null when the catalogue has no definition: such an engine
 * cannot be dispatched, and its row stays readable for history only.
 */
export function effectiveEngine(row: Engine): Engine | null {
  const def = codeEngineDefinition(row.id);
  if (!def) return null;
  const code = codeDefinitionToRow(def);
  const merged = { ...row } as Record<string, unknown>;
  for (const field of CODE_OWNED_CALL_FIELDS) merged[field] = (code as Record<string, unknown>)[field] ?? null;
  return merged as Engine;
}

/** `effectiveEngine` over a list, dropping the engines with no code definition. */
export function effectiveEngines(rows: Engine[]): Engine[] {
  return rows.map(effectiveEngine).filter((e): e is Engine => e !== null);
}

// ────────────────────────────────────────────────────────────────────────────
// Loaders
// ────────────────────────────────────────────────────────────────────────────

/**
 * The effective engine for an id (above). Cached. Null when there is no row,
 * or when the code catalogue has no definition for it, which is logged: an
 * engine without a code definition cannot be dispatched.
 */
export async function loadEngine(id: string): Promise<Engine | null> {
  const cached = getCached(engineByIdCache, id);
  if (cached !== undefined) return cached;

  const [row] = await db
    .select()
    .from(enginesTable)
    .where(eq(enginesTable.id, id))
    .limit(1);
  const value = row ? effectiveEngine(row) : null;
  if (row && !value) logger.warn({ engineId: id }, "engine has no code definition; refusing to dispatch it");
  setCached(engineByIdCache, id, value);
  return value;
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
    case "dimensions": {
      const m = /^(\d+)x(\d+)$/.exec(String(value).trim());
      if (!m) {
        throw new InvalidEngineParamError(engineId, paramName, 'expected "WIDTHxHEIGHT"', value);
      }
      return { width: Number(m[1]), height: Number(m[2]) };
    }
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
