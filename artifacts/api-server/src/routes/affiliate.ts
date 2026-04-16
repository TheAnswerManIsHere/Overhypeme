import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { affiliateClicksTable } from "@workspace/db/schema";
import { desc, count, sql } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { buildZazzleUrl } from "../lib/zazzle";

const router: IRouter = Router();

/**
 * GET /affiliate/zazzle-url
 * Admin-only: returns the fully constructed Zazzle URL for a given imageUrl/returnUrl
 * without logging a click. Used for debugging in the UI.
 */
router.get("/affiliate/zazzle-url", async (req: Request, res: Response) => {
  if (!req.isAuthenticated() || !(req.user as { isAdmin?: boolean })?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const imageUrl = typeof req.query["imageUrl"] === "string" ? req.query["imageUrl"] : undefined;
  const returnUrl = typeof req.query["returnUrl"] === "string" ? req.query["returnUrl"] : undefined;
  let imageName: string | undefined;
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      imageName = parsed.pathname.split("/").pop() || undefined;
    } catch {
      imageName = imageUrl.split("/").pop() || undefined;
    }
  }
  const url = await buildZazzleUrl({ imageUrl, imageName, returnUrl });
  res.json({ url });
});

router.post("/affiliate/click", async (req: Request, res: Response) => {
  const {
    sourceType,
    sourceId,
    destination,
    text,
    imageUrl,
    returnUrl,
  } = req.body as {
    sourceType?: "fact" | "meme";
    sourceId?: string | number;
    destination?: "zazzle";
    text?: string;
    imageUrl?: string;
    returnUrl?: string;
  };

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

  try {
    await db.insert(affiliateClicksTable).values({
      userId: req.isAuthenticated() ? req.user.id : null,
      sourceType,
      sourceId: String(sourceId),
      destination,
    });
  } catch {
  }

  let imageName: string | undefined;
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      imageName = parsed.pathname.split("/").pop() || undefined;
    } catch {
      imageName = imageUrl.split("/").pop() || undefined;
    }
  }
  const url = await buildZazzleUrl({
    imageUrl,
    imageName,
    returnUrl: typeof returnUrl === "string" ? returnUrl : undefined,
  });

  res.json({ url });
});

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

router.get("/affiliate/stats", requireAdmin, async (req: Request, res: Response) => {

  let dateFrom: Date | null = null;
  let dateTo: Date | null = null;

  if (req.query["from"]) {
    const d = new Date(String(req.query["from"]));
    if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid 'from' date" }); return; }
    d.setUTCHours(0, 0, 0, 0);
    dateFrom = d;
  }

  if (req.query["to"]) {
    const d = new Date(String(req.query["to"]));
    if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid 'to' date" }); return; }
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
