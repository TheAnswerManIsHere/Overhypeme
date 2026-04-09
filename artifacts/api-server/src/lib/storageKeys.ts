import { createHash } from "crypto";

/**
 * Computes a 2-hex-character SHA-256 hash prefix from a filename.
 * Distributes keys across 256 buckets (00–ff) to avoid GCS sequential-prefix
 * hotspotting. The prefix is computed from the filename portion only (the part
 * AFTER the hash directory), so the same logical file always hashes the same way.
 */
export function hashPrefix(filename: string): string {
  return createHash("sha256").update(filename).digest("hex").substring(0, 2);
}

/**
 * Key for an AI-generated background image (shared, system-owned).
 * Format: ai-backgrounds/{hash2}/{factId}-{gender}-{uniqueKey}.{ext}
 *    Ref: ai-backgrounds/{hash2}/{factId}-{gender}-ref-{uniqueKey}.{ext}
 */
export function aiBackgroundKey(
  factId: number,
  gender: string,
  uniqueKey: string,
  ext: string = "png",
  isRef: boolean = false
): string {
  const filename = isRef
    ? `${factId}-${gender}-ref-${uniqueKey}.${ext}`
    : `${factId}-${gender}-${uniqueKey}.${ext}`;
  return `ai-backgrounds/${hashPrefix(filename)}/${filename}`;
}

/**
 * Key for a pre-rendered meme composite.
 * Format: memes/{hash2}/{slug}.{ext}
 */
export function memeKey(slug: string, ext: string = "jpg"): string {
  const filename = `${slug}.${ext}`;
  return `memes/${hashPrefix(filename)}/${filename}`;
}

/**
 * Key for a user-uploaded image (avatar or meme background).
 * Format: uploads/{hash2}/{uploadId}.{ext}  or  uploads/{hash2}/{uploadId}
 */
export function uploadKey(uploadId: string, ext?: string): string {
  const filename = ext ? `${uploadId}.${ext}` : uploadId;
  return `uploads/${hashPrefix(filename)}/${filename}`;
}

/**
 * Extracts the bare filename from any storage key (strips all directory components).
 */
export function filenameFromKey(key: string): string {
  return key.split("/").pop() ?? key;
}
