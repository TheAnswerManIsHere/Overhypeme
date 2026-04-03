import type { Request, Response, NextFunction } from "express";

export const CACHE = {
  NO_STORE: "no-store",
  STATIC_IMMUTABLE: "public, max-age=31536000, immutable",
  MEME_IMAGE: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
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
