import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { hashtagsTable } from "@workspace/db/schema";
import { desc, ilike } from "drizzle-orm";
import { ListHashtagsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/hashtags", async (req: Request, res: Response) => {
  const parsed = ListHashtagsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const search = parsed.success ? parsed.data.search : undefined;

  let query = db.select().from(hashtagsTable).$dynamic();
  if (search) {
    query = query.where(ilike(hashtagsTable.name, `%${search}%`));
  }
  const hashtags = await query.orderBy(desc(hashtagsTable.factCount)).limit(limit);
  res.json({ hashtags: hashtags.map((h) => ({ id: h.id, name: h.name, factCount: h.factCount })) });
});

export default router;
