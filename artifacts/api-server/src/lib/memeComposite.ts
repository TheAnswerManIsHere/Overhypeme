/**
 * Phase-4 shared composite module.
 *
 * Single entry point invoked by the three meme-render endpoints
 *   POST /api/render-preview   — anonymous transient render, returns bytes
 *   POST /api/render-download  — same render, served as an attachment
 *   POST /api/memes            — authenticated save, persists to GCS + DB
 *
 * Identical inputs produce byte-identical outputs across all three endpoints,
 * which is the property the verification checklist's "byte-identity" test
 * relies on. To keep that property robust: this module owns the imageSource →
 * BackgroundSource resolution and the personalised-text rendering, then
 * delegates the actual canvas work to the existing `generateMemeBuffer`
 * (the single node-canvas implementation in this codebase). Callers MUST NOT
 * call `generateMemeBuffer` directly for new code — go through here so any
 * future tweak to text rendering or asset resolution lands in one place.
 */

import { Buffer } from "node:buffer";
import { generateMemeBuffer, type BackgroundSource, type FramingTransform, type TextOptions } from "./memeGenerator";
import { renderPersonalized, CANONICAL_NAME } from "./renderCanonical";
import { ObjectStorageService } from "./objectStorage";
import { getPhotoById } from "./pexelsClient";
import type { ImageSource } from "./validators/memeBuilder";
import type { MemeAspectRatio } from "@workspace/api-zod";

export interface ComposeMemeInput {
  /**
   * Raw fact text, possibly tokenised with `{NAME}`, `{SUBJ}`, etc. The
   * composite calls `renderPersonalized` on this string before drawing.
   */
  factTextTemplate: string;
  /** Personalised name to substitute into the fact text. */
  name: string;
  /** Pronouns in canonical "subj/obj" form (e.g. "they/them"). */
  pronouns: string;
  /** Where the background image comes from. Resolved internally. */
  imageSource: ImageSource;
  textOptions?: TextOptions;
  framingTransform?: FramingTransform | null;
  aspectRatio?: MemeAspectRatio;
}

export interface ComposeMemeOptions {
  /**
   * Object-path of the user's profile photo (`/objects/...`), used to resolve
   * `imageSource.type === "identity"`. Required when the caller wants to allow
   * identity memes; omitted otherwise.
   */
  profileImageObjectPath?: string | null;
  /** Optional override for the storage service (test seam). */
  objectStorage?: ObjectStorageService;
}

export interface ComposeMemeResult {
  buffer: Buffer;
  /** Always image/jpeg today — encoded by `generateMemeBuffer`. */
  mime: "image/jpeg";
}

const defaultObjectStorage = new ObjectStorageService();

/**
 * Personalise the split caption halves the same way the fact text itself is
 * personalised.
 *
 * The studio's split slider cuts the **raw template** into `topText` /
 * `bottomText` and sends both over the wire, and `generateMemeBuffer` draws
 * that pair in preference to `factText` whenever it is present. So
 * personalising `factText` alone resolves a string that is then thrown away,
 * and the finished image renders the literal `{NAME}`. Every render path that
 * calls `renderPersonalized` for the fact text must call this for the options
 * in the same breath.
 *
 * Each half is substituted independently, which is exactly what the client's
 * `LivePreview` does (`renderFactSegments` per block) — so the server render
 * stays byte-faithful to the preview the user approved.
 */
export function personalizeMemeTextOptions<T extends Pick<TextOptions, "topText" | "bottomText">>(
  options: T | undefined,
  name: string | null | undefined,
  pronouns: string | null | undefined,
): T | undefined {
  if (!options) return options;
  if (!name) return options;
  const next = { ...options };
  if (typeof next.topText === "string") {
    next.topText = renderPersonalized(next.topText, name, pronouns);
  }
  if (typeof next.bottomText === "string") {
    next.bottomText = renderPersonalized(next.bottomText, name, pronouns);
  }
  return next;
}

/** The columns a stored-recipe render needs from the fact row. */
export interface StoredMemeFactRow {
  text: string | null;
  canonicalText: string | null;
}

/** The columns a stored-recipe render needs from the meme's creator. */
export interface StoredMemeCreatorRow {
  displayName: string | null;
  pronouns: string | null;
}

/**
 * Resolve the caption a stored meme recipe should be re-rendered with.
 *
 * A meme row stores the fact by reference (`fact_id`) plus a `text_options`
 * blob whose `topText`/`bottomText` are the fact **template** cut in two by
 * the studio's split slider. `generateMemeBuffer` draws that pair in
 * preference to the fact sentence, so personalising only the sentence leaves
 * the literal `{NAME}` in the finished image. Both must be personalised with
 * the SAME identity — which is why this lives in one helper rather than being
 * re-derived at each render endpoint (`/memes/:slug/image` and the two Zazzle
 * exports each had their own copy, and each had the same hole).
 *
 * When the creator is gone (deleted/inactive user, or an anonymous meme) the
 * caption falls back to the fact's canonical rendering, and the split halves
 * are rendered canonically too so the two stay in agreement.
 */
export function resolveStoredMemeCaption(
  fact: StoredMemeFactRow | undefined,
  creator: StoredMemeCreatorRow | undefined,
  storedTextOptions: unknown,
): { factText: string; textOptions: TextOptions | undefined } {
  const storedOptions = (storedTextOptions ?? undefined) as TextOptions | undefined;
  const rawTemplate = fact?.text ?? fact?.canonicalText ?? "";

  if (creator?.displayName && rawTemplate) {
    return {
      factText: renderPersonalized(rawTemplate, creator.displayName, creator.pronouns),
      textOptions: personalizeMemeTextOptions(storedOptions, creator.displayName, creator.pronouns),
    };
  }

  return {
    factText: fact?.canonicalText ?? fact?.text ?? "",
    // CANONICAL_NAME + they/them is precisely the identity `renderCanonical`
    // (and therefore `facts.canonical_text`) uses, so the halves and the
    // sentence resolve to the same words.
    textOptions: personalizeMemeTextOptions(storedOptions, CANONICAL_NAME, "they/them"),
  };
}

/**
 * Source-kind manifest. Each `imageSource.type` resolves to a
 * `BackgroundSource` via exactly one entry below — adding a new source kind
 * means adding (a) a new branch to the client's `sourceKinds.ts` and (b) a
 * new entry here. The four-branch `if` chain that lived here previously made
 * it easy for the two sides to drift; the table makes the contract explicit.
 *
 * The `IdentityProfileMissingError` and `StockPhotoUnresolvedError` semantics
 * are preserved — routes catch them and translate to 400 / 502 respectively.
 */
type ResolverDeps = {
  objectStorage: ObjectStorageService;
  profileImageObjectPath?: string | null;
};

type SourceResolver<T extends ImageSource["type"]> = (
  source: Extract<ImageSource, { type: T }>,
  deps: ResolverDeps,
) => Promise<BackgroundSource>;

const SOURCE_RESOLVERS: { [K in ImageSource["type"]]: SourceResolver<K> } = {
  template: async (src) => ({ type: "template", templateId: src.templateId }),

  stock: async (src) => {
    // Re-resolve the photo URL via Pexels so that link rotations on their CDN
    // don't break server-side renders. The optional `photoUrl` from the client
    // is the fallback path used if the Pexels lookup fails — clients that only
    // have the pexelsPhotoId on hand (the universal builder stores just the
    // ID in its state) will surface the lookup failure as a 502 to the user.
    let photoUrl: string | undefined = src.photoUrl;
    try {
      const photo = await getPhotoById(src.pexelsPhotoId);
      photoUrl = photo.photoUrl;
    } catch {
      // Use the client-supplied URL as the fallback.
    }
    if (!photoUrl) {
      throw new StockPhotoUnresolvedError(src.pexelsPhotoId);
    }
    return { type: "image", imageData: photoUrl };
  },

  upload: async (src, deps) => {
    return downloadAsBackground(deps.objectStorage, src.uploadKey);
  },

  identity: async (_src, deps) => {
    const profilePath = deps.profileImageObjectPath;
    if (!profilePath || !profilePath.startsWith("/objects/")) {
      throw new IdentityProfileMissingError();
    }
    return downloadAsBackground(deps.objectStorage, profilePath);
  },

  /**
   * Video memes are stored as MP4s and served directly — they never go
   * through the still-image compositor. If we land here it's because a caller
   * tried to render a video meme as a PNG (OG card, share thumbnail, fallback
   * still). Resolve to the captured still frame so the composite has something
   * to draw on; the proper short-circuit to MP4 lives in routes/memes.ts.
   */
  video: async (src, deps) => {
    return downloadAsBackground(deps.objectStorage, src.stillObjectPath);
  },
};

async function downloadAsBackground(
  objectStorage: ObjectStorageService,
  objectPath: string,
): Promise<BackgroundSource> {
  const objectFile = await objectStorage.getObjectEntityFile(objectPath);
  const downloadResponse = await objectStorage.downloadObject(objectFile);
  const buf = Buffer.from(await downloadResponse.arrayBuffer());
  return { type: "image", imageData: buf };
}

async function resolveBackground(
  imageSource: ImageSource,
  opts: ComposeMemeOptions,
): Promise<BackgroundSource> {
  const deps: ResolverDeps = {
    objectStorage: opts.objectStorage ?? defaultObjectStorage,
    profileImageObjectPath: opts.profileImageObjectPath,
  };
  // Cast is safe: the resolver table is keyed on the discriminator, and
  // `imageSource.type` indexes into it deterministically. TypeScript can't
  // see the relationship between the index and the parameter type.
  const resolver = SOURCE_RESOLVERS[imageSource.type] as SourceResolver<typeof imageSource.type>;
  return resolver(imageSource as never, deps);
}

/**
 * Produce the rendered meme PNG/JPEG buffer. Pure with respect to its inputs:
 * the only ambient state read is the optional Pexels CDN lookup for stock
 * photos and the object-storage download for uploads — both deterministic for
 * a given (pexelsPhotoId / uploadKey).
 */
export async function composeMeme(
  input: ComposeMemeInput,
  opts: ComposeMemeOptions = {},
): Promise<ComposeMemeResult> {
  const factText = renderPersonalized(input.factTextTemplate, input.name, input.pronouns);
  const textOptions = personalizeMemeTextOptions(input.textOptions, input.name, input.pronouns);
  const background = await resolveBackground(input.imageSource, opts);
  const buffer = await generateMemeBuffer(
    background,
    factText,
    textOptions,
    input.aspectRatio ?? "landscape",
    input.framingTransform ?? null,
  );
  return { buffer, mime: "image/jpeg" };
}

/**
 * Thrown when an `imageSource` of type `identity` is requested but the caller
 * has no profile photo on file. Routes catch this and return a 400 with a
 * specific error code.
 */
export class IdentityProfileMissingError extends Error {
  constructor() {
    super("Add a profile photo to create an identity meme.");
    this.name = "IdentityProfileMissingError";
    Object.setPrototypeOf(this, IdentityProfileMissingError.prototype);
  }
}

/**
 * Thrown when a stock-mode render cannot resolve a photo URL — the Pexels
 * lookup failed AND the client did not supply a fallback `photoUrl`. Routes
 * catch this as a 502 so the user sees a transient-error message rather than
 * a stack trace.
 */
export class StockPhotoUnresolvedError extends Error {
  constructor(public readonly pexelsPhotoId: number) {
    super(`Could not resolve Pexels photo ${pexelsPhotoId}`);
    this.name = "StockPhotoUnresolvedError";
    Object.setPrototypeOf(this, StockPhotoUnresolvedError.prototype);
  }
}
