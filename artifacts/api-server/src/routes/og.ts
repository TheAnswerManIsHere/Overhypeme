/**
 * Phase-5 Open Graph shell endpoint.
 *
 *   GET /api/og/m/:slug
 *
 * Returns crawler-targeted HTML with og:* / twitter:* tags. The Cloudflare
 * Worker fronting overhype.me/m/:slug rewrites bot UAs here; humans bypass
 * this endpoint entirely (the worker passes through to the static SPA).
 *
 * Soft-deleted memes return 410 with a generic OG card; missing memes 404
 * with the same. Live memes return 200 with the meme's own image as the
 * card.
 *
 * Cache-Control is set to 1h public — the response is deterministic for a
 * given slug at a given moment, and Cloudflare caches it at the edge.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { renderPersonalized } from "../lib/renderCanonical";
import { getSiteBaseUrl } from "../lib/siteUrl";

const router: IRouter = Router();

const SITE_NAME = "overhype.me";
const SITE_TAGLINE = "Where legends are made up.";
const DEFAULT_OG_IMAGE_PATH = "/og-default.png";

/**
 * HTML escape for dynamic values that land inside attribute strings or text
 * nodes in the OG shell. We never accept HTML from these fields, but the
 * data is user-authored (display names, fact text), so escape is required.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface OgShellInput {
  title: string;
  description: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  imageAlt: string;
  canonicalUrl: string;
  redirectTo: string;
}

function renderOgShell(input: OgShellInput): string {
  const {
    title,
    description,
    imageUrl,
    imageWidth,
    imageHeight,
    imageAlt,
    canonicalUrl,
    redirectTo,
  } = input;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonicalUrl)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(SITE_NAME)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonicalUrl)}" />
<meta property="og:image" content="${esc(imageUrl)}" />
<meta property="og:image:width" content="${imageWidth}" />
<meta property="og:image:height" content="${imageHeight}" />
<meta property="og:image:alt" content="${esc(imageAlt)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${esc(imageUrl)}" />
<meta http-equiv="refresh" content="0;url=${esc(redirectTo)}" />
</head>
<body>
<h1>${esc(title)}</h1>
<p>${esc(description)}</p>
<img src="${esc(imageUrl)}" alt="${esc(imageAlt)}" width="${imageWidth}" height="${imageHeight}" />
<p><a href="${esc(redirectTo)}">View on ${esc(SITE_NAME)}</a></p>
</body>
</html>
`;
}

function aspectRatioToDims(ar: string | null | undefined): { width: number; height: number } {
  switch (ar) {
    case "portrait":  return { width: 1080, height: 1920 };
    case "landscape": return { width: 1920, height: 1080 };
    case "square":
    default:          return { width: 1080, height: 1080 };
  }
}

function firstLine(s: string, max = 100): string {
  const line = (s.split(/\r?\n/)[0] ?? "").trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

/**
 * Production memes are stored with a relative image path
 * (`/api/memes/<slug>/image`) so the SPA can resolve them on whatever
 * host it's running on. Social crawlers don't have a host context — they
 * fetch `og:image` exactly as written — so we MUST emit an absolute URL
 * here. Already-absolute URLs (e.g. R2 / Cloudinary CDN paths used by
 * older memes) pass through unchanged.
 */
function absolutize(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

router.get("/og/m/:slug", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

  const slugParam = req.params["slug"];
  const slug = (typeof slugParam === "string" ? slugParam : "").trim();
  const baseUrl = getSiteBaseUrl();
  const canonicalUrl = `${baseUrl}/m/${slug}`;

  if (!slug) {
    res.status(404).send(renderOgShell({
      title: SITE_NAME,
      description: SITE_TAGLINE,
      imageUrl: `${baseUrl}${DEFAULT_OG_IMAGE_PATH}`,
      imageWidth: 1200,
      imageHeight: 630,
      imageAlt: SITE_NAME,
      canonicalUrl: baseUrl,
      redirectTo: "/",
    }));
    return;
  }

  const [meme] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);

  if (!meme) {
    res.status(404).send(renderOgShell({
      title: `Not found · ${SITE_NAME}`,
      description: SITE_TAGLINE,
      imageUrl: `${baseUrl}${DEFAULT_OG_IMAGE_PATH}`,
      imageWidth: 1200,
      imageHeight: 630,
      imageAlt: SITE_NAME,
      canonicalUrl,
      redirectTo: "/",
    }));
    return;
  }

  if (meme.deletedAt) {
    // Don't leak any of the deleted meme's content (text, image URL, creator
    // name) — generic card only.
    res.status(410).send(renderOgShell({
      title: `Removed · ${SITE_NAME}`,
      description: "This meme has been removed by its creator.",
      imageUrl: `${baseUrl}${DEFAULT_OG_IMAGE_PATH}`,
      imageWidth: 1200,
      imageHeight: 630,
      imageAlt: SITE_NAME,
      canonicalUrl,
      redirectTo: "/",
    }));
    return;
  }

  let factText = meme.renderedFactText ?? null;
  let createdByName: string | null = null;

  if (meme.createdById) {
    const [user] = await db
      .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
      .from(usersTable)
      .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
      .limit(1);
    createdByName = user?.displayName ?? null;
    if (!factText) {
      const [fact] = await db
        .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
        .from(factsTable)
        .where(and(eq(factsTable.id, meme.factId), eq(factsTable.isActive, true)))
        .limit(1);
      const rawTemplate = fact?.text ?? fact?.canonicalText ?? "";
      factText = createdByName && rawTemplate
        ? renderPersonalized(rawTemplate, createdByName, user?.pronouns ?? null)
        : (fact?.canonicalText ?? fact?.text ?? "");
    }
  } else if (!factText) {
    const [fact] = await db
      .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
      .from(factsTable)
      .where(and(eq(factsTable.id, meme.factId), eq(factsTable.isActive, true)))
      .limit(1);
    factText = fact?.canonicalText ?? fact?.text ?? "";
  }

  const dims = aspectRatioToDims(meme.aspectRatio);
  const factLine = firstLine(factText ?? "", 110);
  const title = createdByName
    ? `${createdByName} — ${factLine || SITE_NAME}`
    : (factLine || SITE_NAME);
  const description = factLine
    ? `${factLine} · ${SITE_TAGLINE}`
    : SITE_TAGLINE;

  res.status(200).send(renderOgShell({
    title,
    description,
    imageUrl: absolutize(meme.imageUrl, baseUrl),
    imageWidth: dims.width,
    imageHeight: dims.height,
    imageAlt: factLine || `Meme on ${SITE_NAME}`,
    canonicalUrl,
    redirectTo: `/m/${slug}`,
  }));
});

export default router;
