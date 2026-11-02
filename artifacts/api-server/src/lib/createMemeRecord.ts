/**
 * createMemeRecord — shared meme-row creation logic.
 *
 * Extracted from POST /api/memes so non-HTTP callers create the same row
 * shape. Behaviour mirrors the route's path 1:1 for every image variant
 * (upload / identity). (A `"video"` variant written by the video pipeline went
 * with video, a `"template"` variant with the gradient templates and a
 * `"stock"` variant with stock photos, launch Phase 4.)
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
import { and, eq, gt, count } from "drizzle-orm";
import { type ImageSource } from "./validators/memeBuilder";
import { renderPersonalized } from "./renderCanonical";
import { getConfigInt } from "./adminConfig";
import { userOwnsUpload } from "./uploadOwnership";
import { can, type Principal } from "./featureAccess";
import { getUploadImageMetadata } from "./userImageUpload";
import { renderMemeRecipe, storeMemeFile } from "./memeBake";
import { logger } from "./logger";
import { liveContent } from "./contentVisibility";
import { effectiveTierExpr } from "./membershipState";

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
  name?: string;
  pronouns?: string;
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
  const [privateVisibility, rateLimitHigh] = await Promise.all([
    can(principal, "meme_private_visibility"),
    can(principal, "meme_rate_limit_high"),
  ]);
  return {
    meme_private_visibility: privateVisibility,
    meme_rate_limit_high: rateLimitHigh,
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
  const { userId, factId, textOptions, framingTransform } = input;
  let imageSource = input.imageSource;
  const aspectRatio = input.aspectRatio ?? "landscape";

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
  const canPrivate = decisions.meme_private_visibility;
  const highRateLimit = decisions.meme_rate_limit_high;

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

  // A named upload must be the saver's own (#804): the meme's image is made
  // from these bytes and may be public. An identity source is the account's
  // own profile photo, so it is checked by construction, not here.
  if (imageSource.type === "upload" && !(await userOwnsUpload(imageSource.uploadKey, userId))) {
    throw new CreateMemeError(403, { error: "upload_not_owned" });
  }

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
        liveContent(memesTable),
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

  // ── Personalisation snapshot ────────────────────────────────────────
  // Resolved before the idempotency lookup: the baked caption depends on it,
  // so two saves that differ only in who the caption names are two memes.
  const [profile] = await db
    .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const effectiveName = input.name ?? profile?.displayName ?? null;
  const effectivePronouns = input.pronouns ?? profile?.pronouns ?? null;

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
    name: effectiveName,
    pronouns: effectivePronouns,
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
  const templateIdForDb = "photo_upload";

  // ── Upload metadata (only for type=upload) ──────────────────────────
  const uploadMeta = imageSource.type === "upload"
    ? await getUploadImageMetadata(imageSource.uploadKey)
    : null;

  // ── Bake (plan S16) ─────────────────────────────────────────────────
  // The meme is rendered once, here, from the stored photo and stored as its
  // own file before its row exists, so from its first view it no longer
  // depends on the photo. The caption uses the identity this save used, the
  // same one `renderedFactText` records.
  let baked: Buffer;
  try {
    baked = await renderMemeRecipe({
      fact,
      creator: effectiveName ? { displayName: effectiveName, pronouns: effectivePronouns } : undefined,
      textOptions: textOptions ?? null,
      imageSource,
      aspectRatio,
      framingTransform: framingTransform ?? null,
    });
  } catch (err) {
    logger.warn({ err, userId }, "[createMemeRecord] could not render the meme from its photo");
    throw new CreateMemeError(422, { error: "render_failed", message: "That photo could not be used for a meme." });
  }
  try {
    await storeMemeFile(slug, baked);
  } catch (err) {
    logger.error({ err, slug }, "[createMemeRecord] could not store the baked meme");
    throw new CreateMemeError(503, { error: "storage_unavailable", message: "The meme could not be saved. Try again." });
  }

  // ── Persist ─────────────────────────────────────────────────────────
  const insertValues: typeof memesTable.$inferInsert = {
    factId,
    templateId: templateIdForDb,
    imageUrl: `/api/memes/${slug}/image`,
    permalinkSlug: slug,
    textOptions: (textOptions ?? null) as never,
    imageSource: imageSource as never,
    framingTransform: (framingTransform ?? null) as never,
    isPublic,
    isLowRes: uploadMeta?.isLowRes ?? false,
    originalWidth: uploadMeta?.width ?? null,
    originalHeight: uploadMeta?.height ?? null,
    uploadFileSizeBytes: uploadMeta?.fileSizeBytes ?? null,
    createdById: userId,
    aspectRatio,
    renderedFactText: renderedFactText ?? null,
    artifactType: "image",
    bakedAt: new Date(),
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
