import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { fal, ensureFalConfigured, getFalApiKey } from "../lib/falClient.js";
import { db, videoJobsTable, usersTable, memesTable, factsTable } from "@workspace/db";
import { renderPersonalized } from "../lib/renderCanonical.js";
import { motionPresetsTable, lookStylesTable, enginesTable, type Engine } from "@workspace/db/schema";
import { eq, and, gte, desc, or, asc } from "drizzle-orm";
import { getCachedPrice, type CachedPrice } from "../lib/falPricing.js";
import { computeVideoCost, resolveVideoDimensions } from "../lib/costComputation.js";
import {
  BudgetGateError,
  checkBudget,
  recordCost,
} from "../lib/budgetGate.js";
import { buildAuthorizationSnapshot, can, principalFromRequest } from "../lib/featureAccess.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { userCanReadObject, userOwnsAiReferenceImage } from "../lib/objectAccess.js";
import type { File } from "@google-cloud/storage";
import { completeGovernance, enforceGovernance } from "../lib/resourceGovernance.js";
import { logger } from "../lib/logger.js";
import { requireAdmin } from "./admin.js";
import {
  loadEngine,
  loadDefaultEngine,
  loadActiveEngines,
  buildEngineInput,
  MissingRequiredParamError,
} from "../lib/engineInterpreter.js";
import { applyAudioHandling } from "../lib/engineAudio.js";

const router: IRouter = Router();

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FALLBACK_PROMPT = "Subtle cinematic motion, dramatic lighting, slow camera push-in, epic atmosphere";
const DEFAULT_STYLE_ID = "cinematic";

async function getVideoStyleById(id: string) {
  const [style] = await db.select().from(motionPresetsTable).where(eq(motionPresetsTable.id, id)).limit(1);
  return style ?? null;
}

/**
 * Resolve the admin override `videoModel` field to a concrete engine row.
 * Accepts either an engine id ("veo-3.1-lite") or a raw fal endpoint
 * ("fal-ai/veo3.1/lite/image-to-video"). Returns null when no match.
 */
async function resolveEngineFromOverride(raw: string): Promise<Engine | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = await loadEngine(trimmed);
  if (direct) return direct;
  const [byEndpoint] = await db
    .select()
    .from(enginesTable)
    .where(eq(enginesTable.endpointId, trimmed))
    .limit(1);
  return byEndpoint ?? null;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = (raw ?? "").split(",")[0];
    const ip = (first ?? "").trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? "unknown";
}


const GenerateVideoBody = z
  .object({
    imageUrl: z.string().optional(),
    imageBase64: z.string().optional(),
    factId: z.number().int().positive(),
    motionPrompt: z.string().max(500).optional(),
    styleId: z.string().optional(),
    /** Engine id or fal endpoint. Admin-only override; non-admins get the default engine. */
    videoModel: z.string().max(200).optional(),
    // Admin-only per-request overrides (only a subset survives the migration
    // to the data-driven interpreter — anything not on the engine's
    // paramSchema is silently dropped by buildEngineInput).
    adminDuration: z.string().max(20).optional(),
    adminAspectRatio: z.string().max(50).optional(),
    adminResolution: z.string().max(50).optional(),
    adminGenerateAudio: z.boolean().optional(),
    adminNegativePrompt: z.string().max(1000).optional(),
    adminSeed: z.number().int().nonnegative().optional(),
    adminMode: z.string().max(32).optional(),
    // Rendered fact text (with name/pronouns already substituted) for voiceover cue
    renderedFactText: z.string().max(1000).optional(),
    isPrivate: z.boolean().optional(),
  })
  .refine((data) => data.imageUrl || data.imageBase64, {
    message: "Either imageUrl or imageBase64 must be provided",
  });

function resolveImageUrl(raw: string | undefined, req: Request): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("/")) {
    const proto = req.get("x-forwarded-proto") || "https";
    const host = req.get("host") || "localhost";
    return `${proto}://${host}${raw}`;
  }
  return raw;
}

const _objectStorage = new ObjectStorageService();

/**
 * A caller-supplied image URL pointing at one of our private storage objects.
 * The two forms authorize DIFFERENTLY, so we tag which one it is:
 *
 *   - "ai-reference": /memes/ai-user/image?storagePath=...  → ownership of the
 *     `user_ai_images` row. These objects carry a PUBLIC object ACL, so the ACL
 *     check is NOT sufficient (it would grant everyone).
 *   - "object": /api/storage/objects/{subPath}  → the object ACL (+ legacy
 *     upload-owner fallback), i.e. userCanReadObject.
 */
type PrivateObjectRef =
  | { kind: "ai-reference"; storagePath: string }
  | { kind: "object"; objectsPath: string };

function extractPrivateObjectRef(imageUrl: string): PrivateObjectRef | null {
  try {
    const u = new URL(imageUrl);

    // Form 1: AI reference image query-param style.
    if (u.pathname.includes("/memes/ai-user/image")) {
      const storagePath = u.searchParams.get("storagePath");
      if (storagePath && storagePath.startsWith("/objects/")) {
        return { kind: "ai-reference", storagePath };
      }
      return null;
    }

    // Form 2: /api/storage/objects/{subPath}.
    const OBJECTS_PREFIX = "/api/storage/objects/";
    const idx = u.pathname.indexOf(OBJECTS_PREFIX);
    if (idx !== -1) {
      const subPath = u.pathname.slice(idx + OBJECTS_PREFIX.length);
      if (subPath) return { kind: "object", objectsPath: `/objects/${subPath}` };
    }

    return null;
  } catch {
    return null;
  }
}

/** Thrown when the caller is not authorized to read the requested private
 * object. The route translates this to a 403 — it must NOT fall back to using
 * the original private URL. */
class ObjectAccessForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "ObjectAccessForbiddenError";
  }
}

/** Download an authorized object from GCS and re-host it on fal's transient
 * CDN so the video model can fetch it. Returns null on a transient fetch/upload
 * failure (caller falls back to the original URL). */
async function rehostObjectToFal(objectFile: File): Promise<string | null> {
  try {
    const response = await _objectStorage.downloadObject(objectFile, 60);
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await response.arrayBuffer());
    const blob = new Blob([buf], { type: contentType });
    const cdnUrl = await fal.storage.upload(blob, { lifecycle: { expiresIn: "1h" } });
    // Do not log the private object path or the transient CDN URL.
    logger.info("[videos/generate] Re-hosted an authorized private image to fal CDN");
    return cdnUrl;
  } catch (err) {
    logger.warn({ err }, "[videos/generate] Failed to re-host private image to fal CDN");
    return null;
  }
}

/**
 * If `imageUrl` points to one of our private storage objects, authorize the
 * caller's READ using the SAME policy that object's serving route enforces,
 * then download it and re-host it on fal's public CDN for the video model.
 *
 * SECURITY: without this, any authenticated (Legendary) user could pass another
 * user's storagePath and have the server fetch + re-host their private image
 * (IDOR). The two URL forms authorize differently — AI reference images by
 * `user_ai_images` ownership (they carry a public object ACL, so the ACL alone
 * grants everyone), storage objects by the object ACL (+ upload-owner fallback).
 * Throws `ObjectAccessForbiddenError` when the caller isn't allowed; the route
 * translates that to 403 and must NOT use the original URL.
 *
 * Returns the fal CDN URL on success, or null if `imageUrl` is not one of our
 * private storage objects (caller uses the original URL unchanged).
 */
async function uploadPrivateImageToFalCdn(imageUrl: string, req: Request): Promise<string | null> {
  const ref = extractPrivateObjectRef(imageUrl);
  if (!ref) return null;

  if (ref.kind === "ai-reference") {
    // Mirror GET /memes/ai-user/image: authorize by user_ai_images ownership
    // (the object ACL is public and would grant everyone).
    const userId = req.user?.id;
    if (!userId || !(await userOwnsAiReferenceImage(userId, ref.storagePath))) {
      throw new ObjectAccessForbiddenError();
    }
    let file;
    try {
      file = await _objectStorage.getObjectEntityFile(
        _objectStorage.normalizeObjectEntityPath(ref.storagePath),
      );
    } catch {
      return null;
    }
    return rehostObjectToFal(file);
  }

  // ref.kind === "object": mirror GET /storage/objects (ACL + upload fallback).
  const normalized = _objectStorage.normalizeObjectEntityPath(ref.objectsPath);
  let file;
  try {
    file = await _objectStorage.getObjectEntityFile(normalized);
  } catch {
    return null;
  }
  if (!(await userCanReadObject(_objectStorage, file, normalized, req))) {
    throw new ObjectAccessForbiddenError();
  }
  return rehostObjectToFal(file);
}

router.post("/videos/generate-prompt", requireAdmin, async (req, res) => {
  const styleId = (req.body as Record<string, unknown>)?.styleId as string | undefined;
  const style = (styleId ? await getVideoStyleById(styleId) : null) ?? await getVideoStyleById(DEFAULT_STYLE_ID);
  const prompt = style?.motionPrompt ?? FALLBACK_PROMPT;
  res.json({ prompt });
});

router.get("/video/:videoId", async (req, res) => {
  const videoId = parseInt(req.params.videoId ?? "", 10);
  if (isNaN(videoId) || videoId <= 0) {
    res.status(400).json({ error: "Invalid videoId" });
    return;
  }

  const [video] = await db
    .select({
      id: videoJobsTable.id,
      factId: videoJobsTable.factId,
      imageUrl: videoJobsTable.imageUrl,
      videoUrl: videoJobsTable.videoUrl,
      motionPrompt: videoJobsTable.motionPrompt,
      styleId: videoJobsTable.lookStyleId,
      status: videoJobsTable.status,
      isPrivate: videoJobsTable.isPrivate,
      createdAt: videoJobsTable.createdAt,
    })
    .from(videoJobsTable)
    .where(
      and(
        eq(videoJobsTable.id, videoId),
        eq(videoJobsTable.status, "completed"),
        eq(videoJobsTable.isPrivate, false),
      ),
    )
    .limit(1);

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  // Find the associated meme by imageUrl to get the frozen rendered fact text
  const [meme] = await db
    .select({ createdById: memesTable.createdById, factId: memesTable.factId, renderedFactText: memesTable.renderedFactText })
    .from(memesTable)
    .where(eq(memesTable.imageUrl, video.imageUrl))
    .limit(1);

  let factText: string | null = null;
  if (meme) {
    if (meme.renderedFactText) {
      // Use the frozen text stored at meme creation time
      factText = meme.renderedFactText;
    } else {
      // Fallback: dynamically render for memes predating the renderedFactText column
      const [fact] = await db
        .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
        .from(factsTable)
        .where(eq(factsTable.id, meme.factId))
        .limit(1);

      let createdByName: string | null = null;
      let creatorPronouns: string | null = null;
      if (meme.createdById) {
        const [user] = await db
          .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
          .from(usersTable)
          .where(eq(usersTable.id, meme.createdById))
          .limit(1);
        createdByName = user?.displayName ?? null;
        creatorPronouns = user?.pronouns ?? null;
      }

      const rawTemplate = fact?.text ?? fact?.canonicalText ?? "";
      factText = createdByName && rawTemplate
        ? renderPersonalized(rawTemplate, createdByName, creatorPronouns)
        : (fact?.canonicalText ?? fact?.text ?? null);
    }
  }

  res.json({ video: { ...video, factText } });
});

router.get("/videos/:factId", async (req, res) => {
  const factId = parseInt(req.params.factId ?? "", 10);
  if (isNaN(factId) || factId <= 0) {
    res.status(400).json({ error: "Invalid factId" });
    return;
  }

  const clientIp = getClientIp(req);
  const viewerUserId = req.isAuthenticated() ? req.user.id : null;

  const videos = await db
    .select({
      id: videoJobsTable.id,
      factId: videoJobsTable.factId,
      imageUrl: videoJobsTable.imageUrl,
      videoUrl: videoJobsTable.videoUrl,
      motionPrompt: videoJobsTable.motionPrompt,
      styleId: videoJobsTable.lookStyleId,
      falRequestId: videoJobsTable.falRequestId,
      status: videoJobsTable.status,
      isPrivate: videoJobsTable.isPrivate,
      userId: videoJobsTable.userId,
      createdAt: videoJobsTable.createdAt,
    })
    .from(videoJobsTable)
    .where(
      and(
        eq(videoJobsTable.factId, factId),
        eq(videoJobsTable.status, "completed"),
        or(
          eq(videoJobsTable.isPrivate, false),
          viewerUserId ? eq(videoJobsTable.userId, viewerUserId) : eq(videoJobsTable.ipAddress, clientIp),
        ),
      ),
    )
    .orderBy(desc(videoJobsTable.createdAt));

  res.json({ videos });
});

router.post("/videos/generate", async (req, res) => {
  const governanceGate = enforceGovernance(req, res, {
    path: "video",
    provider: "fal",
    model: String((req.body as Record<string, unknown>)?.videoModel ?? ""),
    estimatedCostUsd: 0.12,
    maxDurationSec: Number((req.body as Record<string, unknown>)?.adminDuration ?? 5),
    payloadBytes: Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8"),
  });
  if (!governanceGate.ok) return;
  const governanceStartedAt = Date.now();
  let governanceActualCostUsd = 0;
  let governanceFailed = false;
  try {
  if (!getFalApiKey()) {
    res
      .status(503)
      .json({
        error:
          "Video generation is not configured. The FAL_AI_API_KEY environment variable is missing.",
      });
    return;
  }

  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    logger.error(
      {
        bodyKeys: Object.keys(req.body ?? {}),
        imageUrl: (req.body as Record<string, unknown>)?.imageUrl,
        hasBase64: !!(req.body as Record<string, unknown>)?.imageBase64,
        factId: (req.body as Record<string, unknown>)?.factId,
        errors: parsed.error.flatten(),
      },
      "[videos/generate] Validation failed",
    );
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  // `isAdmin` here gates admin-only PARAMETER OVERRIDES below (custom engine,
  // duration, aspect ratio, resolution, mode) — operational/debug privilege,
  // not a product entitlement, so it stays role-derived on purpose.
  // `realUserRole` (DB truth, ignoring the "view as user" toggle) is
  // deliberate: an admin previewing as a user should still be able to use
  // these debug controls.
  //
  // The `userTier`-keyed feature-flag lookup that used to live here is gone —
  // video_generation now resolves through `can(principal, ...)` below, the
  // one place a tier is allowed to be consulted for this decision.
  let isAdmin = false;
  if (req.isAuthenticated()) {
    isAdmin = req.user.realUserRole === "admin";
  }

  // Video generation requires authentication
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Login required to generate videos." });
    return;
  }

  // One resolver call decides this, for everyone. The admin exemption is not a
  // short-circuit in front of the grid any more — it is the admin row of the
  // grid, unioned in by the resolver — so turning `video_generation` off in the
  // Admin column now actually turns it off for admins, and an admin previewing
  // as a user is treated as one.
  const principal = principalFromRequest(req);
  const videoGenerationAllowed = await can(principal, "video_generation");
  if (!videoGenerationAllowed) {
    res.status(403).json({
      error: "VIDEO_GENERATION_LOCKED",
      message: "Video generation is a Legendary feature. Upgrade your membership to unlock it.",
    });
    return;
  }

  // meme_private_visibility is a separate, independently configurable grid
  // cell — `video_generation` alone does not imply it. Round 5 of PR #425's
  // review found this route persisting `isPrivate: true` unchecked, so a
  // caller with only the generation entitlement got the private-visibility
  // perk for free; `createMemeRecord.ts` fails closed on the same
  // combination and this route now matches that shape.
  const privateVisibilityAllowed = await can(principal, "meme_private_visibility");
  if (parsed.data.isPrivate && !privateVisibilityAllowed) {
    res.status(403).json({
      error: "PRIVATE_VISIBILITY_LOCKED",
      message: "Private videos are a Legendary feature. Upgrade your membership to unlock it.",
    });
    return;
  }

  const clientIp = getClientIp(req);

  if (!isAdmin) {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

    const recentJobs = await db
      .select({ id: videoJobsTable.id })
      .from(videoJobsTable)
      .where(
        and(
          eq(videoJobsTable.ipAddress, clientIp),
          gte(videoJobsTable.createdAt, windowStart),
        ),
      );

    if (recentJobs.length >= RATE_LIMIT_MAX) {
      res.status(429).json({
        error:
          "Rate limit exceeded. You have generated 3 videos in the past 24 hours. Please try again later.",
      });
      return;
    }
  }

  ensureFalConfigured();

  let imageUrl = resolveImageUrl(parsed.data.imageUrl, req);

  if (imageUrl) {
    try {
      const cdnUrl = await uploadPrivateImageToFalCdn(imageUrl, req);
      if (cdnUrl) imageUrl = cdnUrl;
    } catch (err) {
      if (err instanceof ObjectAccessForbiddenError) {
        res.status(403).json({ error: "You don't have access to that image." });
        return;
      }
      throw err;
    }
  }

  if (!imageUrl && parsed.data.imageBase64) {
    try {
      const base64Data = parsed.data.imageBase64.replace(
        /^data:image\/\w+;base64,/,
        "",
      );
      const buffer = Buffer.from(base64Data, "base64");
      const blob = new Blob([buffer], { type: "image/jpeg" });
      imageUrl = await fal.storage.upload(blob, {
        lifecycle: { expiresIn: "1h" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res
        .status(500)
        .json({ error: `Failed to upload image for processing: ${message}` });
      return;
    }
  }

  // Resolve style:
  // - valid styleId → use that style
  // - invalid styleId (unrecognised but provided) → default to "cinematic"
  // - no styleId provided → LLM-generated path (legacy backwards-compat)
  const rawStyleId = parsed.data.styleId?.trim();
  const styleIdProvided = rawStyleId !== undefined && rawStyleId !== "";
  const resolvedStyle =
    (rawStyleId ? await getVideoStyleById(rawStyleId) : null) ??
    (styleIdProvided ? await getVideoStyleById(DEFAULT_STYLE_ID) : null);
  const styleId = resolvedStyle?.id ?? DEFAULT_STYLE_ID;

  // Determine motion prompt:
  // 1. Explicit manual motionPrompt in request → use it as-is
  // 2. Otherwise → use the resolved style's pre-defined motionPrompt (never calls LLM)
  let motionPrompt = parsed.data.motionPrompt?.trim() || "";

  if (!motionPrompt) {
    const effectiveStyle = resolvedStyle ?? await getVideoStyleById(DEFAULT_STYLE_ID);
    motionPrompt = effectiveStyle?.motionPrompt ?? FALLBACK_PROMPT;
  }

  // ── Resolve engine ────────────────────────────────────────────────────────
  // Admin override (id or fal endpoint) wins; otherwise fall back to the
  // default video engine from the engines table.
  let engine: Engine | null = null;
  const requestedModel = parsed.data.videoModel?.trim();
  if (requestedModel && isAdmin) {
    engine = await resolveEngineFromOverride(requestedModel);
    if (!engine) {
      res.status(400).json({
        error: `Unknown engine "${requestedModel}". Expected an engines.id or engines.endpoint_id.`,
      });
      return;
    }
  }
  if (!engine) {
    try {
      engine = await loadDefaultEngine("video");
    } catch (err) {
      logger.error({ err }, "[videos/generate] No default video engine configured");
      res.status(503).json({ error: "Video engine is not configured." });
      return;
    }
  }
  const endpointId = engine.endpointId;

  // ── Resolve pipeline params (engine row provides defaults) ─────────────────
  // Admin per-request overrides win, then engine defaults from the table.
  // Computed here (before the job row exists) because the budget gate below
  // needs aspectRatio/resolution/durationSec to price the request.
  const durationStr =
    (isAdmin && parsed.data.adminDuration) || String(engine.defaultDurationSec ?? 6);
  const durationSec = parseInt(durationStr, 10) || (engine.defaultDurationSec ?? 6);
  const aspectRatio =
    (isAdmin && parsed.data.adminAspectRatio) || engine.defaultAspectRatio || "16:9";
  const resolution =
    (isAdmin && parsed.data.adminResolution) || engine.defaultResolution || "720p";
  const mode = (isAdmin && parsed.data.adminMode) || engine.defaultMode || undefined;

  // ── Budget gate ──────────────────────────────────────────────────────────────
  // Runs BEFORE the job row is created (#409 round 2). Round 1 ran this after
  // insertion and cleaned up (mark-failed / best-effort delete) on denial, but
  // a best-effort delete can itself fail during the same outage that caused
  // the gate to fail, leaving a `pending` row the rate-limit check below still
  // counts. Gating first means a denied or failed check needs no cleanup at
  // all — there is nothing to leave behind.
  const authenticatedUserId = req.isAuthenticated()
    ? (req.user as { id?: string })?.id ?? null
    : null;
  let estimatedCostUsd = 0;
  let cachedPriceForRecording: CachedPrice | null = null;

  if (authenticatedUserId) {
    let priced: { price: CachedPrice; costUsd: number } | null = null;
    try {
      const price = await getCachedPrice(endpointId);
      const dims = resolveVideoDimensions(aspectRatio, resolution);
      const DEFAULT_FPS = 24;
      const costUsd = computeVideoCost(
        { width: dims.width, height: dims.height, fps: DEFAULT_FPS, durationSeconds: durationSec },
        price,
      ).costUsd;
      priced = { price, costUsd };
    } catch (err) {
      // Pricing unavailable — fail open, log and continue. Deliberately its
      // own catch, separate from the gate call below: a gate failure must
      // never be swallowed here as if it were a pricing miss (#409).
      logger.warn({ err, endpointId }, "[videos/generate] Budget gate skipped (pricing unavailable)");
    }

    if (priced) {
      try {
        // Deliberately outside the catch above (#409): a gate failure is not
        // a pricing failure, and must propagate rather than be swallowed.
        const budget = await checkBudget(authenticatedUserId, priced.costUsd);
        if (!budget.allowed) {
          res.status(429).json({
            error: "BUDGET_EXCEEDED",
            currentSpend: budget.currentSpend,
            limit: budget.limit,
            remainingBudget: budget.remainingBudget,
            upgradePath: "/upgrade",
          });
          return;
        }
        cachedPriceForRecording = priced.price;
        estimatedCostUsd = priced.costUsd;
      } catch (err) {
        if (err instanceof BudgetGateError) {
          // The gate could not answer — this is the server's fault, not the
          // user's. Deny with a retry-able 503, not the 429 above: conflating
          // the two would tell someone hitting a transient database error to
          // go buy more credit.
          res.status(503).json({ error: err.message });
          return;
        }
        throw err;
      }
    }
  }

  const [job] = await db
    .insert(videoJobsTable)
    .values({
      factId: parsed.data.factId,
      imageUrl: imageUrl!,
      motionPrompt,
      lookStyleId: styleId,
      videoEngineId: engine.id,
      status: "pending",
      ipAddress: clientIp,
      userId: req.isAuthenticated() ? req.user.id : null,
      isPrivate: parsed.data.isPrivate ?? false,
      // This route is the SECOND writer of `video_jobs`, and it records its own
      // request's decision rather than deferring to the pipeline's. A
      // placeholder here would be a live writer claiming not to know what
      // authorized the job it is creating.
      authorizationSnapshot: buildAuthorizationSnapshot(principal, {
        video_generation: videoGenerationAllowed,
        meme_private_visibility: privateVisibilityAllowed,
      }),
    })
    .returning();

  if (!job) {
    res.status(500).json({ error: "Failed to create video job record." });
    return;
  }

  // ── Build pipeline params for the interpreter ─────────────────────────────
  // Pipeline-level keys are camelCase and engine-agnostic; the engine's
  // paramSchema maps them to the fal endpoint's actual input shape.
  const pipelineParams: Record<string, unknown> = {
    imageUrl: imageUrl!,
    motionPrompt,
    durationSec,
    aspectRatio,
    resolution,
    generateAudio:
      parsed.data.adminGenerateAudio !== undefined
        ? parsed.data.adminGenerateAudio
        : true,
    endUserId: req.isAuthenticated() ? (req.user as { id?: string })?.id ?? null : null,
    negativePrompt: parsed.data.adminNegativePrompt,
    mode,
  };

  // ── Audio handling: route renderedFactText into the right per-engine slot ─
  const renderedFactText = parsed.data.renderedFactText?.trim() ?? null;
  const augmented = applyAudioHandling(engine, pipelineParams, renderedFactText);

  // ── Build the fal.subscribe input ─────────────────────────────────────────
  let falInput: Record<string, unknown>;
  try {
    falInput = buildEngineInput(engine, augmented);
  } catch (err) {
    if (err instanceof MissingRequiredParamError) {
      await db.update(videoJobsTable).set({ status: "failed" }).where(eq(videoJobsTable.id, job.id));
      logger.error(
        { engineId: engine.id, paramName: err.paramName, from: err.fromKey },
        "[videos/generate] Engine paramSchema missing required value",
      );
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  logger.info(
    {
      engineId: engine.id,
      endpointId,
      falInput: { ...falInput, image_url: (falInput.image_url as string)?.slice(0, 120) },
    },
    "[videos/generate] Calling fal.subscribe",
  );

  try {
    const result = await fal.subscribe(
      endpointId,
      {
        input: falInput,
        logs: false,
        headers: {
          "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
            expiration_duration_seconds: null,
          }),
        },
      },
    );

    const falRequestId = result.requestId ?? null;
    const output = result.data as { video?: { url?: string } };
    const videoUrl = output?.video?.url;

    if (!videoUrl) {
      await db
        .update(videoJobsTable)
        .set({ status: "failed", falRequestId })
        .where(eq(videoJobsTable.id, job.id));
      res
        .status(500)
        .json({
          error: "Video generation completed but no video URL was returned.",
        });
      return;
    }

    const [updated] = await db
      .update(videoJobsTable)
      .set({ status: "completed", videoUrl, falRequestId })
      .where(eq(videoJobsTable.id, job.id))
      .returning({
        id: videoJobsTable.id,
        factId: videoJobsTable.factId,
        imageUrl: videoJobsTable.imageUrl,
        videoUrl: videoJobsTable.videoUrl,
        motionPrompt: videoJobsTable.motionPrompt,
        styleId: videoJobsTable.lookStyleId,
        falRequestId: videoJobsTable.falRequestId,
        status: videoJobsTable.status,
        createdAt: videoJobsTable.createdAt,
      });

    // Record cost AFTER successful job completion (spec: not before, to avoid phantom costs)
    if (authenticatedUserId && cachedPriceForRecording && estimatedCostUsd > 0) {
      const dims = resolveVideoDimensions(aspectRatio, resolution);
      const { billingUnits } = computeVideoCost(
        { width: dims.width, height: dims.height, fps: 24, durationSeconds: durationSec },
        cachedPriceForRecording,
      );
      await recordCost({
        userId: authenticatedUserId,
        jobType: "video",
        endpointId,
        unitPriceAtCreation: cachedPriceForRecording.unitPrice,
        billingUnits,
        computedCostUsd: estimatedCostUsd,
        pricingFetchedAt: cachedPriceForRecording.fetchedAt,
        jobReferenceId: result.requestId ?? updated?.id?.toString() ?? null,
      });
    }

    const responseBody = {
      videoUrl,
      id: updated?.id,
      status: "completed",
      record: updated ?? null,
    };
    governanceActualCostUsd = estimatedCostUsd;
    res.json(responseBody);
  } catch (err) {
    await db
      .update(videoJobsTable)
      .set({ status: "failed" })
      .where(eq(videoJobsTable.id, job.id));
    const message = err instanceof Error ? err.message : "Unknown error";
    // Log all enumerable properties on the error to capture fal.ai error body
    const errDetails: Record<string, unknown> = { message };
    if (err && typeof err === "object") {
      for (const key of Object.keys(err)) {
        try {
          const val = (err as Record<string, unknown>)[key];
          errDetails[key] = val;
        } catch { /* skip */ }
      }
      // Also try cause, status, body which may be non-enumerable
      for (const key of ["status", "body", "cause", "statusCode", "detail"]) {
        if (key in (err as object)) errDetails[key] = (err as Record<string, unknown>)[key];
      }
    }

    // Parse fal.ai error body to extract structured detail
    let parsedBody: { detail?: Array<{ type?: string; msg?: string; loc?: string[] }> } | null = null;
    try {
      if (errDetails.body) {
        parsedBody = typeof errDetails.body === "string"
          ? JSON.parse(errDetails.body)
          : errDetails.body as unknown as typeof parsedBody;
      }
    } catch { /* ignore parse errors */ }

    logger.error(
      {
        engineId: engine.id,
        endpointId,
        message: errDetails.message,
        status: errDetails.status,
        requestId: errDetails.requestId,
        // Fully serialize nested objects so pydantic detail arrays are readable
        body: errDetails.body !== undefined ? JSON.stringify(errDetails.body) : undefined,
        cause: errDetails.cause !== undefined ? JSON.stringify(errDetails.cause) : undefined,
      },
      "[videos/generate] fal.subscribe failed",
    );

    // Surface a specific, helpful message for known fal.ai error types
    let userFacingError = `Video generation failed: ${message}`;
    const firstDetail = parsedBody?.detail?.[0];
    if (firstDetail?.type === "content_policy_violation") {
      userFacingError =
        "Seedance 2.0 does not allow images containing real people's faces or likenesses. " +
        "Please switch to Grok Imagine or another model, or use a background-only image.";
    } else if (firstDetail?.msg) {
      userFacingError = `Video generation failed: ${firstDetail.msg}`;
    }

    res
      .status(500)
      .json({ error: userFacingError });
  }
  } catch (error) {
    governanceFailed = true;
    throw error;
  } finally {
    completeGovernance(req, {
      provider: "fal",
      latencyMs: Date.now() - governanceStartedAt,
      failed: governanceFailed || res.statusCode >= 400,
      actualCostUsd: !governanceFailed && res.statusCode < 400 ? governanceActualCostUsd : 0,
      responseStatus: res.statusCode,
      idempotencyKey: governanceGate.idempotencyKey,
    });
  }
});

// ─── Wizard catalog routes ────────────────────────────────────────────────────

/**
 * Engine catalog for the wizard. Filters by feature-flag visibility so casual
 * LEGEND users see only the default engine; admins and `engine_experiments`
 * flag holders see the full list.
 *
 * paramSchema is stripped — clients don't need the parameter mapping.
 */
router.get("/engines", async (req, res) => {
  const rawKind = String(req.query.kind ?? "video");
  if (rawKind !== "image" && rawKind !== "video" && rawKind !== "utility") {
    res.status(400).json({ error: "Invalid kind. Expected image | video | utility." });
    return;
  }
  const kind = rawKind;

  // Per-user feature-flag predicate. Until a per-user flag table exists we
  // grant `engine_experiments` to admins only; the rest of LEGEND tier sees
  // just the default. The predicate is intentionally local to the route so
  // future per-user flag wiring can drop in here without touching the
  // interpreter.
  const isAdmin = req.isAuthenticated() && req.user.realUserRole === "admin";
  const userHasFlag = isAdmin
    ? (_flag: string) => true
    : (_flag: string) => false;

  const engines = await loadActiveEngines(kind, { userHasFlag });

  // The DB stores aspect ratios in fal.ai format ("16:9", "9:16", "1:1") for
  // server-side validation (validateEngineParams converts wizard→fal before
  // comparing). The client DTO contract speaks wizard format
  // ("landscape", "portrait", "square"), so we convert at the boundary.
  const FAL_TO_WIZARD: Record<string, string> = {
    "16:9": "landscape",
    "9:16": "portrait",
    "1:1": "square",
  };
  const toWizard = (v: string) => FAL_TO_WIZARD[v] ?? v;

  res.json(
    engines.map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      allowedDurationsSec: e.allowedDurationsSec ?? null,
      defaultDurationSec: e.defaultDurationSec ?? null,
      allowedResolutions: e.allowedResolutions ?? null,
      defaultResolution: e.defaultResolution ?? null,
      allowedAspectRatios: Array.isArray(e.allowedAspectRatios)
        ? e.allowedAspectRatios.map((r) => toWizard(String(r)))
        : null,
      defaultAspectRatio: e.defaultAspectRatio ? toWizard(e.defaultAspectRatio) : null,
      supportedModes: e.supportedModes ?? null,
      defaultMode: e.defaultMode ?? null,
      audioHandling: e.audioHandling,
      isDefault: e.isDefault,
      sortOrder: e.sortOrder,
    })),
  );
});

/**
 * Public look-styles catalog. Strips the prompt suffixes which are server-only.
 */
router.get("/look-styles", async (_req, res) => {
  const styles = await db
    .select({
      id: lookStylesTable.id,
      label: lookStylesTable.label,
      description: lookStylesTable.description,
      previewImagePath: lookStylesTable.previewImagePath,
      sortOrder: lookStylesTable.sortOrder,
    })
    .from(lookStylesTable)
    .where(eq(lookStylesTable.isActive, true))
    .orderBy(asc(lookStylesTable.sortOrder), asc(lookStylesTable.id));
  res.json(styles);
});

/**
 * Public motion-presets catalog. Strips motionPrompt (server-only — clients
 * select by id and the server resolves the prompt at generate time).
 */
router.get("/motion-presets", async (_req, res) => {
  const presets = await db
    .select({
      id: motionPresetsTable.id,
      label: motionPresetsTable.label,
      description: motionPresetsTable.description,
      cameraMotion: motionPresetsTable.cameraMotion,
      motionIntensity: motionPresetsTable.motionIntensity,
      previewGifPath: motionPresetsTable.previewGifPath,
      sortOrder: motionPresetsTable.sortOrder,
      gradientFrom: motionPresetsTable.gradientFrom,
      gradientTo: motionPresetsTable.gradientTo,
    })
    .from(motionPresetsTable)
    .where(eq(motionPresetsTable.isActive, true))
    .orderBy(asc(motionPresetsTable.sortOrder), asc(motionPresetsTable.id));
  res.json(presets);
});

// ─── Legacy: Video Styles (admin tooling still points here) ──────────────────

router.get("/video-styles", async (_req, res) => {
  const styles = await db
    .select()
    .from(motionPresetsTable)
    .where(eq(motionPresetsTable.isActive, true))
    .orderBy(asc(motionPresetsTable.sortOrder), asc(motionPresetsTable.id));
  res.json(styles);
});

router.get("/video-styles/:id/preview-gif", async (req, res) => {
  const { id } = req.params;
  const [style] = await db
    .select({ previewGifPath: motionPresetsTable.previewGifPath })
    .from(motionPresetsTable)
    .where(eq(motionPresetsTable.id, id))
    .limit(1);

  if (!style?.previewGifPath) { res.status(404).end(); return; }

  try {
    const normalized = _objectStorage.normalizeObjectEntityPath(style.previewGifPath);
    const file = await _objectStorage.getObjectEntityFile(normalized);
    const response = await _objectStorage.downloadObject(file, 3600);
    res.redirect(302, response.url);
  } catch {
    res.status(404).end();
  }
});

export default router;
