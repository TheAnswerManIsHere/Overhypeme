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
 *     6. Updates the attempt row with the results. subjectFactCompatibility is
 *        advisory only — it never blocks rendering (facts are manually curated).
 *     7. Always enqueues `image_generation` for the same attemptId.
 *
 *   image_generation
 *     Payload: { attemptId }.
 *     1. Loads the attempt row (visual_plan + compiled_prompt populated).
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
  resolveRenderPolicy,
  validateEnrichment,
  defaultIdentityPolicyForRenderMode,
  type ImagePromptGenerationInput,
  type SubjectRenderMode,
  type IdentityPolicy,
  type RenderControls,
  type SourceImageAnalysis,
  type GenerationMode,
  type FactEnrichment,
  type VisualPlan,
} from "@workspace/api-zod";
import { registerJobHandler, enqueueJob, terminalFailure, type JobHandler, type HandlerResult } from "./asyncJobs";
import { generateImagePromptPlan, ImagePromptError } from "./imagePrompt/generator";
import { finishAndStore, recordGenerationRequest, setVendorRequestId } from "./provenance/records";
import { vendorContext } from "./provenance/vendorContext";
import { attemptProvenanceContext } from "./provenance/attemptActor";
import { attemptImageEngineId, resolveImageEngine } from "./imageEngineRouting";
import { buildImageRequestSettings, type ImageRequestPurpose, type ImageRequestSettings } from "./imageRequestBuilder";
import { compileForSubjectRenderMode } from "./imagePrompt/compilers/nanoBanana2";
import { recipeById } from "./imagePrompt/recipeStore";
import type { ResolvedRecipe } from "./imagePrompt/recipe";
import type { CompiledImagePrompt } from "./imagePrompt/types";
import { generationModeFromSubjectRenderMode } from "./sourceImageAnalysis";
import { renderPersonalized, hasUnresolvedFactTokens } from "./renderCanonical";
import { isValidPromptIdentitySnapshot } from "./imagePrompt/promptIdentity";
import { resolveRenderStyle, isValidRenderStyleSnapshot } from "./imagePrompt/styleResolution";
import { buildEngineInput } from "./engineInterpreter";
import { downloadToBuffer, extractFirstImageUrl, imageEngineParams } from "./imageEngineRequest";
import { fal, ensureFalConfigured } from "./falClient";
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
      // Frozen fact text still carries unresolved tokens, or a legacy attempt's
      // fact/template can't be resolved — deterministic, so terminal (§12).
      return recordTerminalAttemptFailure(p.attemptId, "rendered_fact_unresolved_token", msg);
    }

    const input = await buildGenerationInput(attempt, enrichment, factText, renderedSubject);

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
      const fullMsg = `prompt-gen failed: ${msg}${provNote}`;
      // Validation-exhaustion (planner output invalid after the corrective
      // retry) is deterministic → terminal. Provider/timeout/transport failures
      // (or any legacy/unclassified error) stay retryable (§12).
      if (err instanceof ImagePromptError && err.cause === "validation_exhausted") {
        return recordTerminalAttemptFailure(p.attemptId, "planner_output_invalid_after_retry", fullMsg);
      }
      await markAttemptError(p.attemptId, fullMsg);
      return { ok: false, error: fullMsg };
    }

    // The wording chosen when the attempt was queued; none is the baseline. Read
    // outside the compile's try, so a database error stays retryable.
    const recipe = await recipeById(attempt.recipeVersionId);
    let compiled;
    try {
      compiled = compileForSubjectRenderMode({
        visualPlan: output.visualPlan,
        compiledPrompt: output.compiledPrompt,
        input,
        renderedSubject,
        recipe,
      });
    } catch (err) {
      // A compiler throw (e.g. an unhandled subjectRenderMode) is deterministic
      // given the frozen inputs → terminal; never retry the paid planner for it.
      const msg = err instanceof Error ? err.message : String(err);
      return recordTerminalAttemptFailure(p.attemptId, "compile_failed", `compile failed: ${msg}`);
    }

    // Fail-loud gate (§12): the final prompt must carry NO unresolved
    // {NAME}/{SUBJ}/… token. The compiler flags this as a warning (shared with
    // the admin preview), but at RENDER time a leaked token is terminal — we
    // refuse to ship it to the engine and never enqueue image_generation.
    const finalPromptText =
      (compiled as { imagePrompt?: string; prompt?: string }).imagePrompt ??
      (compiled as { prompt?: string }).prompt ??
      "";
    if (hasUnresolvedFactTokens(finalPromptText)) {
      return recordTerminalAttemptFailure(
        p.attemptId,
        "moderator_core_scene_unresolved_token",
        "compiled prompt still contains an unresolved personalization token (check the moderator Concept/override)",
      );
    }

    // §10.5 fail-loud budget gate: the compiler no longer silently truncates
    // required content, so if required content alone overflowed the engine
    // budget (only reachable by legacy over-budget content — save validation
    // prevents it for new saves), fail terminal instead of shipping a prompt
    // whose policy guardrails were cut.
    const overflow = compiled.diagnostics?.requiredBudgetOverflow;
    if (overflow) {
      return recordTerminalAttemptFailure(
        p.attemptId,
        "required_budget_overflow",
        `compiled prompt exceeds the engine budget by ${overflow.overBy} characters (${overflow.totalLength}/${overflow.budget}); shorten the moderator Concept/additions`,
      );
    }

    // Persist which planner engine produced this plan alongside the compiled
    // prompt so attempts (and the admin preview) can attribute render quality.
    if (output.plannerProvenance && compiled.diagnostics) {
      compiled.diagnostics.plannerProvenance = output.plannerProvenance;
    }

    // subjectFactCompatibility is an ADVISORY signal only — persisted for admin
    // visibility (and to drive the legacy "blocked" display for historical rows
    // that predate this change), but it never gates whether image_generation is
    // enqueued. David: facts are manually curated, so a "poor" rating renders
    // (possibly imperfectly) rather than leaving the user with nothing.
    await persistImagePromptPlanAndEnqueueGeneration({
      attemptId: p.attemptId,
      visualPlan: output.visualPlan,
      compiledPrompt: compiled as unknown as Record<string, unknown>,
      subjectFactCompatibility: output.visualPlan.subjectFactCompatibility,
      archetypeStrategyVersion: output.archetypeStrategyVersion,
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

/**
 * Narrow, worker-local success-path helper (extracted as a deterministic test
 * seam — this is NOT a general job-persistence abstraction). Persists the
 * planner/compiler results on the attempt row and always chains
 * `image_generation`, regardless of `subjectFactCompatibility.rating`. The
 * rating is advisory only; it never gates enqueue.
 */
export async function persistImagePromptPlanAndEnqueueGeneration(args: {
  attemptId: number;
  visualPlan: unknown;
  compiledPrompt: unknown;
  subjectFactCompatibility: unknown;
  archetypeStrategyVersion: string;
}): Promise<void> {
  await db
    .update(imagePromptAttemptsTable)
    .set({
      visualPlan: args.visualPlan,
      compiledPrompt: args.compiledPrompt as Record<string, unknown>,
      subjectFactCompatibility: args.subjectFactCompatibility,
      archetypeStrategyVersion: args.archetypeStrategyVersion,
      error: null,
      errorCode: null,
      updatedAt: new Date(),
    })
    .where(eq(imagePromptAttemptsTable.id, args.attemptId));

  await enqueueJob({
    queue: IMAGE_GENERATION_QUEUE,
    payload: { attemptId: args.attemptId } satisfies ImagePromptJobPayload,
    dedupeKey: `image_generation:attempt:${args.attemptId}`,
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
      const msg = err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, msg);
      return { ok: false, error: msg };
    }
    await db
      .update(imagePromptAttemptsTable)
      .set({ requestSettings, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, p.attemptId));
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
      const msg = err instanceof Error ? err.message : String(err);
      await markAttemptError(p.attemptId, `buildEngineInput failed: ${msg}`);
      return { ok: false, error: `buildEngineInput failed: ${msg}` };
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
    let resultUrl: string;
    let vendorData: unknown;
    try {
      const response = await fal.subscribe(engine.endpointId, { input: falInput, logs: false });
      await setVendorRequestId(generationRequestId, (response as { requestId?: string }).requestId);
      const data = (response as { data?: unknown }).data ?? response;
      vendorData = data;
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
};

export function registerImagePromptHandlers(): void {
  // `render` lane: single-item, moderator-watched renders (LLM planner + fal
  // image gen). Isolated so a "test render" never waits behind a bulk backfill.
  registerJobHandler(IMAGE_PROMPT_QUEUE, imagePromptGenerationHandler, { lane: "render" });
  registerJobHandler(IMAGE_GENERATION_QUEUE, imageGenerationHandler, { lane: "render" });
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
async function recordTerminalAttemptFailure(
  attemptId: number,
  code: string,
  message: string,
): Promise<HandlerResult> {
  try {
    await db
      .update(imagePromptAttemptsTable)
      .set({ error: message, errorCode: code, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
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
    // Append to facts.aiMemeImages[gender] so the legacy GET image endpoint
    // can serve this background by index. Gender resolution uses the
    // fallbackSubjectGender when present, else neutral.
    const renderControls = attempt.renderControls as RenderControls;
    const gender: "male" | "female" | "neutral" = renderControls.fallbackSubjectGender ?? "neutral";
    // Row-locked read-modify-write: with the worker now running image_generation
    // handlers concurrently, two completions for the SAME fact could otherwise
    // read the same aiMemeImages array and clobber each other on write (last
    // write drops the other image). `SELECT … FOR UPDATE` serializes the append
    // on the fact row so both paths survive.
    await db.transaction(async (tx) => {
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
      await db.insert(userAiImagesTable).values({
        userId: attempt.userId,
        factId: attempt.factId,
        gender,
        storagePath: storedPath,
        imageType: "reference",
      });
    }
  } catch (err) {
    logger.warn({ err, attemptId: attempt.id }, "[imagePromptJobs] mirror-to-legacy-storage failed (non-fatal)");
  }
}

/**
 * The planner and compiler input a stored attempt renders from: its frozen
 * enrichment, fact text, photo, controls and style, with the effective render
 * policy. Shared by the render worker and the prompt tuner's preview, so a
 * preview compiles exactly what a render would.
 */
async function buildGenerationInput(
  attempt: ImagePromptAttempt,
  enrichment: FactEnrichment,
  factText: string,
  renderedSubject: { name: string; pronouns: string | null },
): Promise<ImagePromptGenerationInput> {
  const generationMode = generationModeFromSubjectRenderMode(attempt.subjectRenderMode as SubjectRenderMode);
  const renderControls = attempt.renderControls as RenderControls;
  const stylePrompt = await resolveStylePrompt(renderControls, generationMode);
  return {
    factText,
    enrichment,
    sourceImageAnalysis: attempt.sourceImageAnalysis as SourceImageAnalysis,
    subjectRenderMode: attempt.subjectRenderMode as SubjectRenderMode,
    userSelectedSubjectRenderMode: (attempt.userSelectedSubjectRenderMode as SubjectRenderMode | null) ?? null,
    identityPolicy: attempt.identityPolicy as IdentityPolicy,
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
}

/**
 * Compile a stored attempt's own scene plan again with another prompt recipe,
 * without a planner call (the prompt tuner's preview). Null when the attempt
 * stored no plan or its frozen inputs no longer resolve.
 */
export async function recompileStoredAttempt(
  attempt: ImagePromptAttempt,
  recipe: ResolvedRecipe,
): Promise<CompiledImagePrompt | null> {
  if (!attempt.visualPlan) return null;
  const enrichment = validateEnrichment(attempt.factEnrichmentSnapshot);
  if (!enrichment.ok) return null;
  const renderedSubject = await resolveAttemptIdentity(attempt);
  let factText: string;
  try {
    factText = await resolveRenderedFactText(attempt, renderedSubject);
  } catch {
    return null;
  }
  const input = await buildGenerationInput(attempt, enrichment.data, factText, renderedSubject);
  return compileForSubjectRenderMode({
    visualPlan: attempt.visualPlan as VisualPlan,
    // The planner's own prose is not stored; it is read only when a plan has no core scene.
    compiledPrompt: { prompt: "", negativePrompt: "", engineNotes: "" },
    input,
    renderedSubject,
    recipe,
  });
}

