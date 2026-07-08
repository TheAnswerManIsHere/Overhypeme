import express, { Router, type IRouter, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { userCanReadObject } from "../lib/objectAccess";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CACHE, setPublicCache, setPublicCors, setNoStore } from "../lib/cacheHeaders";
import {
  MAX_UPLOAD_SIZE_MB,
  getUploadImageMetadata,
  processAndStoreUserUpload,
} from "../lib/userImageUpload";

export { getUploadImageMetadata } from "../lib/userImageUpload";
export type { UploadImageMetadata } from "../lib/userImageUpload";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  setNoStore(res);
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * POST /storage/upload-avatar
 *
 * Server-side profile photo upload, available to every authenticated user.
 * The profile photo is treated as a free identity asset — it is reused as the
 * face/likeness reference for memes, AI image generation, and AI video memes.
 * Accepts the raw image binary as the request body (Content-Type: image/*),
 * capped at 5 MB.
 *
 * Delegates the full validation + moderation + storage pipeline to
 * processAndStoreUserUpload — the same helper that backs every other user
 * image upload in the system.
 */
router.post(
  "/storage/upload-avatar",
  express.raw({ type: "image/*", limit: "5mb" }),
  async (req: Request, res: Response) => {
    const result = await processAndStoreUserUpload(
      req,
      res,
      req.body as Buffer,
      req.headers["content-type"] ?? "",
      { variant: "avatar" },
    );
    if (!result) return;
    res.json({ objectPath: result.objectPath });
  },
);

/**
 * POST /storage/upload-meme
 *
 * Server-side upload for meme background images. The client always sends a
 * JPEG (Content-Type: image/jpeg) that has already been pre-processed
 * (oriented, capped at the client max dimension, and compressed to fit under
 * MAX_UPLOAD_SIZE_MB). The bytes are stored verbatim — no resize, no
 * recompress — so every available pixel survives.
 *
 * Delegates the full validation + moderation + storage pipeline to
 * processAndStoreUserUpload.
 */
router.post(
  "/storage/upload-meme",
  express.raw({ type: "*/*", limit: `${MAX_UPLOAD_SIZE_MB}mb` }),
  async (req: Request, res: Response) => {
    const result = await processAndStoreUserUpload(
      req,
      res,
      req.body as Buffer,
      req.headers["content-type"] ?? "",
      { variant: "meme" },
    );
    if (!result) return;
    res.json({
      objectPath: result.objectPath,
      width: result.width,
      height: result.height,
      isLowRes: result.isLowRes,
      fileSizeBytes: result.fileSizeBytes,
    });
  },
);

router.use("/storage/upload-meme", (
  err: Error & { type?: string; status?: number },
  _req: Request,
  res: Response,
  _next: express.NextFunction,
) => {
  if (err.type === "entity.too.large" || err.status === 413) {
    res.status(413).json({ error: `File too large. Maximum upload size is ${MAX_UPLOAD_SIZE_MB}MB.` });
    return;
  }
  res.status(500).json({ error: "Upload failed" });
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    if (filePath.startsWith("restricted/")) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file, 86400);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "cache-control") res.setHeader(key, value);
    });
    setPublicCache(res, CACHE.PUBLIC_OBJECT);
    setPublicCors(res);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * Public objects (e.g. profile images) are served without authentication.
 * Private objects require the requesting user to be the owner.
 */
router.get("/storage/objects/*path", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    // Hard refuse anything in the moderation/quarantine prefix. The prefix
    // is application-scoped — bytes never go through the user-facing serve
    // path, regardless of ACL state or auth state.
    if (wildcardPath.startsWith("restricted/")) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // Canonical READ authorization (ACL + legacy upload-owner fallback + ACL
    // heal). Shared with the video generator so both gate private-object reads
    // identically — see lib/objectAccess.ts.
    const canAccess = await userCanReadObject(objectStorageService, objectFile, objectPath, req);

    if (!canAccess) {
      res.status(req.isAuthenticated() ? 403 : 401).json({ error: req.isAuthenticated() ? "Forbidden" : "Unauthorized" });
      return;
    }

    const isPublic = await objectStorageService.canAccessObjectEntity({
      userId: undefined,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });

    const response = await objectStorageService.downloadObject(objectFile, isPublic ? 86400 : 3600);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "cache-control") res.setHeader(key, value);
    });

    if (isPublic) {
      setPublicCache(res, CACHE.PUBLIC_OBJECT);
      setPublicCors(res);
    } else {
      res.setHeader("Cache-Control", CACHE.PRIVATE_OBJECT);
    }

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
