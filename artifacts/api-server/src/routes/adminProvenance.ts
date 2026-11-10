/**
 * @purpose Admin-only image tracing endpoints (plan docs/plans/PLAN_IMAGE_TRACING.md): trace an id or a link to its provenance records, and serve a record's stored picture to an admin. Records hold prompts, request parameters and account identity, so nothing here is reachable by a non-admin.
 *
 *   GET /api/admin/provenance/trace?q=<id or link>   every matching record, its chain, the method that matched
 *   GET /api/admin/provenance/images/:id             the stored picture a record names
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { db, imageProvenanceTable } from "@workspace/db";
import { requireAdmin } from "./admin";
import { traceIdOrLink } from "../lib/provenance/trace";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const storage = new ObjectStorageService();

router.get("/admin/provenance/trace", requireAdmin, async (req: Request, res: Response) => {
  const q = String(req.query["q"] ?? "").trim();
  if (!q || q.length > 2000) { res.status(400).json({ error: "Give an id or a link." }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await traceIdOrLink(q));
});

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
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found", deleted: true }); return; }
    logger.error({ err, id }, "[provenance] image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

export default router;
