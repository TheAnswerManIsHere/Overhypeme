/**
 * @purpose Admin-only image tracing endpoints (plan docs/plans/PLAN_IMAGE_TRACING.md): trace an id or a link to its provenance records, and serve a record's stored picture to an admin. Records hold prompts, request parameters and account identity, so nothing here is reachable by a non-admin.
 *
 *   GET  /api/admin/provenance/trace?q=<id or link>  every matching record, its chain, the method that matched
 *   POST /api/admin/provenance/trace-image           the same, from a picture file (its stamp, its bytes, its watermark)
 *   GET  /api/admin/provenance/images/:id            the stored picture a record names
 *   POST /api/admin/content/takedown                 take down a member's meme or photo (audit R9, #875)
 */
import express, { Router, type IRouter, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { db, imageProvenanceTable } from "@workspace/db";
import { requireAdmin } from "./admin";
import { traceIdOrLink, traceImageFile } from "../lib/provenance/trace";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { z } from "zod";
import { takeDownContent, takedownTargetFor } from "../lib/contentTakedown";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware";

const router: IRouter = Router();
const storage = new ObjectStorageService();

router.get("/admin/provenance/trace", requireAdmin, async (req: Request, res: Response) => {
  const q = String(req.query["q"] ?? "").trim();
  if (!q || q.length > 2000) { res.status(400).json({ error: "Give an id or a link." }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  const [traced, takedown] = await Promise.all([traceIdOrLink(q), takedownTargetFor(q)]);
  // The takedown target comes from the content, not its records, so content
  // made before tracing can still be taken down (#875 R9).
  res.json({ ...traced, takedown });
});

/** A screenshot or a downloaded meme: generous, since the file is only read, never stored. */
const MAX_TRACE_IMAGE_MB = 30;

router.post(
  "/admin/provenance/trace-image",
  requireAdmin,
  express.raw({ type: () => true, limit: `${MAX_TRACE_IMAGE_MB}mb` }),
  async (req: Request, res: Response) => {
    const file = Buffer.isBuffer(req.body) ? req.body : null;
    if (!file || file.length === 0) { res.status(400).json({ error: "Choose a picture file." }); return; }
    res.setHeader("Cache-Control", "private, no-store");
    try {
      res.json(await traceImageFile(file));
    } catch (err) {
      logger.warn({ err }, "[provenance] trace-image could not read the file");
      res.status(422).json({ error: "That file could not be read as a picture." });
    }
  },
);

router.get("/admin/provenance/images/:id", requireAdmin, async (req: Request, res: Response) => {
  const raw = String(req.params["id"] ?? "");
  const id = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [record] = await db.select({ objectPath: imageProvenanceTable.objectPath, mime: imageProvenanceTable.mime })
    .from(imageProvenanceTable).where(eq(imageProvenanceTable.id, id)).limit(1);
  if (!record?.objectPath) { res.status(404).json({ error: "image_not_found" }); return; }
  try {
    const response = await storage.downloadObject(await storage.getObjectEntityFile(record.objectPath), 0);
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || record.mime);
    const length = response.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    res.setHeader("Cache-Control", "private, no-store");
    if (response.body) await pipeline(Readable.fromWeb(response.body as never), res);
    else res.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found" }); return; }
    logger.error({ err, id }, "[provenance] image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

// POST /admin/content/takedown — body { kind, key, reason }. Takes down a
// member's meme (key: its slug) or photo (key: its object path): it leaves
// every surface now, its owner cannot restore it, and the purger removes it
// within the hour. Quarantined content is never touched (it is evidence).
const TakedownBody = z.object({
  kind: z.enum(["meme", "photo"]),
  key: z.string().trim().min(1).max(512),
  reason: z.string().trim().min(3).max(500),
}).strict();
router.post("/admin/content/takedown", requireAdmin, async (req: Request, res: Response) => {
  const parsed = TakedownBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "kind, key and a reason are required" }); return; }
  const { kind, key, reason } = parsed.data;
  const result = await takeDownContent({ kind, key }, (req as AuthenticatedRequest).user.id, reason);
  if (result.status === "not_found") {
    res.status(404).json({ error: kind === "meme" ? "No live or restorable meme with that link" : "No live or restorable photo at that path" });
    return;
  }
  logger.info({ kind, key, adminId: (req as AuthenticatedRequest).user.id, ownerId: result.ownerId }, "[takedown] content taken down");
  res.json({ success: true, wasProfile: result.wasProfile });
});

export default router;
