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
import { renderPersonalized } from "./renderCanonical";
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
 * Resolve an `ImageSource` to a `BackgroundSource` that the canvas renderer
 * understands. Three of the four shapes do real I/O:
 *   - "stock"    fetches the resolved photo URL from Pexels (the canvas loader
 *                will then fetch the actual image bytes)
 *   - "upload"   downloads the bytes from object storage as a Buffer
 *   - "identity" resolves the user's profile photo to an upload-shaped source
 * "template" is fully synchronous.
 */
async function resolveBackground(
  imageSource: ImageSource,
  opts: ComposeMemeOptions,
): Promise<BackgroundSource> {
  const objectStorage = opts.objectStorage ?? defaultObjectStorage;

  if (imageSource.type === "template") {
    return { type: "template", templateId: imageSource.templateId };
  }

  if (imageSource.type === "stock") {
    // Re-resolve the photo URL via Pexels so that link rotations on their CDN
    // don't break server-side renders. The optional `photoUrl` from the client
    // is the fallback path used if the Pexels lookup fails — clients that only
    // have the pexelsPhotoId on hand (the universal builder stores just the
    // ID in its state) will surface the lookup failure as a 502 to the user.
    let photoUrl: string | undefined = imageSource.photoUrl;
    try {
      const photo = await getPhotoById(imageSource.pexelsPhotoId);
      photoUrl = photo.photoUrl;
    } catch {
      // Use the client-supplied URL as the fallback.
    }
    if (!photoUrl) {
      throw new StockPhotoUnresolvedError(imageSource.pexelsPhotoId);
    }
    return { type: "image", imageData: photoUrl };
  }

  if (imageSource.type === "upload") {
    const objectFile = await objectStorage.getObjectEntityFile(imageSource.uploadKey);
    const downloadResponse = await objectStorage.downloadObject(objectFile);
    const buf = Buffer.from(await downloadResponse.arrayBuffer());
    return { type: "image", imageData: buf };
  }

  // imageSource.type === "identity"
  const profilePath = opts.profileImageObjectPath;
  if (!profilePath || !profilePath.startsWith("/objects/")) {
    throw new IdentityProfileMissingError();
  }
  const objectFile = await objectStorage.getObjectEntityFile(profilePath);
  const downloadResponse = await objectStorage.downloadObject(objectFile);
  const buf = Buffer.from(await downloadResponse.arrayBuffer());
  return { type: "image", imageData: buf };
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
  const background = await resolveBackground(input.imageSource, opts);
  const buffer = await generateMemeBuffer(
    background,
    factText,
    input.textOptions,
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
