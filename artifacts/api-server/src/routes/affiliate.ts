import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { affiliateClicksTable } from "@workspace/db/schema";
import { desc, count, sql } from "drizzle-orm";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

// Env-configured affiliate IDs — fall back to demo values if unset
const ZAZZLE_AFFILIATE_ID = process.env.ZAZZLE_AFFILIATE_ID ?? "238527546099265388";
const CAFEPRESS_AFFILIATE_ID = process.env.CAFEPRESS_AFFILIATE_ID ?? "chucknorrisfacts";

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

function buildCafePressUrl(text: string): string {
  const params = new URLSearchParams({
    quote: text.slice(0, 100),
    ref: CAFEPRESS_AFFILIATE_ID,
  });
  return `https://www.cafepress.com/cp/design/shirt?${params}`;
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
    destination?: "zazzle" | "cafepress";
    text?: string;
    imageUrl?: string;
  };

  if (!sourceType || !sourceId || !destination || !text) {
    res.status(400).json({ error: "sourceType, sourceId, destination, and text are required" });
    return;
  }

  if (!["fact", "meme"].includes(sourceType)) {
    res.status(400).json({ error: "sourceType must be 'fact' or 'meme'" });
    return;
  }

  if (!["zazzle", "cafepress"].includes(destination)) {
    res.status(400).json({ error: "destination must be 'zazzle' or 'cafepress'" });
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

  const url =
    destination === "zazzle"
      ? buildZazzleUrl(text, imageUrl)
      : buildCafePressUrl(text);

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
