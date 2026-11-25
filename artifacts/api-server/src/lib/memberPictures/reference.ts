/**
 * @purpose A member's own photo, made fetchable by the photo check and the image engine (launch Phase 7, increment 2): read from object storage, scaled to the 1024-pixel edge the engines' edit prices assume, and uploaded to fal's storage on the same short lifecycle as the moderation reference photos.
 * @subsystem visual-pipeline
 */
import { ObjectStorageService } from "../objectStorage";
import { REFERENCE_UPLOAD_LIFECYCLE } from "../falRetention";

/** The longer edge a member's photo is sent at, as the engine comparison sends its references. */
export const MEMBER_REFERENCE_MAX_EDGE_PX = 1024;

type Uploader = (bytes: Uint8Array, contentType: string) => Promise<string>;
let uploader: Uploader | null = null;
/** Test seam: replace the fal storage upload (null restores it). */
export function __setMemberReferenceUploaderForTest(fn: Uploader | null): void {
  uploader = fn;
}

const storage = new ObjectStorageService();

export async function uploadMemberReference(uploadKey: string): Promise<string> {
  const file = await storage.getObjectEntityFile(uploadKey);
  const res = await storage.downloadObject(file);
  const original = Buffer.from(await res.arrayBuffer());
  const { default: sharp } = await import("sharp");
  const scaled = await sharp(original)
    .rotate()
    .resize(MEMBER_REFERENCE_MAX_EDGE_PX, MEMBER_REFERENCE_MAX_EDGE_PX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  if (uploader) return uploader(new Uint8Array(scaled), "image/jpeg");
  const { fal, ensureFalConfigured } = await import("../falClient.js");
  ensureFalConfigured();
  return fal.storage.upload(new Blob([new Uint8Array(scaled)], { type: "image/jpeg" }), { lifecycle: REFERENCE_UPLOAD_LIFECYCLE });
}
