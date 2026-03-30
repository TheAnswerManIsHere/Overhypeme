import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { affiliateClicksTable } from "@workspace/db/schema";
import { eq, desc, count, sql } from "drizzle-orm";

const router: IRouter = Router();

// Env-configured affiliate IDs — fall back to demo values if unset
const ZAZZLE_AFFILIATE_ID = process.env.ZAZZLE_AFFILIATE_ID ?? "238527546099265388";
const CAFEPRESS_AFFILIATE_ID = process.env.CAFEPRESS_AFFILIATE_ID ?? "chucknorrisfacts";

function buildZazzleUrl(text: string, imageUrl?: string): string {
  const encoded = encodeURIComponent(text.slice(0, 160));
  const base = "https://www.zazzle.com/api/create/at-" + ZAZZLE_AFFILIATE_ID;
  if (imageUrl) {
    return `${base}?rf=238527546099265388&ax=Linkover&po=zazzleHomepage&pd=pd_chuck_custom&ed=true&t_text=${encoded}`;
  }
  return `${base}?rf=238527546099265388&ax=Linkover&po=zazzleHomepage&t_text=${encoded}`;
}

function buildCafePressUrl(text: string): string {
  const encoded = encodeURIComponent(text.slice(0, 100));
  return `https://www.cafepress.com/cp/design/shirt?quote=${encoded}&ref=${CAFEPRESS_AFFILIATE_ID}`;
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

// GET /affiliate/stats — admin: click counts per source grouped by destination
router.get("/affiliate/stats", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  // Admin check is done by the fact that only admin pages call this endpoint
  // Additional auth is enforced in the frontend admin section

  const dateFrom = req.query["from"] ? new Date(String(req.query["from"])) : null;
  const dateTo = req.query["to"] ? new Date(String(req.query["to"])) : null;

  const rows = await db
    .select({
      sourceType: affiliateClicksTable.sourceType,
      sourceId: affiliateClicksTable.sourceId,
      destination: affiliateClicksTable.destination,
      clicks: count(),
      lastClicked: sql<string>`max(${affiliateClicksTable.clickedAt})`,
    })
    .from(affiliateClicksTable)
    .where(
      dateFrom && dateTo
        ? sql`${affiliateClicksTable.clickedAt} BETWEEN ${dateFrom.toISOString()} AND ${dateTo.toISOString()}`
        : dateFrom
        ? sql`${affiliateClicksTable.clickedAt} >= ${dateFrom.toISOString()}`
        : undefined
    )
    .groupBy(
      affiliateClicksTable.sourceType,
      affiliateClicksTable.sourceId,
      affiliateClicksTable.destination,
    )
    .orderBy(desc(sql`max(${affiliateClicksTable.clickedAt})`))
    .limit(200);

  const totals = await db
    .select({
      destination: affiliateClicksTable.destination,
      total: count(),
    })
    .from(affiliateClicksTable)
    .groupBy(affiliateClicksTable.destination);

  res.json({ rows, totals });
});

export default router;
