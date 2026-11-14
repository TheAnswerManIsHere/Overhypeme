/**
 * @purpose The admin routes for a fact's gags: read the Gags panel, add or change a gag, discard a change, run its test renders, approve one of its renders as its example, remove it, and stream its render images.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md (migration 0139). Every route is admin
 * only and validated here; the rules live in lib/gags/gagStore.ts. An action
 * from a review screen names the review (`reviewId`); the Facts editor sends
 * none. While a refresh is open the fact's gags are changed only from its
 * review, and its picks and removals land when it is approved.
 *
 *   GET  /api/admin/facts/:factId/gags                         the panel's view
 *   POST /api/admin/facts/:factId/gags                         add a gag (pending)
 *   PUT  /api/admin/facts/:factId/gags/:gagId                  save a change (pending)
 *   POST /api/admin/facts/:factId/gags/:gagId/discard          drop the pending change
 *   POST /api/admin/facts/:factId/gags/:gagId/renders          run its test renders
 *   POST /api/admin/facts/:factId/gags/:gagId/approve          approve a render as its example
 *   POST /api/admin/facts/:factId/gags/:gagId/remove           remove it
 *   GET  /api/admin/gags/:gagId/renders/:renderJobId/image     a render's image
 */
import { Readable } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, imagePromptAttemptsTable } from "@workspace/db";
import {
  gagApproveBodySchema,
  gagCreateBodySchema,
  gagRendersBodySchema,
  gagSaveBodySchema,
  gagScopeBodySchema,
} from "@workspace/api-zod";
import type { z } from "zod";
import { requireAdmin } from "./admin";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import {
  GagError,
  approveGagRender,
  assertCanRunGagRenders,
  createGag,
  discardGagChange,
  removeGag,
  saveGagContent,
} from "../lib/gags/gagStore";
import { buildFactGagsView } from "../lib/gags/gagView";
import { enqueueGagDefaultBatch, runGagScenarios } from "../lib/reviewRenderScenarios";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const renderObjectStorage = new ObjectStorageService();

function ids(req: Request): { factId: number; gagId: number } | null {
  const factId = Number(req.params["factId"]);
  const gagId = req.params["gagId"] === undefined ? 0 : Number(req.params["gagId"]);
  if (!Number.isInteger(factId) || factId <= 0 || !Number.isInteger(gagId) || gagId < 0) return null;
  return { factId, gagId };
}

function parse<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ") });
    return null;
  }
  return r.data;
}

async function respond(res: Response, factId: number, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    res.json(await buildFactGagsView(factId));
  } catch (err) {
    if (err instanceof GagError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
      return;
    }
    // The database rules (fact_gags checks, the live-fact trigger) are the backstop.
    const code = (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (code === "23514" || code === "23505") {
      res.status(409).json({ error: "That change would break a gag rule.", code: "GAG_RULE" });
      return;
    }
    throw err;
  }
}

router.get("/admin/facts/:factId/gags", requireAdmin, async (req: Request, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const view = await buildFactGagsView(p.factId);
  if (!view) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json(view);
});

router.post("/admin/facts/:factId/gags", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagCreateBodySchema, req, res);
  if (!body) return;
  await respond(res, p.factId, () => createGag(p.factId, body.content, { adminId: req.user.id, reviewId: body.reviewId ?? null }, body.slot));
});

router.put("/admin/facts/:factId/gags/:gagId", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagSaveBodySchema, req, res);
  if (!body) return;
  await respond(res, p.factId, () => saveGagContent(p.factId, p.gagId, body.content, { adminId: req.user.id, reviewId: body.reviewId ?? null }));
});

router.post("/admin/facts/:factId/gags/:gagId/discard", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagScopeBodySchema, req, res);
  if (!body) return;
  await respond(res, p.factId, () => discardGagChange(p.factId, p.gagId, { adminId: req.user.id, reviewId: body.reviewId ?? null }));
});

router.post("/admin/facts/:factId/gags/:gagId/remove", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagScopeBodySchema, req, res);
  if (!body) return;
  await respond(res, p.factId, () => removeGag(p.factId, p.gagId, { adminId: req.user.id, reviewId: body.reviewId ?? null }));
});

router.post("/admin/facts/:factId/gags/:gagId/approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagApproveBodySchema, req, res);
  if (!body) return;
  await respond(res, p.factId, () => approveGagRender(p.factId, p.gagId, body.attemptId, { adminId: req.user.id, reviewId: body.reviewId ?? null }));
});

// Run a gag's test renders: the default batch, or the named scenarios again.
// Spends money, so only ever on this explicit request.
router.post("/admin/facts/:factId/gags/:gagId/renders", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagRendersBodySchema, req, res);
  if (!body) return;
  await respond(res, p.factId, async () => {
    await assertCanRunGagRenders(p.factId, p.gagId, { adminId: req.user.id, reviewId: body.reviewId ?? null });
    const result = body.scenarios
      ? await runGagScenarios(p.gagId, body.scenarios, req.user.id)
      : await enqueueGagDefaultBatch(p.gagId, { force: true, adminUserId: req.user.id });
    if ("error" in result) throw new GagError("REVIEW_NOT_EDITABLE", `The renders could not start: ${result.error}.`);
  });
});

// Stream a gag render's image to admins. Moderation render objects carry no ACL
// and are never mirrored, so admins read them here, authorized by requireAdmin
// and the attempt belonging to this gag.
router.get("/admin/gags/:gagId/renders/:renderJobId/image", requireAdmin, async (req: Request, res: Response) => {
  const gagId = Number(req.params["gagId"]);
  const renderJobId = String(req.params["renderJobId"] ?? "");
  if (!Number.isInteger(gagId) || gagId <= 0 || !renderJobId) { res.status(400).json({ error: "Invalid id" }); return; }
  const [attempt] = await db
    .select({ path: imagePromptAttemptsTable.generatedImageObjectPath })
    .from(imagePromptAttemptsTable)
    .where(and(eq(imagePromptAttemptsTable.renderJobId, renderJobId), eq(imagePromptAttemptsTable.gagId, gagId)))
    .limit(1);
  if (!attempt) { res.status(404).json({ error: "render_not_found" }); return; }
  if (!attempt.path) { res.status(404).json({ error: "image_not_ready" }); return; }
  try {
    const file = await renderObjectStorage.getObjectEntityFile(attempt.path);
    const response = await renderObjectStorage.downloadObject(file, 0);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "cache-control") res.setHeader(key, value);
    });
    res.setHeader("Cache-Control", "private, no-store");
    if (response.body) Readable.fromWeb(response.body as never).pipe(res);
    else res.end();
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found" }); return; }
    logger.error({ err, gagId, renderJobId }, "[gags] render image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

export default router;
