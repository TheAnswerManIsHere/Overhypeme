/**
 * Phase-6 share-copy endpoint.
 *
 *   GET /api/share-copy/:memeId/:platform
 *
 * Returns the pre-filled copy and pre-built share-intent URL for one of the
 * four meme-share buttons. The frontend keeps zero copy logic — every string
 * the user sees in the share modal comes from this endpoint, so admins can
 * edit the templates in `admin_config` without a redeploy.
 *
 * The `:memeId` path param accepts the meme's permalink slug (the same
 * value used in the user-facing /m/:slug URL). Internally we look up the
 * meme by slug, render the templates, and emit an absolute permalink so
 * the share content is host-independent.
 *
 * Auth required (sharing is gated to free+ via the CTA matrix; an
 * authenticated viewer is required even at the API surface as belt-and-
 * suspenders for the UI gate). Rate-limited per-user to prevent enumeration.
 *
 * Supported template variables: {name}, {fact_text}, {permalink}.
 *   - {name}       — the meme creator's display name (the SUBJECT of the
 *                    meme; the recipient sees "look at this meme of {name}",
 *                    not "{sender} sent this to you")
 *   - {fact_text}  — the meme's frozen rendered fact text
 *   - {permalink}  — the absolute https URL of the meme detail page
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable } from "@workspace/db/schema";
import type { ShareIntentPlatform } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { getConfigString } from "../lib/adminConfig";
import { renderPersonalized } from "../lib/renderCanonical";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { canViewMeme } from "../lib/memeVisibility";

const router: IRouter = Router();

const VALID_PLATFORMS: readonly ShareIntentPlatform[] = ["twitter", "web_share", "copy_link", "email"];

// ── Per-user rate limit ────────────────────────────────────────────────────
// Light limit to prevent enumeration. 60 requests/minute/user is plenty for
// the share modal (one fetch per platform tab on open, ~4 max per session)
// while being low enough that scripted iteration over slugs is conspicuous.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
function takeBucket(key: string): boolean {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count += 1;
  return true;
}
export function __resetShareCopyRateLimitForTests(): void {
  buckets.clear();
}

// ── Template defaults ──────────────────────────────────────────────────────
// Kept in sync with the seed rows in 0052_share_intents.sql. These defaults
// apply when the admin_config row is missing (which should only happen in
// tests where the seed migration was not run).
const DEFAULTS = {
  twitterTemplate:        "{fact_text}",
  twitterHashtags:        "overhype,legendsaremadeup",
  emailSubjectTemplate:   "A meme of {name} on overhype.me",
  emailBodyTemplate:
    "{name} thought you'd appreciate this:\n\n\"{fact_text}\"\n\nSee it: {permalink}\n\n— Sent from overhype.me, where legends are made up.",
  webShareTitleTemplate:  "{name} on overhype.me",
  webShareTextTemplate:   "{fact_text}",
} as const;

// ── Twitter truncation ─────────────────────────────────────────────────────
// Twitter caps tweets at 280 chars. The intent URL appends `&url=…` (rendered
// as a t.co short link, ~23 chars + one separator space). Hashtags are
// appended client-side by the Twitter composer (`&hashtags=…`) but they DO
// count against the limit visible to the user. We reserve a conservative
// budget so the text never causes the composer to open in a "tweet too long"
// state when hashtags + URL are added.
const TWITTER_MAX_CHARS = 280;
const TWITTER_URL_RESERVE = 24;             // t.co (23) + leading space
const TWITTER_HASHTAG_RESERVE_PER_TAG = 16; // generous; hashtags average shorter
function truncateForTwitter(text: string, hashtagCount: number): string {
  const reserve = TWITTER_URL_RESERVE + hashtagCount * TWITTER_HASHTAG_RESERVE_PER_TAG;
  const budget = TWITTER_MAX_CHARS - reserve;
  if (text.length <= budget) return text;
  return text.slice(0, Math.max(1, budget - 1)).trimEnd() + "…";
}

// ── Template substitution ──────────────────────────────────────────────────
function applyTemplate(
  template: string,
  vars: { name: string; fact_text: string; permalink: string },
): string {
  return template
    .replace(/\{name\}/g, vars.name)
    .replace(/\{fact_text\}/g, vars.fact_text)
    .replace(/\{permalink\}/g, vars.permalink);
}

function parseHashtags(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter((s) => s.length > 0);
}

// ── Meme lookup ────────────────────────────────────────────────────────────
interface ResolvedMeme {
  status: "ok" | "not_found" | "deleted";
  creatorName: string;
  factText: string;
  permalink: string;
}

async function resolveMeme(slug: string, req: Request): Promise<ResolvedMeme> {
  const baseUrl = getSiteBaseUrl();
  const permalink = `${baseUrl}/m/${slug}`;

  const [meme] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);

  if (!meme) {
    return { status: "not_found", creatorName: "", factText: "", permalink };
  }
  if (meme.deletedAt) {
    return { status: "deleted", creatorName: "", factText: "", permalink };
  }
  // Private (owner-only) memes: a non-owner gets share copy for nothing —
  // report not_found so the private meme's existence and content stay hidden.
  if (!canViewMeme(meme, req)) {
    return { status: "not_found", creatorName: "", factText: "", permalink };
  }

  let creatorName = "";
  let creatorPronouns: string | null = null;
  if (meme.createdById) {
    const [user] = await db
      .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
      .from(usersTable)
      .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
      .limit(1);
    creatorName = user?.displayName ?? "";
    creatorPronouns = user?.pronouns ?? null;
  }

  // Prefer the frozen rendered fact text. Fall back to dynamic rendering for
  // older memes that pre-date the renderedFactText column — mirrors the
  // GET /api/memes/:slug path so share copy never disagrees with the page.
  let factText = meme.renderedFactText ?? "";
  if (!factText) {
    const [fact] = await db
      .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
      .from(factsTable)
      .where(and(eq(factsTable.id, meme.factId), eq(factsTable.isActive, true)))
      .limit(1);
    const rawTemplate = fact?.text ?? fact?.canonicalText ?? "";
    factText = creatorName && rawTemplate
      ? renderPersonalized(rawTemplate, creatorName, creatorPronouns)
      : (fact?.canonicalText ?? fact?.text ?? "");
  }

  return { status: "ok", creatorName, factText, permalink };
}

// ── Intent URL builders ────────────────────────────────────────────────────
function buildTwitterIntentUrl(text: string, permalink: string, hashtags: string[]): string {
  const params = new URLSearchParams();
  params.set("text", text);
  params.set("url", permalink);
  if (hashtags.length > 0) params.set("hashtags", hashtags.join(","));
  // twitter.com/intent/tweet remains the recommended path in 2026 (confirmed
  // via X for Websites docs; x.com/intent/post exists but reportedly opens an
  // X-app login screen inside the in-app browser on some platforms).
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

function buildMailtoUrl(subject: string, body: string): string {
  const params = new URLSearchParams();
  params.set("subject", subject);
  params.set("body", body);
  // mailto: URLs use RFC 3986 encoding, but URLSearchParams emits
  // form-urlencoded (spaces as `+`). Mail clients vary in their tolerance —
  // Apple Mail and Gmail accept `+` for spaces, but Outlook will sometimes
  // render the `+` literally. Normalize to `%20` for the widest support.
  return `mailto:?${params.toString().replace(/\+/g, "%20")}`;
}

// ── Route handler ──────────────────────────────────────────────────────────
router.get("/share-copy/:memeId/:platform", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const rateKey = `share-copy:${req.user.id}`;
  if (!takeBucket(rateKey)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const slug = String(req.params["memeId"] ?? "").trim();
  const platform = String(req.params["platform"] ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "memeId is required" });
    return;
  }
  if (!(VALID_PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: `Invalid platform. Expected one of: ${VALID_PLATFORMS.join(", ")}` });
    return;
  }

  const meme = await resolveMeme(slug, req);
  if (meme.status === "not_found") {
    res.status(404).json({ error: "Meme not found" });
    return;
  }
  if (meme.status === "deleted") {
    res.status(410).json({ error: "This meme has been removed by its creator." });
    return;
  }

  const vars = {
    name: meme.creatorName || "Someone",
    fact_text: meme.factText,
    permalink: meme.permalink,
  };

  switch (platform as ShareIntentPlatform) {
    case "twitter": {
      const tpl = await getConfigString("share_copy_twitter_template", DEFAULTS.twitterTemplate);
      const hashtagsRaw = await getConfigString("share_copy_twitter_hashtags", DEFAULTS.twitterHashtags);
      const hashtags = parseHashtags(hashtagsRaw);
      const rendered = applyTemplate(tpl, vars);
      const text = truncateForTwitter(rendered, hashtags.length);
      const intentUrl = buildTwitterIntentUrl(text, meme.permalink, hashtags);
      res.json({ platform: "twitter", url: meme.permalink, text, hashtags, intentUrl });
      return;
    }
    case "web_share": {
      const titleTpl = await getConfigString("share_copy_web_share_title_template", DEFAULTS.webShareTitleTemplate);
      const textTpl  = await getConfigString("share_copy_web_share_text_template",  DEFAULTS.webShareTextTemplate);
      res.json({
        platform: "web_share",
        url: meme.permalink,
        title: applyTemplate(titleTpl, vars),
        text: applyTemplate(textTpl, vars),
      });
      return;
    }
    case "copy_link": {
      res.json({ platform: "copy_link", url: meme.permalink });
      return;
    }
    case "email": {
      const subjectTpl = await getConfigString("share_copy_email_subject_template", DEFAULTS.emailSubjectTemplate);
      const bodyTpl    = await getConfigString("share_copy_email_body_template",    DEFAULTS.emailBodyTemplate);
      const subject = applyTemplate(subjectTpl, vars);
      const body    = applyTemplate(bodyTpl, vars);
      res.json({
        platform: "email",
        url: meme.permalink,
        subject,
        body,
        intentUrl: buildMailtoUrl(subject, body),
      });
      return;
    }
  }
});

export default router;
