/**
 * What "the image decodes" means for an acceptance journey (Launch Phase 2,
 * increment 6, #631; plan D2, the image-content gap recorded on #654).
 *
 * A full pixel decode, not a header read: `sharp(...).metadata()` reads only
 * the header, and a JPEG cut to half its bytes still reports its dimensions
 * there (measured by Astra, plan round 1), while `raw().toBuffer()` rejects
 * it. The format must agree with the response's content type, the
 * dimensions must be positive, and where the request named an aspect ratio
 * the image must match it within 2%.
 */
import sharp from "sharp";

export const ASPECT_RATIOS = { landscape: 16 / 9, square: 1, portrait: 9 / 16 } as const;

export interface DecodedImage {
  format: string;
  width: number;
  height: number;
}

export type ImageCheck = { ok: true; image: DecodedImage } | { ok: false; problem: string };

const CONTENT_TYPES: Record<string, string[]> = {
  jpeg: ["image/jpeg", "image/jpg"],
  png: ["image/png"],
  webp: ["image/webp"],
  gif: ["image/gif"],
};

export async function checkImage(body: Buffer, contentType: string | null, aspect?: keyof typeof ASPECT_RATIOS): Promise<ImageCheck> {
  if (body.length === 0) return { ok: false, problem: "the body is empty" };
  let decoded: { info: { width: number; height: number } };
  let format: string;
  try {
    format = (await sharp(body).metadata()).format ?? "unknown";
    decoded = await sharp(body).raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    return { ok: false, problem: `the body does not decode as an image: ${(err as Error).message}` };
  }
  const { width, height } = decoded.info;
  if (!(width > 0 && height > 0)) return { ok: false, problem: `decoded to ${width}×${height}` };
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(CONTENT_TYPES[format] ?? []).includes(type)) {
    return { ok: false, problem: `the body is ${format} but the response says ${contentType ?? "nothing"}` };
  }
  if (aspect) {
    const want = ASPECT_RATIOS[aspect];
    const got = width / height;
    if (Math.abs(got - want) / want > 0.02) return { ok: false, problem: `${width}×${height} is not ${aspect} (${want.toFixed(3)})` };
  }
  return { ok: true, image: { format, width, height } };
}
