/**
 * @purpose Admin routes for the fold and cast fill: the report (which is its dry run), starting a run, and reversing one conversion.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, E. A run spends one utility-model
 * call per version with work, so it starts only on an admin's explicit action.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import { gagFoldReport, revertGagFold, startGagFold } from "../lib/gags/foldJob";

const router: IRouter = Router();

router.get("/admin/gag-fold", requireAdmin, async (_req: Request, res: Response) => {
  res.json(await gagFoldReport());
});

router.post("/admin/gag-fold/run", requireAdmin, async (_req: Request, res: Response) => {
  res.status(202).json(await startGagFold());
});

router.post("/admin/gag-fold/archive/:archiveId/revert", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["archiveId"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const outcome = await revertGagFold(id);
  const status = outcome === "reverted" ? 200 : outcome === "not_found" ? 404 : 409;
  res.status(status).json({ outcome });
});

export default router;
