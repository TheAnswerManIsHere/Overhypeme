# Moderator visual-strategy override (Phase 2) — automated test run

Paired with **`docs/PR114_VISUAL_STRATEGY_OVERRIDE_UAT.md`** (the click-through
acceptance test). This doc is the engineering safety net for Replit. **Replit
owns the database connection** — apply migrations / run tests against your own
DB; this doc sets no `DATABASE_URL` or DB env. **No new DB columns or migration**
— the override is nested in the existing `enrichment` jsonb blob.

## TL;DR

```
# libs (from repo root) — api-zod schema + override module
pnpm tsc -p lib/api-zod/tsconfig.json                                   # clean

# api-server (from artifacts/api-server)
pnpm run typecheck                                                      # tsc + cycles (still 1 known) + no-console, clean
node --import tsx/esm --test src/__tests__/nanoBanana2Compiler.test.ts             # 56 pass (10 new override cases)
node --import tsx/esm --test src/__tests__/visualStrategyOverride.test.ts          # 12 pass (schema + resolveRenderPolicy)
node --import tsx/esm --test src/__tests__/routes.adminFactsEnrichment.test.ts     # all pass (+ stamping, token, preservation)
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # all pass (non-regression)

# overhype-me (from artifacts/overhype-me)
pnpm tsc -p tsconfig.json --noEmit                                     # clean
npx vitest run src/__tests__/RuntimePromptPreview.test.tsx             # all pass
```

## What this phase adds

A per-fact, structured, style-agnostic, **token-aware** moderator override that
sharpens the AI's first-pass visual strategy without editing the brittle final
Nano Banana prompt. Render-time merge only: **no DB migration, no re-enrichment,
no new engine.**

1. **Schema (`lib/api-zod/src/visualStrategyOverride.ts`)** — `VisualPromptStrategyOverride`
   (`version: 1`, `enabled`, `subjectRealizationOverride{mode,description}` incl.
   the default `use_ai_plan`, `requiredVisualDetails[]`, `forbiddenVisualDetails[]`,
   `roleBindings[{entity,visualRole}]`, `compositionGuidance[]`,
   `styleAgnosticPromptAdditions[]`, `negativePromptAdditions[]`,
   `supportingTextPolicyOverride?`, `violencePolicyOverride?`, `moderatorIntent?`,
   `notesForModerator?`, server-owned `updatedBy?`/`updatedAt?`). Added optional to
   the **stored** `factEnrichmentBase` only — NOT the strict
   `factEnrichmentWireSchema`, so the LLM never produces it.
   - **Token handling**: the schema canonicalizes `{name}`/`{Name}` → `{NAME}` and
     **hard-rejects unknown tokens** (reusing `validateTemplate`).
   - `resolveRenderPolicy(enrichment)` (in `imagePromptGeneration.ts`) maps the
     override's text/violence policy onto the Phase-1 `RenderPolicy`.
2. **Compiler (`compilers/nanoBanana2.ts`)** merges the override into the labeled
   contract: SUBJECT REALIZATION (added, never replacing the compiler-owned
   identity/single-subject/anti-split binding), REQUIRED VISUAL DETAILS,
   REFERENCE INTERPRETATION (role bindings override AI `secondaryCharacters`),
   COMPOSITION, ADDITIONAL DETAILS, and STRICT CONSTRAINTS (forbidden + negative
   additions as normalized "Do not …" lines, no double-prefix). Every section is
   token-rendered; a defensive `hasUnresolvedFactTokens` check warns if any token
   leaks.
3. **Precedence** — moderator render-policy override > per-fact softening
   modifiers > Phase-1 defaults. A moderator violence override drops conflicting
   `avoid_gore`-style modifier directives so the prompt never both demands and
   forbids violent consequences.
4. **Preservation (`enrichmentJobs.ts`)** — re-classification carries the override
   (incl. provenance) forward verbatim; re-running AI never wipes it.
5. **Provenance (`routes/admin.ts`)** — the facts enrichment PATCH stamps
   `updatedBy`/`updatedAt` only when the override content changed (order-independent
   compare, since jsonb reorders keys); the AI never sets them.
6. **Preview (`adminImagePrompt.ts` + `RuntimePromptPreview.tsx`)** — optional
   `previewName`/`previewPronouns` so a moderator can render the override for
   different subjects (default `David Franklin` / `he/him`).
7. **Admin UI** — `VisualStrategyOverridePanel` in the shared `EnrichmentEditor`
   (Facts page + Moderation modal), with client-side warnings (invalid tokens,
   empty role bindings, enabled-but-empty, `require` without guidance, realization
   mode without description). Ships on by default; no rollout flag.

## Test coverage highlights

- Override disabled → prompt unchanged; enabled → REQUIRED VISUAL DETAILS present.
- Realization ADDS SUBJECT REALIZATION while SUBJECT BINDING identity guard
  remains; `use_ai_plan` emits no realization block but other fields still apply.
- Forbidden + negative additions → "Do not …" lines, no `Do not Do not` / `Do not Avoid`.
- Role bindings → REFERENCE INTERPRETATION (subject + secondary); composition →
  COMPOSITION; style additions → ADDITIONAL DETAILS.
- Moderator violence override drops a conflicting `avoid_gore` directive.
- `{NAME}` renders in EVERY override-derived section; final prompt has no
  unresolved tokens.
- Schema: bad enum / wrong version / unknown token → hard fail; `{name}`→`{NAME}`;
  `resolveRenderPolicy` returns override when enabled else default.
- Re-classification preserves the override + provenance; PATCH stamps provenance
  on change and preserves it when unchanged; unknown token rejected on PATCH.

## Schema / SQL checks

- **No migration.** `visualPromptStrategyOverride` lives inside the `enrichment`
  jsonb blob on `facts` (and `pending_reviews`, via the review draft).
- Confirm `factEnrichmentWireSchema` does NOT include the override (the LLM
  contract is unchanged).
- Confirm `validateEnrichment` accepts an enrichment with a valid override and
  rejects an invalid enum / unknown token.

## What's deliberately NOT shipped (deferred to Phase 3)

- Token insertion **chips/helpers** in the UI (Phase 2 validates/renders typed
  tokens but does not add a token picker).
- Semantic suppression of arbitrary conflicting AI prose — conflicts are handled
  by the realization-ADD + `forbiddenVisualDetails` "Do not …" constraints, not by
  rewriting AI sentences.
- A raw full-prompt escape hatch.
