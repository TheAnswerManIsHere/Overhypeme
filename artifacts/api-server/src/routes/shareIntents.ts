/**
 * Phase-6 share-intent logging endpoint.
 *
 *   POST /api/share-intents   { memeId: string, platform: ShareIntentPlatform }
 *
 * Fire-and-forget logging of share *intent* — the user clicked a button in
 * the share modal. The actual share happens off-platform (OS share sheet,
 * Twitter composer, mail client, clipboard) and we cannot observe it. The
 * Web Share API in particular swallows which app the user picked.
 *
 * The `memeId` value is the meme's permalink slug (matching the share-copy
 * endpoint and the user-facing /m/:slug URL). We resolve it to the integer
 * meme PK for the share_intents.meme_id FK.
 *
 * The client treats this as fire-and-forget. Failures here MUST NOT block
 * the user's share action — the client wraps the fetch in a try/catch and
 * the share button does its thing whether the log call succeeded or not.
 * Returning 204 (no content) on success matches that semantic.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { memesTable, shareIntentsTable, SHARE_INTENT_PLATFORMS } from "@workspace/db/schema";
import type { ShareIntentPlatform } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function isShareIntentPlatform(v: unknown): v is ShareIntentPlatform {
  return typeof v === "string" && (SHARE_INTENT_PLATFORMS as readonly string[]).includes(v);
}

router.post("/share-intents", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const body = req.body as { memeId?: unknown; platform?: unknown };
  const slug = typeof body.memeId === "string" ? body.memeId.trim() : "";
  if (!slug) {
    res.status(400).json({ error: "memeId is required" });
    return;
  }
  if (!isShareIntentPlatform(body.platform)) {
    res.status(400).json({
      error: `Invalid platform. Expected one of: ${SHARE_INTENT_PLATFORMS.join(", ")}`,
    });
    return;
  }
  const platform = body.platform;

  const [meme] = await db
    .select({ id: memesTable.id, deletedAt: memesTable.deletedAt })
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);

  if (!meme) {
    res.status(404).json({ error: "Meme not found" });
    return;
  }
  if (meme.deletedAt) {
    // The client may race a soft-delete between modal-open and click. Surface
    // it explicitly rather than silently logging an intent against a meme
    // the user can no longer share.
    res.status(410).json({ error: "This meme has been removed by its creator." });
    return;
  }

  try {
    await db.insert(shareIntentsTable).values({
      memeId:   meme.id,
      userId:   req.user.id,
      platform,
    });
  } catch (err) {
    // Don't 500 to the client — share-intent logging is best-effort. The
    // share itself already completed (or is about to) on the client. We
    // record the failure server-side for visibility but return 204 so the
    // fire-and-forget client logic stays simple.
    logger.warn({ err, slug, platform, userId: req.user.id }, "share_intent_log_failed");
  }

  res.status(204).end();
});

export default router;
