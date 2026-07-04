/**
 * Eval harness (Slice 2B) — admin routes.
 *
 *   POST /admin/facts/:id/eval-golden                golden-set toggle (active facts)
 *   POST /admin/eval/attempts/:attemptId/eval        rate an EVAL-RUN render
 *   POST /admin/eval/runs                            create + enqueue a controlled run
 *   GET  /admin/eval/runs                            list runs
 *   GET  /admin/eval/runs/:runId                     per-item run status (rule 8)
 *   GET  /admin/eval/attempts/:attemptId/image       stream an eval render's image
 *   GET  /admin/eval/dashboard                       golden-set aggregation + run diff
 *
 * The review-scoped rating route (a MODERATION attempt) lives in routes/reviews.ts;
 * this file owns everything eval-run / golden / dashboard scoped. All routes are
 * requireAdmin.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { db } from "@workspace/db";
import { factsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  evalWriteSchema,
  resolveEvalColumns,
  evalColumnUpdateIsEmpty,
  evalGoldenWriteSchema,
  evalRunCreateSchema,
} from "@workspace/api-zod";
import { requireAdmin } from "./admin";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { startEvalRun, listEvalRuns, getEvalRunStatus } from "../lib/eval/evalRunJobs";
import { buildEvalDashboard } from "../lib/eval/dashboard";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const evalObjectStorage = new ObjectStorageService();

// ─── Golden-set toggle (active facts only) ────────────────────────────────────

router.post("/admin/facts/:id/eval-golden", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = evalGoldenWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }

  const [fact] = await db
    .select({ id: factsTable.id, isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "fact_not_found" }); return; }
  // Only ADDING to the golden set requires an active fact — a fact that went
  // inactive after being marked golden must still be removable (golden:false),
  // otherwise it's stuck in the dashboard until someone edits the DB.
  if (parsed.data.golden && !fact.isActive) {
    res.status(409).json({ error: "fact_inactive", detail: "Only active facts can be added to the golden set." });
    return;
  }

  const reason = parsed.data.reason && parsed.data.reason.trim() ? parsed.data.reason.trim() : null;
  await db
    .update(factsTable)
    .set({ evalGolden: parsed.data.golden, evalGoldenReason: parsed.data.golden ? reason : null })
    .where(eq(factsTable.id, id));
  res.json({ success: true, golden: parsed.data.golden });
});

// ─── Rate an EVAL-RUN render (no review_id) ───────────────────────────────────

router.post("/admin/eval/attempts/:attemptId/eval", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const attemptId = parseInt(String(req.params["attemptId"] ?? ""), 10);
  if (isNaN(attemptId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = evalWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid eval body", details: parsed.error.flatten() }); return; }
  const update = resolveEvalColumns(parsed.data);
  if (evalColumnUpdateIsEmpty(update)) { res.status(400).json({ error: "No eval fields provided (rating, failureTag, or notes)." }); return; }

  const [attempt] = await db
    .select({ id: imagePromptAttemptsTable.id, evalRunId: imagePromptAttemptsTable.evalRunId, reviewId: imagePromptAttemptsTable.reviewId })
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.id, attemptId))
    .limit(1);
  if (!attempt) { res.status(404).json({ error: "attempt_not_found" }); return; }
  // Guard: a PURE eval-run attempt (eval_run_id set, review_id NULL). A
  // moderation attempt is rated via the review-scoped route instead.
  if (attempt.evalRunId == null || attempt.reviewId != null) {
    res.status(409).json({ error: "not_eval_run_attempt", detail: "Rate moderation attempts via /admin/reviews/:id/render-scenarios/:scenarioKey/attempts/:attemptId/eval." });
    return;
  }

  await db
    .update(imagePromptAttemptsTable)
    .set({ ...update, evalBy: req.user.id, evalAt: new Date(), updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.id, attemptId));
  res.json({ success: true });
});

// ─── Eval runs ────────────────────────────────────────────────────────────────

router.post("/admin/eval/runs", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = evalRunCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  const label = parsed.data.label && parsed.data.label.trim() ? parsed.data.label.trim() : null;
  const result = await startEvalRun({ label, adminUserId: req.user.id });
  logger.info({ runId: result.runId, items: result.items.length, adminId: req.user.id }, "[eval] run created");
  res.status(202).json(result);
});

router.get("/admin/eval/runs", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ runs: await listEvalRuns() });
});

router.get("/admin/eval/runs/:runId", requireAdmin, async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params["runId"] ?? ""), 10);
  if (isNaN(runId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const status = await getEvalRunStatus(runId);
  if (!status) { res.status(404).json({ error: "run_not_found" }); return; }
  res.json(status);
});

// ─── Eval render image (eval attempts have no review_id / renderJobId route) ───

router.get("/admin/eval/attempts/:attemptId/image", requireAdmin, async (req: Request, res: Response) => {
  const attemptId = parseInt(String(req.params["attemptId"] ?? ""), 10);
  if (isNaN(attemptId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [attempt] = await db
    .select({ evalRunId: imagePromptAttemptsTable.evalRunId, generatedImageObjectPath: imagePromptAttemptsTable.generatedImageObjectPath })
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.id, attemptId))
    .limit(1);
  if (!attempt || attempt.evalRunId == null) { res.status(404).json({ error: "attempt_not_found" }); return; }
  if (!attempt.generatedImageObjectPath) { res.status(404).json({ error: "image_not_ready" }); return; }

  try {
    const file = await evalObjectStorage.getObjectEntityFile(attempt.generatedImageObjectPath);
    const response = await evalObjectStorage.downloadObject(file, 0);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "cache-control") res.setHeader(key, value);
    });
    res.setHeader("Cache-Control", "private, no-store");
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found" }); return; }
    logger.error({ err, attemptId }, "[eval] render image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────

router.get("/admin/eval/dashboard", requireAdmin, async (_req: Request, res: Response) => {
  res.json(await buildEvalDashboard());
});

export default router;
