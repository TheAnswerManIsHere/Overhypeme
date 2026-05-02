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
