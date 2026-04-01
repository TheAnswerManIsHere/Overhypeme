import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { affiliateClicksTable } from "@workspace/db/schema";
import { desc, count, sql } from "drizzle-orm";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

// Env-configured affiliate IDs — fall back to demo/test values if unset
const ZAZZLE_AFFILIATE_ID = process.env.ZAZZLE_AFFILIATE_ID ?? "238527546099265388";

// Warn in production if affiliate IDs are not configured
if (process.env.NODE_ENV === "production") {
  if (!process.env.ZAZZLE_AFFILIATE_ID) {
    console.warn("[affiliate] ZAZZLE_AFFILIATE_ID is not set — using demo affiliate ID. Set this env var to receive real commissions.");
  }
}

function buildZazzleUrl(text: string, imageUrl?: string): string {
  const base = `https://www.zazzle.com/api/create/at-${ZAZZLE_AFFILIATE_ID}`;
  const params = new URLSearchParams({
    rf: ZAZZLE_AFFILIATE_ID,
    ax: "Linkover",
    po: "zazzleHomepage",
    t_text: text.slice(0, 160),
  });
  if (imageUrl) {
    params.set("pd", "pd_chuck_custom");
    params.set("ed", "true");
    params.set("t_imageURL", imageUrl);
  }
  return `${base}?${params}`;
}

// POST /affiliate/click — log a click and return the destination URL
router.post("/affiliate/click", async (req: Request, res: Response) => {
  const {
    sourceType,
    sourceId,
    destination,
    text,
    imageUrl,
  } = req.body as {
    sourceType?: "fact" | "meme";
    sourceId?: string | number;
    destination?: "zazzle";
    text?: string;
    imageUrl?: string;
  };

  // Strict type checks before any string operations — prevents 500s on malformed payloads
  if (!sourceType || !sourceId || !destination || !text) {
    res.status(400).json({ error: "sourceType, sourceId, destination, and text are required" });
    return;
  }

  if (typeof text !== "string") {
    res.status(400).json({ error: "text must be a string" });
    return;
  }

  if (typeof sourceId !== "string" && typeof sourceId !== "number") {
    res.status(400).json({ error: "sourceId must be a string or number" });
    return;
  }

  if (imageUrl !== undefined && typeof imageUrl !== "string") {
    res.status(400).json({ error: "imageUrl must be a string" });
    return;
  }

  if (!["fact", "meme"].includes(sourceType)) {
    res.status(400).json({ error: "sourceType must be 'fact' or 'meme'" });
    return;
  }

  if (destination !== "zazzle") {
    res.status(400).json({ error: "destination must be 'zazzle'" });
    return;
  }

  // Server-side length bounds to prevent abuse/noise
  if (text.length > 1000) {
    res.status(400).json({ error: "text must be 1000 characters or fewer" });
    return;
  }

  if (imageUrl && imageUrl.length > 2048) {
    res.status(400).json({ error: "imageUrl must be 2048 characters or fewer" });
    return;
  }

  if (String(sourceId).length > 255) {
    res.status(400).json({ error: "sourceId must be 255 characters or fewer" });
    return;
  }

  // Log the click (fire and forget errors — we don't want a DB error to break the redirect)
  try {
    await db.insert(affiliateClicksTable).values({
      userId: req.isAuthenticated() ? req.user.id : null,
      sourceType,
      sourceId: String(sourceId),
      destination,
    });
  } catch {
    // Non-fatal — still redirect
  }

  const url = buildZazzleUrl(text, imageUrl);

  res.json({ url });
});

// Build a date range WHERE clause for affiliate_clicks.clicked_at
function dateRangeWhere(dateFrom: Date | null, dateTo: Date | null) {
  if (dateFrom && dateTo) {
    return sql`${affiliateClicksTable.clickedAt} BETWEEN ${dateFrom.toISOString()} AND ${dateTo.toISOString()}`;
  }
  if (dateFrom) {
    return sql`${affiliateClicksTable.clickedAt} >= ${dateFrom.toISOString()}`;
  }
  if (dateTo) {
    return sql`${affiliateClicksTable.clickedAt} <= ${dateTo.toISOString()}`;
  }
  return undefined;
}

// GET /affiliate/stats — admin only: click counts per source grouped by destination
router.get("/affiliate/stats", requireAdmin, async (req: Request, res: Response) => {

  let dateFrom: Date | null = null;
  let dateTo: Date | null = null;

  if (req.query["from"]) {
    const d = new Date(String(req.query["from"]));
    if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid 'from' date" }); return; }
    // Start of the given day in UTC
    d.setUTCHours(0, 0, 0, 0);
    dateFrom = d;
  }

  if (req.query["to"]) {
    const d = new Date(String(req.query["to"]));
    if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid 'to' date" }); return; }
    // End of the given day in UTC (inclusive)
    d.setUTCHours(23, 59, 59, 999);
    dateTo = d;
  }

  const whereClause = dateRangeWhere(dateFrom, dateTo);

  const [rows, totals] = await Promise.all([
    db
      .select({
        sourceType: affiliateClicksTable.sourceType,
        sourceId: affiliateClicksTable.sourceId,
        destination: affiliateClicksTable.destination,
        clicks: count(),
        lastClicked: sql<string>`max(${affiliateClicksTable.clickedAt})`,
      })
      .from(affiliateClicksTable)
      .where(whereClause)
      .groupBy(
        affiliateClicksTable.sourceType,
        affiliateClicksTable.sourceId,
        affiliateClicksTable.destination,
      )
      .orderBy(desc(sql`max(${affiliateClicksTable.clickedAt})`))
      .limit(200),

    db
      .select({
        destination: affiliateClicksTable.destination,
        total: count(),
      })
      .from(affiliateClicksTable)
      .where(whereClause)
      .groupBy(affiliateClicksTable.destination),
  ]);

  res.json({ rows, totals });
});

export default router;
