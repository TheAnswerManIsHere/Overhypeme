import type { Request, Response, NextFunction } from "express";

export const CACHE = {
  NO_STORE: "no-store",
  STATIC_IMMUTABLE: "public, max-age=31536000, immutable",
  // Long TTLs are safe because the meme image endpoint emits a content-aware
  // ETag (render-pipeline version + meme.updatedAt + SHA of rendered bytes),
  // so any change to a meme produces a different ETag and clients/CDN edges
  // pull fresh bytes. Short TTLs were causing social crawlers (Twitter/X,
  // Facebook, Slack, Discord) to re-fetch the image on every unfurl AND, in
  // some cases, refuse to cache it as an OG image at all because the
  // `must-revalidate` directive makes it look user-specific.
  //   max-age=3600  → browser cache 1h
  //   s-maxage=86400 → Cloudflare/CDN cache 24h
  MEME_IMAGE: "public, max-age=3600, s-maxage=86400",
  MEME_TEMPLATE: "public, max-age=86400, s-maxage=604800",
  PUBLIC_OBJECT: "public, max-age=3600, s-maxage=86400",
  PRIVATE_OBJECT: "private, max-age=3600",
} as const;

export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", CACHE.NO_STORE);
  next();
}

export function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", CACHE.NO_STORE);
}

export function setPublicCache(res: Response, cacheControl: string, etagSeed?: string): void {
  res.setHeader("Cache-Control", cacheControl);
  if (etagSeed) {
    res.setHeader("ETag", `"${etagSeed}"`);
  }
}

export function checkConditional(req: Request, res: Response, etag: string): boolean {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `"${etag}"`)) {
    res.status(304).end();
    return true;
  }
  return false;
}

export function setPublicCors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
}
