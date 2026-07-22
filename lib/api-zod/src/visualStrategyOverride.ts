/**
 * Phase 2 — structured moderator visual-strategy override.
 *
 * A per-fact, style-agnostic, token-aware object a human moderator edits to
 * correct/sharpen the AI's first-pass visual strategy WITHOUT editing the brittle
 * final Nano Banana prompt. Stored nested in the `FactEnrichment` blob
 * (`enrichment.visualPromptStrategyOverride`) and merged into the deterministic
 * compiler's labeled sections at render time, so the final prompt still adapts to
 * subject/pronouns, reference image, style, render mode, aspect ratio, and the
 * Phase 1 render policy.
 *
 * Token model: moderator text fields may carry the same personalization tokens as
 * fact templates ({NAME}, {NAME_POSSESSIVE}, {SUBJ}, …). On save we canonicalize
 * the name-token case/possessive variants ({name}/{Name} → {NAME},
 * {name_possessive} → {NAME_POSSESSIVE}) and reject any UNKNOWN token with a clear
 * message; the compiler renders the rest per render via `renderPersonalized`.
 *
 * This module is dependency-light on purpose (only the leaf render-policy enums +
 * the template grammar) so `taxonomy.ts` can embed it without an import cycle.
 */

import { z } from "zod";
import {
  SUPPORTING_TEXT_MODE_VALUES,
  VIOLENCE_MODE_VALUES,
  VIOLENCE_INTENSITY_VALUES,
} from "./renderPolicyEnums";
import { validateTemplate } from "./templateGrammar";

// ─── Subject realization modes ──────────────────────────────────────────────

export const SUBJECT_REALIZATION_MODE_VALUES = [
  "use_ai_plan", // default — keep the AI's subject realization; the rest of the override still applies
  "normal_human",
  "age_transformed_human",
  "adult_head_on_transformed_body",
  "subject_as_object",
  "nonhuman_transformation",
  "symbolic_or_implied",
  "custom",
] as const;
export type SubjectRealizationMode = (typeof SUBJECT_REALIZATION_MODE_VALUES)[number];

export const VISUAL_STRATEGY_OVERRIDE_VERSION = 1 as const;

// ─── Schema ─────────────────────────────────────────────────────────────────

const roleBindingSchema = z.object({
  entity: z.string().max(60), // "subject" or a relationship/name/type label ("mother", "crowd/victims")
  visualRole: z.string().max(300),
});

// ─── Speech / thought bubbles ───────────────────────────────────────────────

export const BUBBLE_TYPE_VALUES = ["speech", "thought"] as const;
export type VisualStrategyBubbleType = (typeof BUBBLE_TYPE_VALUES)[number];

/** Hard cap for a bubble's literal text (legibility drops with length; the UI
 *  soft-warns at BUBBLE_TEXT_SOFT_WARN). */
export const BUBBLE_TEXT_MAX_CHARS = 80;
export const BUBBLE_TEXT_SOFT_WARN = 60;
export const BUBBLE_ENTITY_MAX_CHARS = 60;
export const MAX_BUBBLES = 4;

const bubbleSchema = z.object({
  type: z.enum(BUBBLE_TYPE_VALUES),
  // WHO thinks/speaks: "subject" or a plain role label ("the bartender") —
  // exact same rules + normalization as roleBindings.entity (no tokens).
  entity: z.string().max(BUBBLE_ENTITY_MAX_CHARS),
  // The bubble's literal text, rendered as exact in-image glyphs. Token-capable
  // ({NAME} etc.); whitespace-normalized on save.
  text: z.string().max(BUBBLE_TEXT_MAX_CHARS),
});
export type VisualStrategyBubble = z.infer<typeof bubbleSchema>;

/**
 * Whitespace normalization for literal bubble text: trim outer whitespace and
 * collapse any internal whitespace run (spaces, tabs, newlines, NBSP) to one
 * space. Unicode punctuation and glyphs are preserved — the result IS the
 * string the engine is asked to letter, so preview/save/runtime all show the
 * same value. Applied on save via `canonicalizeOverrideTokens`.
 */
export function normalizeLiteralBubbleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const subjectRealizationOverrideSchema = z.object({
  mode: z.enum(SUBJECT_REALIZATION_MODE_VALUES),
  description: z.string(),
});

const supportingTextPolicyOverrideSchema = z.object({
  mode: z.enum(SUPPORTING_TEXT_MODE_VALUES),
  guidance: z.string().optional(),
});

const violencePolicyOverrideSchema = z.object({
  mode: z.enum(VIOLENCE_MODE_VALUES),
  intensity: z.enum(VIOLENCE_INTENSITY_VALUES),
  guidance: z.string().optional(),
});

// Shape only (no transform/refine) so the object can be reasoned about + the
// token transform/refine layered on top in `visualPromptStrategyOverrideSchema`.
const visualPromptStrategyOverrideBase = z.object({
  version: z.literal(VISUAL_STRATEGY_OVERRIDE_VERSION),
  enabled: z.boolean(),
  moderatorIntent: z.string().optional(),
  /**
   * Moderator-authored CORE SCENE ("describe the picture"). When non-empty it
   * is the AUTHORITATIVE scene: the planner LLM is directed to realize it and
   * the compiler emits it as the required, non-compressible CORE SCENE section
   * (winning over the AI plan's coreScene). Carries {NAME}/pronoun tokens.
   * Capped: the engine prompt budget is 6000 chars and this section is never
   * compressed — it is a scene brief, not a full prompt.
   */
  coreSceneOverride: z.string().max(1500).optional(),
  subjectRealizationOverride: subjectRealizationOverrideSchema.optional(),
  requiredVisualDetails: z.array(z.string()).max(40).default([]),
  forbiddenVisualDetails: z.array(z.string()).max(40).default([]),
  roleBindings: z.array(roleBindingSchema).max(20).default([]),
  /**
   * Explicit speech/thought bubbles — verbatim moderator content the compiler
   * emits as the required SPEECH & THOUGHT BUBBLES section (one deterministic
   * directive per bubble, stored order, exempt from sentence de-duplication).
   * Budgeted by the dedicated BUBBLE_DIRECTIVES_RENDERED_MAX pool at save.
   */
  bubbles: z.array(bubbleSchema).max(MAX_BUBBLES).default([]),
  compositionGuidance: z.array(z.string()).max(20).default([]),
  styleAgnosticPromptAdditions: z.array(z.string()).max(20).default([]),
  negativePromptAdditions: z.array(z.string()).max(20).default([]),
  supportingTextPolicyOverride: supportingTextPolicyOverrideSchema.optional(),
  violencePolicyOverride: violencePolicyOverrideSchema.optional(),
  notesForModerator: z.string().optional(),
  // Server-owned provenance — stamped by the admin save path, preserved verbatim
  // across re-classification, never generated by the AI. A human-readable actor
  // label (display name, or email as a fallback) — never the raw admin user id,
  // since it is rendered directly in the enrichment editor.
  updatedBy: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type VisualPromptStrategyOverride = z.infer<typeof visualPromptStrategyOverrideBase>;
export type VisualStrategyRoleBinding = z.infer<typeof roleBindingSchema>;

// ─── Token handling ─────────────────────────────────────────────────────────

/**
 * A single rendered-text field of the override, addressed by a stable string
 * path. `kind: "entity"` is the one field (`roleBindings[i].entity`) that
 * holds a plain "subject"/role label rather than free prose — every other
 * rendered field is `"prose"`. This is the ONE source of which VSO fields are
 * tokenized/rendered; `firstOverrideTokenError`, the admin batch tokenize
 * route, and the frontend save flow all consume it so the field list can
 * never drift between them.
 */
export type VisualStrategyRenderedTextKind = "prose" | "entity";

export interface VisualStrategyRenderedTextEntry {
  path: string;
  value: string;
  kind: VisualStrategyRenderedTextKind;
}

/** Fields whose text is RENDERED into the engine prompt (so tokens matter).
 *  `moderatorIntent` / `notesForModerator` are admin-only and never emitted. */
export function collectRenderedTextEntries(
  ov: VisualPromptStrategyOverride,
): VisualStrategyRenderedTextEntry[] {
  const out: VisualStrategyRenderedTextEntry[] = [];
  if (ov.coreSceneOverride) {
    out.push({ path: "coreSceneOverride", value: ov.coreSceneOverride, kind: "prose" });
  }
  if (ov.subjectRealizationOverride?.description) {
    out.push({
      path: "subjectRealizationOverride.description",
      value: ov.subjectRealizationOverride.description,
      kind: "prose",
    });
  }
  ov.requiredVisualDetails.forEach((value, i) =>
    out.push({ path: `requiredVisualDetails[${i}]`, value, kind: "prose" }),
  );
  ov.forbiddenVisualDetails.forEach((value, i) =>
    out.push({ path: `forbiddenVisualDetails[${i}]`, value, kind: "prose" }),
  );
  ov.roleBindings.forEach((rb, i) => {
    out.push({ path: `roleBindings[${i}].entity`, value: rb.entity, kind: "entity" });
    out.push({ path: `roleBindings[${i}].visualRole`, value: rb.visualRole, kind: "prose" });
  });
  ov.bubbles.forEach((b, i) => {
    out.push({ path: `bubbles[${i}].entity`, value: b.entity, kind: "entity" });
    out.push({ path: `bubbles[${i}].text`, value: b.text, kind: "prose" });
  });
  ov.compositionGuidance.forEach((value, i) =>
    out.push({ path: `compositionGuidance[${i}]`, value, kind: "prose" }),
  );
  ov.styleAgnosticPromptAdditions.forEach((value, i) =>
    out.push({ path: `styleAgnosticPromptAdditions[${i}]`, value, kind: "prose" }),
  );
  ov.negativePromptAdditions.forEach((value, i) =>
    out.push({ path: `negativePromptAdditions[${i}]`, value, kind: "prose" }),
  );
  if (ov.supportingTextPolicyOverride?.guidance) {
    out.push({
      path: "supportingTextPolicyOverride.guidance",
      value: ov.supportingTextPolicyOverride.guidance,
      kind: "prose",
    });
  }
  if (ov.violencePolicyOverride?.guidance) {
    out.push({
      path: "violencePolicyOverride.guidance",
      value: ov.violencePolicyOverride.guidance,
      kind: "prose",
    });
  }
  return out;
}

const RENDERED_TEXT_PATH_RE =
  /^(coreSceneOverride|subjectRealizationOverride\.description|requiredVisualDetails\[\d+\]|forbiddenVisualDetails\[\d+\]|roleBindings\[\d+\]\.(entity|visualRole)|bubbles\[\d+\]\.(entity|text)|compositionGuidance\[\d+\]|styleAgnosticPromptAdditions\[\d+\]|negativePromptAdditions\[\d+\]|supportingTextPolicyOverride\.guidance|violencePolicyOverride\.guidance)$/;

/** True iff `path` is one of the addressable rendered-text paths above — the
 *  admin batch tokenize route uses this to reject an unknown/forged path
 *  before doing any LLM work. */
export function isVisualStrategyRenderedTextPath(path: string): boolean {
  return RENDERED_TEXT_PATH_RE.test(path);
}

/** Every path that holds a plain "subject"/role LABEL rather than free prose —
 *  role-binding entities AND bubble entities share identical rules (no tokens,
 *  `normalizeRoleEntity` normalization). The single entity-path recognizer, so
 *  the path→kind map can't drift when a new entity-bearing field is added. */
const ENTITY_PATH_RE = /^(roleBindings|bubbles)\[\d+\]\.entity$/;

/** Pure path → kind map (the route receives `{path, value, kind}` entries,
 *  not a whole override, so it needs this to catch a client "kind lie" —
 *  e.g. an entity path submitted as `kind: "prose"`). Returns null for a path
 *  that isn't a rendered-text path at all. */
export function getVisualStrategyRenderedTextKind(
  path: string,
): VisualStrategyRenderedTextKind | null {
  if (!isVisualStrategyRenderedTextPath(path)) return null;
  return ENTITY_PATH_RE.test(path) ? "entity" : "prose";
}

const INDEXED_ARRAY_FIELD_RE =
  /^(requiredVisualDetails|forbiddenVisualDetails|compositionGuidance|styleAgnosticPromptAdditions|negativePromptAdditions)\[(\d+)\]$/;
const ROLE_BINDING_FIELD_RE = /^roleBindings\[(\d+)\]\.(entity|visualRole)$/;
const BUBBLE_FIELD_RE = /^bubbles\[(\d+)\]\.(entity|text)$/;

type IndexedArrayField =
  | "requiredVisualDetails"
  | "forbiddenVisualDetails"
  | "compositionGuidance"
  | "styleAgnosticPromptAdditions"
  | "negativePromptAdditions";

/**
 * Pure writeback for one rendered-text path — used by the frontend to fold
 * tokenize-route results back into the override. **Index-tolerant but
 * mutation-safe**: a valid-shaped path whose target isn't currently present
 * (an out-of-range array index, or a parent object that's absent, e.g.
 * `subjectRealizationOverride.description` when `subjectRealizationOverride`
 * is unset) is a no-op that returns `ov` unchanged — it never creates a
 * surprising array element or object. Only a path that resolves to an
 * existing field gets updated.
 */
export function setRenderedTextAtPath(
  ov: VisualPromptStrategyOverride,
  path: string,
  value: string,
): VisualPromptStrategyOverride {
  if (path === "coreSceneOverride") {
    return ov.coreSceneOverride == null ? ov : { ...ov, coreSceneOverride: value };
  }
  if (path === "subjectRealizationOverride.description") {
    return ov.subjectRealizationOverride == null
      ? ov
      : { ...ov, subjectRealizationOverride: { ...ov.subjectRealizationOverride, description: value } };
  }
  if (path === "supportingTextPolicyOverride.guidance") {
    return ov.supportingTextPolicyOverride == null
      ? ov
      : { ...ov, supportingTextPolicyOverride: { ...ov.supportingTextPolicyOverride, guidance: value } };
  }
  if (path === "violencePolicyOverride.guidance") {
    return ov.violencePolicyOverride == null
      ? ov
      : { ...ov, violencePolicyOverride: { ...ov.violencePolicyOverride, guidance: value } };
  }
  const roleMatch = ROLE_BINDING_FIELD_RE.exec(path);
  if (roleMatch) {
    const index = Number(roleMatch[1]);
    const field = roleMatch[2] as "entity" | "visualRole";
    if (index < 0 || index >= ov.roleBindings.length) return ov;
    const roleBindings = ov.roleBindings.slice();
    roleBindings[index] = { ...roleBindings[index], [field]: value };
    return { ...ov, roleBindings };
  }
  const bubbleMatch = BUBBLE_FIELD_RE.exec(path);
  if (bubbleMatch) {
    const index = Number(bubbleMatch[1]);
    const field = bubbleMatch[2] as "entity" | "text";
    if (index < 0 || index >= ov.bubbles.length) return ov;
    const bubbles = ov.bubbles.slice();
    bubbles[index] = { ...bubbles[index], [field]: value };
    return { ...ov, bubbles };
  }
  const arrayMatch = INDEXED_ARRAY_FIELD_RE.exec(path);
  if (arrayMatch) {
    const field = arrayMatch[1] as IndexedArrayField;
    const index = Number(arrayMatch[2]);
    const arr = ov[field];
    if (index < 0 || index >= arr.length) return ov;
    const next = arr.slice();
    next[index] = value;
    return { ...ov, [field]: next };
  }
  return ov;
}

/**
 * Save-time normalization for a role binding's `entity` field: a `{…}`
 * personalization token is context-free invalid (`error`); a typed value that
 * IS the subject — `"subject"` case-insensitively, or a match against a
 * client-supplied subject name — collapses to the canonical `"subject"`;
 * anything else (a role label like `"mother"`) is left as-is. Facts store
 * *templates*, so the server has no canonical display name of its own —
 * `subjectNames` is client-supplied context (the moderator's preview name +
 * defaults), which is safe here because the token-rejection half of this
 * check is context-free; names only ever collapse a typed name to the benign
 * `"subject"` label, never introduce or validate a token.
 */
export function normalizeRoleEntity(
  entity: string,
  subjectNames: string[] = [],
): { value: string; error?: string } {
  const trimmed = entity.trim();
  if (trimmed.includes("{")) {
    return {
      value: entity,
      error:
        "personalization tokens are not allowed here — use \"subject\" or a plain role label instead",
    };
  }
  const lower = trimmed.toLowerCase();
  if (lower === "subject" || subjectNames.some((name) => name.trim().toLowerCase() === lower)) {
    return { value: "subject" };
  }
  return { value: entity };
}

/** Canonicalize personalization-token case so a hand-typed token behaves like
 *  the toolbar chip. Name variants {name}/{Name} → {NAME} and possessives
 *  {name_possessive}/… → {NAME_POSSESSIVE}. For the pronoun tokens, an
 *  ALL-lowercase form is folded to its ALL-CAPS (lowercase-output) equivalent —
 *  {poss} → {POSS}, {subj} → {SUBJ}, etc. — so typing lowercase just works. The
 *  Title-case forms ({Poss} → "Their") are intentionally left untouched, since
 *  case there controls output capitalization. Possessive is canonicalized first
 *  so the bare-{NAME} pass can't partially touch it. */
export function canonicalizeNameToken(text: string): string {
  return text
    .replace(/\{(?:name|Name|NAME)_(?:possessive|Possessive|POSSESSIVE)\}/g, "{NAME_POSSESSIVE}")
    .replace(/\{(?:name|Name)\}/g, "{NAME}")
    .replace(/\{(subj|obj|poss_pro|poss|refl)\}/g, (_m, t: string) => `{${t.toUpperCase()}}`);
}

function mapText(text: string): string {
  return canonicalizeNameToken(text);
}

/** Return the canonicalized override (name-token variants normalized in every
 *  rendered field). Pure; used by the schema transform on save. */
export function canonicalizeOverrideTokens(
  ov: VisualPromptStrategyOverride,
): VisualPromptStrategyOverride {
  return {
    ...ov,
    coreSceneOverride: ov.coreSceneOverride != null ? mapText(ov.coreSceneOverride) : ov.coreSceneOverride,
    subjectRealizationOverride: ov.subjectRealizationOverride
      ? { ...ov.subjectRealizationOverride, description: mapText(ov.subjectRealizationOverride.description) }
      : ov.subjectRealizationOverride,
    requiredVisualDetails: ov.requiredVisualDetails.map(mapText),
    forbiddenVisualDetails: ov.forbiddenVisualDetails.map(mapText),
    compositionGuidance: ov.compositionGuidance.map(mapText),
    styleAgnosticPromptAdditions: ov.styleAgnosticPromptAdditions.map(mapText),
    negativePromptAdditions: ov.negativePromptAdditions.map(mapText),
    roleBindings: ov.roleBindings.map((rb) => ({ entity: mapText(rb.entity), visualRole: mapText(rb.visualRole) })),
    // Bubble text is a LITERAL string the engine letters verbatim — canonicalize
    // tokens AND normalize whitespace so preview/save/runtime show one value.
    bubbles: ov.bubbles.map((b) => ({
      ...b,
      entity: mapText(b.entity),
      text: normalizeLiteralBubbleText(mapText(b.text)),
    })),
    supportingTextPolicyOverride: ov.supportingTextPolicyOverride?.guidance
      ? { ...ov.supportingTextPolicyOverride, guidance: mapText(ov.supportingTextPolicyOverride.guidance) }
      : ov.supportingTextPolicyOverride,
    violencePolicyOverride: ov.violencePolicyOverride?.guidance
      ? { ...ov.violencePolicyOverride, guidance: mapText(ov.violencePolicyOverride.guidance) }
      : ov.violencePolicyOverride,
  };
}

/** First unknown-token error across the override's rendered text fields, or null.
 *  Empty/whitespace strings are skipped (mid-edit rows). Assumes name-case
 *  variants were already canonicalized. */
export function firstOverrideTokenError(ov: VisualPromptStrategyOverride): string | null {
  for (const { value } of collectRenderedTextEntries(ov)) {
    const t = value.trim();
    if (!t || !t.includes("{")) continue;
    const res = validateTemplate(t);
    if (!res.valid) return res.error ?? "invalid token";
  }
  return null;
}

export const visualPromptStrategyOverrideSchema = visualPromptStrategyOverrideBase
  .transform(canonicalizeOverrideTokens)
  .superRefine((ov, ctx) => {
    const err = firstOverrideTokenError(ov);
    if (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `visual strategy override has an invalid personalization token: ${err}. Use {NAME}, {NAME_POSSESSIVE}, and pronoun tokens only.`,
      });
    }
    // Defense-in-depth backstop (bypassed tokenize route / stale client /
    // manual PATCH): a role `entity` is a "subject"/role LABEL, never a
    // personalization token — `normalizeRoleEntity` is the save-time helper
    // that keeps a typed token out in the first place, but this is the hard
    // server-side invariant. Message is deliberately machine-recognizable
    // (`roleBindings[i].entity: personalization tokens are not allowed…`) so
    // the frontend's narrow Save-disable exception can match ONLY this exact
    // issue and nothing else.
    ov.roleBindings.forEach((rb, i) => {
      if (rb.entity.includes("{")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roleBindings", i, "entity"],
          message:
            "personalization tokens are not allowed here — use \"subject\" or a plain role label instead",
        });
      }
    });
    // Same hard invariant for bubble entities (identical machine-recognizable
    // message so the frontend's narrow Save-disable exception matches both).
    ov.bubbles.forEach((b, i) => {
      if (b.entity.includes("{")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bubbles", i, "entity"],
          message:
            "personalization tokens are not allowed here — use \"subject\" or a plain role label instead",
        });
      }
    });
  });

/**
 * True when the override carries any content that is RENDERED into the engine
 * prompt. The single source of truth for "enabled but empty" style checks so
 * UI surfaces can't drift on what counts as content. Admin-only fields
 * (moderatorIntent, notesForModerator) deliberately do NOT count.
 */
export function hasRenderableVisualStrategyOverrideContent(
  ov: VisualPromptStrategyOverride,
): boolean {
  if (ov.supportingTextPolicyOverride || ov.violencePolicyOverride) return true;
  if (ov.subjectRealizationOverride && ov.subjectRealizationOverride.mode !== "use_ai_plan") return true;
  return collectRenderedTextEntries(ov).some(({ value }) => value.trim().length > 0);
}

/** A disabled-but-present override scaffold (all lists empty). */
export const EMPTY_VISUAL_STRATEGY_OVERRIDE: VisualPromptStrategyOverride = {
  version: VISUAL_STRATEGY_OVERRIDE_VERSION,
  enabled: false,
  requiredVisualDetails: [],
  forbiddenVisualDetails: [],
  roleBindings: [],
  bubbles: [],
  compositionGuidance: [],
  styleAgnosticPromptAdditions: [],
  negativePromptAdditions: [],
};
