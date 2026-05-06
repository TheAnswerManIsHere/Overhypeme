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
