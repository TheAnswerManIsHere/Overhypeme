/**
 * The schema-guided jsonb walker (plan D4: one transformer per stored shape,
 * written against that shape's own validator).
 *
 * The stored value is walked alongside its zod schema. At each leaf:
 *
 * - a path rule, when the shape names one, decides (keep, prose, a user id, a
 *   label, a media reference, a hash, …);
 * - otherwise an enum or literal leaf is kept, a number, boolean or null is
 *   kept, and a plain string becomes content-keyed prose — blank stays blank;
 * - a key the schema does not know, a type the schema does not expect, an
 *   `unknown`/`any` node without a rule, or a string with a format check and
 *   no rule STOPS the run, naming the table, column, row and path — never the
 *   value (plan D4: "A stored legacy shape the transformer cannot retain safely
 *   stops the run and comes back to this plan").
 *
 * The walker reads the RAW stored value and never parses it, so no schema
 * default is ever materialised into the exported shape; absent stays absent.
 */
import type { ZodTypeAny } from "zod";

import type { MediaMap, MediaRole } from "./media";
import type { Scrubber } from "./scrub";

export class ShapeStop extends Error {
  constructor(
    readonly where: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`[legacy-fixture] ${where}: ${reason} at ${path || "$"}`);
    this.name = "ShapeStop";
  }
}

/** The row-level facts a rule may need. */
export interface WalkContext {
  scrubber: Scrubber;
  media: MediaMap;
  mode: "note" | "emit";
  /** `table.column row <id>` — for stop messages. */
  where: string;
  table: string;
  row: string;
  /** The source user who owns the row (for media ACLs and identity rules). */
  ownerSourceId: string | null;
  /** True when the row's fact text is the live text of an active fact. */
  keptText: boolean;
  /** Hashtags to use for a row whose text is a placeholder. */
  placeholderHashtags: readonly string[];
  /** The synthetic identity to write where a real user's name was frozen. */
  syntheticName: string;
}

export type LeafRule =
  | "keep"
  | "prose"
  | "map-user"
  | "admin-label"
  | "rekey"
  | "predicate-hash"
  | "subject-or-prose"
  | "fixture-url"
  | "stock-data-url"
  | "hashtags"
  | "prose-deep"
  | "structural-deep"
  | { media: MediaRole }
  | { custom: (value: unknown, ctx: WalkContext, path: string) => unknown };

export type PathRules = Readonly<Record<string, LeafRule>>;

interface Def {
  typeName: string;
  [k: string]: unknown;
}
const def = (s: ZodTypeAny): Def => (s as unknown as { _def: Def })._def;

/** Strip wrappers that do not change the stored value's shape. */
export function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let s = schema;
  for (let i = 0; i < 32; i++) {
    const d = def(s);
    switch (d.typeName) {
      case "ZodOptional":
      case "ZodNullable":
      case "ZodDefault":
      case "ZodCatch":
      case "ZodReadonly":
        s = d.innerType as ZodTypeAny;
        continue;
      case "ZodEffects":
        s = d.schema as ZodTypeAny;
        continue;
      case "ZodPipeline":
        s = d.in as ZodTypeAny;
        continue;
      case "ZodBranded":
        s = d.type as ZodTypeAny;
        continue;
      case "ZodLazy":
        s = (d.getter as () => ZodTypeAny)();
        continue;
      default:
        return s;
    }
  }
  return s;
}

function stringBound(schema: ZodTypeAny): { max?: number; formatted: boolean } {
  const checks = (def(schema).checks as Array<{ kind: string; value?: number }> | undefined) ?? [];
  let max: number | undefined;
  let formatted = false;
  for (const c of checks) {
    if (c.kind === "max" || c.kind === "length") max = Math.min(max ?? Infinity, c.value ?? Infinity);
    if (["email", "url", "uuid", "cuid", "cuid2", "ulid", "regex", "emoji", "ip", "datetime", "base64", "startsWith", "endsWith", "includes"].includes(c.kind)) {
      formatted = true;
    }
  }
  return { max, formatted };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string leaf becomes prose; everything else is kept. For legacy keys whose shape no schema describes. */
export function proseDeep(value: unknown, ctx: WalkContext): unknown {
  if (typeof value === "string") return ctx.scrubber.prose(value);
  if (Array.isArray(value)) return value.map((v) => proseDeep(v, ctx));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, proseDeep(v, ctx)]));
  return value;
}

const STRUCTURAL_STRING = /^[A-Za-z0-9_.:/+-]{0,64}$/;

/** Kept verbatim when every string in it looks like an identifier, not prose; stops otherwise. */
export function structuralDeep(value: unknown, ctx: WalkContext, path: string): unknown {
  if (typeof value === "string") {
    if (!STRUCTURAL_STRING.test(value)) throw new ShapeStop(ctx.where, path, "a non-identifier string in a structural shape");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => structuralDeep(v, ctx, `${path}[*]`));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuralDeep(v, ctx, `${path}.${k}`)]));
  return value;
}

function applyRule(rule: LeafRule, value: unknown, ctx: WalkContext, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof rule === "object") {
    if ("custom" in rule) return rule.custom(value, ctx, path);
    if (typeof value !== "string") throw new ShapeStop(ctx.where, path, "a media rule on a non-string");
    if (ctx.mode === "note") {
      ctx.media.note(value, rule.media, { table: ctx.table, row: ctx.row }, ctx.ownerSourceId);
      return value;
    }
    return ctx.media.rewrite(value);
  }
  const needString = () => {
    if (typeof value !== "string") throw new ShapeStop(ctx.where, path, `rule "${rule}" on a ${Array.isArray(value) ? "array" : typeof value}`);
    return value;
  };
  switch (rule) {
    case "keep":
      return value;
    case "prose":
      return ctx.scrubber.prose(needString());
    case "map-user":
      return ctx.scrubber.userId(needString());
    case "admin-label":
      return ctx.scrubber.adminLabel(needString());
    case "rekey":
    case "predicate-hash":
      return ctx.scrubber.rekey(needString());
    case "subject-or-prose": {
      const v = needString();
      return v.trim().toLowerCase() === "subject" ? v : ctx.scrubber.prose(v);
    }
    case "fixture-url": {
      const v = needString();
      return v.trim() === "" ? v : `https://example.test/fixture/${ctx.scrubber.hmac("url", v).slice(0, 12)}`;
    }
    case "stock-data-url": {
      const v = needString();
      if (v.trim() === "") return v;
      if (ctx.mode === "note") {
        ctx.media.note(v, "catalogue-asset", { table: ctx.table, row: ctx.row }, null);
        return v;
      }
      return ctx.media.rewrite(v);
    }
    case "hashtags": {
      if (!Array.isArray(value)) throw new ShapeStop(ctx.where, path, "hashtags that are not an array");
      return ctx.keptText ? value : [...ctx.placeholderHashtags];
    }
    case "prose-deep":
      return proseDeep(value, ctx);
    case "structural-deep":
      return structuralDeep(value, ctx, path);
  }
}

/**
 * Transform `value` against `schema` with `rules`. `path` is the dotted path
 * from the shape's root (`a.b[*].c`); array indices are `[*]`, record keys
 * `{*}`.
 */
export function walk(value: unknown, schema: ZodTypeAny, rules: PathRules, ctx: WalkContext, path = ""): unknown {
  const rule = rules[path];
  if (rule !== undefined) return applyRule(rule, value, ctx, path);
  if (value === null || value === undefined) return value;

  const s = unwrap(schema);
  const d = def(s);
  const child = (key: string) => (path ? `${path}.${key}` : key);

  switch (d.typeName) {
    case "ZodObject": {
      if (!isPlainObject(value)) throw new ShapeStop(ctx.where, path, "expected an object");
      const shape = (s as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const childPath = child(k);
        if (rules[childPath] !== undefined) {
          out[k] = applyRule(rules[childPath]!, v, ctx, childPath);
        } else if (shape[k]) {
          out[k] = walk(v, shape[k]!, rules, ctx, childPath);
        } else {
          throw new ShapeStop(ctx.where, childPath, "a key the shape does not describe");
        }
      }
      return out;
    }
    case "ZodRecord": {
      if (!isPlainObject(value)) throw new ShapeStop(ctx.where, path, "expected a record");
      const valueType = d.valueType as ZodTypeAny;
      const keysRule = rules[`${path}{key}`];
      if (keysRule !== "keep") throw new ShapeStop(ctx.where, `${path}{key}`, "record keys with no rule");
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, valueType, rules, ctx, `${path}{*}`);
      return out;
    }
    case "ZodArray": {
      if (!Array.isArray(value)) throw new ShapeStop(ctx.where, path, "expected an array");
      const el = d.type as ZodTypeAny;
      return value.map((v) => walk(v, el, rules, ctx, `${path}[*]`));
    }
    case "ZodTuple": {
      if (!Array.isArray(value)) throw new ShapeStop(ctx.where, path, "expected a tuple");
      const items = d.items as ZodTypeAny[];
      return value.map((v, i) => {
        if (!items[i]) throw new ShapeStop(ctx.where, `${path}[${i}]`, "a tuple element past the schema");
        return walk(v, items[i]!, rules, ctx, `${path}[${i}]`);
      });
    }
    case "ZodDiscriminatedUnion": {
      if (!isPlainObject(value)) throw new ShapeStop(ctx.where, path, "expected an object");
      const disc = d.discriminator as string;
      const options = (s as unknown as { optionsMap: Map<unknown, ZodTypeAny> }).optionsMap;
      const opt = options.get(value[disc]);
      if (!opt) throw new ShapeStop(ctx.where, `${path}.${disc}`, "a discriminator value the shape does not describe");
      return walk(value, opt, rules, ctx, path);
    }
    case "ZodUnion": {
      const options = d.options as ZodTypeAny[];
      const fit = options.find((o) => o.safeParse(value).success);
      if (!fit) throw new ShapeStop(ctx.where, path, "a value matching no option of a union");
      return walk(value, fit, rules, ctx, path);
    }
    case "ZodEnum":
    case "ZodNativeEnum":
    case "ZodLiteral": {
      if (typeof value === "object") throw new ShapeStop(ctx.where, path, "an object where an enum was expected");
      return value;
    }
    case "ZodString": {
      if (typeof value !== "string") throw new ShapeStop(ctx.where, path, `a ${typeof value} where a string was expected`);
      const { max, formatted } = stringBound(s);
      if (formatted) throw new ShapeStop(ctx.where, path, "a formatted string with no rule");
      return ctx.scrubber.prose(value, max);
    }
    case "ZodNumber":
    case "ZodBigInt":
      if (typeof value !== "number" && typeof value !== "bigint") throw new ShapeStop(ctx.where, path, `a ${typeof value} where a number was expected`);
      return value;
    case "ZodBoolean":
      if (typeof value !== "boolean") throw new ShapeStop(ctx.where, path, `a ${typeof value} where a boolean was expected`);
      return value;
    case "ZodNull":
    case "ZodUndefined":
      return value;
    default:
      throw new ShapeStop(ctx.where, path, `a ${d.typeName} node with no rule`);
  }
}

/** Re-root a shape's rules at a sub-path (for an override keyed by its field). */
export function rerootRules(rules: PathRules, prefix: string): PathRules {
  const out: Record<string, LeafRule> = {};
  for (const [k, v] of Object.entries(rules)) {
    if (k === prefix) out[""] = v;
    else if (k.startsWith(`${prefix}.`)) out[k.slice(prefix.length + 1)] = v;
    else if (k.startsWith(`${prefix}[`) || k.startsWith(`${prefix}{`)) out[k.slice(prefix.length)] = v;
  }
  return out;
}
