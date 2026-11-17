# Plan: Nano Banana 2.1 draws the picture when GPT Image 2.6 refuses it on content grounds

Workstream: #980

```plan-oracle
# Oracle: Nano Banana 2.1 fallback when GPT Image 2.6 refuses on content grounds

Agreed with David in chat, 2026-11-17 (Issue #980). Q12: option 2, automatic fallback ("We were using Nano Banana in the past so we know it works."). Scope approved ("Q13 1. Approved."). Q13: fall back on the first refusal.

**Direction:** the product strategy's photoreal/styled split stays: GPT Image 2.6 draws photoreal, Nano Banana 2.1 draws styled. The fallback is a safety net for photoreal only.

**Product intent:** when GPT Image refuses a photoreal render on content grounds, the same picture is drawn on Nano Banana 2.1, photoreal, with the same photo and the same gag. The member or moderator gets a picture, not an error. This holds for moderation test renders and member renders alike. The fallback happens on the FIRST content refusal (Q13: 1), with no GPT retries before it.

**Must not change:**
- The default routing: photoreal goes to GPT Image first, styled to Nano Banana.
- Every picture is traceable to the engine that actually drew it. A fallback picture says Nano Banana drew it, and the refused GPT attempt stays on record with its reason.
- Other failures (network, outage, bad input) never trigger the fallback.

**Settled decisions it follows:** engine choice lives in code (decisions.md, 2026-11-14); every picture starts from a photo; each engine has its own prompt recipe wording, so the fallback compiles with Nano Banana's recipe, never GPT's.

**Now:** fallback for content refusals on photoreal renders.
**Next:** a fallback for styled renders if Nano Banana itself refuses — only if it comes up.
**Never:** rewording a refused prompt to slip it past GPT Image's filter.

**Ceremony:** full (production phase, visual pipeline is sensitive): plan, Astra's plan review, approval, build, code review, UAT.
```

## Problem

GPT Image 2.6 refuses some photoreal pictures under its content policy. Measured on Issue #980: the "newborn drives his mom home" gag was refused 7 of 9 times in the request history and 3 of 3 in the paid probes. The trigger is the scene itself, an infant at the wheel; neither the compiler's age-change wording nor the reference photo causes it. Nano Banana 2.1 drew the same gag with the same photo (anime style). Today a refusal leaves the moderator with an error, after up to five queue retries that each go back to GPT.

## Direction

[Product strategy, *Pictures and engines*](../ai-context/product-strategy.md#pictures-and-engines): GPT Image 2.6 photoreal, Nano Banana 2.1 styled. This plan adds no engine and changes no default; it adds one recorded detour for a content refusal.

## Product Intent

As the oracle block above.

## Must Not Change

As the oracle block above, plus these adjacent behaviours on the same path:
- A styled render (Nano Banana first) never falls back anywhere.
- The planner runs once per render. The fallback draws the scene the planner already wrote; it does not ask for a new one.
- A moderation render's staleness and idempotency (the scenario input hash, `reviewRenderScenarios.ts`) are unchanged by a fallback: a render that fell back is neither stale nor re-queued because of it.
- The render-poll payload's shape (`buildRenderStatusPayload`) keeps every existing field.

## Settled Decisions

1. **Engine choice lives in code** (decisions.md, 2026-11-14). The fallback engine is named in `imageEngineRouting.ts` beside `IMAGE_ENGINE_IDS`, never in a database row.
2. **Every picture starts from a photo.** The fallback is an edit-mode render with the same reference photo; there is no text-to-image fallback.
3. **Each engine family has its own recipe wording.** The fallback compiles with Nano Banana 2.1's live recipe, never GPT's.
4. **First refusal, no GPT retry before it** (David, Q13: 1).
5. **A content refusal is recognised only by fal's own classification**: a 422 whose detail carries `type: "content_policy_violation"` (`falContentRefusal`, PR #988). Nothing else triggers it: no message matching, no other status.
6. **Affected-surface inventory.** The class is "a fal call that draws a picture from a compiled prompt". Oracle: `git grep -n '\.subscribe(\|queue\.submit(' -- 'artifacts/api-server/src/**/*.ts' ':!**/__tests__/**' ':!**/aiDouble/**'`, run 2026-11-17, printed five lines: two are the transport's own wrappers in `falClient.ts`, two are classifiers (`moderation/nsfwClassifier.ts`, `sourceImageAnalysis/tier1FalDetector.ts`), and one draws pictures, `imagePromptJobs.ts:397`. The engine comparison draws through `comparison/runs.ts` and is deliberately out of scope: a comparison measures each engine as itself, and a fallback there would corrupt the measurement.
7. **Who uses this path today, and what "member renders alike" means here.** `git grep -ln buildAndEnqueueImagePromptAttempt` finds `routes/reviews.ts`, `lib/reviewRenderScenarios.ts` and `lib/imagePromptAttempts.ts`: today only moderation renders queue attempts. Member AI pictures were removed and are rebuilt in launch Phase 7 (`meme-and-video-studio.md`). So the fallback lives in the shared worker every render uses, it is proven here with member-shaped inputs (`final` purpose) as well as moderation renders, and **the working member journey is verified in Phase 7, not claimed by this plan** (Astra, scope S1). No credit or charge exists on this path today, so none can be taken twice.

## Repo Context Inspected

`imagePromptJobs.ts` (both handlers), `imagePromptAttempts.ts` (`buildAndEnqueueImagePromptAttempt`, `buildRenderStatusPayload`), `imageEngineRouting.ts`, `reviewRenderScenarios.ts` (input hash, staleness), `routes/reviews.ts` (render polls by `renderJobId`), `provenance/records.ts`, `falClient.ts`, `docs/ai-context/visual-pipeline.md` (*Which engine draws a render*, *Terminal vs retryable render failures*), `lib/db/src/schema/imagePromptAttempts.ts`.

## Current Behavior

`image_prompt_generation` plans and compiles with the recipe of the engine recorded on the attempt, then queues `image_generation`. That handler submits to fal. Any exception is recorded on the attempt's `error` and returned retryable, so a refusal is retried up to `async_job_<queue>_max_attempts` (default 5), each retry going back to GPT. After PR #988 the error names the refusal legibly; nothing else changes.

## Source-of-Truth Analysis

- **Which engine drew the picture:** the attempt's `actual_image_engine_id`, and the generation-request row written before each vendor call (`image_generation_requests`, `recordGenerationRequest`), and the stamp on the finished image (`finishAndStore`'s `stampEngine`).
- **That GPT refused, and why:** today recorded nowhere durable except the attempt's free-text `error`, which a later success clears (`persistImagePromptPlanAndEnqueueGeneration` sets `error: null`). The plan adds a durable record (below).

## Proposed Design

**The same attempt is redrawn in place on Nano Banana, and the detour is recorded before it happens.** One logical render, one poll handle (`renderJobId`), two recorded vendor requests (Astra, scope S2).

**At queue time**, a photoreal attempt freezes its fallback on its render controls beside its routing: the fallback engine (`nano-banana-2-1-edit`) and Nano Banana 2.1's live recipe version, so a recipe promotion never changes queued work (Astra, scope S3). An attempt queued before this release has none frozen; at handover it resolves them live, and its fallback record says so.

**On a content refusal from the photoreal engine**, the `image_generation` handler (Astra, round 1, S2):

1. **records the refusal first**, before anything else can fail: `engine_fallback` (below) with the refused request's identity, fal's reason and the intended fallback, in state `preparing`. From this write on, no run of this job calls GPT again;
2. **prepares the fallback**: recompiles the stored scene plan with the fallback recipe through the existing `recompileStoredAttempt` (`imagePromptJobs.ts:752`), which re-reads the frozen photo, identity, fact text and render controls and calls no planner, and runs the render-time gates the first compile passed (no unresolved personalization token, no required-budget overflow). A gate failure, or a recompile that returns nothing, ends the render terminally with its own code, and the GPT refusal stays recorded beside it. A transient failure here (a database read) is retried, and the retry resumes at this step;
3. **switches the attempt in one write**: engine, recipe, compiled prompt and its diagnostics, request settings, and `engine_fallback` state `switched`;
4. **submits to Nano Banana**. The picture is stored and stamped with Nano Banana, as any render is.

**Resumption.** Every run of the job reads the attempt as persisted: `preparing` resumes at step 2, `switched` at step 4. No path returns to GPT.

**A render stays live while it is still retrying** (Astra, round 1, S2). Today a retryable failure writes the attempt's `error`, the render reads `failed`, the moderation grid stops polling, and a later successful retry leaves a picture that still reads failed and cannot be approved as the gag's example. On this worker's path that changes: a retryable failure is logged on the queue row and written to the attempt only when the queue gives up, through the queue's own exhaustion hook (`onAbandon`, `asyncJobs.ts:523`, which also fires when a handler throws), never by re-deriving the retry ceiling in the handler; a stored picture clears `error` and `error_code`. A render therefore reads rendering while it retries, a picture when one arrives, and failed when the queue gives up. This applies to every render on this worker, not only fallbacks, because the fallback cannot be correct without it.

**Styled renders keep today's behaviour** (Astra, round 1, A1): routing and retries are unchanged. Only a content refusal from the fallback engine, reached through the photoreal fallback, ends that render terminally (`vendor_content_refused`, naming both refusals), subject to Q14.

If Nano Banana also refuses, the attempt fails **terminally** with a typed code (`vendor_content_refused`) and a message naming both refusals. There is no second fallback and no GPT retry.

**Why in place, rather than a new child attempt.** Every reader that polls or lists a render (`routes/reviews.ts`'s two `renderJobId` lookups, the gag scenario grid, the eval signature) assumes one attempt per render. A child attempt would need a link column *and* a change to each of those readers so they follow it, which widens the change to every surface. Redrawing in place keeps every reader as it is, and the new column keeps the history the attempt would otherwise lose. The cost is that `actual_image_engine_id` stops being write-once: it changes exactly once, on a recorded fallback. *Which engine draws a render* in `visual-pipeline.md` is updated to say so. The rule's purpose, that a changed default never re-routes queued work, still holds.

**Recompiling without a second planner call** already exists: `recompileStoredAttempt` (`imagePromptJobs.ts:752`, the prompt tuner's preview) compiles a stored attempt's plan with another recipe. Quoted from it: *"The planner's own prose is not stored; it is read only when a plan has no core scene."* So a plan with no core scene recompiles without the planner's prose; the gates above still apply.

## Data Model and Migration Impact

One additive, nullable column on `image_prompt_attempts`, `engine_fallback` (jsonb): `{ routedEngineId, routedRecipeVersionId, refusedGenerationRequestId, refusedVendorRequestId, reason, fallbackEngineId, fallbackRecipeVersionId, resolvedAtHandover, at }`. It keeps the routed engine (what the queue chose) apart from the attempt's engine column (what drew the picture). Null on every existing row and on every render that did not fall back. No backfill. Rollback: revert the behaviour and keep the column, so recorded refusals survive (Astra, round 1). Migration ceremony per `overhype-migration-review`. A success never clears it (unlike `error`). The frozen fallback choice lives in the existing `render_controls` jsonb, so it needs no column.

**Tracing: the picture names the engine that drew it** (David, 2026-11-17: the trace must show that a picture made after a GPT refusal was drawn by Nano Banana). Every picture's provenance record (`image_provenance`) is written at storage with four engine facts: its `engine_id`; its `generation_request_id`, pointing at the exact request that produced it, which carries that request's engine and endpoint; the visible engine stamp burned into the image (`stampEngine`, `imagePromptJobs.ts:425`); and the prompt in its snapshot. Today all four come from the engine the handler resolved before the call. After the switch, the handler resolves the engine, the request it records and the stamp from the switched attempt, so on a fallback picture **all four name Nano Banana 2.1** and the prompt is Nano Banana's. None of them can name GPT, which never produced a picture for that render. A test asserts all four.

The refused GPT request already gets its own `image_generation_requests` row (written before the vendor call). That table has no outcome field, and the trace reader expands only the finished image's request (Astra, scope S3), so the finished picture's frozen provenance snapshot (`imageProvenance.ts`; written at `imagePromptJobs.ts:436`) carries the attempt as it stands after the switch, its `engine_fallback` included, and the trace reader expands the refused request from the id recorded there. A fallback picture's trace therefore shows both calls and why the first failed, and keeps showing it after the attempt row is deleted (Astra, round 1).

**Moderation freshness** (Astra, rounds 0 and 1, S3). A scenario's stored input hash (`factRenderScenarios.ts:176`, computed at queue time from the routed engine and recipe) is never rewritten by a fallback, and staleness keeps comparing it with the hash computed from today's routing. **For an attempt that fell back**, staleness also compares the fallback recipe it drew with against today's fallback recipe. The same rule applies to the scenario grid, the diagnostics and the existing-attempt check (`reviewRenderScenarios.ts:165`), so an outdated fallback picture does not suppress its replacement. Outcomes:
- fallback alone: current, no duplicate queueing;
- a Nano Banana recipe promotion: queued work keeps its frozen recipe, and a picture drawn with the previous recipe reads stale;
- a GPT-drawn picture is not made stale by a change to Nano Banana's wording;
- content and primary-routing changes: their current effect, unchanged.

## Runtime Behavior

- Photoreal render, GPT draws it: unchanged.
- Photoreal render, GPT refuses: refusal recorded, scene recompiled with Nano Banana's recipe, one Nano Banana call in the same job run. Picture stored; `engine_fallback` state `switched`; `actual_image_engine_id` = `nano-banana-2-1-edit`; `error` null; the render read rendering throughout.
- Nano Banana then refuses: terminal `vendor_content_refused`; `engine_fallback` still records the GPT refusal; the error names both.
- Any non-content failure (either engine): retryable as today. A retry after the re-route redraws on Nano Banana, never on GPT.
- Styled render refused: as today (retried by the queue), no fallback.

## Admin/User UX Impact

The moderation render tile shows the attempt's error; the engine is in its diagnostics only (`actualImageEngineId`), not on the ordinary scenario card (`lib/api-zod/src/renderScenarios.ts:175`; Astra, round 1). The card payload gains the fallback fact, and the tile shows one line, "GPT Image refused this picture; Nano Banana drew it", only once a fallback picture has arrived. No new screen.

## Security, Permissions, and Validation

No new route or permission. The fallback engine is validated by the existing routing validation (`ImageEngineRoutingError`): unknown, inactive or wrong-mode engines are refused, never defaulted. fal's reason is stored as text and rendered as text.

## Testing Plan

- Unit: refusal classification (from PR #988); routing names a fallback for photoreal edit and none for styled.
- Worker (the AI double, `AI_DOUBLE_FAIL`-style injection of a 422 content refusal on the GPT edit endpoint): GPT refuses → the Nano Banana request is recorded and submitted once, the picture is stored, `engine_fallback` and the engine column are set, the planner ran once, and the compiled prompt is the Nano Banana recipe's.
- Worker: both refuse → terminal `vendor_content_refused`, one call per engine, no retry.
- Worker: a non-content 422 and a 500 → retryable, no fallback.
- Scenario grid: a fallen-back render is not stale and is not re-queued.
- Migration test per the migration skill.
- Worker: a retry after the handover (Nano Banana submit fails with a 500, then succeeds) draws on Nano Banana; GPT is called once in total.
- Worker: a recompile that fails a gate ends terminally with its own code, and no Nano Banana call is made.
- Worker: a member-shaped (`final` purpose) photoreal attempt falls back the same way.
- Poll payload: during the handover the status reads rendering, not failed.
- Trace reader: a fallback picture's trace names the refused request and its reason.
- Worker: the fallback keeps the frozen photo, scene plan, identity, photoreal selection, aspect and render purpose, and changes only the recipe, the compiled prompt and the engine attribution.
- Worker: a refusal recorded, then a transient failure during preparation: the retry resumes preparation and GPT is not called again; a preparation gate failure keeps the GPT refusal beside its own terminal error.
- Worker: retries exhausted on the Nano Banana call: the render ends visibly failed, never "rendering" for ever.
- Worker: a styled render's content refusal behaves as today.
- Freshness: the three outcomes listed under *Moderation freshness*, and the existing-attempt check queueing a replacement for an outdated fallback picture.
- Trace: a fallback picture's trace names the refused request and its reason after the attempt row is deleted.
- Provenance: on a fallback picture, the provenance record's `engine_id`, its linked generation request's engine and endpoint, the visible engine stamp and the snapshot's prompt all name Nano Banana 2.1; none names GPT.
- Card: the fallback line appears only after a fallback picture has arrived.
- **Live, judged by David** (UAT, human step): one real Nano Banana photoreal render of fact 41's gag with his reference photo, judged for scene fidelity, likeness and looking real. A live run through GPT may simply succeed, so the handover itself is proven by the deterministic tests above, not by this step. It runs as a direct Nano Banana photoreal render of the gag (the fallback engine and recipe, chosen explicitly), so GPT is not called and is not provoked repeatedly (Astra, round 2). Bound: one planner call and at most five Nano Banana image calls with retries, about $2 at worst, inside the fleet's $100 a calendar month (KITT 5e60439), and recorded on the ledger.

## Implementation Steps

One increment, one PR (migration plus worker plus tile line), since none of it is useful alone.

## Risks and Mitigations

- **Nano Banana's photoreal output has not been seen for this gag.** Its first real run is the live check; if it refuses, the attempt fails legibly.
- **A refusal may be billed.** unable to verify: fal's invoice for 2026-11-17. The fallback adds at most one Nano Banana call per refusal, and removes up to four GPT retries.
- **Write-once engine column.** Mitigated by the recorded column and the doc update; the eval signature reads the engine that drew the picture, which is the right one for an eval.

## Questions for David

**Q14. If Nano Banana also refuses the picture, the render fails.** The intent says the moderator or member "gets a picture, not an error"; when both engines refuse, that cannot hold without a third engine or rewording the prompt, which the scope rules out ("Never"). The plan ends such a render with a clear failure naming both refusals. Astra's view and mine agree: a clear final failure, no third engine, no rewording. Options: 1. accept that limit (recommended); 2. add a third engine (a new plan).

**Answered (David, 2026-11-17): "Q14 Option 1."** A render that both engines refuse ends in a clear failure naming both refusals; no third engine, no rewording.

## Definition of Done

A photoreal moderation render of the newborn-driving gag, refused by GPT, comes back as a Nano Banana picture with the tile saying so; every test above passes; `visual-pipeline.md` describes the fallback.
