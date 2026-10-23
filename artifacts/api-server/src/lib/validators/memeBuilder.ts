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
 * explicitly so the anonymous cold-permalink personalisation flow on
 * /api/render-preview works without a session — authenticated callers may
 * still pass them to override their stored profile values.
 *
 * The pronoun allowlist is intentionally narrower than what the existing
 * `sanitizeAndValidatePronouns` helper accepts. The render endpoints draw a
 * smaller abuse surface because they accept anonymous traffic; restricting
 * pronouns to a curated set keeps the prompt-injection / weird-output blast
 * radius small while still covering the cases we actually surface in the UI.
 */

import { z } from "zod";

/** Allowlist of pronoun strings accepted by Phase-4 endpoints (canonical "subj/obj" form). */
export const PRONOUN_ALLOWLIST = ["he/him", "she/her", "they/them", "xe/xem", "ze/zir"] as const;
export type AllowedPronouns = (typeof PRONOUN_ALLOWLIST)[number];

/**
 * Strict pronoun schema. Accepts only the canonical allowlist — case-insensitive
 * input is normalised to lower-case before the enum check so e.g. `"He/Him"`
 * still passes.
 */
export const PronounsSchema = z
  .string()
  .min(1)
  .max(20)
  .transform((v) => v.toLowerCase().trim())
  .pipe(z.enum(PRONOUN_ALLOWLIST));

/**
 * Strict name schema. Length 1-50, no newlines or other control characters.
 * Allows letters (any Unicode script), marks, digits, spaces, apostrophes,
 * hyphens, periods. The Unicode property escapes mean we do not need a
 * separate strip-control-chars pass — anything in `Cc` / `Cf` is rejected by
 * the regex outright.
 */
export const NameSchema = z
  .string()
  .min(1)
  .max(50)
  .refine((v) => !/[\n\r\t\v\f]/.test(v), { message: "Name must not contain control characters" })
  .refine((v) => /^[\p{L}\p{M}\p{N} '.\-]+$/u.test(v), {
    message: "Name may only contain letters, numbers, spaces, apostrophes, periods, and hyphens",
  })
  .transform((v) => v.replace(/\s+/g, " ").trim())
  .refine((v) => v.length > 0, { message: "Name cannot be empty after trimming" });

export const TextOptionsSchema = z.object({
  fontSize: z.number().int().min(14).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalPosition: z.enum(["top", "middle", "bottom"]).optional(),
  topText: z.string().max(500).optional(),
  bottomText: z.string().max(500).optional(),
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
  previewImageBase64: z.string().max(700_000).optional(),
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
