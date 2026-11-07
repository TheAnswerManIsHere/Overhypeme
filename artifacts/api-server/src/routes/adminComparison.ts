/**
 * Admin routes for the engine comparison (launch Phase 8, increment 2a; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Admin/User UX Impact*).
 *
 *   POST /api/admin/comparison/sets              create a set (panels + expected cells)
 *   GET  /api/admin/comparison/sets              list sets
 *   GET  /api/admin/comparison/sets/:id          a set's status: per cell and aggregate, with its estimate
 *   POST /api/admin/comparison/sets/:id/plan     the next run of a kind, its bound, or the refusal with the figure
 *
 * Planning spends nothing and writes nothing. Running is increment 2b's.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { comparisonRunPlanSchema, comparisonSetCreateSchema } from "@workspace/api-zod";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { requireAdmin } from "./admin";
import {
  ComparisonLayoutError,
  createComparisonSet,
  getComparisonSet,
  listComparisonSets,
  planComparisonRun,
} from "../lib/comparison/sets";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function setIdParam(req: Request): number | null {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

router.post("/admin/comparison/sets", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = comparisonSetCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    const result = await createComparisonSet(parsed.data, req.user.id);
    logger.info({ ...result, adminId: req.user.id }, "[comparison] set created");
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ComparisonLayoutError) { res.status(400).json({ error: "set_refused", reasons: err.reasons }); return; }
    throw err;
  }
});

router.get("/admin/comparison/sets", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ sets: await listComparisonSets() });
});

router.get("/admin/comparison/sets/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = setIdParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const detail = await getComparisonSet(id);
  if (!detail) { res.status(404).json({ error: "set_not_found" }); return; }
  res.json(detail);
});

router.post("/admin/comparison/sets/:id/plan", requireAdmin, async (req: Request, res: Response) => {
  const id = setIdParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = comparisonRunPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  const plan = await planComparisonRun(id, parsed.data);
  if (!plan) { res.status(404).json({ error: "set_not_found" }); return; }
  res.json(plan);
});

export default router;
