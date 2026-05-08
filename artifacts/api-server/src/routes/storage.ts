import express, { Router, type IRouter, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { uploadKey } from "../lib/storageKeys";
import sharp from "sharp";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CACHE, setPublicCache, setPublicCors, setNoStore } from "../lib/cacheHeaders";
import { scanFaceSource, isArachnidFailOpen } from "../lib/moderation/arachnid";
import { quarantineImage } from "../lib/moderation/quarantine";
import { checkUploadRateLimit } from "../lib/moderation/uploadRateLimit";
import { classifyAndDecide } from "../lib/moderation/nsfwClassifier";
import { GENERIC_REJECT_MESSAGE } from "../lib/moderation/types";

function parseEnvInt(name: string, defaultValue: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) return defaultValue;
  if (min !== undefined && parsed < min) return defaultValue;
  if (max !== undefined && parsed > max) return defaultValue;
  return parsed;
}

const MAX_UPLOAD_SIZE_MB = parseEnvInt("MAX_UPLOAD_SIZE_MB", 15, 1);
const LOW_RES_THRESHOLD_PX = parseEnvInt("LOW_RES_THRESHOLD_PX", 1500, 1);

export interface ProcessedImageResult {
  buffer: Buffer;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
}

export interface UploadImageMetadata {
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
}

interface ArachnidScanColumns {
  arachnidClassification?: string | null;
  arachnidMatchType?: string | null;
  arachnidSha1Base32?: string | null;
  arachnidSha256Hex?: string | null;
}

async function saveUploadImageMetadata(
  objectPath: string,
  meta: UploadImageMetadata,
  userId?: string,
  arachnid?: ArachnidScanColumns,
  isNsfw?: boolean,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO upload_image_metadata (
      object_path, width, height, is_low_res, file_size_bytes, user_id,
      arachnid_classification, arachnid_match_type, arachnid_sha1_base32,
      arachnid_sha256_hex, arachnid_scanned_at, is_nsfw
    )
    VALUES (
      ${objectPath}, ${meta.width}, ${meta.height}, ${meta.isLowRes}, ${meta.fileSizeBytes}, ${userId ?? null},
      ${arachnid?.arachnidClassification ?? null}, ${arachnid?.arachnidMatchType ?? null},
      ${arachnid?.arachnidSha1Base32 ?? null}, ${arachnid?.arachnidSha256Hex ?? null},
      ${arachnid ? sql`now()` : sql`NULL`},
      ${isNsfw ?? false}
    )
    ON CONFLICT (object_path) DO NOTHING
  `);
}

export async function getUploadImageMetadata(objectPath: string): Promise<UploadImageMetadata | null> {
  const rows = await db.execute(sql`
    SELECT width, height, is_low_res, file_size_bytes
    FROM upload_image_metadata
    WHERE object_path = ${objectPath}
    LIMIT 1
  `);
  const row = rows.rows[0] as { width: number; height: number; is_low_res: boolean; file_size_bytes: number } | undefined;
  if (!row) return null;
  return {
    width: row.width,
    height: row.height,
    isLowRes: row.is_low_res,
    fileSizeBytes: row.file_size_bytes,
  };
}

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Result of running Layer 1 (rate limit + Arachnid Shield) on an upload buffer.
 * On `proceed`, callers may continue to the storage write and pass the
 * `arachnid` columns to `saveUploadImageMetadata`. On `reject`, the response
 * has already been sent.
 */
type Layer1Result =
  | { state: "proceed"; arachnid?: ArachnidScanColumns }
  | { state: "rejected" };

async function runUploadModeration(
  req: Request,
  res: Response,
  buffer: Buffer,
  contentType: string,
): Promise<Layer1Result> {
  // Rate limit (24h window, tier-aware) — runs BEFORE classifier calls.
  const user = req.user!;
  const rl = await checkUploadRateLimit({
    userId: user.id,
    membershipTier: user.membershipTier ?? null,
    isAdmin: !!user.isRealAdmin,
    ip: req.ip ?? null,
  });
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "Daily upload limit reached. Try again later.",
      limit: rl.limit,
      retryAfterSeconds: retryAfter,
    });
    return { state: "rejected" };
  }

  // Layer 1 — Arachnid Shield scan.
  const scan = await scanFaceSource({ bytes: buffer, mimeType: contentType });
  if (scan.outcome === "match") {
    try {
      await quarantineImage({
        source: "arachnid",
        bytes: buffer,
        mimeType: contentType,
        userId: user.id,
        evidence: {
          source: "arachnid",
          classification: scan.evidence.classification,
          matchType: scan.evidence.match_type,
          raw: scan.evidence,
        },
        reportToNcmec: true,
        ncmecMetadata: {
          ip: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          route: req.originalUrl,
        },
      });
    } catch (err) {
      req.log.error({ err }, "[upload moderation] quarantine write failed for Arachnid match");
    }
    res.status(422).json({ error: GENERIC_REJECT_MESSAGE });
    return { state: "rejected" };
  }
  if (scan.outcome === "error") {
    const failOpen = await isArachnidFailOpen();
    if (!failOpen) {
      req.log.warn({ message: scan.message }, "[upload moderation] Arachnid error — failing closed");
      res.status(503).json({ error: "Moderation service unavailable. Please try again." });
      return { state: "rejected" };
    }
    req.log.warn({ message: scan.message }, "[upload moderation] Arachnid error — failing open by config");
    return { state: "proceed" };
  }
  if (scan.outcome === "disabled") {
    return { state: "proceed" };
  }
  // Clean.
  return {
    state: "proceed",
    arachnid: {
      arachnidClassification: scan.evidence.classification,
      arachnidMatchType: scan.evidence.match_type,
      arachnidSha1Base32: scan.evidence.sha1_base32,
      arachnidSha256Hex: scan.evidence.sha256_hex,
    },
  };
}

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
 * capped at 5 MB. Uploads to object storage, sets public ACL, and returns the
 * objectPath.
 */
router.post(
  "/storage/upload-avatar",
  express.raw({ type: "image/*", limit: "5mb" }),
  async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(contentType)) {
      res.status(400).json({ error: "Only JPEG, PNG, WebP, or GIF images are accepted" });
      return;
    }

    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      res.status(400).json({ error: "No file data received" });
      return;
    }

    // Layer 1: rate limit + Arachnid Shield. On reject, response is sent.
    const moderation = await runUploadModeration(req, res, buffer, contentType);
    if (moderation.state === "rejected") return;

    try {
      const extMap: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
      };
      const ext = extMap[contentType] ?? "jpg";
      const subPath = uploadKey(randomUUID(), ext);

      const objectPath = await objectStorageService.uploadObjectBuffer({ subPath, buffer, contentType });
      await objectStorageService.trySetObjectEntityAclPolicy(objectPath, { owner: req.user.id, visibility: "public" });

      // Avatar uploads do not previously go through saveUploadImageMetadata,
      // but the Arachnid scan results still need to be persisted so a later
      // PuLID consumer can verify "this byte sequence was scanned". Avatars
      // skip width/height + size since the route never decoded them.
      if (moderation.arachnid) {
        await db.execute(sql`
          INSERT INTO upload_image_metadata (
            object_path, width, height, is_low_res, file_size_bytes, user_id,
            arachnid_classification, arachnid_match_type, arachnid_sha1_base32,
            arachnid_sha256_hex, arachnid_scanned_at
          )
          VALUES (
            ${objectPath}, 0, 0, false, ${buffer.length}, ${req.user.id},
            ${moderation.arachnid.arachnidClassification ?? null},
            ${moderation.arachnid.arachnidMatchType ?? null},
            ${moderation.arachnid.arachnidSha1Base32 ?? null},
            ${moderation.arachnid.arachnidSha256Hex ?? null},
            now()
          )
          ON CONFLICT (object_path) DO NOTHING
        `);
      }

      res.json({ objectPath });
    } catch (error) {
      req.log.error({ err: error }, "Error uploading avatar");
      res.status(500).json({ error: "Upload failed" });
    }
  },
);

/**
 * POST /storage/upload-meme
 *
 * Server-side upload for meme background images.
 * The client always sends a JPEG (Content-Type: image/jpeg) that has already
 * been pre-processed (oriented, capped at the client max dimension, and
 * compressed to fit under MAX_UPLOAD_SIZE_MB). To preserve every available
 * pixel the server stores the bytes verbatim — no resize, no recompress.
 *
 * Pipeline:
 *  1. Hard-reject anything > MAX_UPLOAD_SIZE_MB → 413
 *  2. Require Content-Type: image/jpeg → 415
 *  3. Cheap header read (sharp().metadata()) to validate it's a real JPEG and
 *     pull width/height for downstream low-res flagging.
 *  4. Save buffer verbatim to object storage (always as .jpg).
 *  5. Flag is_low_res when longest edge < LOW_RES_THRESHOLD_PX (default 1500px).
 */
router.post(
  "/storage/upload-meme",
  express.raw({ type: "*/*", limit: `${MAX_UPLOAD_SIZE_MB}mb` }),
  async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "image/jpeg") {
      res.status(415).json({ error: "Only JPEG uploads are accepted." });
      return;
    }

    const rawBuffer = req.body as Buffer;
    if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
      res.status(400).json({ error: "No file data received" });
      return;
    }

    if (rawBuffer.length > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
      res.status(413).json({ error: `File too large. Maximum upload size is ${MAX_UPLOAD_SIZE_MB}MB.` });
      return;
    }

    let processed: ProcessedImageResult;
    try {
      // Cheap header read only — does NOT decode pixels.
      const meta = await sharp(rawBuffer, { failOn: "error" }).metadata();
      if (meta.format !== "jpeg" || !meta.width || !meta.height) {
        res.status(422).json({ error: "The uploaded file is not a valid JPEG image." });
        return;
      }

      const longestEdge = Math.max(meta.width, meta.height);
      processed = {
        buffer: rawBuffer,
        width: meta.width,
        height: meta.height,
        isLowRes: longestEdge < LOW_RES_THRESHOLD_PX,
        fileSizeBytes: rawBuffer.length,
      };
    } catch (err) {
      req.log.warn({ err }, "Image header parse failed — not a valid JPEG");
      res.status(422).json({ error: "The uploaded file is not a valid JPEG image." });
      return;
    }

    // Layer 1: rate limit + Arachnid Shield. On reject, response is sent.
    const moderation = await runUploadModeration(req, res, processed.buffer, "image/jpeg");
    if (moderation.state === "rejected") return;

    // Layer 2: NSFW classifier — runs on the raw uploaded image (before any
    // text compositing) so the classifier sees the full unobscured content.
    let isNsfwUpload = false;
    try {
      const { fal } = await import("@fal-ai/client");
      const blob = new Blob([new Uint8Array(processed.buffer)], { type: "image/jpeg" });
      const classifierUrl = await fal.storage.upload(blob);
      const nsfwDecision = await classifyAndDecide(classifierUrl, { nsfwModeEnabled: !!req.user?.nsfwModeEnabled });
      if (nsfwDecision.outcome === "reject") {
        try {
          await quarantineImage({
            source: "classifier",
            bytes: processed.buffer,
            mimeType: "image/jpeg",
            userId: req.user.id,
            evidence: {
              source: "classifier",
              classifierScore: nsfwDecision.score,
              classifierModel: nsfwDecision.model,
              raw: nsfwDecision.raw,
            },
            reportToNcmec: false,
          });
        } catch (qErr) {
          req.log.error({ err: qErr }, "[upload-meme] quarantine failed for NSFW classifier reject");
        }
        res.status(422).json({ error: GENERIC_REJECT_MESSAGE });
        return;
      }
      if (nsfwDecision.outcome === "error") {
        req.log.warn({ message: nsfwDecision.message }, "[upload-meme] NSFW classifier error — failing closed");
        res.status(503).json({ error: "Moderation service unavailable. Please try again." });
        return;
      }
      isNsfwUpload = nsfwDecision.isNsfwTag;
    } catch (nsfwErr) {
      req.log.warn({ err: nsfwErr }, "[upload-meme] NSFW classifier step failed — failing closed");
      res.status(503).json({ error: "Moderation service unavailable. Please try again." });
      return;
    }

    try {
      const subPath = uploadKey(randomUUID(), "jpg");
      const objectPath = await objectStorageService.uploadObjectBuffer({
        subPath,
        buffer: processed.buffer,
        contentType: "image/jpeg",
      });

      await objectStorageService.trySetObjectEntityAclPolicy(objectPath, { owner: req.user.id, visibility: "private" });

      await saveUploadImageMetadata(objectPath, {
        width: processed.width,
        height: processed.height,
        isLowRes: processed.isLowRes,
        fileSizeBytes: processed.fileSizeBytes,
      }, req.user.id, moderation.arachnid, isNsfwUpload);

      res.json({
        objectPath,
        width: processed.width,
        height: processed.height,
        isLowRes: processed.isLowRes,
        fileSizeBytes: processed.fileSizeBytes,
      });
    } catch (error) {
      req.log.error({ err: error }, "Error uploading meme image");
      res.status(500).json({ error: "Upload failed" });
    }
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

    let canAccess = await objectStorageService.canAccessObjectEntity({
      userId: req.user?.id,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });

    // Fallback for uploads without ACL (pre-fix uploads): check upload_image_metadata ownership.
    // If the authenticated user owns this upload, grant access and retroactively set ACL so future
    // requests hit the fast path.
    if (!canAccess && req.isAuthenticated() && wildcardPath.startsWith("uploads/")) {
      const uploadOwnerCheck = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
        FROM upload_image_metadata
        WHERE object_path = ${objectPath}
          AND user_id = ${req.user.id}
      `);
      const owned = parseInt(uploadOwnerCheck.rows[0]?.count ?? "0", 10) > 0;
      if (owned) {
        canAccess = true;
        // Heal the missing ACL so subsequent requests skip this fallback
        objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
          owner: req.user.id,
          visibility: "private",
        }).catch(() => { /* non-critical */ });
      }
    }

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
