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
 *   POST /api/admin/comparison/panels/:id/pick    record or replace a panel's judgement: a first-edition set's 1-to-5 scores and marks, or a second-edition set's five category scores, pick and broken marks
 *   GET  /api/admin/comparison/results?setIds=1,2 the engines revealed: average scores per mode, style and scenario, face marks, costs
 *
 * Planning spends nothing and writes nothing; a run is the one action that spends.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { comparisonJudgementSchema, comparisonPickSchema, comparisonResultsQuerySchema, comparisonRunPlanSchema, comparisonSetCreateSchema, evaluationCreateSchema, evaluationSelectionSchema } from "@workspace/api-zod";
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
import {
  EvaluationRefused,
  createEvaluation,
  estimateEvaluation,
  finishEvaluation,
  listEvaluations,
  resumeEvaluation,
  searchEligibleFacts,
  startRetry,
} from "../lib/comparison/evaluations";
import { db } from "@workspace/db";
import { comparisonCellsTable, comparisonPanelsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { blindImagePath, ComparisonPickRefused, editionOfSets, getBlindSet, getComparisonResults, getJudgedResults, recordJudgement, recordPick } from "../lib/comparison/judging";
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
  router.post(`/admin/comparison/${path}`, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const id = idParam(req);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    try {
      const after = await action(id);
      // A paid retry starts its work at once (plan PLAN_EVAL_PAGE.md, C):
      // Retry scene prepares the panel and then draws its pictures, Retry
      // picture draws the cell's one rerun. Retry storage spends nothing and
      // has nothing to start. The reset is already committed, so a start that
      // fails is reported in words, and the list's Resume action picks it up.
      let startError: string | null = null;
      if (action !== retryCellStorage) {
        try {
          await startRetry(await setIdOf(key, id), key === "panel" ? { panelId: id } : { cellId: id }, req.user.id);
        } catch (err) {
          startError = err instanceof ComparisonRunRefused ? err.refusal : err instanceof ComparisonLayoutError ? err.reasons.join("; ") : "it could not be started; use Resume generation";
          logger.warn({ err, key, id }, "[comparison] retry reset, start failed");
        }
      }
      res.json({ [key]: after, startError });
    } catch (err) {
      if (err instanceof ComparisonCellActionRefused) { res.status(409).json({ error: "cell_action_refused", refusal: err.message }); return; }
      throw err;
    }
  });
}

/** The set a panel or cell belongs to. */
async function setIdOf(key: "cell" | "panel", id: number): Promise<number> {
  if (key === "panel") {
    const [p] = await db.select({ setId: comparisonPanelsTable.setId }).from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, id));
    return p!.setId;
  }
  const [c] = await db.select({ setId: comparisonPanelsTable.setId }).from(comparisonCellsTable)
    .innerJoin(comparisonPanelsTable, eq(comparisonPanelsTable.id, comparisonCellsTable.panelId)).where(eq(comparisonCellsTable.id, id));
  return c!.setId;
}

// ─── The Eval page's evaluations (plan PLAN_EVAL_PAGE.md) ────────────────────

function sendEvaluationRefusal(res: Response, err: unknown): void {
  if (err instanceof EvaluationRefused) { res.status(409).json({ error: "evaluation_refused", refusal: err.refusal, reasons: err.reasons }); return; }
  if (err instanceof ComparisonLayoutError) { res.status(400).json({ error: "evaluation_refused", refusal: "the selection cannot be drawn", reasons: err.reasons }); return; }
  if (err instanceof ComparisonRunRefused) { res.status(409).json({ error: "evaluation_refused", refusal: err.refusal, reasons: [] }); return; }
  throw err;
}

router.get("/admin/comparison/eligible-facts", requireAdmin, async (req: Request, res: Response) => {
  const q = typeof req.query["q"] === "string" ? req.query["q"].slice(0, 200) : "";
  res.json(await searchEligibleFacts(q));
});

router.post("/admin/comparison/evaluations/estimate", requireAdmin, async (req: Request, res: Response) => {
  const parsed = evaluationSelectionSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    res.json(await estimateEvaluation(parsed.data));
  } catch (err) {
    sendEvaluationRefusal(res, err);
  }
});

router.post("/admin/comparison/evaluations", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = evaluationCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    const out = await createEvaluation(parsed.data, req.user.id);
    logger.info({ setId: out.setId, created: out.created, adminId: req.user.id }, "[comparison] evaluation generated");
    res.status(out.created ? 201 : 200).json(out);
  } catch (err) {
    sendEvaluationRefusal(res, err);
  }
});

router.get("/admin/comparison/evaluations", requireAdmin, async (req: Request, res: Response) => {
  const kind = req.query["kind"] === "prompt" ? "prompt" : "engine";
  res.json({ evaluations: await listEvaluations(kind) });
});

router.post("/admin/comparison/evaluations/:id/resume", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    res.json(await resumeEvaluation(id, req.user.id));
  } catch (err) {
    sendEvaluationRefusal(res, err);
  }
});

router.post("/admin/comparison/evaluations/:id/finish", requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    res.json({ progress: await finishEvaluation(id) });
  } catch (err) {
    sendEvaluationRefusal(res, err);
  }
});

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
  try {
    // The body's shape says which edition it judges; the server checks it is the set's.
    if (req.body && typeof req.body === "object" && "scores" in req.body) {
      const parsed = comparisonJudgementSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
      res.json({ judgement: await recordJudgement(id, parsed.data, req.user.id) });
      return;
    }
    const parsed = comparisonPickSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
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
  const edition = await editionOfSets(parsed.data.setIds);
  if (edition === null) { res.status(404).json({ error: "set_not_found" }); return; }
  // Scores from the two judging editions mean different things, so they are never averaged together.
  if (edition === "mixed") {
    res.status(409).json({ error: "mixed_editions", refusal: "these sets were judged in different ways; read the older and the newer sets separately" });
    return;
  }
  await refreshBilledCosts(parsed.data.setIds);
  const results = edition === 2 ? await getJudgedResults(parsed.data.setIds) : await getComparisonResults(parsed.data.setIds);
  if (!results) { res.status(404).json({ error: "set_not_found" }); return; }
  res.json(results);
});

export default router;
