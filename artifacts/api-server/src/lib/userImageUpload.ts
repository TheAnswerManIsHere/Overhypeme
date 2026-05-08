import { randomUUID } from "crypto";
import { type Request, type Response } from "express";
import sharp from "sharp";
import { sql } from "drizzle-orm";

import { db } from "@workspace/db";

import { uploadKey } from "./storageKeys";
import { ObjectStorageService } from "./objectStorage";
import { isArachnidFailOpen, scanFaceSource } from "./moderation/arachnid";
import { quarantineImage } from "./moderation/quarantine";
import { checkUploadRateLimit } from "./moderation/uploadRateLimit";
import { classifyAndDecide } from "./moderation/nsfwClassifier";
import { GENERIC_REJECT_MESSAGE } from "./moderation/types";

/**
 * Unified user-image upload pipeline.
 *
 * All user image uploads (meme backgrounds, profile photos, AI reference photos,
 * video frames, …) flow through `processAndStoreUserUpload` so CSAM/NSFW
 * scanning, rate limiting, GCS storage, ACL, and metadata persistence are
 * applied identically every time. Future upload surfaces should call this
 * helper instead of re-implementing the moderation pipeline.
 */

function parseEnvInt(name: string, defaultValue: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) return defaultValue;
  if (min !== undefined && parsed < min) return defaultValue;
  if (max !== undefined && parsed > max) return defaultValue;
  return parsed;
}

export const MAX_UPLOAD_SIZE_MB = parseEnvInt("MAX_UPLOAD_SIZE_MB", 15, 1);
export const LOW_RES_THRESHOLD_PX = parseEnvInt("LOW_RES_THRESHOLD_PX", 1500, 1);

const MEME_ALLOWED_TYPES = ["image/jpeg"] as const;
const AVATAR_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type UploadVariant = "meme" | "avatar";

export interface ProcessAndStoreUploadOptions {
  variant: UploadVariant;
}

export interface UploadImageMetadata {
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
}

export interface ProcessAndStoreUploadResult extends UploadImageMetadata {
  objectPath: string;
}

interface ArachnidScanColumns {
  arachnidClassification?: string | null;
  arachnidMatchType?: string | null;
  arachnidSha1Base32?: string | null;
  arachnidSha256Hex?: string | null;
}

const objectStorageService = new ObjectStorageService();

/**
 * Validate the inbound payload's content-type and (for meme uploads) decode
 * the JPEG header to read width/height. Sends the appropriate error response
 * and returns null on rejection.
 */
async function validateAndProbe(
  req: Request,
  res: Response,
  buffer: Buffer,
  contentType: string,
  variant: UploadVariant,
): Promise<UploadImageMetadata | null> {
  if (variant === "meme") {
    if (contentType !== "image/jpeg") {
      res.status(415).json({ error: "Only JPEG uploads are accepted." });
      return null;
    }
    if (buffer.length > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
      res
        .status(413)
        .json({ error: `File too large. Maximum upload size is ${MAX_UPLOAD_SIZE_MB}MB.` });
      return null;
    }
    try {
      const meta = await sharp(buffer, { failOn: "error" }).metadata();
      if (meta.format !== "jpeg" || !meta.width || !meta.height) {
        res.status(422).json({ error: "The uploaded file is not a valid JPEG image." });
        return null;
      }
      const longestEdge = Math.max(meta.width, meta.height);
      return {
        width: meta.width,
        height: meta.height,
        isLowRes: longestEdge < LOW_RES_THRESHOLD_PX,
        fileSizeBytes: buffer.length,
      };
    } catch (err) {
      req.log.warn({ err }, "[user-upload] image header parse failed — not a valid JPEG");
      res.status(422).json({ error: "The uploaded file is not a valid JPEG image." });
      return null;
    }
  }

  // avatar
  if (!AVATAR_ALLOWED_TYPES.includes(contentType as typeof AVATAR_ALLOWED_TYPES[number])) {
    res.status(400).json({ error: "Only JPEG, PNG, WebP, or GIF images are accepted" });
    return null;
  }
  // Avatars skip dimension decoding (the route never used it); width/height
  // are recorded as 0 in metadata.
  return { width: 0, height: 0, isLowRes: false, fileSizeBytes: buffer.length };
}

/**
 * Layer 1 — daily rate limit + Arachnid Shield CSAM hash scan. On match,
 * quarantines the bytes, reports to NCMEC, and sends a 422. On error, fails
 * open or closed per `isArachnidFailOpen()`.
 */
async function runLayer1Moderation(
  req: Request,
  res: Response,
  buffer: Buffer,
  contentType: string,
): Promise<{ state: "proceed"; arachnid?: ArachnidScanColumns } | { state: "rejected" }> {
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
      req.log.error({ err }, "[user-upload] quarantine write failed for Arachnid match");
    }
    res.status(422).json({ error: GENERIC_REJECT_MESSAGE });
    return { state: "rejected" };
  }
  if (scan.outcome === "error") {
    const failOpen = await isArachnidFailOpen();
    if (!failOpen) {
      req.log.warn({ message: scan.message }, "[user-upload] Arachnid error — failing closed");
      res.status(503).json({ error: "Moderation service unavailable. Please try again." });
      return { state: "rejected" };
    }
    req.log.warn({ message: scan.message }, "[user-upload] Arachnid error — failing open by config");
    return { state: "proceed" };
  }
  if (scan.outcome === "disabled") {
    return { state: "proceed" };
  }
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
 * Layer 2 — fal.ai NSFW classifier. Quarantines + 422 on reject; 503 on
 * classifier error (fail-closed). Returns the NSFW tag flag for metadata
 * persistence.
 */
async function runNsfwClassifier(
  req: Request,
  res: Response,
  buffer: Buffer,
  contentType: string,
): Promise<{ state: "proceed"; isNsfw: boolean } | { state: "rejected" }> {
  const falKey = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  if (!falKey) {
    req.log.warn("[user-upload] fal.ai key not configured — skipping NSFW classifier");
    return { state: "proceed", isNsfw: false };
  }
  try {
    const { fal } = await import("@fal-ai/client");
    fal.config({ credentials: falKey });
    const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
    const classifierUrl = await fal.storage.upload(blob);
    const decision = await classifyAndDecide(classifierUrl, {
      nsfwModeEnabled: !!req.user?.nsfwModeEnabled,
    });
    if (decision.outcome === "reject") {
      try {
        await quarantineImage({
          source: "classifier",
          bytes: buffer,
          mimeType: contentType,
          userId: req.user!.id,
          evidence: {
            source: "classifier",
            classifierScore: decision.score,
            classifierModel: decision.model,
            raw: decision.raw,
          },
          reportToNcmec: false,
        });
      } catch (qErr) {
        req.log.error({ err: qErr }, "[user-upload] quarantine failed for NSFW classifier reject");
      }
      res.status(422).json({ error: GENERIC_REJECT_MESSAGE });
      return { state: "rejected" };
    }
    if (decision.outcome === "error") {
      req.log.warn(
        { message: decision.message },
        "[user-upload] NSFW classifier error — failing closed",
      );
      res.status(503).json({ error: "Moderation service unavailable. Please try again." });
      return { state: "rejected" };
    }
    return { state: "proceed", isNsfw: decision.isNsfwTag };
  } catch (err) {
    req.log.warn({ err }, "[user-upload] NSFW classifier step failed — failing closed");
    res.status(503).json({ error: "Moderation service unavailable. Please try again." });
    return { state: "rejected" };
  }
}

async function persistUploadMetadata(
  objectPath: string,
  meta: UploadImageMetadata,
  userId: string,
  arachnid: ArachnidScanColumns | undefined,
  isNsfw: boolean,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO upload_image_metadata (
      object_path, width, height, is_low_res, file_size_bytes, user_id,
      arachnid_classification, arachnid_match_type, arachnid_sha1_base32,
      arachnid_sha256_hex, arachnid_scanned_at, is_nsfw
    )
    VALUES (
      ${objectPath}, ${meta.width}, ${meta.height}, ${meta.isLowRes}, ${meta.fileSizeBytes}, ${userId},
      ${arachnid?.arachnidClassification ?? null}, ${arachnid?.arachnidMatchType ?? null},
      ${arachnid?.arachnidSha1Base32 ?? null}, ${arachnid?.arachnidSha256Hex ?? null},
      ${arachnid ? sql`now()` : sql`NULL`},
      ${isNsfw}
    )
    ON CONFLICT (object_path) DO NOTHING
  `);
}

export async function getUploadImageMetadata(
  objectPath: string,
): Promise<UploadImageMetadata | null> {
  const rows = await db.execute(sql`
    SELECT width, height, is_low_res, file_size_bytes
    FROM upload_image_metadata
    WHERE object_path = ${objectPath}
    LIMIT 1
  `);
  const row = rows.rows[0] as
    | { width: number; height: number; is_low_res: boolean; file_size_bytes: number }
    | undefined;
  if (!row) return null;
  return {
    width: row.width,
    height: row.height,
    isLowRes: row.is_low_res,
    fileSizeBytes: row.file_size_bytes,
  };
}

/**
 * Single entry point for every user image upload. Validates the payload, runs
 * the full moderation pipeline (Arachnid + NSFW classifier + quarantine),
 * writes the bytes to GCS, sets the appropriate ACL, and records metadata.
 *
 * On rejection the response has already been written; the caller MUST return
 * without writing further. On success the caller can either let the helper
 * write the response (`writeResponse: true`, the default) or take the result
 * and respond itself.
 */
export async function processAndStoreUserUpload(
  req: Request,
  res: Response,
  buffer: Buffer,
  contentType: string,
  options: ProcessAndStoreUploadOptions,
): Promise<ProcessAndStoreUploadResult | null> {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    res.status(400).json({ error: "No file data received" });
    return null;
  }

  const normalizedContentType = (contentType ?? "").split(";")[0].trim().toLowerCase();

  const probed = await validateAndProbe(req, res, buffer, normalizedContentType, options.variant);
  if (!probed) return null;

  const layer1 = await runLayer1Moderation(req, res, buffer, normalizedContentType);
  if (layer1.state === "rejected") return null;

  const layer2 = await runNsfwClassifier(req, res, buffer, normalizedContentType);
  if (layer2.state === "rejected") return null;

  try {
    const ext = EXT_BY_CONTENT_TYPE[normalizedContentType] ?? "jpg";
    const subPath = uploadKey(randomUUID(), ext);
    const objectPath = await objectStorageService.uploadObjectBuffer({
      subPath,
      buffer,
      contentType: normalizedContentType,
    });

    const visibility: "public" | "private" =
      options.variant === "avatar" ? "public" : "private";
    await objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
      owner: req.user.id,
      visibility,
    });

    await persistUploadMetadata(objectPath, probed, req.user.id, layer1.arachnid, layer2.isNsfw);

    return { objectPath, ...probed };
  } catch (err) {
    req.log.error({ err }, `[user-upload] storage write failed (${options.variant})`);
    res.status(500).json({ error: "Upload failed" });
    return null;
  }
}
