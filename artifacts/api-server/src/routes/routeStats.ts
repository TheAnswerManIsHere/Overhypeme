import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { routeStatsTable, routeStatEventsTable } from "@workspace/db/schema";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";

const router: IRouter = Router();

const VALID_ROUTE_KEYS = new Set([
  "home", "search", "facts", "submit", "profile",
  "onboard", "activity", "meme", "video", "pricing", "login",
]);

const PostRouteStatBody = z.union([
  z.object({ route: z.string() }),
  z.object({ counts: z.record(z.string(), z.unknown()) }),
]);

router.get("/route-stats", async (req, res) => {
  try {
    const n = Math.min(Number(req.query.n) || 3, 10);
    const rows = await db
      .select({
        routeKey: routeStatsTable.routeKey,
        visitCount: routeStatsTable.visitCount,
      })
      .from(routeStatsTable)
      .orderBy(desc(routeStatsTable.visitCount))
      .limit(n);
    res.json({
      routes: rows.map((r) => r.routeKey),
      stats: rows,
    });
  } catch (err) {
    req.log.warn({ err }, "route-stats: GET failed, returning empty list");
    res.json({ routes: [], stats: [] });
  }
});

router.post("/route-stats", async (req, res) => {
  const parsed = PostRouteStatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  // Normalize both accepted payload shapes into { routeKey, delta } entries:
  //   { route: "home" }                  — single visit increment
  //   { counts: { home: 3, search: 1 } } — session flush of accumulated counts
  const entries: { routeKey: string; delta: number }[] = [];
  if ("route" in parsed.data) {
    const { route } = parsed.data;
    if (!VALID_ROUTE_KEYS.has(route)) {
      res.status(400).json({ error: "Unknown route key" });
      return;
    }
    entries.push({ routeKey: route, delta: 1 });
  } else {
    for (const [key, val] of Object.entries(parsed.data.counts)) {
      if (!VALID_ROUTE_KEYS.has(key)) continue;
      const delta = typeof val === "number" ? Math.floor(val) : parseInt(String(val), 10);
      if (isNaN(delta) || delta <= 0 || delta > 100_000) continue;
      entries.push({ routeKey: key, delta });
    }
    if (entries.length === 0) {
      res.json({ accepted: 0 });
      return;
    }
  }

  try {
    await Promise.all(
      entries.map(({ routeKey, delta }) =>
        db
          .insert(routeStatsTable)
          .values({ routeKey, visitCount: delta })
          .onConflictDoUpdate({
            target: routeStatsTable.routeKey,
            set: {
              visitCount: sql`${routeStatsTable.visitCount} + ${delta}`,
              updatedAt: sql`now()`,
            },
          }),
      ),
    );
    await db.insert(routeStatEventsTable).values(
      entries.map(({ routeKey, delta }) => ({ routeKey, delta })),
    );
  } catch {
    // Best-effort — never let a counting failure surface as an error
  }
  // Contract: single-visit `{route}` posts respond 204 (fire-and-forget);
  // session-flush `{counts}` posts respond with how many keys were accepted.
  if ("route" in parsed.data) {
    res.status(204).end();
  } else {
    res.json({ accepted: entries.length });
  }
});

export default router;
