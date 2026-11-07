/**
 * Admin routes for the engine comparison (launch Phase 8, increment 2a; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Admin/User UX Impact*).
 *
 *   POST /api/admin/comparison/sets              create a set (panels + expected cells)
 *   GET  /api/admin/comparison/sets              list sets
 *   GET  /api/admin/comparison/sets/:id          a set's status: per cell and aggregate, with its estimate
 *   POST /api/admin/comparison/sets/:id/plan     the next run of a kind, its bound, or the refusal with the figure
 *   POST /api/admin/comparison/sets/:id/runs     admit and start that run (increment 2b) — the one route that spends
 *   POST /api/admin/comparison/cells/:id/retry-storage   store a failed cell's vendor image again (spends nothing)
 *   POST /api/admin/comparison/cells/:id/rerun   a failed cell's one re-run: back to expected, admitted by the next run
 *   POST /api/admin/comparison/panels/:id/reprepare   a failed panel back to pending, admitted by the next preparation run
 *   POST /api/admin/comparison/sets/:id/settle-bills  read fal's bills for the set's completed calls (spends nothing)
 *
 * Planning spends nothing and writes nothing; a run spends only what admission reserved.
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
import {
  ComparisonCellActionRefused,
  ComparisonRunRefused,
  reprepareFailedPanel,
  rerunCell,
  retryCellStorage,
  settlePendingBills,
  startComparisonRun,
} from "../lib/comparison/runs";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** A refusal (an unusable family, an unpriceable planner) is the admin's to read, with its reasons. */
function sendRefusal(res: Response, err: unknown): void {
  if (err instanceof ComparisonLayoutError) { res.status(400).json({ error: "set_refused", reasons: err.reasons }); return; }
  throw err;
}

function idParam(req: Request): number | null {
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
    sendRefusal(res, err);
  }
});

router.get("/admin/comparison/sets", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ sets: await listComparisonSets() });
});

router.get("/admin/comparison/sets/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const detail = await getComparisonSet(id);
  if (!detail) { res.status(404).json({ error: "set_not_found" }); return; }
  res.json(detail);
});

router.post("/admin/comparison/sets/:id/plan", requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = comparisonRunPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    const plan = await planComparisonRun(id, parsed.data);
    if (!plan) { res.status(404).json({ error: "set_not_found" }); return; }
    res.json(plan);
  } catch (err) {
    sendRefusal(res, err);
  }
});

router.post("/admin/comparison/sets/:id/runs", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = comparisonRunPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    const started = await startComparisonRun(id, parsed.data, req.user.id);
    if (!started) { res.status(404).json({ error: "set_not_found" }); return; }
    logger.info({ setId: id, runId: started.run.id, adminId: req.user.id }, "[comparison] run started");
    res.status(202).json(started);
  } catch (err) {
    if (err instanceof ComparisonRunRefused) { res.status(409).json({ error: "run_refused", refusal: err.refusal, run: err.run, plan: err.plan }); return; }
    sendRefusal(res, err);
  }
});

router.post("/admin/comparison/sets/:id/settle-bills", requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  res.json(await settlePendingBills(id));
});

for (const [path, key, action] of [
  ["cells/:id/retry-storage", "cell", retryCellStorage],
  ["cells/:id/rerun", "cell", rerunCell],
  ["panels/:id/reprepare", "panel", reprepareFailedPanel],
] as const) {
  router.post(`/admin/comparison/${path}`, requireAdmin, async (req: Request, res: Response) => {
    const id = idParam(req);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    try {
      res.json({ [key]: await action(id) });
    } catch (err) {
      if (err instanceof ComparisonCellActionRefused) { res.status(409).json({ error: "cell_action_refused", refusal: err.message }); return; }
      throw err;
    }
  });
}

export default router;
