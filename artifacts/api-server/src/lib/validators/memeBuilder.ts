/**
 * Phase-4 shared validators for the meme-builder endpoints.
 *
 * These zod schemas describe the request body shared between
 *   POST /api/render-preview
 *   POST /api/render-download
 *   POST /api/memes
 *
 * The shape mirrors what `MemeBuilder.tsx` already POSTs (Phase 3 contract,
 * which is the source of truth per the Phase-4 brief): an `imageSource`
 * discriminated union plus optional `textOptions` / `framingTransform` /
 * `aspectRatio`. Personalisation fields (`name`, `pronouns`) are accepted
 * explicitly so a caller may override its stored profile values. (They first
 * served a signed-out "cold permalink" flow on /api/render-preview; that flow
 * went in launch Phase 4, and the render endpoints are signed-in only.)
 *
 * Names and pronouns follow the same rules as an account (identity-flow
 * Phase 2): until then this file kept a five-preset pronoun allowlist and its
 * own name rule, so a meme refused an account's own custom pronouns. The
 * render endpoints are signed-in only since launch Phase 4.
 */

import { z } from "zod";
import { checkPersonalName } from "@workspace/api-zod";
import { PRONOUN_WORD_CAP_UPPER_BOUND, sanitizePronounsWithCap } from "./personalName";

/**
 * The preset pronoun sets the builder offers. Not a gate: since identity-flow
 * Phase 2 the meme endpoints accept any pronouns an account accepts, custom
 * six-part sets included, so an account's own choice is never refused here.
 */
export const PRONOUN_ALLOWLIST = ["he/him", "she/her", "they/them", "xe/xem", "ze/zir"] as const;

/**
 * Pronoun schema: the account's own pronoun rule (`sanitizePronounsWithCap`,
 * the pipeline `sanitizeAndValidatePronouns` runs), with the largest per-word
 * cap admin_config allows, so every value an account write accepted passes.
 * Slash forms are lower-cased as before; a custom set keeps its forms as typed.
 */
export const PronounsSchema = z.string().transform((v, ctx) => {
  const trimmed = v.trim();
  const input = trimmed.includes("|") ? trimmed : trimmed.toLowerCase();
  const checked = sanitizePronounsWithCap(input, PRONOUN_WORD_CAP_UPPER_BOUND);
  if (!checked.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: checked.error });
    return z.NEVER;
  }
  return checked.value;
});

/**
 * Name schema: the shared name rule (`checkPersonalName`, identity-flow
 * Phase 2) — letters and marks in any script, digits, space, `'`, `-`, `.`,
 * ZWJ/ZWNJ, at most 50 visible characters; a disallowed character is refused.
 * The value is the rule's normalized form.
 */
export const NameSchema = z.string().transform((v, ctx) => {
  const checked = checkPersonalName(v);
  if (!checked.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: checked.error });
    return z.NEVER;
  }
  return checked.value;
});

export const TextOptionsSchema = z.object({
  fontSize: z.number().int().min(14).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalPosition: z.enum(["top", "middle", "bottom"]).optional(),
  topText: z.string().max(500).optional(),
  bottomText: z.string().max(500).optional(),
  // The builder's caption-position slider: each half's vertical midpoint as a
  // percentage of the image height (#707). Stripped as unknown keys before.
  topY: z.number().min(0).max(100).optional(),
  bottomY: z.number().min(0).max(100).optional(),
  fontFamily: z.string().max(50).optional(),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  textEffect: z.enum(["shadow", "outline", "none"]).optional(),
  outlineWidth: z.number().min(0).max(20).optional(),
  allCaps: z.boolean().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
}).optional();

// A meme's background is the user's own photo: an upload, or the profile photo
// (`identity`). Stock photos went in launch Phase 4, removal 6, and the
// gradient templates in removal 5.
export const ImageSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("upload"),
    uploadKey: z.string().regex(/^\/objects\//).max(500),
  }),
  z.object({
    type: z.literal("identity"),
  }),
]);

export type ImageSource = z.infer<typeof ImageSourceSchema>;

export const FramingTransformSchema = z.object({
  offsetX: z.number().finite().min(-10_000).max(10_000),
  offsetY: z.number().finite().min(-10_000).max(10_000),
}).nullable().optional();

/**
 * Body schema for `/api/render-preview` and `/api/render-download`. Name and
 * pronouns are required because anonymous callers have no `req.user` to fall
 * back on. Authenticated callers should also pass them — the builder collects
 * the values explicitly from a form field and passing them via the body keeps
 * the render bytes a pure function of the request, which is what the byte-
 * identity invariant (verification §"Composite consistency") requires.
 */
export const RenderRequestBody = z.object({
  factId: z.number().int().positive(),
  imageSource: ImageSourceSchema,
  name: NameSchema,
  pronouns: PronounsSchema,
  textOptions: TextOptionsSchema,
  framingTransform: FramingTransformSchema,
  aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
});
export type RenderRequest = z.infer<typeof RenderRequestBody>;

/**
 * Body schema for `POST /api/memes` (the authenticated save endpoint).
 * Name and pronouns are optional here — the route falls back to the
 * authenticated user's profile values when omitted, which preserves
 * backwards-compatibility with what `MemeBuilder.tsx` POSTs today (it does
 * not currently send name/pronouns; it relies on the server reading them
 * from `req.user`). When the caller does provide them, they must still
 * pass the same allowlist checks.
 */
export const SaveMemeBody = z.object({
  factId: z.number().int().positive(),
  imageSource: ImageSourceSchema,
  name: NameSchema.optional(),
  pronouns: PronounsSchema.optional(),
  textOptions: TextOptionsSchema,
  framingTransform: FramingTransformSchema,
  aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
  isPublic: z.boolean().optional(),
});
export type SaveMemeRequest = z.infer<typeof SaveMemeBody>;

/**
 * Coarse "mode" recorded on each transient render, derived from the structured
 * `imageSource`. Every remaining source is the user's own photo, so every mode
 * is `self-upload` (free + legendary) and needs a session; `stock` was the only
 * anonymous-allowed mode until launch Phase 4, removal 6.
 */
export type RenderMode = "self-upload";

export function deriveRenderMode(_imageSource: ImageSource): RenderMode {
  return "self-upload";
}
