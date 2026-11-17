/**
 * Phase 2 — async-job handlers for the render-time image prompt pipeline.
 *
 * Two queues, two handlers:
 *
 *   image_prompt_generation
 *     Payload: { attemptId }.
 *     1. Loads the pre-inserted image_prompt_attempts row.
 *     2. Reads the gag frozen on the attempt (scene, bubbles, cast) and
 *        resolves the look's stylePrompt from look_styles.
 *     3. Compiles the prompt directly from that gag (`compileDirect`): no
 *        planner call (plan PLAN_GAG_DIRECT_RENDER.md, D).
 *     4. Stores the compiled prompt and enqueues `image_generation`.
 *
 *   image_generation
 *     Payload: { attemptId }.
 *     1. Loads the attempt row (compiled_prompt populated).
 *     2. Resolves the engine recorded on the attempt (imageEngineRouting.ts), sizes the call (imageRequestBuilder.ts), then buildEngineInput.
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
import {
  db,
  factsTable,
  usersTable,
  imagePromptAttemptsTable,
  userAiImagesTable,
  type ImagePromptAttempt,
} from "@workspace/db";
import type { AsyncJobRow } from "@workspace/db/schema";
import {
  validateEnrichment,
  type SubjectRenderMode,
  type RenderControls,
  type SourceImageAnalysis,
  type GenerationMode,
  type FactEnrichment,
} from "@workspace/api-zod";
import { registerJobHandler, enqueueJob, terminalFailure, type JobHandler, type HandlerResult } from "./asyncJobs";
import { assertJobOwnership, fencedTransaction, jobAbortSignal } from "./jobFence";
import { finishAndStore, recordGenerationRequest, setVendorRequestId } from "./provenance/records";
import { vendorContext } from "./provenance/vendorContext";
import { attemptProvenanceContext } from "./provenance/attemptActor";
import { attemptImageEngineId, ImageEngineRoutingError, resolveImageEngine } from "./imageEngineRouting";
import { NoPhotoRenderRefusedError } from "./imagePromptAttempts";
import { buildImageRequestSettings, type ImageRequestPurpose, type ImageRequestSettings } from "./imageRequestBuilder";
import { compileDirect, type DirectCompileArgs } from "./imagePrompt/compilers/nanoBanana2";
import { directGagInput, DirectGagInputError } from "./imagePrompt/directInput";
import { engineFamilyOf, recipeById } from "./imagePrompt/recipeStore";
import type { ResolvedRecipe } from "./imagePrompt/recipe";
import type { CompiledImagePrompt } from "./imagePrompt/types";
import { generationModeFromSubjectRenderMode } from "./sourceImageAnalysis";
import { hasUnresolvedFactTokens } from "./renderCanonical";
import { isValidPromptIdentitySnapshot } from "./imagePrompt/promptIdentity";
import { resolveRenderStyle, isValidRenderStyleSnapshot } from "./imagePrompt/styleResolution";
import { buildEngineInput } from "./engineInterpreter";
import { downloadToBuffer, extractFirstImageUrl, imageEngineParams } from "./imageEngineRequest";
import { fal, ensureFalConfigured, falContentRefusal, falSubmitErrorMessage } from "./falClient";
import {
  bothRefusedMessage,
  engineFallbackOf,
  fallbackChoiceForAttempt,
  fallbackRecipe,
  recordRefusal,
  switchToFallback,
} from "./engineFallback";
import type { EngineFallbackRecord } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

export const IMAGE_PROMPT_QUEUE = "image_prompt_generation";
export const IMAGE_GENERATION_QUEUE = "image_generation";

export interface ImagePromptJobPayload {
  attemptId: number;
}

/** True for the review-panel test renders (scenario grid + single render),
 *  which set `renderControls.mirrorToLegacyStorage: false` so they don't pollute
 *  the staging fact's shared image set. */
export function isEphemeralModerationRender(renderControls: RenderControls): boolean {
  return (
    (renderControls as RenderControls & { mirrorToLegacyStorage?: boolean }).mirrorToLegacyStorage === false
  );
}

/** Moderation and eval test renders only need to show whether the visual gag
 *  lands, so they ask the request builder for the engine's smallest size
 *  (`preview`); a member's render asks for `final`, about four megapixels. */
export function requestPurposeForRenderControls(renderControls: RenderControls): ImageRequestPurpose {
  return isEphemeralModerationRender(renderControls) ? "preview" : "final";
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
      // The frozen enrichment snapshot is invalid — re-running can't fix stored
      // data, so this is terminal (§12).
      return recordTerminalAttemptFailure(
        p.attemptId,
        "invalid_persisted_enrichment",
        `enrichment snapshot invalid: ${enrichmentValidation.error}`,
      );
    }
    const enrichment = enrichmentValidation.data;

    // No picture is made without a reference photo (compiler review, Phase 2).
    // An attempt queued in the retired no-photo mode before that release is
    // refused here, terminally and legibly, never drawn some other way.
    if (attempt.subjectRenderMode === "t2i_fallback") {
      const refused = new NoPhotoRenderRefusedError();
      return recordTerminalAttemptFailure(p.attemptId, refused.code, refused.message);
    }

    // The identity (name + pronouns) used to render this attempt: the
    // compiler's final token gate renders the gag's tokens with it, so a
    // template token can never leak into the engine prompt.
    const renderedSubject = await resolveAttemptIdentity(attempt);

    // The one selected gag, frozen on the attempt when it was queued, is the
    // whole fact-specific input (plan PLAN_GAG_DIRECT_RENDER.md, D; Q11: 1).
    // No planner call: the classification frozen beside it is never read.
    let args: DirectCompileArgs;
    try {
      args = await directArgsForAttempt(attempt, enrichment, renderedSubject);
    } catch (err) {
      if (err instanceof DirectGagInputError) return recordTerminalAttemptFailure(p.attemptId, err.code, err.message);
      throw err;
    }

    // The wording chosen when the attempt was queued; none is the baseline of
    // the family of the engine recorded on the attempt. Read outside the
    // compile's try, so a database error stays retryable.
    const recipe = await recipeById(attempt.recipeVersionId, engineFamilyOf(attemptImageEngineId(attempt)));
    let compiled: CompiledImagePrompt;
    try {
      compiled = compileDirect({ ...args, recipe });
    } catch (err) {
      // A compiler throw is deterministic given the frozen inputs → terminal.
      const msg = err instanceof Error ? err.message : String(err);
      return recordTerminalAttemptFailure(p.attemptId, "compile_failed", `compile failed: ${msg}`);
    }

    // Fail-loud gate (§12): the final prompt must carry NO unresolved
    // {NAME}/{SUBJ}/… token. The compiler flags this as a warning (shared with
    // the admin preview), but at RENDER time a leaked token is terminal — we
    // refuse to ship it to the engine and never enqueue image_generation.
    if (hasUnresolvedFactTokens(compiled.imagePrompt ?? compiled.prompt ?? "")) {
      return recordTerminalAttemptFailure(
        p.attemptId,
        "moderator_core_scene_unresolved_token",
        "compiled prompt still contains an unresolved personalization token (check the gag's scene and bubbles)",
      );
    }

    // §10.5 fail-loud budget gate: the compiler never silently truncates
    // required content, so if required content alone overflowed the engine
    // budget (only reachable by legacy over-budget content — save validation
    // prevents it for new saves), fail terminal instead of shipping a prompt
    // whose policy guardrails were cut.
    const overflow = compiled.diagnostics?.requiredBudgetOverflow;
    if (overflow) {
      return recordTerminalAttemptFailure(
        p.attemptId,
        "required_budget_overflow",
        `compiled prompt exceeds the engine budget by ${overflow.overBy} characters (${overflow.totalLength}/${overflow.budget}); shorten the gag's scene`,
      );
    }

    await persistCompiledPromptAndEnqueueGeneration({
      attemptId: p.attemptId,
      compiledPrompt: compiled as unknown as Record<string, unknown>,
    });

    return { ok: true, result: { attemptId: p.attemptId, compiledPrompt: compiled } };
  },
};

/**
 * Narrow, worker-local success-path helper (a deterministic test seam, not a
 * general job-persistence abstraction): stores the compiled prompt on the
 * attempt and chains `image_generation`. A direct attempt stores no plan.
 */
export async function persistCompiledPromptAndEnqueueGeneration(args: {
  attemptId: number;
  compiledPrompt: Record<string, unknown>;
}): Promise<void> {
  // One fenced transaction (Issue #1000): the prompt and its image job land
  // together, and only while this run still owns its job.
  await fencedTransaction(db, async (tx) => {
    await tx
      .update(imagePromptAttemptsTable)
      .set({
        compiledPrompt: args.compiledPrompt,
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(imagePromptAttemptsTable.id, args.attemptId));

    await enqueueJob({
      queue: IMAGE_GENERATION_QUEUE,
      payload: { attemptId: args.attemptId } satisfies ImagePromptJobPayload,
      dedupeKey: `image_generation:attempt:${args.attemptId}`,
    }, tx);
  });
}

/**
 * An attempt as its picture's record keeps it: every column that shaped the render, with the settings computed for
 * this run. Only bookkeeping that came after it (its error, its stored path, timestamps) is left out.
 */
function attemptLineage(attempt: ImagePromptAttempt, requestSettings: ImageRequestSettings): Record<string, unknown> {
  const { error: _error, errorCode: _errorCode, generatedImageObjectPath: _path, createdAt: _c, updatedAt: _u, ...lineage } =
    attempt as ImagePromptAttempt & Record<string, unknown>;
  return { ...lineage, requestSettings };
}

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
    // A refusal already recorded and its fallback not yet switched (an earlier
    // run stopped mid-preparation): resume the preparation, never the routed
    // engine (plan PLAN_NB_FALLBACK.md, step 2).
    const priorFallback = engineFallbackOf(attempt);
    if (priorFallback?.state === "preparing") {
      return (await prepareAndSwitchFallback(attempt, priorFallback)) ?? imageGenerationHandler.run(payload, _row);
    }
    if (!attempt.compiledPrompt) {
      return { ok: false, error: `image_generation: attempt ${p.attemptId} has no compiledPrompt` };
    }

    const compiled = attempt.compiledPrompt as { imagePrompt?: string; prompt?: string; referenceImageUrl?: string };
    const promptText = compiled.imagePrompt ?? compiled.prompt;
    if (!promptText) {
      // A stored prompt does not change between runs, so a retry cannot help
      // (David, Q17 option 1): the render fails now, with its reason.
      return recordTerminalAttemptFailure(p.attemptId, RENDER_INPUT_INVALID, "compiledPrompt has no prompt text");
    }

    const generationMode = generationModeFromSubjectRenderMode(
      attempt.subjectRenderMode as SubjectRenderMode,
    );
    // Fail fast + legibly when an i2i render has no reference image, instead of
    // the opaque MissingRequiredParamError buildEngineInput would throw later.
    if (generationMode === "i2i" && !compiled.referenceImageUrl) {
      return recordTerminalAttemptFailure(p.attemptId, RENDER_INPUT_INVALID, "i2i_missing_reference_url");
    }
    // The engine recorded at construction draws the attempt, never today's
    // default: an attempt queued before a default changed still renders
    // through the engine it was made for (and reads stale in moderation).
    const engineId = attemptImageEngineId(attempt);
    const renderControls = attempt.renderControls as RenderControls;
    let engine;
    let requestSettings: ImageRequestSettings;
    try {
      engine = await resolveImageEngine(generationMode, engineId);
      requestSettings = buildImageRequestSettings(
        engine,
        requestPurposeForRenderControls(renderControls),
        renderControls.aspectRatio,
      );
    } catch (err) {
      // An engine that cannot draw this mode stays unable to on every retry;
      // anything else here (a configuration read) may be transient.
      if (err instanceof ImageEngineRoutingError) {
        return recordTerminalAttemptFailure(p.attemptId, RENDER_INPUT_INVALID, err.message);
      }
      return retryRender(p.attemptId, err instanceof Error ? err.message : String(err));
    }
    await fencedTransaction(db, (tx) => tx
      .update(imagePromptAttemptsTable)
      .set({ requestSettings, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, p.attemptId)));
    const pipelineParams = imageEngineParams(requestSettings, {
      generationMode,
      promptText,
      aspectRatio: renderControls.aspectRatio,
      referenceImageUrl: compiled.referenceImageUrl,
    });
    logger.info(
      { attemptId: p.attemptId, engineId, generationMode, requestSettings },
      "[imagePromptJobs] submitting image_generation",
    );

    let falInput: Record<string, unknown>;
    try {
      falInput = buildEngineInput(engine, pipelineParams);
    } catch (err) {
      // Built from the stored attempt alone, so it fails the same way every time.
      return recordTerminalAttemptFailure(
        p.attemptId,
        RENDER_INPUT_INVALID,
        `buildEngineInput failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Image tracing: the exact request, its producer and who started it are
    // persisted BEFORE the vendor is called, so the record never has to be
    // rebuilt from later configuration (plan PLAN_IMAGE_TRACING.md).
    const provenance = await attemptProvenanceContext(attempt);
    const generationRequestId = await recordGenerationRequest({
      producer: provenance.producer,
      engineId: engine.id,
      endpointId: engine.endpointId,
      request: falInput,
      actor: provenance.actor,
      attemptId: p.attemptId,
      factId: attempt.factId,
    });

    ensureFalConfigured();
    // The picture is paid: check this run still owns its job immediately
    // before submitting (plan PLAN_JOB_RESUME.md §A). The wait gives up when the
    // run's effect context is stopped; a request fal already accepted is not
    // undone by that, which is what increment 2's collect-on-resume is for.
    await assertJobOwnership();
    let resultUrl: string;
    let vendorData: unknown;
    try {
      const response = await fal.subscribe(engine.endpointId, { input: falInput, logs: false, abortSignal: jobAbortSignal() });
      await setVendorRequestId(generationRequestId, (response as { requestId?: string }).requestId);
      const data = (response as { data?: unknown }).data ?? response;
      vendorData = data;
      resultUrl = extractFirstImageUrl(data);
      if (!resultUrl) {
        throw new Error("fal response missing image url");
      }
    } catch (err) {
      const refusal = falContentRefusal(err);
      if (refusal) {
        // The fallback engine refused too: the render ends here, naming both
        // refusals. No third engine and no rewording (David, Q14 option 1).
        if (priorFallback?.state === "switched") {
          return recordTerminalAttemptFailure(
            p.attemptId,
            "vendor_content_refused",
            bothRefusedMessage(priorFallback, engine.label, refusal),
          );
        }
        // A photoreal engine refused: hand over to its fallback on this first
        // refusal, with no retry on the engine that refused (Q13 option 1).
        const choice = await fallbackChoiceForAttempt(attempt, engine.id);
        if (choice) {
          const record = await recordRefusal(attempt, {
            routedEngineId: engine.id,
            reason: refusal,
            refusedGenerationRequestId: generationRequestId,
            refusedVendorRequestId: (err as { requestId?: string }).requestId ?? null,
          }, choice);
          // Then draw it on the fallback: the handler runs once more on the switched attempt.
          return (await prepareAndSwitchFallback({ ...attempt, engineFallback: record }, record))
            ?? imageGenerationHandler.run(payload, _row);
        }
        // A styled engine refused, with no fallback to hand over to: the
        // render ends now with the refusal named, instead of retrying the same
        // engine for hours behind a "Drawing…" tile (David, Q17 option 1).
        return recordTerminalAttemptFailure(
          p.attemptId,
          "vendor_content_refused",
          falSubmitErrorMessage(err, engine.label),
        );
      }
      return retryRender(p.attemptId, falSubmitErrorMessage(err, engine.label));
    }

    // Download + persist to object storage.
    let storedPath: string;
    try {
      const buf = await downloadToBuffer(resultUrl);
      // Saved under the format the engine actually returned, and recorded,
      // stamped and hashed before it is stored (image tracing).
      const stamp = Date.now();
      const finished = await finishAndStore({
        store: objectStorage,
        subPathFor: (ext) => `ai-bg-v2/${attempt.factId}/${attempt.id}-${stamp}.${ext}`,
        bytes: buf,
        kind: "ai_render",
        actor: provenance.actor,
        stamp: true,
        stampEngine: engine.label,
        generationRequestId,
        attemptId: p.attemptId,
        factId: attempt.factId,
        engineId: engine.id,
        // Everything that shaped the picture, frozen into the record: the attempt's whole planning lineage (the
        // visual plan, the compiled prompt, the source analysis and its hash, the enrichment, the identity policy),
        // which lives otherwise on a row deleted with its fact; and what the vendor returned (its seed and flags)
        // with a fingerprint of every reference picture the request named (image tracing, completeness audit).
        snapshot: {
          producer: provenance.producer,
          generationMode,
          prompt: promptText,
          renderControls,
          renderJobId: attempt.renderJobId,
          attempt: attemptLineage(attempt, requestSettings),
          ...(await vendorContext(falInput, vendorData)),
        },
      });
      storedPath = finished.objectPath;
    } catch (err) {
      return retryRender(p.attemptId, `image store failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Mark attempt complete.
    await fencedTransaction(db, (tx) => tx
      .update(imagePromptAttemptsTable)
      .set({ generatedImageObjectPath: storedPath, error: null, errorCode: null, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, p.attemptId)));

    // Mirror to facts.aiMemeImages + user_ai_images for read compatibility
    // with the legacy GET /memes/ai/:factId/image endpoint — UNLESS this is an
    // ephemeral moderation review render (mirrorToLegacyStorage === false), which
    // must verify the pipeline without polluting the staging fact's shared set.
    // The generatedImageObjectPath write above already happened, so the poll
    // route can still surface the image either way.
    const skipMirror = isEphemeralModerationRender(renderControls);
    if (!skipMirror) {
      await mirrorToLegacyStorage(attempt, storedPath);
    } else {
      logger.info(
        { attemptId: p.attemptId, factId: attempt.factId },
        "[imagePromptJobs] ephemeral review render — skipping legacy mirror",
      );
    }

    return { ok: true, result: { attemptId: p.attemptId, generatedImageObjectPath: storedPath } };
  },

  /**
   * The queue gave up on this render after its retries. Only now is the last
   * failure written to the attempt, so a render reads "rendering" while it is
   * still retrying and "failed" once the queue stops (plan PLAN_NB_FALLBACK.md,
   * Astra round 1, S2). A render that has a picture is left alone.
   */
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const attemptId = (row.payload as Partial<ImagePromptJobPayload> | null)?.attemptId;
    if (typeof attemptId !== "number") return;
    const attempt = await loadAttempt(attemptId);
    if (!attempt || attempt.generatedImageObjectPath) return;
    await markAttemptError(attemptId, row.lastError ?? "image generation abandoned after its retries");
  },
};

/**
 * A retryable image-job failure. Logged, and returned for the queue to retry;
 * the attempt is not marked failed while the queue will still retry it
 * (`onAbandon` writes it when it will not).
 */
function retryRender(attemptId: number, error: string): HandlerResult {
  logger.warn({ attemptId, error }, "[imagePromptJobs] image_generation failed; the queue will retry it");
  return { ok: false, error };
}

/**
 * Steps 2 and 3 of the photoreal fallback (`engineFallback.ts`): recompile
 * the stored scene with the fallback recipe, run the render-time gates, and
 * switch the attempt. Returns null once switched, or the terminal result when
 * the fallback prompt cannot be built; the GPT refusal stays recorded beside
 * it on `engine_fallback`. A transient error (a database read) throws and is
 * retried by the queue, and the retry resumes here.
 */
async function prepareAndSwitchFallback(
  attempt: ImagePromptAttempt,
  record: EngineFallbackRecord,
): Promise<HandlerResult | null> {
  const fail = (code: string, why: string) => recordTerminalAttemptFailure(
    attempt.id,
    code,
    `${record.routedEngineId} refused this picture under its content policy (${record.reason}); ${why}`,
  );
  const compiled = await recompileStoredAttempt(attempt, await fallbackRecipe(record));
  if (!compiled) return fail("fallback_compile_failed", `its scene could not be compiled again for ${record.fallbackEngineId}`);
  const { imagePrompt, prompt } = compiled as { imagePrompt?: string; prompt?: string };
  if (hasUnresolvedFactTokens(imagePrompt ?? prompt ?? "")) {
    return fail("moderator_core_scene_unresolved_token", `the prompt compiled for ${record.fallbackEngineId} still contains an unresolved personalization token`);
  }
  const overflow = compiled.diagnostics?.requiredBudgetOverflow;
  if (overflow) {
    return fail("required_budget_overflow", `the prompt compiled for ${record.fallbackEngineId} exceeds its budget by ${overflow.overBy} characters (${overflow.totalLength}/${overflow.budget})`);
  }
  await switchToFallback(attempt, record, compiled);
  return null;
}

export function registerImagePromptHandlers(): void {
  // `render` lane: single-item, moderator-watched renders (prompt compile + fal
  // image gen). Isolated so a "test render" never waits behind a bulk backfill.
  // Execution limit (Issue #1000): the prompt stage makes no AI call since the
  // planner was removed (plan PLAN_GAG_DIRECT_RENDER.md, D); five minutes is
  // margin for its database reads.
  registerJobHandler(IMAGE_PROMPT_QUEUE, imagePromptGenerationHandler, { lane: "render", executionLimitMs: 5 * 60_000 });
  // Execution limit (Issue #1000): the image wait has no bound of its own; kept at the old 30-minute reclaim until increment 2 collects a submitted picture instead of paying again.
  registerJobHandler(IMAGE_GENERATION_QUEUE, imageGenerationHandler, { lane: "render", executionLimitMs: 30 * 60_000 });
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
 * Resolve the identity (name + pronouns) for an attempt.
 *
 * Order of preference:
 *  1. A frozen `promptIdentity` snapshot on the attempt's renderControls — set
 *     at attempt-construction time (the prompt-reproducibility fix). This is
 *     the SAME identity that rendered the attempt's frozen `renderedFactText`,
 *     so a profile edit between enqueue and worker-run can't diverge the token
 *     gate from the fact text. The name here is already prompt-reduced.
 *  2. A legacy `reviewRenderSubject` (older moderation attempts, pre-snapshot).
 *  3. The attempt's user (display name + pronouns) — legacy user attempts.
 *  4. The canonical "Alex / they-them" fallback (anonymous/admin render).
 *
 * Used both to render legacy fact templates and as the compiler's final token gate.
 */
async function resolveAttemptIdentity(
  attempt: ImagePromptAttempt,
): Promise<{ name: string; pronouns: string | null }> {
  const rc = attempt.renderControls as RenderControls & {
    promptIdentity?: unknown;
    reviewRenderSubject?: { name: string; pronouns: string | null };
  };
  // 1. Frozen prompt-identity snapshot (new attempts).
  if (isValidPromptIdentitySnapshot(rc.promptIdentity)) {
    return { name: rc.promptIdentity.name, pronouns: rc.promptIdentity.pronouns };
  }
  // 2. Legacy moderation reviewRenderSubject.
  const reviewSubject = rc.reviewRenderSubject;
  if (reviewSubject && typeof reviewSubject.name === "string" && reviewSubject.name.trim()) {
    return { name: reviewSubject.name, pronouns: reviewSubject.pronouns ?? null };
  }
  // 3-4. Legacy live user, else canonical fallback.
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

async function markAttemptError(attemptId: number, error: string): Promise<void> {
  await fencedTransaction(db, (tx) => tx
    .update(imagePromptAttemptsTable)
    .set({ error, updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.id, attemptId)));
}

/**
 * Persist a DETERMINISTIC (terminal) prompt-generation failure and return the
 * matching queue outcome (§12).
 *
 * The queue-row terminalization and the attempt `error`/`error_code` write are
 * SEPARATE writes. If the attempt write fails transiently, terminalizing the
 * queue row anyway would strand the UI: the render poll derives failure from the
 * attempt row, so it would show `pending` forever behind a `failed` queue row.
 * So: persist first; on success return a terminal outcome; on a persist failure,
 * log the (known) deterministic code plus the persistence error and return a
 * RETRYABLE infra failure — the retry re-discovers the same deterministic state
 * and re-attempts the write. A terminal queue row can therefore never coexist
 * indefinitely with a `pending`-looking attempt.
 */
/**
 * A render whose stored input cannot be drawn: an empty prompt, a missing
 * reference photo, an engine that cannot draw the mode, or a request that
 * cannot be built. Every retry would fail the same way (David, Q17 option 1).
 */
const RENDER_INPUT_INVALID = "render_input_invalid";

async function recordTerminalAttemptFailure(
  attemptId: number,
  code: string,
  message: string,
): Promise<HandlerResult> {
  try {
    await fencedTransaction(db, (tx) => tx
      .update(imagePromptAttemptsTable)
      .set({ error: message, errorCode: code, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, attemptId)));
  } catch (persistErr) {
    const detail = persistErr instanceof Error ? persistErr.message : String(persistErr);
    logger.error(
      { attemptId, code, message, persistError: detail },
      "[imagePromptJobs] terminal failure known but error_code persist failed — returning retryable so the write is re-attempted",
    );
    return { ok: false, error: `terminal_persist_failed(${code}): ${detail}` };
  }
  return terminalFailure(code, message);
}

async function resolveStylePrompt(
  renderControls: RenderControls,
  generationMode: GenerationMode,
): Promise<string> {
  const rc = renderControls as RenderControls & {
    resolvedRenderStyle?: unknown;
    styleId?: string | null;
  };
  // 1. Frozen style snapshot (new attempts) — the render is reproducible: a
  // style edited/deactivated between enqueue and now can't change this render.
  // The compiler supplies its own photorealistic default when stylePrompt is
  // empty, so a "default" snapshot's prompt need not be threaded here — but a
  // frozen snapshot always carries the resolved prompt, so use it directly.
  if (isValidRenderStyleSnapshot(rc.resolvedRenderStyle)) {
    return rc.resolvedRenderStyle.selection === "default" ? "" : rc.resolvedRenderStyle.prompt;
  }
  // 2. Legacy attempts (no frozen snapshot): resolve live from styleId. An
  // invalid/inactive/missing style resolves to "" here (today's behavior) —
  // the terminal-failure path for a legacy invalid style is a follow-up.
  const styleId = rc.styleId;
  if (!styleId) return "";
  const resolved = await resolveRenderStyle(styleId, generationMode);
  if (resolved.selection === "selected") return resolved.prompt;
  // default → "" (compiler adds its own photorealistic default); invalid → ""
  // (legacy compatibility; unchanged from prior behavior).
  return "";
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

/**
 * Records a generated fact background where the meme builder reads it:
 * `facts.aiMemeImages`, and `user_ai_images` for the account that asked.
 *
 * It writes no `upload_image_metadata` row. That table holds a member's own
 * uploaded photos, which the meme save and the private-photo read treat as
 * theirs and My content will delete and purge (#806): a background shared by
 * every member of the fact must never be one of them. Exported for its test.
 */
export async function mirrorToLegacyStorage(attempt: ImagePromptAttempt, storedPath: string): Promise<void> {
  try {
    // Append to facts.aiMemeImages.neutral so the legacy GET image endpoint
    // can serve this background by index. Every picture starts from a photo,
    // so no render carries a fallback gender to file it under.
    const gender = "neutral" as const;
    // Row-locked read-modify-write: with the worker now running image_generation
    // handlers concurrently, two completions for the SAME fact could otherwise
    // read the same aiMemeImages array and clobber each other on write (last
    // write drops the other image). `SELECT … FOR UPDATE` serializes the append
    // on the fact row so both paths survive.
    await fencedTransaction(db, async (tx) => {
      const [factRow] = await tx
        .select({ aiMemeImages: factsTable.aiMemeImages })
        .from(factsTable)
        .where(eq(factsTable.id, attempt.factId))
        .for("update")
        .limit(1);
      if (!factRow) return;
      const current = (factRow.aiMemeImages ?? {}) as Record<string, string[]>;
      const arr = Array.isArray(current[gender]) ? [...current[gender]!] : [];
      arr.push(storedPath);
      const next = { ...current, [gender]: arr };
      await tx
        .update(factsTable)
        .set({ aiMemeImages: next as unknown as Record<string, string[]>, updatedAt: new Date() })
        .where(eq(factsTable.id, attempt.factId));
    });
    if (attempt.userId) {
      await fencedTransaction(db, (tx) => tx.insert(userAiImagesTable).values({
        userId: attempt.userId!,
        factId: attempt.factId,
        gender,
        storagePath: storedPath,
        imageType: "reference",
      }));
    }
  } catch (err) {
    logger.warn({ err, attemptId: attempt.id }, "[imagePromptJobs] mirror-to-legacy-storage failed (non-fatal)");
  }
}

/**
 * The direct compile's input for a stored attempt: the gag frozen on it, its
 * photo's mode, look, controls, reference and identity. Shared by the render
 * worker, the photoreal fallback and the prompt tuner's preview, so a preview
 * compiles exactly what a render would. Throws `DirectGagInputError` when the
 * frozen gag cannot be drawn.
 */
async function directArgsForAttempt(
  attempt: ImagePromptAttempt,
  enrichment: FactEnrichment,
  renderedSubject: { name: string; pronouns: string | null },
): Promise<DirectCompileArgs> {
  const subjectRenderMode = attempt.subjectRenderMode as SubjectRenderMode;
  const renderControls = attempt.renderControls as RenderControls;
  return {
    ...directGagInput(enrichment.visualPromptStrategyOverride),
    subjectRenderMode,
    stylePrompt: await resolveStylePrompt(renderControls, generationModeFromSubjectRenderMode(subjectRenderMode)),
    renderControls,
    referenceImageUrl: extractReferenceImageUrl(attempt),
    renderedSubject,
  };
}

/**
 * Compile a stored attempt's frozen gag again with another prompt recipe (the
 * prompt tuner's preview and the photoreal fallback). An attempt the planner
 * planned before the switch compiles the same way: its frozen gag is what it
 * drew, and its stored plan stays readable but is never compiled again. Null
 * when its frozen inputs no longer resolve.
 */
export async function recompileStoredAttempt(
  attempt: ImagePromptAttempt,
  recipe: ResolvedRecipe,
): Promise<CompiledImagePrompt | null> {
  const enrichment = validateEnrichment(attempt.factEnrichmentSnapshot);
  if (!enrichment.ok) return null;
  const renderedSubject = await resolveAttemptIdentity(attempt);
  try {
    return compileDirect({ ...(await directArgsForAttempt(attempt, enrichment.data, renderedSubject)), recipe });
  } catch (err) {
    if (err instanceof DirectGagInputError) return null;
    throw err;
  }
}

