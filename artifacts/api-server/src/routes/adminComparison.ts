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
 *   GET  /api/admin/comparison/sets/:id/judging   the blind view: panels, images by opaque token, saved scores (increment 3)
 *   GET  /api/admin/comparison/panels/:id/images/:token   one blind image, with nothing that names its engine
 *   POST /api/admin/comparison/panels/:id/pick    record or replace David's 1-to-5 scores and face marks for a panel
 *   GET  /api/admin/comparison/results?setIds=1,2 the engines revealed: average scores per mode, style and scenario, face marks, costs
 *
 * Planning spends nothing and writes nothing; a run is the one action that spends.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { comparisonPickSchema, comparisonResultsQuerySchema, comparisonRunPlanSchema, comparisonSetCreateSchema } from "@workspace/api-zod";
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
  startComparisonRun,
} from "../lib/comparison/runs";
import { refreshBilledCosts } from "../lib/comparison/billedCost";
import { blindImagePath, ComparisonPickRefused, getBlindSet, getComparisonResults, recordPick } from "../lib/comparison/judging";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

type BlindImageStorage = Pick<ObjectStorageService, "getObjectEntityFile" | "downloadObject">;
const liveBlindImageStorage = new ObjectStorageService();
let blindImageStorage: BlindImageStorage = liveBlindImageStorage;
/** Test seam: serve blind images from a fake store. */
export function __setBlindImageStorageForTest(impl: BlindImageStorage | null): void {
  blindImageStorage = impl ?? liveBlindImageStorage;
}

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

// ─── Blind judging and results (increment 3) ─────────────────────────────────

router.get("/admin/comparison/sets/:id/judging", requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const blind = await getBlindSet(id);
  if (!blind) { res.status(404).json({ error: "set_not_found" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(blind);
});

router.get("/admin/comparison/panels/:id/images/:token", requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  const token = String(req.params["token"] ?? "");
  if (!id || !/^[0-9a-f]{16}$/.test(token)) { res.status(400).json({ error: "Invalid id" }); return; }
  const path = await blindImagePath(id, token);
  if (!path) { res.status(404).json({ error: "image_not_found" }); return; }
  try {
    const response = await blindImageStorage.downloadObject(await blindImageStorage.getObjectEntityFile(path), 0);
    // Only what a browser needs to draw it: no storage header can name the engine.
    res.status(response.status);
    const type = response.headers.get("content-type");
    const length = response.headers.get("content-length");
    if (type) res.setHeader("Content-Type", type);
    if (length) res.setHeader("Content-Length", length);
    // A cell's stored image never changes once it has one, so its token's URL can be cached.
    res.setHeader("Cache-Control", "private, max-age=3600");
    // Awaited, so a storage error mid-body lands in the catch below and ends
    // only this response, never the process.
    if (response.body) await pipeline(Readable.fromWeb(response.body as never), res);
    else res.end();
  } catch (err) {
    if (res.headersSent) {
      logger.warn({ err, panelId: id }, "[comparison] blind image stream failed mid-body");
      res.destroy();
      return;
    }
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found" }); return; }
    logger.error({ err, panelId: id }, "[comparison] blind image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

router.post("/admin/comparison/panels/:id/pick", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = comparisonPickSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    res.json({ pick: await recordPick(id, parsed.data, req.user.id) });
  } catch (err) {
    if (err instanceof ComparisonPickRefused) { res.status(409).json({ error: "pick_refused", refusal: err.message }); return; }
    throw err;
  }
});

router.get("/admin/comparison/results", requireAdmin, async (req: Request, res: Response) => {
  const parsed = comparisonResultsQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() }); return; }
  // fal records a bill a little after a picture comes back, so missing ones are read here.
  await refreshBilledCosts(parsed.data.setIds);
  const results = await getComparisonResults(parsed.data.setIds);
  if (!results) { res.status(404).json({ error: "set_not_found" }); return; }
  res.json(results);
});

export default router;
