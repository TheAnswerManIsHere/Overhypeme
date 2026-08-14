/**
 * createMemeRecord — shared meme-row creation logic.
 *
 * Extracted from POST /api/memes so the async video pipeline can drop a
 * completed video meme into the same row shape without going through HTTP.
 * Behaviour mirrors the route's path 1:1 for the image variants (template /
 * stock / upload / identity); the new `"video"` variant skips the preview-
 * classifier (the pipeline has already moderated the still and the captioned
 * MP4) and persists artifact metadata on the row's imageSource jsonb.
 *
 * The route handler in routes/memes.ts becomes a thin wrapper around this
 * function — same checks, same idempotency, same status codes. The function
 * never sends a response; instead it throws a typed error or returns the
 * persisted row. Callers translate errors into HTTP status codes.
 */

import { createHash } from "crypto";
import { customAlphabet } from "nanoid";
import { db } from "@workspace/db";
import {
  memesTable,
  factsTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, gt, count, isNull } from "drizzle-orm";
import {
  ImageSourceSchema as StoredImageSourceSchema,
  type ImageSource,
  type AllowedPronouns,
} from "./validators/memeBuilder";
import { z } from "zod";
import { renderPersonalized } from "./renderCanonical";
import { ObjectStorageService } from "./objectStorage";
import { getConfigInt } from "./adminConfig";
import { classifyAndDecide } from "./moderation/nsfwClassifier";
import { quarantineImage } from "./moderation/quarantine";
import { GENERIC_REJECT_MESSAGE } from "./moderation/types";
import { memeKey } from "./storageKeys";
import { can, type Principal } from "./featureAccess";
import { getUploadImageMetadata } from "./userImageUpload";
import { logger } from "./logger";
import { effectiveTierExpr } from "./membershipState";

type StoredImageSource = z.infer<typeof StoredImageSourceSchema>;

const FREE_TIER_DAILY_SAVE_CAP_DEFAULT = 30;
const LEGENDARY_TIER_DAILY_SAVE_CAP_DEFAULT = 200;

const IDEM_WINDOW_MS = 60_000;
interface IdemEntry {
  memeId: number;
  permalinkSlug: string;
  expiresAt: number;
}
const idempotencyMap = new Map<string, IdemEntry>();

function pruneIdempotencyMap(now: number): void {
  for (const [key, entry] of idempotencyMap.entries()) {
    if (entry.expiresAt <= now) idempotencyMap.delete(key);
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function computeIdemKey(userId: string, parsed: Record<string, unknown>): string {
  return createHash("sha256").update(`${userId}|${canonicalize(parsed)}`).digest("hex");
}

const generateSlug = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  10,
);

export interface CreateMemeRecordInput {
  userId: string;
  factId: number;
  imageSource: ImageSource;
  textOptions?: Record<string, unknown> | null;
  framingTransform?: { offsetX: number; offsetY: number } | null;
  aspectRatio?: "landscape" | "square" | "portrait";
  isPublic?: boolean;
  imageTransform?: "pulid" | "pulid_fallback_text";
  name?: string;
  pronouns?: AllowedPronouns;
  /**
   * Base64-encoded JPEG of the client-rendered preview canvas. When present
   * the bytes are NSFW-classified and (on accept) uploaded to GCS so the
   * meme is served as a stored bitmap rather than rendered on demand. Skipped
   * automatically for the "video" image source.
   */
  previewImageBase64?: string;
  /**
   * The authorization decisions for the features this path gates, resolved by
   * the CALLER at submission time.
   *
   * Required, not optional, and deliberately so: this function used to re-read
   * the stored admin flag from the user row and resolve its own gates, which
   * cannot see session-scoped "view as user" state. An admin previewing as a
   * registered user would have bypassed every gate here through the background
   * path. Making the field required puts the compiler in charge of enumerating
   * the callers — there are only two, and both now resolve against a real
   * principal.
   */
  decisions: MemeAuthorizationDecisions;
}

/** The boolean features the meme-creation path gates. */
export const MEME_GATED_FEATURES = [
  "meme_private_visibility",
  "meme_rate_limit_high",
  "meme_pulid_stylize",
] as const;

export type MemeAuthorizationDecisions = {
  [K in (typeof MEME_GATED_FEATURES)[number]]: boolean;
};

/**
 * Resolves the meme path's decisions for a principal. Call this at SUBMISSION
 * time; for queued work persist the result and hand it back rather than
 * calling this again at execution time, which would resolve against whatever
 * the grid says *then*.
 */
export async function resolveMemeDecisions(principal: Principal): Promise<MemeAuthorizationDecisions> {
  const [privateVisibility, rateLimitHigh, pulid] = await Promise.all([
    can(principal, "meme_private_visibility"),
    can(principal, "meme_rate_limit_high"),
    can(principal, "meme_pulid_stylize"),
  ]);
  return {
    meme_private_visibility: privateVisibility,
    meme_rate_limit_high: rateLimitHigh,
    meme_pulid_stylize: pulid,
  };
}

export interface CreateMemeRecordResult {
  memeId: number;
  permalinkSlug: string;
  permalinkUrl: string;
  imageUrl: string;
  idempotent?: boolean;
  /** Auxiliary fields used by some callers (route handler). */
  factId?: number;
  templateId?: string;
  createdAt?: string;
}

export class CreateMemeError extends Error {
  public readonly status: number;
  public readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body["error"] === "string" ? body["error"] : "create_meme_failed");
    this.name = "CreateMemeError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Persist a meme row from the various sources the builder supports.
 * Throws CreateMemeError on validation / policy failures so the route can
 * translate the error into an HTTP status. Never sends a response.
 */
export async function createMemeRecord(
  input: CreateMemeRecordInput,
): Promise<CreateMemeRecordResult> {
  const { userId, factId, textOptions, framingTransform, previewImageBase64 } = input;
  let imageSource = input.imageSource;
  const aspectRatio = input.aspectRatio ?? "landscape";
  const imageTransform = input.imageTransform;

  // ── Authorization: decided by the caller, at submission time ────────
  // This function no longer resolves its own gates. It used to read the user
  // row and derive `tier`/`role` from the stored admin flag, which meant two
  // different vocabularies answered the same question — the PR #402 shape —
  // and meant the background path could not see "view as user" at all.
  //
  // The entitlement half of the union now lives in `featureAccess.ts`, and the
  // decisions arrive already made. What survives here is only the *application*
  // of those decisions.
  const { decisions } = input;
  const canPulid = decisions.meme_pulid_stylize;
  const canPrivate = decisions.meme_private_visibility;
  const highRateLimit = decisions.meme_rate_limit_high;

  // ── Gate: PuLID-stylised memes ───────────────────────────────────────
  if (imageTransform === "pulid" && !canPulid) {
    throw new CreateMemeError(403, { error: "tier_mismatch" });
  }

  // ── Gate: private visibility ─────────────────────────────────────────
  // Fail CLOSED on an explicit private request we cannot honour. Coercing it
  // to public instead is how an entitlement mismatch became a data exposure:
  // the caller asked for owner-only, got a 201, and the meme was world-
  // readable at its permalink. Publishing what someone asked to keep private
  // must never be a silent outcome. Omitting the field is not a request for
  // privacy and still defaults to public, so pipeline callers are unaffected.
  if (input.isPublic === false && !canPrivate) {
    throw new CreateMemeError(403, { error: "Private memes are a Legendary feature." });
  }
  const isPublic = input.isPublic ?? true;

  // Identity → resolve into upload via the user's profile photo.
  if (imageSource.type === "identity") {
    const [u] = await db
      .select({ profileImageUrl: usersTable.profileImageUrl })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const profileUrl = u?.profileImageUrl;
    const PROFILE_PREFIX = "/api/storage";
    if (!profileUrl || typeof profileUrl !== "string" || !profileUrl.startsWith(`${PROFILE_PREFIX}/objects/`)) {
      throw new CreateMemeError(400, { error: "Add a profile photo to create an identity meme." });
    }
    const uploadKey = profileUrl.slice(PROFILE_PREFIX.length);
    imageSource = { type: "upload", uploadKey };
  }

  // ── Daily save cap ──────────────────────────────────────────────────
  const dailyCapDefault = highRateLimit
    ? LEGENDARY_TIER_DAILY_SAVE_CAP_DEFAULT
    : FREE_TIER_DAILY_SAVE_CAP_DEFAULT;
  const dailyCapKey = highRateLimit
    ? "memes.legendary_tier_daily_save_cap"
    : "memes.free_tier_daily_save_cap";
  const dailyCap = await getConfigInt(dailyCapKey, dailyCapDefault);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count: recentCount }] = await db
    .select({ count: count() })
    .from(memesTable)
    .where(
      and(
        eq(memesTable.createdById, userId),
        gt(memesTable.createdAt, oneDayAgo),
        isNull(memesTable.deletedAt),
      ),
    );
  if (Number(recentCount) >= dailyCap) {
    throw new CreateMemeError(429, {
      error: "daily_cap_reached",
      cap: dailyCap,
      retryAfterSeconds: 60 * 60,
      message: `Daily save cap of ${dailyCap} memes reached. Try again in 24 hours.`,
    });
  }

  // ── Idempotency window ──────────────────────────────────────────────
  const now = Date.now();
  pruneIdempotencyMap(now);
  const idemKey = computeIdemKey(userId, {
    factId,
    imageSource,
    textOptions: textOptions ?? null,
    framingTransform: framingTransform ?? null,
    aspectRatio,
    isPublic,
    imageTransform: imageTransform ?? null,
  });
  const idemHit = idempotencyMap.get(idemKey);
  if (idemHit && idemHit.expiresAt > now) {
    return {
      memeId: idemHit.memeId,
      permalinkSlug: idemHit.permalinkSlug,
      permalinkUrl: `/m/${idemHit.permalinkSlug}`,
      imageUrl: `/api/memes/${idemHit.permalinkSlug}/image`,
      idempotent: true,
    };
  }

  // ── Look up fact ────────────────────────────────────────────────────
  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, canonicalText: factsTable.canonicalText })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) {
    throw new CreateMemeError(404, { error: "Fact not found" });
  }

  // ── Personalisation snapshot ────────────────────────────────────────
  const [profile] = await db
    .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns, nsfwModeEnabled: usersTable.nsfwModeEnabled })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const effectiveName = input.name ?? profile?.displayName ?? null;
  const effectivePronouns = input.pronouns ?? profile?.pronouns ?? null;
  const rawTemplate = fact.text ?? fact.canonicalText ?? "";
  const renderedFactText = effectiveName && rawTemplate
    ? renderPersonalized(rawTemplate, effectiveName, effectivePronouns)
    : (fact.canonicalText ?? fact.text ?? null);

  // ── Slug allocation ─────────────────────────────────────────────────
  let slug = generateSlug();
  for (let i = 0; i < 3; i++) {
    const [existing] = await db
      .select({ id: memesTable.id })
      .from(memesTable)
      .where(eq(memesTable.permalinkSlug, slug))
      .limit(1);
    if (!existing) break;
    slug = generateSlug();
    if (i === 2) {
      logger.error({ userId }, "[createMemeRecord] Slug allocation failed after 3 attempts");
      throw new CreateMemeError(500, { error: "slug_alloc_failed" });
    }
  }

  // ── Determine templateId for DB ─────────────────────────────────────
  const templateIdForDb =
    imageSource.type === "template" ? imageSource.templateId :
    imageSource.type === "stock"    ? "photo_stock" :
    imageSource.type === "video"    ? "video" :
    "photo_upload";

  // ── Preview classifier (image-only path) ────────────────────────────
  let storedImageSource: StoredImageSource | null = imageSource;
  let classifierScoreForMeme: number | null = null;
  let isNsfwForMeme = false;

  const objectStorageService = new ObjectStorageService();

  if (previewImageBase64 && imageSource.type !== "video") {
    const imgBuffer = Buffer.from(previewImageBase64, "base64");
    const { getFalApiKey, ensureFalConfigured, fal } = await import("./falClient");
    if (!getFalApiKey()) {
      logger.warn("[createMemeRecord] fal.ai key not configured — skipping NSFW classifier on preview");
    } else {
      let classifierUrl: string | null = null;
      try {
        ensureFalConfigured();
        const blob = new Blob([new Uint8Array(imgBuffer)], { type: "image/jpeg" });
        classifierUrl = await fal.storage.upload(blob);
      } catch (uErr) {
        logger.warn({ err: uErr }, "[createMemeRecord] failed to upload preview to fal storage for classification — failing closed");
      }

      if (classifierUrl) {
        const decision = await classifyAndDecide(classifierUrl, {
          nsfwModeEnabled: !!profile?.nsfwModeEnabled,
        });
        if (decision.outcome === "reject" || decision.outcome === "error") {
          if (decision.outcome === "reject") {
            try {
              await quarantineImage({
                source: "classifier",
                bytes: imgBuffer,
                mimeType: "image/jpeg",
                userId,
                evidence: {
                  source: "classifier",
                  classifierScore: decision.score,
                  classifierModel: decision.model,
                  raw: decision.raw,
                },
                reportToNcmec: false,
              });
            } catch (qErr) {
              logger.error({ err: qErr }, "[createMemeRecord] quarantine failed for preview classifier reject");
            }
          }
          throw new CreateMemeError(422, { error: GENERIC_REJECT_MESSAGE });
        }
        classifierScoreForMeme = decision.score;
        isNsfwForMeme = decision.isNsfwTag;
      } else {
        throw new CreateMemeError(503, { error: "Moderation service unavailable. Please try again." });
      }
    }

    try {
      await objectStorageService.uploadObjectBuffer({
        subPath: memeKey(slug, "jpg"),
        buffer: imgBuffer,
        contentType: "image/jpeg",
      });
      storedImageSource = null;
    } catch (uploadErr) {
      logger.warn({ uploadErr }, "[createMemeRecord] Preview image upload failed — falling back to server-side render");
    }
  }

  // ── Upload metadata (only for type=upload) ──────────────────────────
  const uploadMeta = imageSource.type === "upload"
    ? await getUploadImageMetadata(imageSource.uploadKey)
    : null;

  // ── Video-variant metadata (artifact_type, video_*, look/motion ids) ───
  // The `video` imageSource discriminant carries the FK + R2 path the pipeline
  // produced — surface those onto dedicated columns so they're queryable
  // without parsing imageSource JSON. lookStyleId / motionPresetId are also
  // copied for image memes that carry them (image-mode AI styling).
  const videoSource = imageSource.type === "video" ? imageSource : null;
  const isVideoSource = videoSource !== null;

  // ── Persist ─────────────────────────────────────────────────────────
  const insertValues: typeof memesTable.$inferInsert = {
    factId,
    templateId: templateIdForDb,
    imageUrl: `/api/memes/${slug}/image`,
    permalinkSlug: slug,
    textOptions: (textOptions ?? null) as never,
    imageSource: storedImageSource as never,
    framingTransform: (framingTransform ?? null) as never,
    isPublic,
    isLowRes: uploadMeta?.isLowRes ?? false,
    originalWidth: uploadMeta?.width ?? null,
    originalHeight: uploadMeta?.height ?? null,
    uploadFileSizeBytes: uploadMeta?.fileSizeBytes ?? null,
    createdById: userId,
    aspectRatio,
    renderedFactText: renderedFactText ?? null,
    nsfwClassifierScore: classifierScoreForMeme != null ? classifierScoreForMeme.toFixed(4) : null,
    isNsfw: isNsfwForMeme,
    imageTransform: imageTransform ?? null,
    artifactType: isVideoSource ? "video" : "image",
    videoObjectPath: videoSource?.videoObjectPath ?? null,
    videoJobId: videoSource?.videoJobId ?? null,
    lookStyleId: videoSource?.lookStyleId ?? null,
    motionPresetId: videoSource?.motionPresetId ?? null,
  };

  const [meme] = await db
    .insert(memesTable)
    .values(insertValues)
    .returning();

  idempotencyMap.set(idemKey, {
    memeId: meme.id,
    permalinkSlug: meme.permalinkSlug,
    expiresAt: Date.now() + IDEM_WINDOW_MS,
  });

  return {
    memeId: meme.id,
    permalinkSlug: meme.permalinkSlug,
    permalinkUrl: `/m/${meme.permalinkSlug}`,
    imageUrl: meme.imageUrl,
    factId: meme.factId,
    templateId: meme.templateId,
    createdAt: meme.createdAt.toISOString(),
  };
}
