/**
 * Phase 2 — async-job handlers for the render-time image prompt pipeline.
 *
 * Two queues, two handlers:
 *
 *   image_prompt_generation
 *     Payload: { attemptId }.
 *     1. Loads the pre-inserted image_prompt_attempts row.
 *     2. Loads fact text + enrichment, resolves stylePrompt from look_styles.
 *     3. Builds ImagePromptGenerationInput.
 *     4. Calls generateImagePromptPlan() → visualPlan + compiledPrompt + compatibility.
 *     5. Compiles via the matching Nano Banana 2 compiler.
 *     6. Updates the attempt row with the results.
 *     7. Enqueues `image_generation` for the same attemptId.
 *
 *   image_generation
 *     Payload: { attemptId }.
 *     1. Loads the attempt row (visual_plan + compiled_prompt populated).
 *     2. Calls loadEngine(nano-banana-2 or nano-banana-2-edit) + buildEngineInput.
 *     3. Submits to fal, downloads the result, uploads to object storage.
 *     4. Updates attempt row with generated_image_object_path.
 *     5. Updates facts.aiMemeImages + user_ai_images for read compatibility.
 *
 * Failure semantics: handler returns ok=false to leave the row pending +
 * record last_error (queue retries with backoff). Failed-irretrievably state
 * is also written to the attempt row's `error` so the polling endpoint can
 * surface it to the user.
 */

import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  db,
  factsTable,
  usersTable,
  lookStylesTable,
  imagePromptAttemptsTable,
  userAiImagesTable,
  uploadImageMetadataTable,
  type ImagePromptAttempt,
} from "@workspace/db";
import type { AsyncJobRow } from "@workspace/db/schema";
import {
  resolveRenderPolicy,
  validateEnrichment,
  defaultIdentityPolicyForRenderMode,
  type ImagePromptGenerationInput,
  type SubjectRenderMode,
  type IdentityPolicy,
  type RenderControls,
  type SourceImageAnalysis,
  type GenerationMode,
} from "@workspace/api-zod";
import { registerJobHandler, enqueueJob, type JobHandler, type HandlerResult } from "./asyncJobs";
import { generateImagePromptPlan, ImagePromptError } from "./imagePrompt/generator";
import { compileForSubjectRenderMode } from "./imagePrompt/compilers/nanoBanana2";
import { generationModeFromSubjectRenderMode } from "./sourceImageAnalysis";
import { renderPersonalized, hasUnresolvedFactTokens } from "./renderCanonical";
import { loadEngine, buildEngineInput } from "./engineInterpreter";
import { fal, ensureFalConfigured } from "./falClient";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

export const IMAGE_PROMPT_QUEUE = "image_prompt_generation";
export const IMAGE_GENERATION_QUEUE = "image_generation";

export interface ImagePromptJobPayload {
  attemptId: number;
}

// ─── image_prompt_generation handler ──────────────────────────────────────

const objectStorage = new ObjectStorageService();

export const imagePromptGenerationHandler: JobHandler = {
  async run(payload: unknown, _row: AsyncJobRow): Promise<HandlerResult> {
    const p = payload as ImagePromptJobPayload;
    if (typeof p.attemptId !== "number") {
      return { ok: false, error: "image_prompt_generation: payload missing attemptId" };
    }

    const attempt = await loadAttempt(p.attemptId);
    if (!attempt) {
      return { ok: false, error: `image_prompt_generation: attempt ${p.attemptId} not found` };
    }

    // Reproducible inputs: validate the enrichment SNAPSHOT frozen on the
    // attempt at insert time — NOT the fact's current enrichment, which may
    // have been re-classified since this render was requested.
    const enrichmentValidation = validateEnrichment(attempt.factEnrichmentSnapshot);
    if (!enrichmentValidation.ok) {
      await markAttemptError(p.attemptId, `enrichment snapshot invalid: ${enrichmentValidation.error}`);
      return { ok: false, error: `enrichment snapshot invalid: ${enrichmentValidation.error}` };
    }
    const enrichment = enrichmentValidation.data;

    // The identity (name + pronouns) used to render this attempt. Drives both
    // the legacy fact-text render and the compiler's final token gate, so a
    // template token can never leak into the engine prompt.
    const renderedSubject = await resolveAttemptIdentity(attempt);

    // RENDERED fact text (subject/pronouns resolved). Frozen on the attempt
    // since migration 0070; legacy rows are rendered on the fly. Either way the
    // generator must never see an unresolved {NAME}/{SUBJ} token.
    let factText: string;
    try {
      factText = await resolveRenderedFactText(attempt, renderedSubject);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, msg);
      return { ok: false, error: msg };
    }

    // Resolve style suffix per generation mode.
    const generationMode = generationModeFromSubjectRenderMode(
      attempt.subjectRenderMode as SubjectRenderMode,
    );
    const renderControls = attempt.renderControls as RenderControls;
    const identityPolicy = attempt.identityPolicy as IdentityPolicy;
    const stylePrompt = await resolveStylePrompt(renderControls, generationMode);

    const input: ImagePromptGenerationInput = {
      factText,
      enrichment,
      sourceImageAnalysis: attempt.sourceImageAnalysis as SourceImageAnalysis,
      subjectRenderMode: attempt.subjectRenderMode as SubjectRenderMode,
      userSelectedSubjectRenderMode:
        (attempt.userSelectedSubjectRenderMode as SubjectRenderMode | null) ?? null,
      identityPolicy,
      renderControls,
      // Effective render policy = Phase-1 default ← moderator override (Phase 2).
      renderPolicy: resolveRenderPolicy(enrichment),
      stylePrompt,
      referenceImageUrl: extractReferenceImageUrl(attempt),
      targetEngine: "nano_banana_2",
      requestId: attempt.requestId ?? undefined,
      // Token-renders moderator-authored override text (visual concept) before
      // the planner sees it — the planner never receives raw {NAME} tokens.
      renderedSubject,
    };

    let output;
    try {
      output = await generateImagePromptPlan(input);
    } catch (err) {
      const msg = err instanceof ImagePromptError ? err.message : err instanceof Error ? err.message : String(err);
      // Attribute the failure to the planner engine vs. fallback — a gpt-5.5
      // timeout and a fallback-path failure are different diagnoses.
      const prov = err instanceof ImagePromptError ? err.plannerProvenance : undefined;
      const provNote = prov
        ? ` [planner: ${prov.fallbackReason ? `fallback (${prov.fallbackReason})` : `${prov.model ?? "?"} via ${prov.resolvedEngineId ?? "?"}`}]`
        : "";
      await markAttemptError(p.attemptId, `prompt-gen failed: ${msg}${provNote}`);
      return { ok: false, error: `prompt-gen failed: ${msg}${provNote}` };
    }

    const compiled = compileForSubjectRenderMode({
      visualPlan: output.visualPlan,
      compiledPrompt: output.compiledPrompt,
      input,
      renderedSubject,
    });
    // Persist which planner engine produced this plan alongside the compiled
    // prompt so attempts (and the admin preview) can attribute render quality.
    if (output.plannerProvenance && compiled.diagnostics) {
      compiled.diagnostics.plannerProvenance = output.plannerProvenance;
    }

    // A "poor" subject↔fact compatibility means the uploaded subject can't
    // carry this fact — rendering anyway wastes a paid generation and produces
    // an off-target image. Block here: persist the plan + reason, surface it via
    // the poll route (which maps this error to status:"blocked"), and do NOT
    // enqueue image_generation. "risky" still proceeds but the warning rides
    // along on the poll payload.
    const compatibility = output.visualPlan.subjectFactCompatibility;
    const blockedPoor = compatibility.rating === "poor";

    await db
      .update(imagePromptAttemptsTable)
      .set({
        visualPlan: output.visualPlan,
        compiledPrompt: compiled as unknown as Record<string, unknown>,
        subjectFactCompatibility: compatibility,
        archetypeStrategyVersion: output.archetypeStrategyVersion,
        error: blockedPoor ? "subject_fact_compatibility_poor" : null,
        updatedAt: new Date(),
      })
      .where(eq(imagePromptAttemptsTable.id, p.attemptId));

    if (blockedPoor) {
      logger.info(
        { attemptId: p.attemptId, recommendedFallback: compatibility.recommendedFallback },
        "[imagePromptJobs] attempt blocked: subject_fact_compatibility=poor",
      );
      return {
        ok: true,
        result: { attemptId: p.attemptId, blocked: true, subjectFactCompatibility: compatibility },
      };
    }

    // Chain into image_generation.
    await enqueueJob({
      queue: IMAGE_GENERATION_QUEUE,
      payload: { attemptId: p.attemptId } satisfies ImagePromptJobPayload,
      dedupeKey: `image_generation:attempt:${p.attemptId}`,
    });

    return {
      ok: true,
      result: {
        attemptId: p.attemptId,
        visualPlan: output.visualPlan,
        compiledPrompt: compiled,
      },
    };
  },
};

// ─── image_generation handler ─────────────────────────────────────────────

export const imageGenerationHandler: JobHandler = {
  async run(payload: unknown, _row: AsyncJobRow): Promise<HandlerResult> {
    const p = payload as ImagePromptJobPayload;
    if (typeof p.attemptId !== "number") {
      return { ok: false, error: "image_generation: payload missing attemptId" };
    }
    const attempt = await loadAttempt(p.attemptId);
    if (!attempt) {
      return { ok: false, error: `image_generation: attempt ${p.attemptId} not found` };
    }
    if (!attempt.compiledPrompt) {
      return { ok: false, error: `image_generation: attempt ${p.attemptId} has no compiledPrompt` };
    }

    const compiled = attempt.compiledPrompt as { imagePrompt?: string; prompt?: string; referenceImageUrl?: string };
    const promptText = compiled.imagePrompt ?? compiled.prompt;
    if (!promptText) {
      await markAttemptError(p.attemptId, "compiledPrompt has no prompt text");
      return { ok: false, error: "compiledPrompt has no prompt text" };
    }

    const generationMode = generationModeFromSubjectRenderMode(
      attempt.subjectRenderMode as SubjectRenderMode,
    );
    // Fail fast + legibly when an i2i render has no reference image, instead of
    // the opaque MissingRequiredParamError buildEngineInput would throw later.
    if (generationMode === "i2i" && !compiled.referenceImageUrl) {
      await markAttemptError(p.attemptId, "i2i_missing_reference_url");
      return { ok: false, error: "i2i_missing_reference_url" };
    }
    const engineId = generationMode === "i2i" ? "nano-banana-2-edit" : "nano-banana-2";
    const engine = await loadEngine(engineId);
    if (!engine) {
      const msg = `engine ${engineId} not found in catalogue`;
      await markAttemptError(p.attemptId, msg);
      return { ok: false, error: msg };
    }

    const renderControls = attempt.renderControls as RenderControls;
    // Render at 2K. Both nano-banana-2 engines accept it; it materially lifts
    // detail/legibility for meme backgrounds at the cost of more latency/$ per
    // image and larger stored files (see PROMPT_FIDELITY_TEST_RUN.md).
    const resolution = "2K";
    const pipelineParams: Record<string, unknown> = {
      imagePrompt: promptText,
      aspectRatio: renderControls.aspectRatio,
      numImages: 1,
      resolution,
    };
    if (generationMode === "i2i" && compiled.referenceImageUrl) {
      pipelineParams["referenceImageUrl"] = compiled.referenceImageUrl;
    }
    logger.info(
      { attemptId: p.attemptId, engineId, generationMode, resolution, aspectRatio: renderControls.aspectRatio },
      "[imagePromptJobs] submitting image_generation",
    );

    let falInput: Record<string, unknown>;
    try {
      falInput = buildEngineInput(engine, pipelineParams);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, `buildEngineInput failed: ${msg}`);
      return { ok: false, error: `buildEngineInput failed: ${msg}` };
    }

    ensureFalConfigured();
    let resultUrl: string;
    try {
      const response = await fal.subscribe(engine.endpointId, { input: falInput, logs: false });
      const data = (response as { data?: unknown }).data ?? response;
      resultUrl = extractFirstImageUrl(data);
      if (!resultUrl) {
        throw new Error("fal response missing image url");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, `fal submit failed: ${msg}`);
      return { ok: false, error: `fal submit failed: ${msg}` };
    }

    // Download + persist to object storage. Measure the ACTUAL output
    // dimensions off the buffer (at 2K these are no longer 1024²) so the
    // lineage row records the truth.
    let storedPath: string;
    let outputDimensions: OutputDimensions = { width: 0, height: 0, byteSize: 0 };
    try {
      const buf = await downloadToBuffer(resultUrl);
      outputDimensions = await measureImage(buf, p.attemptId);
      const subPath = `ai-bg-v2/${attempt.factId}/${attempt.id}-${Date.now()}.png`;
      storedPath = await objectStorage.uploadObjectBuffer({
        subPath,
        buffer: buf,
        contentType: "image/png",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, `image store failed: ${msg}`);
      return { ok: false, error: `image store failed: ${msg}` };
    }

    // Mark attempt complete.
    await db
      .update(imagePromptAttemptsTable)
      .set({ generatedImageObjectPath: storedPath, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, p.attemptId));

    // Mirror to facts.aiMemeImages + user_ai_images for read compatibility
    // with the legacy GET /memes/ai/:factId/image endpoint — UNLESS this is an
    // ephemeral moderation review render (mirrorToLegacyStorage === false), which
    // must verify the pipeline without polluting the staging fact's shared set.
    // The generatedImageObjectPath write above already happened, so the poll
    // route can still surface the image either way.
    const skipMirror =
      (renderControls as RenderControls & { mirrorToLegacyStorage?: boolean }).mirrorToLegacyStorage === false;
    if (!skipMirror) {
      await mirrorToLegacyStorage(attempt, storedPath, outputDimensions);
    } else {
      logger.info(
        { attemptId: p.attemptId, factId: attempt.factId },
        "[imagePromptJobs] ephemeral review render — skipping legacy mirror",
      );
    }

    return { ok: true, result: { attemptId: p.attemptId, generatedImageObjectPath: storedPath } };
  },
};

export function registerImagePromptHandlers(): void {
  registerJobHandler(IMAGE_PROMPT_QUEUE, imagePromptGenerationHandler);
  registerJobHandler(IMAGE_GENERATION_QUEUE, imageGenerationHandler);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function loadAttempt(attemptId: number): Promise<ImagePromptAttempt | null> {
  const [row] = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.id, attemptId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the identity (display name + pronouns) for an attempt.
 *
 * Order of preference:
 *  1. A `reviewRenderSubject` frozen on the attempt's renderControls — set by an
 *     admin moderation render so the compiler's final token gate resolves the
 *     SAME sampled subject the prompt preview used (a moderation attempt is
 *     intentionally `userId:null`, which would otherwise fall through to "Alex"
 *     and silently diverge from the preview for identity-tokened overrides).
 *  2. The attempt's user (display name + pronouns).
 *  3. The canonical "Alex / they-them" fallback (anonymous/admin render).
 *
 * Used both to render legacy fact templates and as the compiler's final token gate.
 */
async function resolveAttemptIdentity(
  attempt: ImagePromptAttempt,
): Promise<{ name: string; pronouns: string | null }> {
  const reviewSubject = (attempt.renderControls as RenderControls & {
    reviewRenderSubject?: { name: string; pronouns: string | null };
  }).reviewRenderSubject;
  if (reviewSubject && typeof reviewSubject.name === "string" && reviewSubject.name.trim()) {
    return { name: reviewSubject.name, pronouns: reviewSubject.pronouns ?? null };
  }
  let name = "Alex";
  let pronouns: string | null = null;
  if (attempt.userId) {
    const [u] = await db
      .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
      .from(usersTable)
      .where(eq(usersTable.id, attempt.userId))
      .limit(1);
    if (u?.displayName) name = u.displayName;
    pronouns = u?.pronouns ?? null;
  }
  return { name, pronouns };
}

/**
 * Resolve the RENDERED (token-free) fact text for an attempt.
 *
 * Preferred path: the `renderedFactText` frozen on the row at insert time
 * (migration 0070+). Legacy rows (pre-0070) have a null column — render the
 * fact template on the fly using the supplied attempt identity. In both cases
 * we refuse to proceed if unresolved {NAME}/{SUBJ} tokens remain, so a template
 * can never leak into a production image prompt.
 */
async function resolveRenderedFactText(
  attempt: ImagePromptAttempt,
  identity: { name: string; pronouns: string | null },
): Promise<string> {
  if (attempt.renderedFactText && attempt.renderedFactText.trim()) {
    if (hasUnresolvedFactTokens(attempt.renderedFactText)) {
      throw new Error(`renderedFactText on attempt ${attempt.id} still contains unresolved tokens`);
    }
    return attempt.renderedFactText;
  }
  // Legacy fallback: render from the fact template + the attempt's identity.
  const [factRow] = await db
    .select({ text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.id, attempt.factId))
    .limit(1);
  if (!factRow) {
    throw new Error(`legacy_attempt_missing_rendered_text: fact ${attempt.factId} not found`);
  }
  const rendered = renderPersonalized(factRow.text, identity.name, identity.pronouns);
  if (hasUnresolvedFactTokens(rendered)) {
    throw new Error(`legacy_attempt_missing_rendered_text: render left unresolved tokens on attempt ${attempt.id}`);
  }
  return rendered;
}

async function markAttemptError(attemptId: number, error: string): Promise<void> {
  await db
    .update(imagePromptAttemptsTable)
    .set({ error, updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.id, attemptId));
}

async function resolveStylePrompt(
  renderControls: RenderControls,
  generationMode: GenerationMode,
): Promise<string> {
  // The wizard passes lookStyleId via renderControls? Actually it lives in
  // renderControls extension or comes via the job payload separately. We
  // stored it on the attempt row via identityPolicy/renderControls JSONB? No
  // — the attempt row has render_controls jsonb, but lookStyleId conceptually
  // lives outside render_controls. We store nothing about it on the attempt
  // today; the resolved stylePrompt string is what matters and we recompute
  // it here from a renderControls.styleId field that the route layer attaches.
  const styleId = (renderControls as RenderControls & { styleId?: string | null }).styleId;
  if (!styleId) return "";
  const [row] = await db
    .select({
      promptSuffix: lookStylesTable.promptSuffix,
      promptSuffixReference: lookStylesTable.promptSuffixReference,
    })
    .from(lookStylesTable)
    .where(eq(lookStylesTable.id, styleId))
    .limit(1);
  if (!row) return "";
  return generationMode === "i2i" ? row.promptSuffixReference : row.promptSuffix;
}

function extractReferenceImageUrl(attempt: ImagePromptAttempt): string | null {
  const analysis = attempt.sourceImageAnalysis as SourceImageAnalysis & { uploadedObjectPath?: string };
  // The route layer attaches the resolved reference URL onto sourceImageAnalysis
  // as a transient `__referenceImageUrl` property when passing to the handler.
  // Cleaner: the handler accepts a separate field. We pass it via
  // renderControls.referenceImageUrl set by the route.
  return (
    (attempt.renderControls as RenderControls & { referenceImageUrl?: string | null }).referenceImageUrl ??
    analysis.uploadedObjectPath ??
    null
  );
}

function extractFirstImageUrl(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  // Nano Banana 2 returns { images: [{ url, ... }] }.
  if (Array.isArray(obj["images"])) {
    const first = obj["images"][0];
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>)["url"] === "string") {
      return (first as Record<string, string>)["url"] ?? "";
    }
  }
  if (typeof obj["image"] === "object" && obj["image"] !== null) {
    const im = obj["image"] as Record<string, unknown>;
    if (typeof im["url"] === "string") return im["url"];
  }
  if (typeof obj["url"] === "string") return obj["url"];
  return "";
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} returned ${r.status}`);
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

interface OutputDimensions {
  width: number;
  height: number;
  byteSize: number;
}

/** Read real pixel dimensions + byte size off a generated image buffer. */
async function measureImage(buf: Buffer, attemptId: number): Promise<OutputDimensions> {
  const byteSize = buf.length;
  try {
    const meta = await sharp(buf).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0, byteSize };
  } catch (err) {
    logger.warn({ err, attemptId }, "[imagePromptJobs] could not read output image dimensions");
    return { width: 0, height: 0, byteSize };
  }
}

async function mirrorToLegacyStorage(
  attempt: ImagePromptAttempt,
  storedPath: string,
  dimensions: OutputDimensions,
): Promise<void> {
  try {
    // Append to facts.aiMemeImages[gender] so the legacy GET image endpoint
    // can serve this background by index. Gender resolution uses the
    // fallbackSubjectGender when present, else neutral.
    const renderControls = attempt.renderControls as RenderControls;
    const gender: "male" | "female" | "neutral" = renderControls.fallbackSubjectGender ?? "neutral";
    const [factRow] = await db
      .select({ aiMemeImages: factsTable.aiMemeImages })
      .from(factsTable)
      .where(eq(factsTable.id, attempt.factId))
      .limit(1);
    if (factRow) {
      const current = (factRow.aiMemeImages ?? {}) as Record<string, string[]>;
      const arr = Array.isArray(current[gender]) ? [...current[gender]!] : [];
      arr.push(storedPath);
      const next = { ...current, [gender]: arr };
      await db
        .update(factsTable)
        .set({ aiMemeImages: next as unknown as Record<string, string[]>, updatedAt: new Date() })
        .where(eq(factsTable.id, attempt.factId));
    }
    if (attempt.userId) {
      await db.insert(userAiImagesTable).values({
        userId: attempt.userId,
        factId: attempt.factId,
        gender,
        storagePath: storedPath,
        imageType: "reference",
      });
    }
    // Drop a derivative row in upload_image_metadata for lineage too — best-effort.
    try {
      // Use the measured output dimensions; fall back to the engine's nominal
      // square only if metadata couldn't be read (notNull columns).
      await db.insert(uploadImageMetadataTable).values({
        objectPath: storedPath,
        width: dimensions.width > 0 ? dimensions.width : 1024,
        height: dimensions.height > 0 ? dimensions.height : 1024,
        isLowRes: false,
        fileSizeBytes: dimensions.byteSize,
        userId: attempt.userId ?? null,
        transform: "phase2_v2",
        factId: attempt.factId,
      });
    } catch (err) {
      logger.warn({ err, storedPath }, "[imagePromptJobs] upload_image_metadata insert skipped (dup or ref)");
    }
  } catch (err) {
    logger.warn({ err, attemptId: attempt.id }, "[imagePromptJobs] mirror-to-legacy-storage failed (non-fatal)");
  }
}
