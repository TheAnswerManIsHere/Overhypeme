/**
 * Center-crop an image to a square and re-encode as JPEG, downscaled to
 * `maxSize` on the long edge. The cropped image is the user's reusable
 * identity asset — meme overlays, AI image generation, and AI video memes
 * all consume a square face crop, so we normalise on upload.
 */
export async function cropToSquareJpeg(file: File, maxSize = 1024): Promise<File> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(new Error("Could not read image"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new globalThis.Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not decode image"));
    i.src = dataUrl;
  });
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (side <= 0) throw new Error("Image has no pixels");
  const sx = Math.floor((img.naturalWidth - side) / 2);
  const sy = Math.floor((img.naturalHeight - side) / 2);
  const out = Math.min(side, maxSize);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("Could not encode image");
  const baseName = file.name.replace(/\.[^.]+$/, "") || "photo";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
}

export const CLIENT_MAX_DIMENSION = 6000;
export const CLIENT_JPEG_QUALITY = 0.9;
export const CLIENT_MAX_UPLOAD_MB = 15;
export const CLIENT_MAX_UPLOAD_BYTES = CLIENT_MAX_UPLOAD_MB * 1024 * 1024;

export interface PreProcessImageOptions {
  maxDimension?: number;
  jpegQuality?: number;
  maxUploadBytes?: number;
}

export interface PreProcessImageResult {
  blob: Blob;
  width: number;
  height: number;
}

export async function preProcessImageFile(
  file: File,
  options: PreProcessImageOptions = {},
): Promise<PreProcessImageResult> {
  const maxDimension = options.maxDimension ?? CLIENT_MAX_DIMENSION;
  const jpegQuality = options.jpegQuality ?? CLIENT_JPEG_QUALITY;
  const maxUploadBytes = options.maxUploadBytes ?? CLIENT_MAX_UPLOAD_BYTES;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;
      const longestEdge = Math.max(w, h);
      if (longestEdge > maxDimension) {
        const scale = maxDimension / longestEdge;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const attempt = (curW: number, curH: number, quality: number, attemptsLeft: number) => {
        const c = document.createElement("canvas");
        c.width = curW;
        c.height = curH;
        const cx = c.getContext("2d");
        if (!cx) { reject(new Error("Canvas unavailable")); return; }
        cx.drawImage(img, 0, 0, curW, curH);
        c.toBlob(
          (blob) => {
            if (!blob) { reject(new Error("Image encoding failed")); return; }
            if (blob.size <= maxUploadBytes || attemptsLeft <= 0) {
              resolve({ blob, width: curW, height: curH });
              return;
            }
            if (quality > 0.6) {
              attempt(curW, curH, Math.max(0.6, quality - 0.1), attemptsLeft - 1);
            } else {
              const nextW = Math.round(curW * 0.85);
              const nextH = Math.round(curH * 0.85);
              attempt(nextW, nextH, 0.85, attemptsLeft - 1);
            }
          },
          "image/jpeg",
          quality,
        );
      };
      attempt(w, h, jpegQuality, 8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

// ─── Unified upload helper ───────────────────────────────────────────────────
//
// `uploadUserImage` is the single entry point for every user image upload in
// the app. Use it for meme backgrounds, profile photos, AI reference photos,
// and any future surface that takes an image from the user. It picks the
// correct server endpoint, preprocesses the file (fit / square / none),
// transmits the bytes, and surfaces the server response in a single shape —
// keeping the CSAM/NSFW pipeline, rate limiting, ACLs, and metadata logging
// behind one consistent client call.

/**
 * - "meme": private uploads scoped to the meme/AI flows. Always JPEG.
 *   Endpoint: POST /api/storage/upload-meme.
 * - "avatar": public profile photo asset (also reused as identity reference).
 *   Endpoint: POST /api/storage/upload-avatar. Accepts JPEG, PNG, WebP, GIF.
 */
export type UploadUserImageKind = "meme" | "avatar";

/**
 * - "fit"    — `preProcessImageFile` (downscale to maxDimension, encode JPEG,
 *              iteratively recompress to fit maxUploadBytes). Default.
 * - "square" — `cropToSquareJpeg` (center-crop to a square, encode JPEG).
 * - "none"   — send the bytes verbatim (caller already preprocessed, or wants
 *              to preserve animation, e.g. a GIF avatar).
 */
export type UploadUserImagePreprocess = "fit" | "square" | "none";

export interface UploadUserImageOptions {
  kind: UploadUserImageKind;
  preprocess?: UploadUserImagePreprocess;
  /** Override for `fit` preprocessing. */
  maxDimension?: number;
  jpegQuality?: number;
  maxUploadBytes?: number;
  /** Override for `square` preprocessing. */
  squareSize?: number;
}

export interface UploadUserImageResult {
  objectPath: string;
  width: number | null;
  height: number | null;
  isLowRes: boolean;
  fileSizeBytes: number | null;
}

const ENDPOINTS: Record<UploadUserImageKind, string> = {
  meme: "/api/storage/upload-meme",
  avatar: "/api/storage/upload-avatar",
};

export async function uploadUserImage(
  file: File,
  options: UploadUserImageOptions,
): Promise<UploadUserImageResult> {
  const preprocess: UploadUserImagePreprocess = options.preprocess ?? "fit";

  let body: Blob;
  let contentType: string;
  let preWidth: number | null = null;
  let preHeight: number | null = null;

  if (preprocess === "fit") {
    const processed = await preProcessImageFile(file, {
      maxDimension: options.maxDimension,
      jpegQuality: options.jpegQuality,
      maxUploadBytes: options.maxUploadBytes,
    });
    body = processed.blob;
    contentType = "image/jpeg";
    preWidth = processed.width;
    preHeight = processed.height;
  } else if (preprocess === "square") {
    const cropped = await cropToSquareJpeg(file, options.squareSize ?? 1024);
    body = cropped;
    contentType = "image/jpeg";
  } else {
    body = file;
    contentType = file.type || "application/octet-stream";
  }

  const res = await fetch(ENDPOINTS[options.kind], {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `Upload failed (${res.status})`);
  }
  const data = (await res.json()) as {
    objectPath: string;
    width?: number;
    height?: number;
    isLowRes?: boolean;
    fileSizeBytes?: number;
  };
  return {
    objectPath: data.objectPath,
    width: data.width ?? preWidth,
    height: data.height ?? preHeight,
    isLowRes: data.isLowRes ?? false,
    fileSizeBytes: data.fileSizeBytes ?? null,
  };
}
