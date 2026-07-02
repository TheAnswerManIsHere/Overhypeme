# PR157 — Frontier visual planner + moderator core scene (Visual concept) — Replit TEST RUN

Companion UAT (for David): `docs/PR157_VISUAL_CONCEPT_CORE_SCENE_UAT.md`.

## What this PR changes (context for the checks)

1. Render-time image-prompt generation now routes through a dedicated LLM engine
   (`openai-visual-planner`, gpt-5.5 @ reasoning effort `xhigh`, 180s per-call
   timeout) selected by the new `fact_image_prompt_engine_id` admin_config key.
   Invalid/inactive engine config falls back to the old default-LLM behavior with
   a recorded `fallbackReason`. Planner provenance (engine/model/effort/fallback)
   rides the compiled prompt's diagnostics and prompt-gen error messages.
2. The planner engine can NEVER become the global default `llm` engine — blocked
   on both `POST /admin/engines/:id/set-default` and the PATCH `isDefault` path
   (`eligibleAsKindDefault` derived from the code catalogue).
3. `visualPromptStrategyOverride.coreSceneOverride` (max 1500 chars, token-aware):
   moderator-authored scene that wins over the AI plan's coreScene, compiles as
   the required non-compressible CORE SCENE (marked `moderatorAuthored`), is
   injected into the planner user message as a hard directive, and raises
   visible warnings when compiler-owned language is stripped from it (falling
   back to the AI scene if it empties out).

## STEP 1 — Live API smoke check (REQUIRED; could not run in the build env — no OpenAI key there)

This is the one check the build environment could not perform. OpenAI's current
reasoning guide documents the Responses API shape, while this repo calls Chat
Completions with `reasoning_effort` — gpt-5.5 + `xhigh` through OUR path must be
proven live, not assumed.

- With the app's real `OPENAI_API_KEY` available, run a single render-time
  prompt generation through the real path (e.g. the Runtime Prompt Preview
  recompute via `POST /api/admin/image-prompt/preview` against any enriched
  fact, or a moderation scenario render).
- PASS: server logs show a completed call with model `gpt-5.5`; the preview
  response's `compiledPrompt.diagnostics.plannerProvenance` is
  `{ resolvedEngineId: "openai-visual-planner", model: "gpt-5.5", reasoningEffort: "xhigh", fallbackReason: null }`
  and the structured-output plan validates (no `prompt-gen failed` error).
- FAIL (API rejects the model/param combination): record the exact OpenAI error.
  The agreed contingency is a planner-route-local adaptation to the Responses
  API (same resolver/provenance/fallback semantics) — do NOT migrate other
  `callUtilityLLM` callers. Report before changing anything.
- Record the observed result (model, endpoint shape, xhigh accepted, structured
  output OK, wall-clock duration) in your run notes — the duration also sanity-
  checks the 180s timeout headroom.

## Commands

```
pnpm typecheck                              # tsc -b libs + both artifacts (incl. cycle + no-console checks)
pnpm --filter @workspace/api-server test    # node:test, sharded; pretest pushes schema + migrations
pnpm --filter @workspace/overhype-me test   # vitest
```

Expected: typecheck clean; api-server all pass (479 at time of writing across 4
shards); overhype-me all pass (667 at time of writing). Zero skips.

## Test files that carry this PR's contract

- `artifacts/api-server/src/__tests__/imagePromptEngine.test.ts` (NEW) — catalogue
  definition (gpt-5.5/xhigh/2800/eligibleAsKindDefault:false), resolver
  provenance for the valid path + all six fallback reasons (missing id,
  inactive, soft-deleted, wrong kind, wrong provider, missing endpointId),
  config-key seeding + idempotence.
- `artifacts/api-server/src/__tests__/adminEngines.test.ts` — "kind-default
  eligibility guard" describe: 400 on set-default AND on PATCH isDefault:true
  for the planner; DB-only rows stay eligible; derived `eligibleAsKindDefault`
  on GET; gpt-5.5 + xhigh PATCH round-trip.
- `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts` —
  "moderator-authored core scene" describe: precedence over the AI scene,
  required/non-compressible under budget pressure, MODERATOR marker, token
  render before sanitation, `moderator_core_scene_stripped` +
  `moderator_core_scene_empty_after_sanitize` warnings with AI-scene fallback,
  coexistence with requiredVisualDetails, hard-truncation note.
- `artifacts/api-server/src/__tests__/imagePromptUserMessage.test.ts` —
  "moderator core-scene directive" describe: authoritative block present only
  when enabled + non-empty; token-free; ONLY coreSceneOverride is read.
- `artifacts/api-server/src/__tests__/visualStrategyOverride.test.ts` — schema
  cases: optional field, token canonicalization, unknown-token rejection,
  1500-char cap, `hasRenderableVisualStrategyOverrideContent`.
- `artifacts/api-server/src/__tests__/factRenderScenarios.test.ts` — staleness
  hash flips on a coreSceneOverride-only edit (the auto-stale UX contract).
- `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx` (NEW)
  + `src/__tests__/RuntimePromptPreview.test.tsx` — card auto-enable/clear/
  chips/counter; MODERATOR chip, provenance line + FALLBACK banner, warnings.

## DB expectations (after one server boot)

- `engines` has row `openai-visual-planner`: `kind='llm'`, `provider='openai'`,
  `endpoint_id='gpt-5.5'`, `is_default=false`, `default_reasoning_effort='xhigh'`,
  `default_max_tokens=2800`.
- `admin_config` has `fact_image_prompt_engine_id = 'openai-visual-planner'`.
- NO new tables/columns — `coreSceneOverride` lives inside the enrichment JSONB;
  eligibility is code-catalogue-derived, not a column. There is no migration in
  this PR (journal count unchanged).

## Manual API spot-checks (optional, against the dev server)

- `POST /api/admin/engines/openai-visual-planner/set-default` → 400 with
  "dedicated config key" in the error. `PATCH … {"isDefault": true}` → same 400.
- `GET /api/admin/engines` → the planner row carries
  `eligibleAsKindDefault: false`; `openai-general` carries `true`.
- Set `fact_image_prompt_engine_id` to a bogus id in admin config, recompute a
  Runtime Prompt Preview → response still succeeds;
  `diagnostics.plannerProvenance.fallbackReason = "engine_not_found"`; server
  log has `[imagePrompt.generator] visual planner engine fallback`. Restore the
  key afterwards.

## Deliberately NOT shipped (do not flag as missing)

- Candidate visual-concept generation / pick-one UX (slice 2; will auto-generate
  during async prep per the agreed decision).
- Attempt rating / eval-loop fields; taxonomy knob re-tiering; raw-prompt debug
  tool (slices 2–3).
- Responses-API migration for utility LLM calls (only the contingency above,
  and only if Step 1 fails).
- The planner reads ONLY `coreSceneOverride`; other override fields reaching the
  planner is out of scope (compiler still owns them — documented split-brain
  boundary).

## Gotchas

- gpt-5.5 @ xhigh is SLOW (tens of seconds to minutes per prompt-gen) and
  meaningfully pricier — that is the accepted design, not a regression. The
  per-call timeout is 180s; the async queue has no per-job execution timeout,
  so a slow call retries rather than data-losing.
- If prompt-gen returns empty content / truncation errors under xhigh, raise the
  engine row's `defaultMaxTokens` from /admin/engines (reasoning headroom is
  +8000 on top of it) and note it in your run report.
- `moderator_core_scene_*` warnings in preview diagnostics are FEATURES (visible
  sanitation), not failures.
