/**
 * @purpose The admin routes for a fact's gags: read the Gags panel, add or change a gag in the draft, run its test renders, approve one of its renders as its example, remove it, and stream its render images.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md (migration 0139) and
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md (1F). Every route is admin only
 * and validated here; the rules live in lib/gags/gagStore.ts. Every write
 * changes the fact's draft set and comes from a review screen, which names
 * its review (`reviewId`). A live fact's gags cannot be changed between
 * Phase 1 and Phase 3 (plan, 1F): its old Facts-page editing is removed, and
 * its replacement is the fact sheet.
 *
 *   GET  /api/admin/facts/:factId/gags                         the panel's view
 *   POST /api/admin/facts/:factId/gags                         add a gag (draft)
 *   POST /api/admin/facts/:factId/gags/cast                    read a draft's cast
 *   PUT  /api/admin/facts/:factId/gags/:gagId                  save a change (draft)
 *   POST /api/admin/facts/:factId/gags/:gagId/renders          run its test renders
 *   POST /api/admin/facts/:factId/gags/:gagId/approve          approve a render as its draft example
 *   POST /api/admin/facts/:factId/gags/:gagId/remove           remove it from the draft
 *   GET  /api/admin/facts/:factId/gags/:gagId/render-history   its renders, newest first, 50 a page
 *   GET  /api/admin/facts/:factId/render-history/removed-gags  removed gags that still have renders
 *   POST /api/admin/facts/:factId/gags/:gagId/renders/:attemptId/delete  delete an old render for good
 *   GET  /api/admin/gags/:gagId/renders/:renderJobId/image     a render's image
 */
import { sendStorageBody } from "../lib/sendStorageBody";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, factGagsTable, imagePromptAttemptsTable } from "@workspace/db";
import {
  gagApproveBodySchema,
  gagRenderDeleteBodySchema,
  type GagRenderDeleteResult,
  gagCastBodySchema,
  gagCreateBodySchema,
  gagRendersBodySchema,
  gagSaveBodySchema,
  gagScopeBodySchema,
  gagDescriptionBodySchema,
} from "@workspace/api-zod";
import type { z } from "zod";
import { requireAdmin } from "./admin";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { recordAdminAction } from "../lib/adminActions";
import {
  GagError,
  approveGagRender,
  assertCanRunGagRenders,
  createGag,
  deleteGagRender,
  removeGag,
  saveGagContent,
} from "../lib/gags/gagStore";
import { buildFactGagsView } from "../lib/gags/gagView";
import { DescriptionError, draftDescriptionsSoon, saveReviewedDescription } from "../lib/gags/descriptions";
import { gagRenderHistory, removedGagHistories } from "../lib/gags/renderHistory";
import { cleanUpQueuedFiles } from "../lib/storedFileDeletions";
import { GAG_MODERATION_RENDER } from "../lib/imagePromptAttempts";
import { CastPreparationError, prepareDraftCast } from "../lib/gags/castPreparation";
import { createRateLimiter } from "../lib/rateLimit";
import { drawGagKinds } from "../lib/reviewRenderScenarios";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();
// One model call per request, on a moderator's draft; the same ceiling as the tokenize route's.
const requireCastRateLimit = createRateLimiter("gag-cast");
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
  const reviewId = body.reviewId ?? null;
  await respond(res, p.factId, async () => {
    const gag = await createGag(p.factId, body.content, { adminId: req.user.id, reviewId }, body.slot);
    // Draws nothing: every render is asked for (Issue #1282).
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_create", { gagId: gag.id, content: body.content });
    draftDescriptionsSoon([gag.id]);
  });
});

// Read who is in a draft's scene (plan PLAN_GAG_DIRECT_RENDER.md, F). Stores
// nothing: the editor shows the cast and the save carries it. One utility-model
// call, on the moderator's action only.
router.post("/admin/facts/:factId/gags/cast", requireAdmin, requireCastRateLimit, async (req: Request, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagCastBodySchema, req, res);
  if (!body) return;
  try {
    res.json(await prepareDraftCast(p.factId, body));
  } catch (err) {
    if (err instanceof CastPreparationError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

router.put("/admin/facts/:factId/gags/:gagId", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagSaveBodySchema, req, res);
  if (!body) return;
  const reviewId = body.reviewId ?? null;
  await respond(res, p.factId, async () => {
    await saveGagContent(p.factId, p.gagId, body.content, { adminId: req.user.id, reviewId });
    draftDescriptionsSoon([p.gagId]);
    // Stores the gag and draws nothing (Issue #1282); a changed content leaves
    // the gag's earlier renders unusable for it (saveGagContent, approval, go-live).
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_save", { gagId: p.gagId, content: body.content });
  });
});

/**
 * A moderator writes, edits or approves a gag's one-line description for the
 * version they are looking at (plan PLAN_PHASE7_AI_PICTURE_FLOW.md). Saving
 * it reviews it: a description of the published content shows to members at
 * once and publishes nothing else (Q15: 1); one of the draft content waits for
 * the fact's publish.
 */
router.put("/admin/facts/:factId/gags/:gagId/description", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagDescriptionBodySchema, req, res);
  if (!body) return;
  const [gag] = await db.select({ factId: factGagsTable.factId }).from(factGagsTable).where(eq(factGagsTable.id, p.gagId)).limit(1);
  if (!gag || gag.factId !== p.factId) { res.status(404).json({ error: "That gag no longer exists.", code: "GAG_NOT_FOUND" }); return; }
  try {
    const saved = await saveReviewedDescription(p.gagId, body.contentFingerprint, body.text, req.user.id);
    await recordAdminAction({ factId: p.factId, reviewId: body.reviewId ?? null }, req.user.id, "gag_description_review", { gagId: p.gagId, text: saved.text });
  } catch (err) {
    if (err instanceof DescriptionError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
  res.json(await buildFactGagsView(p.factId));
});

router.post("/admin/facts/:factId/gags/:gagId/remove", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagScopeBodySchema, req, res);
  if (!body) return;
  const reviewId = body.reviewId ?? null;
  await respond(res, p.factId, async () => {
    await removeGag(p.factId, p.gagId, { adminId: req.user.id, reviewId });
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_remove", { gagId: p.gagId });
  });
});

router.post("/admin/facts/:factId/gags/:gagId/approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagApproveBodySchema, req, res);
  if (!body) return;
  const reviewId = body.reviewId ?? null;
  await respond(res, p.factId, async () => {
    // The record is written inside the approval's transaction (D8).
    await approveGagRender(p.factId, p.gagId, body.attemptId, { adminId: req.user.id, reviewId });
  });
});

// Run a gag's test renders: the kinds the admin named, drawn or drawn again.
// Spends money, so only ever on this explicit request; it is the only way a
// test render starts (Issue #1282, plan PLAN_RENDERS_MANUAL.md).
router.post("/admin/facts/:factId/gags/:gagId/renders", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagRendersBodySchema, req, res);
  if (!body) return;
  const reviewId = body.reviewId ?? null;
  await respond(res, p.factId, async () => {
    await assertCanRunGagRenders(p.factId, p.gagId, { adminId: req.user.id, reviewId });
    const result = await drawGagKinds(p.gagId, body.kinds, { adminUserId: req.user.id, redraw: body.redraw === true });
    if ("error" in result) throw new GagError("REVIEW_NOT_EDITABLE", `The renders could not start: ${result.error}.`);
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_renders_requested", { gagId: p.gagId, kinds: body.kinds ?? null, redraw: body.redraw === true });
  });
});

// A gag's render history (Issue #1304, plan PLAN_RENDER_HISTORY.md D4): every
// render of this fact's gag, newest first, 50 a page; `before` reads the next
// older page. Read only; makes no fal call (bills are stored by the hourly fill).
router.get("/admin/facts/:factId/gags/:gagId/render-history", requireAdmin, async (req: Request, res: Response) => {
  const p = ids(req);
  if (!p || p.gagId <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const before = typeof req.query["before"] === "string" ? req.query["before"] : undefined;
  res.json(await gagRenderHistory(p.factId, p.gagId, before));
});

// A fact's removed gags that still have renders, grouped by the gag's own id (D3).
router.get("/admin/facts/:factId/render-history/removed-gags", requireAdmin, async (req: Request, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  res.json({ gags: await removedGagHistories(p.factId) });
});

// Delete an old render for good (D6; David, Q47): its row and its picture
// file. Refused, saying why, for a pick, a render still drawing, or one
// that is not this gag's. The file is removed after the commit; the answer
// says when it is still on its way out.
router.post("/admin/facts/:factId/gags/:gagId/renders/:attemptId/delete", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  const attemptId = Number(req.params["attemptId"]);
  if (!p || p.gagId <= 0 || !Number.isInteger(attemptId) || attemptId <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagRenderDeleteBodySchema, req, res);
  if (!body) return;
  try {
    const { files } = await deleteGagRender(p.factId, p.gagId, attemptId, { adminId: req.user.id, reviewId: body.reviewId ?? null });
    const outstanding = await cleanUpQueuedFiles(files);
    const result: GagRenderDeleteResult = { deleted: true, fileStillBeingRemoved: outstanding > 0 };
    res.json(result);
  } catch (err) {
    if (err instanceof GagError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
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
    .where(and(eq(imagePromptAttemptsTable.renderJobId, renderJobId), eq(imagePromptAttemptsTable.gagId, gagId), GAG_MODERATION_RENDER))
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
    await sendStorageBody(res, response.body, { gagId, renderJobId });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found" }); return; }
    logger.error({ err, gagId, renderJobId }, "[gags] render image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

export default router;
