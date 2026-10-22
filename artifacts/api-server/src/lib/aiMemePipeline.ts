/**
 * AI Meme Pipeline
 *
 * 1. Calls gpt-4o-mini to generate three scene prompt variants (male/female/neutral).
 * 2. Calls fal.ai to generate images using the scene prompts.
 *    - Standard generation: fal-ai/flux-pro/v1.1 (or admin_config override)
 *    - Reference-photo generation: fal-ai/ip-adapter-face-id-plus (or admin_config override)
 * 3. Saves each image to object storage and persists the paths on the fact record.
 *
 * Runs async (non-blocking) — callers fire-and-forget with void.
 * Should never throw — catches all errors internally.
 */

import { fal, ensureFalConfigured } from "./falClient";
import { callUtilityLLM, JUDGEMENT_REASONING_EFFORT } from "./utilityLLM";
import { ObjectStorageService } from "./objectStorage";
import { aiBackgroundKey } from "./storageKeys";
import { db } from "@workspace/db";
import { factsTable, userAiImagesTable, usersTable, enginesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getConfigInt, getConfigString } from "./adminConfig";
import { getScenePromptSystem } from "./scenePromptConfig";
import { getCachedPrice, type CachedPrice } from "./falPricing";
import { ALL_ENGINES } from "./engines";
import { computeImageCost, resolveImageSizePx } from "./costComputation";
import {
  BudgetExceededError,
  BudgetGateError,
  checkBudget,
  noteLedgerWriteFailure,
  recordCost,
} from "./budgetGate";
import { logger } from "./logger";
import { withBookkeepingTimeout } from "./bookkeepingTimeout";
import { applyFalSafetyTolerance, assertNoFalNsfwConcepts, FalSafetyTriggeredError } from "./moderation/falSafety";
import { classifyAndDecide } from "./moderation/nsfwClassifier";
import { quarantineImage } from "./moderation/quarantine";
import { ModerationRejectedError } from "./moderation/types";

/** Look up the user's nsfw mode flag with a small per-call cost. */
async function getUserNsfwModeEnabled(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const [row] = await db
      .select({ nsfwModeEnabled: usersTable.nsfwModeEnabled })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    return !!row?.nsfwModeEnabled;
  } catch (err) {
    logger.warn({ err, userId }, "[aiMemePipeline] failed to read nsfw_mode_enabled — defaulting false");
    return false;
  }
}

const DEFAULT_IMAGE_MODEL_STANDARD  = "fal-ai/flux-pro/v1.1";
const DEFAULT_IMAGE_SIZE            = "square_hd";

/**
 * Per-call cost used to gate an image generation whose real price could not be
 * resolved, so the budget gate still runs when pricing is unavailable. A
 * GATING estimate only — never written to the cost ledger, which records
 * measured prices.
 *
 * A single hardcoded number cannot be right for every model: round 1 of PR
 * #474's review caught a flat $0.03 (PuLID's figure) gating the standard
 * path's `fal-ai/flux-pro/v1.1`, seeded at $0.04.
 *
 * THE PERSISTED ROW IS THE SOURCE OF TRUTH, NOT THE CODE CATALOGUE. Round 2
 * caught the first fix reading `ALL_ENGINES`, which is only the seed:
 * `estimatedCostUsdPerCall` is in `ADMIN_EDITABLE_FIELDS`, and
 * `engines/reconcile.ts` strips those from its boot update (`codeOwnedFields`)
 * precisely so admin edits survive.
 *
 * ZERO IS A VALID PERSISTED COST, NOT A MISSING ONE. The admin PATCH validator
 * accepts any non-negative number (`adminEngines.ts:338`, `v >= 0`), so an
 * operator can deliberately waive an engine's cost. Round 3 caught an earlier
 * `n > 0` test discarding that and substituting a positive estimate, which
 * would refuse a call the operator had made free. `null` still means "no
 * estimate" and is rejected explicitly BEFORE the numeric test — `Number(null)`
 * is `0`, not `NaN`, so an implicit check would read "no estimate" as "free"
 * and price every such call at zero.
 */
function costOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // A numeric column arrives as a string; an empty one is not a zero.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function maxCost(values: readonly unknown[]): number | null {
  const nums = values.map(costOrNull).filter((n): n is number => n !== null);
  return nums.length > 0 ? Math.max(...nums) : null;
}

/** Highest per-call cost the code catalogue knows about. */
const CATALOGUE_MAX_COST_USD = maxCost(ALL_ENGINES.map((e) => e.estimatedCostUsdPerCall));

/**
 * Used only when neither source has any estimate at all — an empty engines
 * table and a catalogue with no costs. Deliberately high rather than typical:
 * this is the branch where we know least, and under-charging spends money that
 * is never recovered.
 */
const LAST_RESORT_COST_USD = 0.15;

/**
 * Resolves the gating estimate for a model, preferring the persisted engine row
 * over the seed.
 *
 * Only ever called on the degraded path (pricing already unavailable), so the
 * extra read costs nothing in the normal case.
 *
 * A FAILED READ DENIES RATHER THAN GUESSES. Round 3 of this PR's review
 * dismantled the argument that swallowing it was safe: an `engines` read can
 * fail transiently, or because that one table is inaccessible, while
 * `checkBudget`'s own queries still succeed — so the failure is NOT necessarily
 * correlated, and falling back to the catalogue could silently replace an
 * admin-set $0.08 with the seeded $0.04 and let a call through. Nor is
 * "fall back to something that cannot undercut" achievable: if the table is
 * unreadable we do not know what the persisted values are, so no derived number
 * is provably above them. That leaves the rule this gate already applies
 * everywhere else — a check that cannot determine cost denies.
 * `BudgetGateError` is the exact existing shape for that: callers translate it
 * to a retry-able failure, never to "you are out of budget" (#409).
 */
async function fallbackImageCostUsd(model: string): Promise<number> {
  let rows: Array<{ endpointId: string; cost: unknown }>;
  try {
    rows = await db
      .select({
        endpointId: enginesTable.endpointId,
        cost: enginesTable.estimatedCostUsdPerCall,
      })
      .from(enginesTable);
  } catch (err) {
    logger.error(
      { err, model },
      "[aiMemePipeline] engines table unreadable — denying rather than gating on a possibly-stale estimate",
    );
    throw new BudgetGateError(err);
  }

  // ORDER MATTERS, and not in the obvious way. A MODEL-SPECIFIC figure always
  // beats an aggregate, even a persisted aggregate — otherwise an incomplete
  // engines table silently under-gates. Concretely: the table can legitimately
  // lack a row for a model the code knows about (a seeded test database has 7
  // rows and no `fal-ai/flux-pro/v1.1`; production relies on `reconcileEngines`
  // having run at boot). Preferring `max(persisted)` over the catalogue's own
  // $0.04 entry for that model would gate it at some other engine's $0.03 —
  // reintroducing round 1's under-gating through a different door.
  const persistedExact = costOrNull(rows.find((r) => r.endpointId === model)?.cost);
  if (persistedExact !== null) return persistedExact; // admin-editable truth

  const catalogueExact = costOrNull(
    ALL_ENGINES.find((e) => e.endpointId === model)?.estimatedCostUsdPerCall,
  );
  if (catalogueExact !== null) return catalogueExact; // model-specific seed

  // Genuinely unknown model: the highest cost either source knows about, so an
  // incomplete table cannot lower the floor.
  return maxCost([maxCost(rows.map((r) => r.cost)), CATALOGUE_MAX_COST_USD]) ?? LAST_RESORT_COST_USD;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AiScenePrompts {
  fact_type: "action" | "abstract";
  male:    string;
  female:  string;
  neutral: string;
}

export interface AiMemeImages {
  male:    string[];  // object storage paths, 3 per gender
  female:  string[];
  neutral: string[];
}

// fal.ai client initialisation moved to lib/falClient.ts (single source of
// truth for FAL_AI_API_KEY/FAL_KEY lookup + fal.config). Call sites in this
// module invoke `ensureFalConfigured()` defensively before fal.subscribe.

/**
 * Detects the image content type and extension from HTTP response headers.
 * Falls back to image/jpeg / .jpg if Content-Type is absent or unrecognised.
 */
function detectImageFormat(response: Response): { contentType: string; ext: string } {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("image/png"))  return { contentType: "image/png",  ext: "png"  };
  if (ct.includes("image/webp")) return { contentType: "image/webp", ext: "webp" };
  if (ct.includes("image/gif"))  return { contentType: "image/gif",  ext: "gif"  };
  // Default: treat as JPEG (fal.ai often returns JPEG for photorealistic models)
  return { contentType: "image/jpeg", ext: "jpg" };
}

// ─── LLM scene prompt generation ─────────────────────────────────────────────

/**
 * @deprecated Legacy FLUX scene-prompt generator. The t2i/i2i engine bench and
 * the image meme generator now use the render-time image-prompt engine
 * (`lib/imagePrompt/*` + `buildAndEnqueueImagePromptAttempt`) rendering with Nano
 * Banana 2. This function survives ONLY for the per-fact AI background backfill
 * (`generateAiMemeBackgrounds`); its other callers (video, PuLID) were deleted
 * in launch Phase 4 (`docs/retired/README.md`). Do NOT wire new
 * image-generation surfaces to this path.
 */
export async function generateScenePrompts(factText: string): Promise<AiScenePrompts> {
  // The system prompt is admin-configurable (debug-overlay aware). The model +
  // sampling come from the shared General Intelligence engine, which picks the
  // right call shape for reasoning vs non-reasoning models. See lib/utilityLLM.ts.
  const systemPrompt = await getScenePromptSystem();
  const response = await callUtilityLLM({
    reasoningEffort: JUDGEMENT_REASONING_EFFORT,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Fact template: "${factText}"` },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<AiScenePrompts>;

  const factType = parsed.fact_type === "abstract" ? "abstract" : "action";
  const fallback = factType === "abstract"
    ? "Epic cinematic cosmic scene with dramatic light rays, dark nebula background, ultra high detail"
    : "Cinematic portrait of a person in dramatic lighting, ultra realistic, high quality";

  return {
    fact_type: factType,
    male:    typeof parsed.male    === "string" && parsed.male.trim()    ? parsed.male.trim()    : fallback,
    female:  typeof parsed.female  === "string" && parsed.female.trim()  ? parsed.female.trim()  : fallback,
    neutral: typeof parsed.neutral === "string" && parsed.neutral.trim() ? parsed.neutral.trim() : fallback,
  };
}

// ─── Constants (defaults — overridden at runtime by admin_config table) ────────

const DEFAULT_MAX_IMAGES_PER_GENDER = 34;

// ─── Image generation ─────────────────────────────────────────────────────────

const objectStorage = new ObjectStorageService();

/**
 * Merges admin-supplied string overrides into the fal.ai input object.
 * Numeric coercion: if the value looks like a finite number, it's cast to number.
 * Values set to "" are ignored (admin left the field blank = use default).
 */
function applyParamOverrides(input: Record<string, unknown>, overrides?: Record<string, string>): void {
  if (!overrides) return;
  for (const [key, raw] of Object.entries(overrides)) {
    if (raw === "" || raw === undefined) continue;
    const num = Number(raw);
    input[key] = Number.isFinite(num) ? num : raw;
  }
}

async function generateAndStoreImage(
  factId: number,
  gender: "male" | "female" | "neutral",
  uniqueKey: string,
  prompt: string,
  modelOverride?: string,
  paramsOverride?: Record<string, string>,
  userId?: string,
): Promise<string> {
  ensureFalConfigured();

  // Phase 6: the retired ai_image_model_standard / ai_image_size / ai_std_*
  // admin_config keys are now baked-in defaults. Admin per-request overrides
  // via `paramsOverride` still apply at the bottom of this function.
  const model             = modelOverride || DEFAULT_IMAGE_MODEL_STANDARD;
  const imageSize         = DEFAULT_IMAGE_SIZE;
  const numInferenceSteps = 28;
  const guidanceScale     = 3.5;
  const safetyTolerance   = "2";
  const outputFormat      = "jpeg";
  const aspectRatio       = "1:1";
  const ultraRaw          = false;

  const input: Record<string, unknown> = { prompt, num_images: 1 };

  if (model === "xai/grok-imagine-image") {
    delete input["num_images"];
    input["n"]            = 1;
    input["aspect_ratio"] = aspectRatio;
  } else if (model === "fal-ai/flux-pro/v1.1-ultra") {
    input["aspect_ratio"]      = aspectRatio;
    input["safety_tolerance"]  = safetyTolerance;
    input["raw"]               = ultraRaw;
    input["output_format"]     = outputFormat;
  } else if (model === "fal-ai/flux-2-pro" || model === "fal-ai/flux-2-max") {
    input["aspect_ratio"]  = aspectRatio;
    input["output_format"] = outputFormat;
  } else {
    // FLUX 1 models: dev, schnell, flux-pro, flux-pro/v1.1
    input["image_size"]            = imageSize;
    input["num_inference_steps"]   = numInferenceSteps;
    input["guidance_scale"]        = guidanceScale;
    input["output_format"]         = outputFormat;
    if (model === "fal-ai/flux-pro" || model === "fal-ai/flux-pro/v1.1") {
      input["safety_tolerance"] = safetyTolerance;
    }
  }

  // Phase 6: ai_std_seed retired; admin overrides still flow via paramsOverride.

  // Apply admin per-request overrides last — they win over all config values
  applyParamOverrides(input, paramsOverride);

  // Layer 2 (request side): set fal.ai safety_tolerance for models that
  // accept it. No-op for models whose schema rejects the field.
  await applyFalSafetyTolerance(input, model);

  // ── Budget gate ──────────────────────────────────────────────────────────────
  let cachedImgPrice: CachedPrice | null = null;
  /** The exact figure checkBudget used, or null when the gate exempted the user. */
  let gateResolvedCostUsd: number | null = null;
  if (userId) {
    let priced: { price: CachedPrice; costUsd: number } | null = null;
    try {
      const price = await getCachedPrice(model);
      const { width, height } = resolveImageSizePx(imageSize);
      const costUsd = computeImageCost({ widthPx: width, heightPx: height, count: 1 }, price).costUsd;
      priced = { price, costUsd };
    } catch (err) {
      // Pricing unavailable — fail open, log and continue. Deliberately its
      // own catch, separate from the gate call below: a gate failure must
      // never be swallowed here as if it were a pricing miss (#409).
      logger.warn({ err, model }, "[aiMemePipeline] Pricing unavailable — gating on the fallback estimate");
    }
    // Deliberately outside the catch above (#409): a gate failure is not a
    // pricing failure, and must propagate rather than be swallowed.
    //
    // The gate runs whether or not pricing resolved. This used to be
    // `if (priced)`, which skipped the check entirely on a pricing miss and
    // left the ceiling unenforced exactly when something else was failing.
    // The fallback is passed as a THUNK, not awaited here: it is only needed
      // for a user who is actually subject to a limit, and resolving it eagerly
      // would let its failure preempt checkBudget's admin exemption (round 4).
      const budget = await checkBudget(userId, async () => {
        const resolved = priced ? priced.costUsd : await fallbackImageCostUsd(model);
        // Capture what the gate ACTUALLY used rather than re-deriving it at the
        // write site. The fallback resolves through a precedence chain
        // (persisted-exact -> catalogue-exact -> max-across-persisted), so a
        // second call could legitimately return a different figure — and would
        // do so precisely when the chain fell past its first tier, i.e. exactly
        // when an estimate is being recorded at all.
        //
        // Stays null for an admin: checkBudget returns at its exemption before
        // invoking this thunk, deliberately (resolving a fallible read ahead of
        // an exemption is the ordering bug PR #474 fixed). The recording path
        // handles that case separately.
        gateResolvedCostUsd = resolved;
        return resolved;
      });
    if (!budget.allowed) throw new BudgetExceededError(budget);
    // Only a REAL price is carried forward for ledger recording.
    if (priced) cachedImgPrice = priced.price;
  }

  const result = await fal.subscribe(model, {
    input,
    logs: false,
  }) as { data: { images: Array<{ url: string }> } };

  // Layer 2 (response side): refuse outputs the model itself flagged as NSFW.
  try {
    assertNoFalNsfwConcepts(result, model);
  } catch (err) {
    if (err instanceof FalSafetyTriggeredError) {
      logger.warn({ model, factId, gender }, "[aiMemePipeline] fal safety triggered — rejecting standard generation");
      throw new ModerationRejectedError("fal_safety", "Image rejected.", {
        source: "fal_safety",
        classifierModel: model,
        raw: err.raw,
      });
    }
    throw err;
  }

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error(`No image URL returned from fal.ai model ${model}`);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download image from fal.ai: ${imgRes.status}`);
  const { contentType, ext } = detectImageFormat(imgRes);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  // Layer 3: NSFW classifier on the generated bytes (via the fal-hosted URL).
  const nsfwModeEnabled = await getUserNsfwModeEnabled(userId);
  const decision = await classifyAndDecide(imageUrl, { nsfwModeEnabled });
  if (decision.outcome === "reject") {
    try {
      await quarantineImage({
        source: "classifier",
        bytes: imageBuffer,
        mimeType: contentType,
        userId: userId ?? null,
        evidence: {
          source: "classifier",
          classifierScore: decision.score,
          classifierModel: decision.model,
          raw: decision.raw,
        },
        reportToNcmec: false,
      });
    } catch (qErr) {
      logger.error({ err: qErr }, "[aiMemePipeline] quarantine failed for classifier reject");
    }
    throw new ModerationRejectedError("classifier", "Image rejected.", {
      source: "classifier",
      classifierScore: decision.score,
      classifierModel: decision.model,
      raw: decision.raw,
    });
  }
  if (decision.outcome === "error") {
    logger.warn({ message: decision.message, model }, "[aiMemePipeline] NSFW classifier error — failing closed");
    throw new ModerationRejectedError("classifier", "Image rejected.", {
      source: "classifier",
      classifierModel: model,
      raw: { error: decision.message },
    });
  }

  const subPath = aiBackgroundKey(factId, gender, uniqueKey, ext, false);
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType,
  });

  // Set public-read ACL so thumbnails can be served via /api/storage/objects/*
  // AI meme backgrounds are non-personal scene images — public read is safe
  try {
    await objectStorage.trySetObjectEntityAclPolicy(storedPath, {
      owner: `system`,
      visibility: "public",
    });
  } catch (aclErr) {
    logger.warn({ err: aclErr, storedPath }, "[aiMemePipeline] Failed to set ACL");
  }

  // Record cost AFTER successful storage (spec: not before).
  //
  // The `if (cachedImgPrice)` guard is GONE, and that removal is the point of
  // this change: a generation gated on a fallback estimate used to be gated
  // correctly and then recorded nowhere, so across a pricing outage the
  // ceiling was measured against a total that stopped growing.
  if (userId) {
    if (cachedImgPrice) {
      const { width, height } = resolveImageSizePx(imageSize);
      const { billingUnits, costUsd } = computeImageCost(
        { widthPx: width, heightPx: height, count: 1 },
        cachedImgPrice,
      );
      await recordCost({
        userId,
        jobType: "image",
        endpointId: model,
        unitPriceAtCreation: cachedImgPrice.unitPrice,
        billingUnits,
        computedCostUsd: costUsd,
        pricingFetchedAt: cachedImgPrice.fetchedAt,
        isEstimated: false,
        jobReferenceId: storedPath,
      });
    } else {
      // Unpriced. Record the estimate the gate used, decomposed per the plan:
      // a per-call estimate is unit_price = the figure, billing_units = 1, so
      // unit_price * billing_units = computed_cost holds for every estimated
      // row. pricing_fetched_at is the WRITE time — no fetch happened, which is
      // what is_estimated = true tells a reader.
      let estimate: number | null = gateResolvedCostUsd;
      if (estimate === null) {
        // Admin: exempt, so checkBudget returned before invoking the thunk and
        // there is no gate figure to carry. Resolve it now, inside a non-fatal
        // envelope — the provider call has already completed and been paid for,
        // so a BudgetGateError thrown here would fail a generation over
        // bookkeeping. A skip is visible through the same counter as a lost
        // write rather than silent.
        try {
          estimate = await withBookkeepingTimeout(
            fallbackImageCostUsd(model),
            "exempt-user estimate lookup",
          );
        } catch (err) {
          logger.warn(
            { err, model, userId },
            "[aiMemePipeline] could not resolve an estimate for an exempt user's unpriced generation — skipping the ledger row",
          );
// Detached, not awaited: the pool checkout inside this call is
          // unbounded and this is a user-facing path. See the call site in
          // budgetGate.recordCost for the full reasoning.
          void noteLedgerWriteFailure();
        }
      }
      if (estimate !== null) {
        await recordCost({
          userId,
          jobType: "image",
          endpointId: model,
          unitPriceAtCreation: estimate,
          billingUnits: 1,
          computedCostUsd: estimate,
          pricingFetchedAt: new Date(),
          isEstimated: true,
          jobReferenceId: storedPath,
        });
      }
    }
  }

  return storedPath;
}

// ─── Per-user storage tracking ────────────────────────────────────────────────

/**
 * Records a newly generated AI image for a user.
 */
async function trackUserAiImage(
  userId: string,
  factId: number,
  gender: "male" | "female" | "neutral",
  storagePath: string,
): Promise<void> {
  await db.insert(userAiImagesTable).values({ userId, factId, gender, storagePath, imageType: "generic" });
}

// ─── Pipeline orchestration ───────────────────────────────────────────────────

/**
 * Generates AI meme backgrounds for a fact.
 * Runs the full pipeline: scene prompts → image generation → persistence.
 * Safe to call fire-and-forget: catches all errors internally.
 *
 * scope:
 *   - undefined / "full"  → generate all 9 images (3 genders × 3 indices)
 *   - "gendered"          → generate exactly 3 images (index 0 for each gender)
 *   - "abstract"          → generate exactly 1 image (neutral gender, index 0)
 *   - targetGender+targetIndex → generate a single specific image (legacy partial regen)
 */
export async function generateAiMemeBackgrounds(
  factId: number,
  factText: string,
  options?: {
    /** High-level scope shorthand; takes precedence over targetGender/targetIndex */
    scope?: "full" | "gendered" | "abstract";
    /** If provided, only regenerate one specific image (use with targetIndex) */
    targetGender?: "male" | "female" | "neutral";
    targetIndex?: number;
    /** If provided, use existing prompts from DB (skip prompt regen) */
    existingPrompts?: AiScenePrompts;
    /** Existing images to preserve when doing partial regen */
    existingImages?: AiMemeImages;
    /**
     * ID of the legendary user triggering the generation.
     * When provided, each generated image is tracked in user_ai_images and
     * the per-user 1000-image storage limit is enforced.
     * Omit for admin/system backfill operations.
     */
    userId?: string;
    /** Optional style suffix appended to each scene prompt before image generation. */
    styleSuffix?: string;
    /** Override the fal.ai model for this request (admin-only) */
    modelOverride?: string;
    /** Per-request param overrides for fal.ai (admin-only) */
    paramsOverride?: Record<string, string>;
    /** When true, errors are caught internally and logged; when false (default), errors propagate to caller */
    suppressErrors?: boolean;
  },
): Promise<void> {
  try {
    // 1. Generate scene prompts (or use existing)
    let prompts: AiScenePrompts;
    if (options?.existingPrompts) {
      prompts = options.existingPrompts;
    } else {
      logger.info({ factId }, "[aiMemePipeline] Generating scene prompts");
      prompts = await generateScenePrompts(factText);

      // Persist prompts immediately
      await db
        .update(factsTable)
        .set({ aiScenePrompts: prompts })
        .where(eq(factsTable.id, factId));
    }

    // 2. Resolve which (gender, index) slots to generate based on scope
    const scope = options?.scope ?? "full";
    let slots: Array<{ gender: "male" | "female" | "neutral"; index: number }>;

    if (scope === "abstract") {
      // 1 image: neutral, index 0
      slots = [{ gender: "neutral", index: 0 }];
    } else if (scope === "gendered") {
      // 3 images: one per gender, all at index 0
      slots = [
        { gender: "male",    index: 0 },
        { gender: "female",  index: 0 },
        { gender: "neutral", index: 0 },
      ];
    } else if (options?.targetGender !== undefined && options?.targetIndex !== undefined) {
      // Legacy single-slot regen
      slots = [{ gender: options.targetGender, index: options.targetIndex }];
    } else {
      // Full: all 9 images
      slots = (["male", "female", "neutral"] as const).flatMap(g =>
        [0, 1, 2].map(i => ({ gender: g, index: i })),
      );
    }

    // 3. Generate images for resolved slots
    // Start from existing images (filtered to remove legacy empty-string placeholders)
    const result: AiMemeImages = {
      male:    (options?.existingImages?.male    ?? []).filter(Boolean),
      female:  (options?.existingImages?.female  ?? []).filter(Boolean),
      neutral: (options?.existingImages?.neutral ?? []).filter(Boolean),
    };

    // Each generation creates a unique filename using timestamp so no two images collide
    const batchKey = Date.now();
    let slotCounter = 0;

    const userId = options?.userId;
    const maxPerGender = await getConfigInt("ai_max_images_per_gender", DEFAULT_MAX_IMAGES_PER_GENDER);

    for (const { gender } of slots) {
      const uniqueKey = `${batchKey}_${slotCounter++}`;
      const basePrompt = prompts[gender];
      const prompt = options?.styleSuffix ? `${basePrompt.trim()} ${options.styleSuffix}` : basePrompt;
      logger.info(
        { factId, gender, key: uniqueKey, modelOverride: options?.modelOverride },
        "[aiMemePipeline] Generating image",
      );
      const storedPath = await generateAndStoreImage(factId, gender, uniqueKey, prompt, options?.modelOverride, options?.paramsOverride, userId);
      // Prepend newest image at the front — gallery always shows newest-first
      result[gender].unshift(storedPath);
      // Trim per-fact gallery to max per gender
      if (result[gender].length > maxPerGender) {
        result[gender] = result[gender].slice(0, maxPerGender);
      }
      // Track per-user storage and enforce 1000-image limit (AI + uploads combined)
      if (userId) {
        try {
          await trackUserAiImage(userId, factId, gender, storedPath);
        } catch (trackErr) {
          logger.warn({ err: trackErr, userId }, "[aiMemePipeline] Failed to track user image");
        }
      }
    }

    // 4. Persist image paths — explicitly set updatedAt so polling detection always works
    await db
      .update(factsTable)
      .set({ aiMemeImages: result, updatedAt: new Date() })
      .where(eq(factsTable.id, factId));

    const totalImages = result.male.filter(Boolean).length +
      result.female.filter(Boolean).length +
      result.neutral.filter(Boolean).length;
    logger.info({ factId, totalImages, scope }, "[aiMemePipeline] AI meme images stored");
  } catch (err) {
    logger.error({ err, factId }, "[aiMemePipeline] Failed");
    if (!options?.suppressErrors) throw err;
  }
}
