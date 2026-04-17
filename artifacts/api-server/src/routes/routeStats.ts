import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { routeStatsTable } from "@workspace/db/schema";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";

const router: IRouter = Router();

const VALID_ROUTE_KEYS = new Set([
  "home", "search", "facts", "submit", "profile",
  "activity", "meme", "video", "pricing",
]);

const PostRouteStatBody = z.object({
  route: z.string(),
});

router.get("/route-stats", async (req, res) => {
  try {
    const n = Math.min(Number(req.query.n) || 3, 10);
    const rows = await db
      .select({ routeKey: routeStatsTable.routeKey })
      .from(routeStatsTable)
      .orderBy(desc(routeStatsTable.visitCount))
      .limit(n);
    res.json({ routes: rows.map((r) => r.routeKey) });
  } catch (err) {
    req.log.warn({ err }, "route-stats: GET failed, returning empty list");
    res.json({ routes: [] });
  }
});

router.post("/route-stats", async (req, res) => {
  const parsed = PostRouteStatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const { route } = parsed.data;
  if (!VALID_ROUTE_KEYS.has(route)) {
    res.status(400).json({ error: "Unknown route key" });
    return;
  }
  try {
    await db
      .insert(routeStatsTable)
      .values({ routeKey: route, visitCount: 1 })
      .onConflictDoUpdate({
        target: routeStatsTable.routeKey,
        set: {
          visitCount: sql`${routeStatsTable.visitCount} + 1`,
          updatedAt: sql`now()`,
        },
      });
  } catch {
    // Best-effort — never let a counting failure surface as an error
  }
  res.status(204).end();
});

export default router;
