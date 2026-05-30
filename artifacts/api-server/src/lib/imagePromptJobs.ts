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

import { and, eq } from "drizzle-orm";
import {
  db,
  factsTable,
  lookStylesTable,
  imagePromptAttemptsTable,
  userAiImagesTable,
  uploadImageMetadataTable,
  type ImagePromptAttempt,
} from "@workspace/db";
import type { AsyncJobRow } from "@workspace/db/schema";
import {
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

    // Pull fact + enrichment.
    const [factRow] = await db
      .select({ text: factsTable.text, enrichment: factsTable.enrichment })
      .from(factsTable)
      .where(eq(factsTable.id, attempt.factId))
      .limit(1);
    if (!factRow) {
      await markAttemptError(p.attemptId, `fact ${attempt.factId} not found`);
      return { ok: false, error: `fact ${attempt.factId} not found` };
    }
    const enrichmentValidation = validateEnrichment(factRow.enrichment);
    if (!enrichmentValidation.ok) {
      await markAttemptError(p.attemptId, `enrichment invalid: ${enrichmentValidation.error}`);
      return { ok: false, error: `enrichment invalid: ${enrichmentValidation.error}` };
    }
    const enrichment = enrichmentValidation.data;

    // Resolve style suffix per generation mode.
    const generationMode = generationModeFromSubjectRenderMode(
      attempt.subjectRenderMode as SubjectRenderMode,
    );
    const renderControls = attempt.renderControls as RenderControls;
    const identityPolicy = attempt.identityPolicy as IdentityPolicy;
    const stylePrompt = await resolveStylePrompt(renderControls, generationMode);

    const input: ImagePromptGenerationInput = {
      factText: factRow.text,
      enrichment,
      sourceImageAnalysis: attempt.sourceImageAnalysis as SourceImageAnalysis,
      subjectRenderMode: attempt.subjectRenderMode as SubjectRenderMode,
      userSelectedSubjectRenderMode:
        (attempt.userSelectedSubjectRenderMode as SubjectRenderMode | null) ?? null,
      identityPolicy,
      renderControls,
      stylePrompt,
      referenceImageUrl: extractReferenceImageUrl(attempt),
      targetEngine: "nano_banana_2",
      requestId: attempt.requestId ?? undefined,
    };

    let output;
    try {
      output = await generateImagePromptPlan(input);
    } catch (err) {
      const msg = err instanceof ImagePromptError ? err.message : err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, `prompt-gen failed: ${msg}`);
      return { ok: false, error: `prompt-gen failed: ${msg}` };
    }

    const compiled = compileForSubjectRenderMode({
      visualPlan: output.visualPlan,
      compiledPrompt: output.compiledPrompt,
      input,
    });

    await db
      .update(imagePromptAttemptsTable)
      .set({
        visualPlan: output.visualPlan,
        compiledPrompt: compiled as unknown as Record<string, unknown>,
        subjectFactCompatibility: output.visualPlan.subjectFactCompatibility,
        archetypeStrategyVersion: output.archetypeStrategyVersion,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(imagePromptAttemptsTable.id, p.attemptId));

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
    const engineId = generationMode === "i2i" ? "nano-banana-2-edit" : "nano-banana-2";
    const engine = await loadEngine(engineId);
    if (!engine) {
      const msg = `engine ${engineId} not found in catalogue`;
      await markAttemptError(p.attemptId, msg);
      return { ok: false, error: msg };
    }

    const renderControls = attempt.renderControls as RenderControls;
    const pipelineParams: Record<string, unknown> = {
      imagePrompt: promptText,
      aspectRatio: renderControls.aspectRatio,
      numImages: 1,
    };
    if (generationMode === "i2i" && compiled.referenceImageUrl) {
      pipelineParams["referenceImageUrl"] = compiled.referenceImageUrl;
    }

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

    // Download + persist to object storage.
    let storedPath: string;
    try {
      const buf = await downloadToBuffer(resultUrl);
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
    // with the legacy GET /memes/ai/:factId/image endpoint.
    await mirrorToLegacyStorage(attempt, storedPath);

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

async function mirrorToLegacyStorage(
  attempt: ImagePromptAttempt,
  storedPath: string,
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
      await db.insert(uploadImageMetadataTable).values({
        objectPath: storedPath,
        width: 1024,
        height: 1024,
        isLowRes: false,
        fileSizeBytes: 0,
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
