# Plan: AI call settings live in code

```plan-oracle
Direction: decisions.md 2026-11-14, "AI call settings live in code"; KITT's fleet guideline "Prefer configuration in code" (KITT PR #301): configuration defaults to code, the database is for a setting that must take effect immediately where a commit would be too slow, and AI call settings default firmly to code; a sensible exception is named with its reason in decisions.md. David, 2026-11-14: "Remember that all API calls, model selection, reasoning effort, etc. should now only be stored in code, never in database entries." Then: "1-3 should all be refactored." Then, on the scope: "Agreed. Don't take "never" and "always" as being such strong absolutes … It's a guideline, not a hard and fast must follow rule."

Product intent: every AI call the product makes takes its engine or model, endpoint, reasoning effort, temperature, token limits and default image size and shape from code, so the code's version says exactly how every AI step behaves, and changing one is a reviewed code change. The admin UI that defines engines or other AI settings is retired and removed, so an admin no longer sees it. Every active engine's request carries only parameters its model accepts, and the code shows only settings that are actually sent.

Must not change:
- What each AI step uses today. Image routing keeps today's engine per render mode, now set in code; the approved photoreal/styled split stays in Phase 8 (product-strategy.md places its adoption there).
- Every image attempt still records the engine it actually ran.
- The Eval page can still run any candidate engine as a parameter.
- The prompt tuner's stored and promoted wording versions stay in the database (David's named exception).
- The gag writer has no fallback model.
- Secrets stay in environment variables.
- No schema change and no row deletion; retiring the stored rows and columns is a separate destructive step, asked separately.

David's confirmations, 2026-11-14: "1) Once the update is complete, the effective engines that are used are the same as they are today. in other words, you're capturing the current state and enshrining it in code. 2) The admin UI that defines engines or other AI settings are all retired and removed so an admin doesn't see them anymore. 3) We've audited all the settings so that the currently active engines are all configured properly. In other words, if something doesn't support temperature, we're not trying to send a temperature setting."

Settled decisions: decisions.md 2026-11-14; 2026-11-13 (gag writer on Astra, no fallback); 2026-11-06 (image engine per render mode; the choice moves into code); 2026-10-13 (utility helpers on GPT-6 Luna). Scope agreed by David 2026-11-14 ("Agreed"), including Astra's scope-exchange points: every place an AI request is built is covered, not only the three audited fields, and the photoreal/styled split stays in Phase 8.
```

## Problem

Several AI calls still take their settings from the database. Changing the
code default does not change behaviour while a row disagrees: on 2026-11-14 the
gag writer's reasoning effort stayed `high` on dev after the code said
`medium`, until the row was edited by hand. A version of the code therefore
does not say how the product's AI steps behave.

## Direction

decisions.md 2026-11-14 and KITT's *Prefer configuration in code*. This
increment makes the code authoritative for every AI call's settings.

## Product Intent

As in the oracle: engine or model, endpoint, reasoning effort, temperature,
token limits and default image size and shape come from code for every AI
call, and the admin UI that defined them is removed.

## Must Not Change

As in the oracle.

## Settled Decisions

- The oracle's list.
- **Affected-surface inventory, run at `ef191840`** (`git grep`, production
  sources only, tests excluded):
  - **Engine choice by `admin_config` key, 5 readers:**
    - `factEnrichmentConfig.ts:334`
    - `visualConceptsConfig.ts:51`
    - `imageEngineRouting.ts:75–76`
    - `moderation/nsfwClassifier.ts:75`
    - The image-prompt and source-classifier keys, read through their config
      modules.

    The build re-runs the search before the first commit and works from its
    output.
  - **Call settings read from the engine row:**
    - `utilityLLM.ts:100–103`
    - `factEnrichment.ts:347–356`
    - `imagePrompt/generator.ts:131–146`
    - `visualConcepts/generator.ts:149–164`
    - `imagePromptJobs.ts:376–387`
    - `sourceImageAnalysis/tier1FalDetector.ts:61`
    - `comparison/runs.ts:519–588`
    - `routes/adminEngines.ts:894–1253`, the workbench, which is removed rather than migrated
  - **Direct engine-row readers outside `engineInterpreter.ts`:**
    `comparison/{runs,sets,evaluations,judging}.ts`,
    `imagePrompt/recipeStore.ts` and `routes/adminEngines.ts`. Most read
    identity, family, price or deletion only; `runs.ts:519` reads a whole row
    to dispatch.
- **Preservation baseline (read-only, through the connector, 2026-11-14).**
  - **Dev:** every selector and engine-row value matches the code catalogue
    exactly:
    - Engine choices: enricher `openai-enricher`; planner
      `openai-visual-planner`; gag writer `openai-gag-writer`; source
      classifier `fal-yolo-world`; image routing `nano-banana-2` (t2i) and
      `nano-banana-2-edit` (i2i); NSFW `fal-ai/imageutils/nsfw`.
    - Engine-row settings: gpt-5.5 high/0.20/600 (enricher); gpt-5.5
      high/0.40/2800 (planner); gpt-6-astra medium/0.80/4000 (gag writer);
      gpt-6-luna none/0.70/512 as the `is_default` utility LLM; 1K/portrait
      for both image engines.
  - **Production:** the same values, except that it runs an older release:
    - It has no image-routing keys, and so falls back to the same two image
      engines.
    - Its gag-writer key still names `openai-visual-planner`, because it
      predates migration 0137. decisions.md 2026-11-13 settles the gag writer
      on GPT-6 Astra, so the code value is the intended one.
  - Publishing is David's act, and it brings production to these values.
- **No engine setting stays admin-editable** (David's confirmation 2). The
  on/off switch, tier, feature flag, ordering and pricing hints keep their
  stored values, and those stored flags stay authoritative wherever the code
  reads them today. A catalogue edit to `isActive` does not override an
  existing row. With the Engines page removed, switching an engine off becomes
  a reviewed migration that sets the stored flag. The kill-switch exception proposed in v2
  is withdrawn.
- **Today nothing unsupported is sent to OpenAI** (code read,
  `openaiChatParams.ts:39-62`). For gpt-5, gpt-6 and o-series models at any
  effort other than GPT-6's "none", the helper sends `max_completion_tokens`
  and `reasoning_effort` and drops `temperature`. So the catalogue's
  temperatures for the enricher (0.2), planner (0.4) and gag writer (0.8) are
  never sent. They read as live settings, so they are a defect in the code's
  self-description.

## Repo Context Inspected

- **Engines:**
  - `lib/engines/types.ts` (`EngineDefinition`, `ADMIN_EDITABLE_FIELDS`)
  - `lib/engines/reconcile.ts` (code-owned versus admin-tunable fields; an
    OpenAI engine's `endpointId` is admin-owned)
  - `lib/engineInterpreter.ts` (`loadEngine`, `loadDefaultEngine`,
    `loadActiveEngines`, all reading rows)
- **Settings modules:** `lib/utilityLLM.ts` (default llm engine by
  `is_default`), `lib/visualConceptsConfig.ts`, `lib/imageEngineRouting.ts`,
  `lib/moderation/nsfwClassifier.ts`
- **Admin routes:** `routes/adminEngines.ts` (PATCH, set-default, workbench)
- **Precedent:** `lib/codeOwnedPrompts.ts`
- **Docs:** decisions.md 2026-11-14 and 2026-11-06, product-strategy.md
  (Phase 8 adoption), visual-pipeline.md

## Current Behavior

- **How an engine is chosen.** Each AI step picks its engine from an
  `admin_config` key, falling back to a code default. The utility LLM is
  whichever active `llm` row has `is_default`.
- **How a call is built.** The request takes its model, effort, temperature
  and token limit from that engine's row. For OpenAI engines, the admin can
  edit the model.
- **Boot reconciliation** rewrites code-owned fields, but keeps the admin-tunable
  ones once a row exists. The Eval cell renderer and the engine workbench read
  rows directly.
- **Admin screens.** The admin Engines page edits all of these, and "Set
  default" writes a routing key or `is_default`.

## Source-of-Truth Analysis

- **After:** the code catalogue (`ALL_ENGINES` plus each step's engine-id
  constant) is the one source for which engine a step uses and how its request
  is built.
- **The engine row** remains the record of:
  - availability (`is_active`, tier, flag)
  - price and run-time hints
  - soft deletion
  - history: attempts reference engine ids
- **The prompt tuner's promoted wording** remains in its own tables.
- **No new source is created:** the retired keys and fields are not read, so
  they cannot disagree with anything.

## Proposed Design

1. **One effective engine definition.** Executable engine definitions come
   from the code catalogue. That covers:
   - endpoint
   - provider and kind
   - family and image mode
   - size vocabulary
   - allowed options
   - parameter schema
   - call defaults: temperature, token limit, reasoning effort, default
     resolution and aspect ratio

   Database rows contribute only the retained operational fields:
   - availability (`is_active`)
   - retirement and deletion state
   - tier and visibility
   - ordering
   - pricing and run-time hints

   Selection and request construction both use
   this effective definition. That includes Eval's candidate selection by
   family and mode, and the prompt tuner's live family lookup. Historical
   records keep their recorded identities and requests, and prompt versions
   and promotions stay database records. A shared projection over the
   catalogue does this; it is not a new framework.
   - Every path that builds a request goes through it, including the Eval
     cell renderer. The workbench is removed rather than migrated.
   - An engine with no code definition cannot be dispatched. It is refused
     with a message naming it. Existing rows of that kind remain readable for
     history.
2. **Each step's engine is a code constant.** Enrichment, the gag writer, the
   image-prompt planner, the source classifier, image routing per render mode,
   the NSFW classifier endpoint, and the utility LLM, whose engine id replaces
   the `is_default` lookup.
   - Image routing's constants are dev's current per-mode values, read at build
     time and quoted in the PR.
   - The retired `admin_config` keys stop being read and seeded, following
     `codeOwnedPrompts.ts`.
3. **No stored value is overwritten.** The retired fields and keys stop
   being read and stop accepting edits, but keep their stored values,
   `is_default` included, until the separately approved cleanup.
   Reconciliation is unchanged. A code revert therefore restores today's
   behaviour exactly.
4. **Admin: retired and removed** (David's confirmation 2).
   - The Engines page goes, with its route, its navigation entry and its
     help-content entry. That includes the list, edit, Set default, on/off,
     soft-delete and restore, and the engine workbench test bench.
   - Their API routes are removed: PATCH, set-default, delete, restore and
     the workbench test routes.
   - The settings screen no longer shows the retired AI keys.
   - Anything else on that page that is not an AI setting is listed in the PR
     with where it went. Removing the page must not strand a non-AI control.
   - The Eval page and the prompt tuner stay. Eval compares engines and does
     not define them, and the tuner is David's named exception.
6. **Parameter audit** (David's confirmation 3).
   - For every engine the product can dispatch today, check the parameters
     its request actually carries against the model's accepted parameters:
     - production steps, image routing and the Eval candidates;
     - OpenAI by actual model and effort combination, checked against current
       OpenAI documentation rather than the helper's own comments;
     - each fal endpoint against its published input schema, read free
       through the fal connector.
   - The PR records the result per engine, covering parameter names, the
     values sent and conditional combinations.
   - A setting that is never sent (the reasoning models' temperatures) is
     removed from the catalogue, so the code shows only what is sent.
   - A parameter sent that the model does not accept is a defect, fixed in
     this PR.
5. **Docs.**
   - decisions.md: the 2026-11-14 entry records the removal of the engine admin
     UI and the parameter audit, following David's three confirmations.
   - visual-pipeline.md and admin-console.md describe the new admin behaviour.
   - glossary.md is touched only if a term changes.

## Data Model and Migration Impact

There is no schema change and no migration.

This change writes no data. Stored values are left as they are, and so
are reconciliation's existing refreshes of code-owned fields, including on
soft-deleted rows, which keep their tombstone.

Rollback is a code revert, and it is complete because nothing stored
changed.

The retired `admin_config` rows stay until the separate destructive step.

## Runtime Behavior

- Every AI request carries the code's settings, whatever any row or key holds.
- A call-site override that exists today stays, because it is also code. For
  example, the utility LLM's per-call effort.
- If a step's code-chosen engine is switched off with `is_active`, the step
  behaves as it does today when its engine is inactive:
  - The gag writer fails visibly.
  - The utility LLM uses its baked-in fallback.
  - The other steps keep their current fallback behaviour.

## Admin/User UX Impact

- **Admin:** the Engines page and the AI keys on the settings screen are gone.
  The Eval page and the prompt tuner are unchanged.
- **Users:** no visible change.

## Security, Permissions, and Validation

- The admin routes keep `requireAdmin`.
- Removing the engine admin routes narrows what an admin can write and widens
  nothing.

## Testing Plan

Runner: `pnpm --filter api-server test`, plus the frontend suite for the
Engines page. Following the `codeOwnedPrompts.test.ts` stale-row pattern:

- **For each AI call path** (utility LLM, enrichment, gag writer, image-prompt
  planner, image render per mode, NSFW classifier, source classifier, Eval
  cell):
  - Seed a conflicting row value and a conflicting `admin_config` key.
  - Capture the outgoing request and assert that it carries the code's model,
    endpoint and parameters.
- **Negative cases:**
  - The removed engine admin routes are gone.
  - Dispatching an engine with no code definition is refused.
  - `is_active=false` on the gag writer still fails visibly.
- **Also seeded with conflicting values:**
  - a valid but different size vocabulary, which must not change the
    dimensions sent;
  - a different family or mode, which must not change Eval's candidate
    selection or the prompt tuner's family lookup;
- **Rollback safety:** seed conflicting values in the formerly editable
  settings, `is_default` included, run reconciliation, and assert those
  values are unchanged.
- **Unchanged cases:**
  - An Eval candidate still renders on its own engine.
  - An attempt records the engine it ran.
  - Prompt-tuner promotion still works.
- **Parameter guard:** for every dispatchable engine, the built request
  carries only the parameters and values the audit recorded as accepted for
  that model and effort.
  The test fails if one is added that is not.
- **Frontend:** the Engines page and its navigation entry are gone, the
  settings screen shows no retired AI key, and the old route is not found.

UAT: none. Every visible change is a removal, checked by tests.

## Implementation Steps

1. Re-run the inventory search, then add the code-authoritative engine loader
   and route every dispatching reader through it.
2. Replace each `admin_config` engine key and `is_default` with code constants.
   Read dev's image-routing values first.
3. Reconciliation keeps its existing field-preservation policy. Today
   `ADMIN_EDITABLE_FIELDS` is both the PATCH allowlist and the set
   reconciliation preserves. Removing PATCH must not shrink the preserved
   set, so boot still never overwrites the formerly admin-owned fields.
   Stored defaults and `is_default` are left untouched, and the cutover
   writes nothing.
4. Admin: remove the Engines page, its routes and the retired settings keys.
5. Parameter audit, removing values that are never sent.
6. Tests as above; docs; decisions.md entry.

One PR.

## Risks and Mitigations

- **Production's values.** Production was read through the connector. It
  differs from dev only by release lag, which decisions.md 2026-11-13 settles
  (see Settled Decisions).
- **A missed reader.** The stale-row tests cover each named path, and the
  inventory search is re-run at build time and quoted.
- **Losing the workbench and the on/off switch.** Trying a new model is a code
  change, and switching one off is a reviewed migration. That is David's direction, and the
  Eval page still compares engines.

## Questions for David

None. David's three confirmations of 2026-11-14 are in the oracle.

## Definition of Done

- [ ] Every AI call path's outgoing request carries code settings despite
      conflicting rows and keys (tests).
- [ ] The admin Engines page, its routes and the retired settings keys are
      gone.
- [ ] Every dispatchable engine's request carries only accepted parameters,
      recorded per engine in the PR, and the code holds no setting that is
      never sent.
- [ ] Eval, attempt provenance and prompt-tuner promotion unchanged (tests).
- [ ] decisions.md and the subsystem docs are updated.
- [ ] On dev after the sync, the gag writer runs at medium effort with no hand
      edit, checked through the connector.
