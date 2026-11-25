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
 *     4. Updates attempt row with generated_image_object_path; a member's
 *        picture is delivered as theirs in the same transaction
 *        (memberPictures/settlement.ts), and never filed in the fact's
 *        shared gallery (launch Phase 7, increment 2).
 *
 * Failure semantics: handler returns ok=false to leave the row pending +
 * record last_error (queue retries with backoff). Failed-irretrievably state
 * is also written to the attempt row's `error` so the polling endpoint can
 * surface it to the user.
 */

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  imagePromptAttemptsTable,
  type ImagePromptAttempt,
} from "@workspace/db";
import type { AsyncJobRow } from "@workspace/db/schema";
import {
  validateGagRenderInput,
  type SubjectRenderMode,
  type RenderControls,
  type SourceImageAnalysis,
  type GenerationMode,
  type GagRenderInput,
} from "@workspace/api-zod";
import { registerJobHandler, enqueueJob, terminalFailure, type JobHandler, type HandlerResult } from "./asyncJobs";
import { assertJobOwnership, fencedTransaction } from "./jobFence";
import { drawOrCollect } from "./renderRequestRecovery";
import { finishAndStore, recordGenerationRequest } from "./provenance/records";
import { vendorContext } from "./provenance/vendorContext";
import { attemptProvenanceContext } from "./provenance/attemptActor";
import { attemptImageEngineId, ImageEngineRoutingError, resolveImageEngine } from "./imageEngineRouting";
import { ENGINE_REFUSED_ERROR_CODE, NoPhotoRenderRefusedError } from "./imagePromptAttempts";
import { buildImageRequestSettings, ImageRequestBuildError, type ImageRequestPurpose, type ImageRequestSettings } from "./imageRequestBuilder";
import { compileDirect, type DirectCompileArgs } from "./imagePrompt/compilers/nanoBanana2";
import { directGagInput, DirectGagInputError } from "./imagePrompt/directInput";
import { engineFamilyOf, recipeById } from "./imagePrompt/recipeStore";
import type { ResolvedRecipe } from "./imagePrompt/recipe";
import type { CompiledImagePrompt } from "./imagePrompt/types";
import { generationModeFromSubjectRenderMode } from "./sourceImageAnalysis";
import { hasUnresolvedFactTokens } from "./renderCanonical";
import { isValidPromptIdentitySnapshot, reducePromptName } from "./imagePrompt/promptIdentity";
import { resolveRenderStyle, isValidRenderStyleSnapshot } from "./imagePrompt/styleResolution";
import { buildEngineInput } from "./engineInterpreter";
import { downloadToBuffer, extractFirstImageUrl, imageEngineParams } from "./imageEngineRequest";
import { ensureFalConfigured, falContentRefusal, falPermanentRejection, falSubmitErrorMessage } from "./falClient";
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
import { deliverMemberPicture, isMemberPicture, isReturnedPicture, markReturnedPictureFailed, PictureReturnedError, RETURNED_MESSAGE, returnUndeliveredPicture } from "./memberPictures/settlement";
import { gateMemberCall, MemberSpendRefusedError, recordEngineRequestCost } from "./memberPictures/spend";
import { LATE_AFTER_RETURN_ERROR_CODE, OUTPUT_REFUSED_ERROR_CODE } from "./memberPictures/failures";
import { sniffImage } from "./provenance/imageFile";
import { imageJobDedupeKey } from "./imagePromptAttempts";
import { checkMemberPictureOutput } from "./memberPictures/outputCheck";
import { GENERIC_REJECT_MESSAGE } from "./moderation/types";
import { logger } from "./logger";

import { IMAGE_GENERATION_QUEUE, IMAGE_PROMPT_QUEUE } from "./imagePromptAttempts";
export { IMAGE_GENERATION_QUEUE, IMAGE_PROMPT_QUEUE };

/**
 * The recovery protocol the render queues implement (plan PLAN_JOB_RESUME.md
 * §A): version 1 is increment 2's — the prompt stage reuses a saved compiled
 * prompt (a saved plan, before the planner was removed), and the image job
 * collects a submitted picture instead of paying again. A row taken
 * back from a stopped holder is claimable only by a worker declaring at least
 * this, so a worker from before increment 2 never runs it.
 */
export const RENDER_RECOVERY_PROTOCOL = 1;

export interface ImagePromptJobPayload {
  attemptId: number;
}

/** True for the review-panel test renders (scenario grid + single render),
 *  which set `renderControls.mirrorToLegacyStorage: false`. The flag's name is
 *  historical: nothing is mirrored into a fact's shared gallery any more
 *  (launch Phase 7, increment 2); it now only marks a moderation render. */
export function isEphemeralModerationRender(renderControls: RenderControls): boolean {
  return (
    (renderControls as RenderControls & { mirrorToLegacyStorage?: boolean }).mirrorToLegacyStorage === false
  );
}

/** Moderation and eval test renders only need to show whether the visual gag
 *  lands, so they ask the request builder for the engine's smallest size
 *  (`preview`); a member's render asks for `final`, about one megapixel. */
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
    if (isMemberPicture(attempt) && await isReturnedPicture(p.attemptId)) return endReturned(p.attemptId);

    // Checkpoint (plan PLAN_JOB_RESUME.md §F): the compiled prompt for this
    // attempt is already saved — an earlier run stopped after saving it and
    // before its job finished. Reuse it: never compile again. Its image job
    // was enqueued in the same transaction; it is created again here only if
    // the render is still open (deduped against one in flight). Since the
    // switch a saved prompt stands alone (plan PLAN_GAG_DIRECT_RENDER.md, D),
    // so the compiled prompt is the checkpoint, not a stored plan.
    if (attempt.compiledPrompt) {
      if (!attempt.generatedImageObjectPath && !attempt.error) {
        await fencedTransaction(db, (tx) => enqueueJob({
          queue: IMAGE_GENERATION_QUEUE,
          payload: { attemptId: p.attemptId } satisfies ImagePromptJobPayload,
          dedupeKey: imageJobDedupeKey(p.attemptId),
        }, tx));
      }
      logger.info({ attemptId: p.attemptId }, "[imagePromptJobs] compiled prompt already saved for this attempt; reusing it");
      return { ok: true, result: { attemptId: p.attemptId, reusedSavedPrompt: true } };
    }

    // Reproducible inputs: validate the gag SNAPSHOT frozen on the attempt at
    // insert time — NOT the gag as it is now. A snapshot frozen before the
    // taxonomy left moderation also carries the classification, which is
    // ignored (validateGagRenderInput).
    const enrichmentValidation = validateGagRenderInput(attempt.factEnrichmentSnapshot);
    if (!enrichmentValidation.ok) {
      // The frozen enrichment snapshot is invalid — re-running can't fix stored
      // data, so this is terminal (§12).
      return recordTerminalAttemptFailure(
        p.attemptId,
        "invalid_persisted_enrichment",
        `the gag saved with this render can no longer be read, so it cannot be drawn (${enrichmentValidation.error})`,
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
    // With it, the wording chosen when the attempt was queued (none is the
    // baseline of the family of the engine recorded on the attempt), read
    // alongside, outside the compile's try, so a database error stays retryable.
    let args: DirectCompileArgs;
    let recipe: ResolvedRecipe;
    try {
      [args, recipe] = await Promise.all([
        directArgsForAttempt(attempt, enrichment, renderedSubject),
        recipeById(attempt.recipeVersionId, engineFamilyOf(attemptImageEngineId(attempt))),
      ]);
    } catch (err) {
      if (err instanceof DirectGagInputError) return recordTerminalAttemptFailure(p.attemptId, err.code, err.message);
      throw err;
    }
    let compiled: CompiledImagePrompt;
    try {
      compiled = compileDirect({ ...args, recipe });
    } catch (err) {
      // A compiler throw is deterministic given the frozen inputs → terminal.
      const msg = err instanceof Error ? err.message : String(err);
      return recordTerminalAttemptFailure(p.attemptId, "compile_failed", `the picture's prompt could not be put together from the gag (${msg})`);
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
    // A member's picture returned meanwhile is finished: its failure is not
    // cleared and no image job is queued. Decided under the attempt lock the
    // return takes, so the two cannot interleave (Codex review, PR #1300).
    const [locked] = await tx.select({ memberRequestId: imagePromptAttemptsTable.memberRequestId })
      .from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, args.attemptId)).for("update").limit(1);
    if (locked?.memberRequestId != null && await isReturnedPicture(args.attemptId, tx)) {
      await markReturnedPictureFailed(args.attemptId, tx);
      return;
    }
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
      dedupeKey: imageJobDedupeKey(args.attemptId),
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
    // A returned picture is finished: nothing more is drawn or paid for it.
    if (isMemberPicture(attempt) && !attempt.generatedImageObjectPath && await isReturnedPicture(p.attemptId)) return endReturned(p.attemptId);
    // The picture is already stored and recorded (an earlier run stopped
    // after its completion committed, before the job finished): finish
    // without drawing again (plan PLAN_JOB_RESUME.md §C).
    if (attempt.generatedImageObjectPath) {
      logger.info({ attemptId: p.attemptId }, "[imagePromptJobs] picture already stored; finishing without drawing again");
      return { ok: true, result: { attemptId: p.attemptId, generatedImageObjectPath: attempt.generatedImageObjectPath } };
    }
    // A refusal already recorded and its fallback not yet switched (an earlier
    // run stopped mid-preparation): resume the preparation, never the routed
    // engine (plan PLAN_NB_FALLBACK.md, step 2).
    const priorFallback = engineFallbackOf(attempt);
    if (priorFallback?.state === "preparing") {
      return (await prepareAndSwitchFallback(attempt, priorFallback)) ?? imageGenerationHandler.run(payload, _row);
    }
    if (!attempt.compiledPrompt) {
      // Nothing re-compiles a stored attempt, so a retry finds it missing
      // again: the render fails now, with its reason (Issue #1020, Q17 option 1).
      return recordTerminalAttemptFailure(p.attemptId, RENDER_INPUT_INVALID, "the render has no compiled prompt, so there is nothing to draw");
    }

    const compiled = attempt.compiledPrompt as { imagePrompt?: string; prompt?: string; referenceImageUrl?: string };
    const promptText = compiled.imagePrompt ?? compiled.prompt;
    if (!promptText) {
      // A stored prompt does not change between runs, so a retry cannot help
      // (David, Q17 option 1): the render fails now, with its reason.
      return recordTerminalAttemptFailure(p.attemptId, RENDER_INPUT_INVALID, "the render's stored prompt is empty, so there is nothing to draw");
    }

    const generationMode = generationModeFromSubjectRenderMode(
      attempt.subjectRenderMode as SubjectRenderMode,
    );
    // Fail fast + legibly when an i2i render has no reference image, instead of
    // the opaque MissingRequiredParamError buildEngineInput would throw later.
    if (generationMode === "i2i" && !compiled.referenceImageUrl) {
      return recordTerminalAttemptFailure(p.attemptId, RENDER_INPUT_INVALID, "this picture is drawn from a reference photo, but none was saved with the render");
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
      // An engine that cannot draw this mode, or a stored shape it offers no
      // size for, stays that way on every retry, so the render ends now
      // (Issue #1020) rather than reading "Drawing…" until the retries run out.
      // Engines and their sizes are set in code, so anything else is unexpected.
      if (err instanceof ImageEngineRoutingError || err instanceof ImageRequestBuildError) {
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
        `the request to ${engine.label} could not be built from this render (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    // Image tracing: the exact request, its producer and who started it are
    // persisted BEFORE the vendor is called, so the record never has to be
    // rebuilt from later configuration (plan PLAN_IMAGE_TRACING.md).
    const provenance = await attemptProvenanceContext(attempt);
    ensureFalConfigured();
    // Draw it, or collect the picture an earlier run already submitted (plan
    // PLAN_JOB_RESUME.md §C): a resumed render reads its request record first
    // and pays again only when that request failed or cannot be found.
    // A member's picture: every new paid submission passes the budget gate
    // (the first draw, the styled fallback, a redraw recovery makes on
    // purpose); collecting a request already paid for does not (plan
    // PLAN_PHASE7_IMAGE_OFFERING.md §2). A refusal ends the picture and
    // returns its credit.
    const memberPicture = isMemberPicture(attempt) && attempt.userId != null;
    let drawn: Awaited<ReturnType<typeof drawOrCollect>>;
    try {
    drawn = await drawOrCollect({
      attemptId: p.attemptId,
      endpointId: engine.endpointId,
      input: falInput,
      usable: (data) => Boolean(extractFirstImageUrl(data)),
      unusableError: () => new Error("fal response missing image url"),
      record: async () => {
        if (memberPicture) {
          if (await isReturnedPicture(p.attemptId)) throw new PictureReturnedError(p.attemptId);
          await gateMemberCall(attempt.userId!, engine);
        }
        // The picture is paid: check this run still owns its job immediately
        // before recording and submitting it (plan §A).
        await assertJobOwnership();
        return recordGenerationRequest({
          producer: provenance.producer,
          engineId: engine.id,
          endpointId: engine.endpointId,
          request: falInput,
          actor: provenance.actor,
          attemptId: p.attemptId,
          factId: attempt.factId,
        });
      },
    });
    } catch (err) {
      return endIfSpendRefused(p.attemptId, err);
    }
    const resultUrl = drawn.ok ? extractFirstImageUrl(drawn.data) : null;
    if (!drawn.ok || !resultUrl) {
      const err = drawn.ok ? new Error("fal response missing image url") : drawn.err;
      const refusal = falContentRefusal(err);
      if (refusal) {
        // The fallback engine refused too: the render ends here, naming both
        // refusals. No third engine and no rewording (David, Q14 option 1).
        if (priorFallback?.state === "switched") {
          return recordTerminalAttemptFailure(
            p.attemptId,
            ENGINE_REFUSED_ERROR_CODE,
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
            refusedGenerationRequestId: drawn.generationRequestId,
            refusedVendorRequestId: drawn.vendorRequestId,
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
          ENGINE_REFUSED_ERROR_CODE,
          falSubmitErrorMessage(err, engine.label),
        );
      }
      // fal rejected the request itself (malformed input, a reference photo it
      // cannot fetch because its link has expired): the same request is
      // rejected on every retry, so the render ends now instead of showing
      // "Drawing…" for hours (Issue #1020, Q17 option 1).
      const rejection = !drawn.ok && drawn.answered ? falPermanentRejection(err) : null;
      if (rejection) {
        return recordTerminalAttemptFailure(
          p.attemptId,
          VENDOR_REJECTED_ERROR_CODE,
          `${engine.label} rejected the request for this picture, which will not change on a retry (${rejection})`,
        );
      }
      return retryRender(p.attemptId, falSubmitErrorMessage(err, engine.label));
    }
    const { generationRequestId, data: vendorData } = drawn;
    // Its cost is attributed to the engine request and recorded once, however
    // often the request is collected (the ledger's unique reference).
    if (memberPicture) {
      await recordEngineRequestCost({ userId: attempt.userId!, engine, input: falInput, generationRequestId, megapixels: requestSettings.megapixels });
    }

    // Download + persist to object storage.
    let buf: Buffer;
    try {
      buf = await downloadToBuffer(resultUrl);
    } catch (err) {
      return retryRender(p.attemptId, `the finished picture could not be downloaded (${err instanceof Error ? err.message : String(err)})`);
    }
    // A member's picture passes the output check before it is stored or
    // delivered; a refused one is quarantined and ends with the generic
    // rejection, and its credit returns (plan §2).
    if (memberPicture) {
      if (await isReturnedPicture(p.attemptId)) return endReturned(p.attemptId);
      let check;
      try {
        check = await checkMemberPictureOutput({ attemptId: p.attemptId, userId: attempt.userId!, imageUrl: resultUrl, bytes: buf, mimeType: sniffImage(buf).mime });
      } catch (err) {
        return endIfSpendRefused(p.attemptId, err);
      }
      if (check.outcome === "refused") return recordTerminalAttemptFailure(p.attemptId, OUTPUT_REFUSED_ERROR_CODE, GENERIC_REJECT_MESSAGE);
      if (check.outcome === "unavailable") return retryRender(p.attemptId, check.message);
    }
    let storedPath: string;
    try {
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
      return retryRender(p.attemptId, `the finished picture could not be saved (${err instanceof Error ? err.message : String(err)})`);
    }

    // Mark the attempt complete in one fenced transaction (plan
    // PLAN_JOB_RESUME.md §F). A member's picture is delivered as theirs in the
    // same transaction: the stored path, the `user_ai_images` row and the
    // credit's final state commit together, and a failure fails the whole
    // commit, so it is retried (the request is collected, never paid again)
    // and, at the end, failed and returned (plan PLAN_PHASE7_IMAGE_OFFERING.md
    // §2). Nothing is filed in the fact's shared gallery. A picture whose
    // credit the recovery pass already returned is not delivered.
    if (memberPicture) {
      const outcome = await fencedTransaction(db, (tx) => deliverMemberPicture(p.attemptId, storedPath, tx));
      if (outcome === "returned") {
        logger.warn({ attemptId: p.attemptId }, "[imagePromptJobs] member picture finished after its credit was returned; not delivered");
        return terminalFailure(LATE_AFTER_RETURN_ERROR_CODE, RETURNED_MESSAGE);
      }
    } else {
      await fencedTransaction(db, (tx) => tx
        .update(imagePromptAttemptsTable)
        .set({ generatedImageObjectPath: storedPath, error: null, errorCode: null, updatedAt: new Date() })
        .where(eq(imagePromptAttemptsTable.id, p.attemptId)));
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
  // margin for its database reads. Recovery (plan PLAN_JOB_RESUME.md §A, §F):
  // a resumed run reuses a saved compiled prompt, so a reclaimed row is safe
  // to run again at once (fast reclaim).
  registerJobHandler(IMAGE_PROMPT_QUEUE, imagePromptGenerationHandler, {
    lane: "render",
    executionLimitMs: 5 * 60_000,
    recoveryProtocol: RENDER_RECOVERY_PROTOCOL,
    fastReclaim: true,
  });
  // Execution limit (plan §B): submit, the provider's queue and drawing (a
  // collect waits up to COLLECT_TIMEOUT_MS), a lost receipt's wait for the
  // history (LOST_RECEIPT_HORIZON_MS), and storing — 15 minutes. A request
  // already submitted is collected by the next run, never paid for again (§C).
  registerJobHandler(IMAGE_GENERATION_QUEUE, imageGenerationHandler, {
    lane: "render",
    executionLimitMs: 15 * 60_000,
    recoveryProtocol: RENDER_RECOVERY_PROTOCOL,
    fastReclaim: true,
  });
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
 * Every name it returns is prompt-reduced (`reducePromptName`: the first name,
 * capped), as David decided on 2026-07-20 and kept on 2026-10-15 (Issue #693):
 * the image model never gets a full display name. Sources 2 and 3 store the
 * full name, so they are reduced here; the meme caption is composited
 * elsewhere and keeps the full name.
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
    return { name: reducePromptName({ displayName: reviewSubject.name }), pronouns: reviewSubject.pronouns ?? null };
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
    if (u?.displayName) name = reducePromptName({ displayName: u.displayName });
    pronouns = u?.pronouns ?? null;
  }
  return { name, pronouns };
}

async function markAttemptError(attemptId: number, error: string): Promise<void> {
  // A member's picture that the queue gave up on returns its credit in the
  // same transaction. This hook is best-effort (it runs after the failure
  // commits and its errors are swallowed), so the recovery pass settles any
  // picture it misses (memberPictures/settlement.ts).
  await fencedTransaction(db, async (tx) => {
    await tx
      .update(imagePromptAttemptsTable)
      .set({ error, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
    await returnUndeliveredPicture(attemptId, tx);
  });
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
/** fal rejected the request for a cause a retry cannot change (not a content refusal). */
const VENDOR_REJECTED_ERROR_CODE = "vendor_request_rejected";

/** The spend backstop refused a member's paid call: the picture ends and its credit returns. Anything else is rethrown. */
async function endIfSpendRefused(attemptId: number, err: unknown): Promise<HandlerResult> {
  if (err instanceof MemberSpendRefusedError) return recordTerminalAttemptFailure(attemptId, err.code, err.message);
  if (err instanceof PictureReturnedError) return endReturned(attemptId);
  throw err;
}

/**
 * A member's picture found returned: it is finished, left reading failed,
 * and its job ends with no further work and nothing more paid for it.
 */
async function endReturned(attemptId: number): Promise<HandlerResult> {
  logger.info({ attemptId }, "[imagePromptJobs] member picture was stopped and its credit returned; doing no more for it");
  await fencedTransaction(db, (tx) => markReturnedPictureFailed(attemptId, tx));
  return terminalFailure(LATE_AFTER_RETURN_ERROR_CODE, RETURNED_MESSAGE);
}

async function recordTerminalAttemptFailure(
  attemptId: number,
  code: string,
  message: string,
): Promise<HandlerResult> {
  try {
    // A member's picture returns its credit in the same transaction as its
    // failure, so a failed picture never keeps its spend.
    await fencedTransaction(db, async (tx) => {
      await tx
        .update(imagePromptAttemptsTable)
        .set({ error: message, errorCode: code, updatedAt: new Date() })
        .where(eq(imagePromptAttemptsTable.id, attemptId));
      await returnUndeliveredPicture(attemptId, tx);
    });
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
 * The direct compile's input for a stored attempt: the gag frozen on it, its
 * photo's mode, look, controls, reference and identity. Shared by the render
 * worker, the photoreal fallback and the prompt tuner's preview, so a preview
 * compiles exactly what a render would. Throws `DirectGagInputError` when the
 * frozen gag cannot be drawn.
 */
async function directArgsForAttempt(
  attempt: ImagePromptAttempt,
  enrichment: GagRenderInput,
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
  const enrichment = validateGagRenderInput(attempt.factEnrichmentSnapshot);
  if (!enrichment.ok) return null;
  const renderedSubject = await resolveAttemptIdentity(attempt);
  try {
    return compileDirect({ ...(await directArgsForAttempt(attempt, enrichment.data, renderedSubject)), recipe });
  } catch (err) {
    if (err instanceof DirectGagInputError) return null;
    throw err;
  }
}

