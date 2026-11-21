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
 *   GET  /api/admin/gags/:gagId/renders/:renderJobId/image     a render's image
 */
import { Readable } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, imagePromptAttemptsTable } from "@workspace/db";
import {
  gagApproveBodySchema,
  gagCastBodySchema,
  gagCreateBodySchema,
  gagRendersBodySchema,
  gagSaveBodySchema,
  gagScopeBodySchema,
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
  removeGag,
  saveGagContent,
} from "../lib/gags/gagStore";
import { buildFactGagsView } from "../lib/gags/gagView";
import { CastPreparationError, prepareDraftCast } from "../lib/gags/castPreparation";
import { createRateLimiter } from "../lib/rateLimit";
import { drawGagKinds, enqueueGagIterationRender } from "../lib/reviewRenderScenarios";
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

/**
 * A write names the review it comes from. A live fact's gags are not edited
 * between phases (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1F), so a write with no
 * review is refused before anything runs.
 */
function reviewScope(reviewId: number | null | undefined, res: Response): number | null {
  if (reviewId == null) {
    res.status(409).json({
      error: "A live fact's gags can't be changed yet: the new fact page brings that back. A fact in moderation is edited from its review.",
      code: "LIVE_GAG_EDITING_UNAVAILABLE",
    });
    return null;
  }
  return reviewId;
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
  const reviewId = reviewScope(body.reviewId, res);
  if (reviewId == null) return;
  await respond(res, p.factId, async () => {
    const gag = await createGag(p.factId, body.content, { adminId: req.user.id, reviewId }, body.slot);
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_create", { gagId: gag.id, content: body.content });
    await enqueueGagIterationRender(p.factId, gag.id, { adminId: req.user.id, reviewId });
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
  const reviewId = reviewScope(body.reviewId, res);
  if (reviewId == null) return;
  await respond(res, p.factId, async () => {
    await saveGagContent(p.factId, p.gagId, body.content, { adminId: req.user.id, reviewId });
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_save", { gagId: p.gagId, content: body.content });
    await enqueueGagIterationRender(p.factId, p.gagId, { adminId: req.user.id, reviewId });
  });
});

router.post("/admin/facts/:factId/gags/:gagId/remove", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagScopeBodySchema, req, res);
  if (!body) return;
  const reviewId = reviewScope(body.reviewId, res);
  if (reviewId == null) return;
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
  const reviewId = reviewScope(body.reviewId, res);
  if (reviewId == null) return;
  await respond(res, p.factId, async () => {
    await approveGagRender(p.factId, p.gagId, body.attemptId, { adminId: req.user.id, reviewId });
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_render_approval", { gagId: p.gagId, attemptId: body.attemptId });
  });
});

// Run a gag's test renders: the default batch, or the named scenarios again.
// Spends money, so only ever on this explicit request.
router.post("/admin/facts/:factId/gags/:gagId/renders", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req);
  if (!p) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = parse(gagRendersBodySchema, req, res);
  if (!body) return;
  const reviewId = reviewScope(body.reviewId, res);
  if (reviewId == null) return;
  await respond(res, p.factId, async () => {
    await assertCanRunGagRenders(p.factId, p.gagId, { adminId: req.user.id, reviewId });
    const result = await drawGagKinds(p.gagId, body.kinds, { adminUserId: req.user.id, redraw: body.redraw === true });
    if ("error" in result) throw new GagError("REVIEW_NOT_EDITABLE", `The renders could not start: ${result.error}.`);
    await recordAdminAction({ factId: p.factId, reviewId }, req.user.id, "gag_renders_requested", { gagId: p.gagId, kinds: body.kinds ?? null, redraw: body.redraw === true });
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
