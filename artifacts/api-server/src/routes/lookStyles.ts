import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { lookStylesTable } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";

/**
 * Look-styles catalogue. Read by the admin image bench (`/admin/engines`) and
 * the runtime prompt preview. It lived in the video route file until video was
 * cut (launch Phase 4, removal 2); the catalogue itself is the image flow's.
 */

const router: IRouter = Router();

/**
 * Public look-styles catalog. Strips the prompt suffixes which are server-only.
 */
router.get("/look-styles", async (_req, res) => {
  const styles = await db
    .select({
      id: lookStylesTable.id,
      label: lookStylesTable.label,
      description: lookStylesTable.description,
      previewImagePath: lookStylesTable.previewImagePath,
      sortOrder: lookStylesTable.sortOrder,
    })
    .from(lookStylesTable)
    .where(eq(lookStylesTable.isActive, true))
    .orderBy(asc(lookStylesTable.sortOrder), asc(lookStylesTable.id));
  res.json(styles);
});

export default router;
