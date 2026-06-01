# Runtime Compiled Prompt Preview — Automated test run

Engineering-side checklist for the **Runtime Compiled Prompt Preview**
(Phase 2C). The feature surfaces the *real* render-time image prompt in
the admin UI and makes the existing enrichment "example" prompts
unmistakably preview-only. Hand this to Replit (or run locally) to
confirm everything is wired correctly.

The User Acceptance Test is in
[`RUNTIME_PROMPT_PREVIEW_UAT.md`](./RUNTIME_PROMPT_PREVIEW_UAT.md) — that
one is for the product owner to walk through in a browser.

No schema or migration changes ship in this work.

---

## TL;DR

```bash
# 1. Apply migrations (no new ones here, but keep the DB current).
pnpm --filter @workspace/db run migrate

# 2. Backend: the new preview-route test (12 tests, mocks the generator —
#    NO live OpenAI call).
cd artifacts/api-server && \
  node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts

# 3. Frontend: the new component + relabel test (6 tests).
cd artifacts/overhype-me && \
  pnpm exec vitest run src/__tests__/RuntimePromptPreview.test.tsx

# 4. Targeted typecheck for the touched packages.
cd artifacts/api-server && pnpm exec tsc -p tsconfig.json --noEmit
cd artifacts/overhype-me && pnpm exec tsc -p tsconfig.json --noEmit
```

If those are green you can stop. Sections below break each step out and
note the pre-existing failures that are **not** caused by this work.

---

## A — Setup gate

### A1. Test DB is up

Ensure a Postgres database is reachable for the backend test. The exact
connection setup belongs to the running environment, not this doc — the
backend test seeds and tears down its own rows under the `t-ipp-`
prefix.

### A2. No new migrations

This work adds no DDL/DML. `pnpm --filter @workspace/db run migrate`
should report everything already up-to-date. The `image_prompt_attempts`
table the optional "persist" path writes to already exists from Phase 2.

---

## B — Backend (api-server)

```bash
cd artifacts/api-server && \
  node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts
```

Pass criterion: **12 tests pass, 0 fail.**

The route statically imports the live OpenAI-backed
`generateImagePromptPlan`. The test swaps it via the
`__setPlanGeneratorForTest` seam (mirroring `adminEngines.ts`), so **no
test hits OpenAI**. The real Nano Banana compiler
(`compileForSubjectRenderMode`) still runs on the stubbed plan, so the
mode-specific preamble assertions exercise production compile logic.

| Group | Check |
| --- | --- |
| auth | 401 unauthenticated; 403 `admin_required` for a non-admin |
| validation | 400 `factId is required`; 400 `fact_not_found`; 400 `fact_enrichment_invalid` for a fact with junk enrichment |
| human i2i | `renderedFactText` resolves `{NAME}` → "David" (no raw token); `inputSummary` echoes mode/generationMode/targetEngine/`styleSource:"none"`/`preservePhysique`; `debug` carries archetype/subtype/version/`generatedBy`; compiled prompt contains "preserve the reference person's recognizable face" |
| nonhuman i2i | compiled prompt contains the "do not replace … human" clause |
| t2i fallback | `inputSummary.generationMode:"t2i"`, `fallbackSubjectGender:"female"`; compiled prompt mentions "female" |
| style source | with a seeded `look_styles` row + `lookStyleId` → `styleSource:"selected_look_style"` + non-empty `stylePrompt` + suffix appears in the compiled prompt; without → `styleSource:"none"`, empty `stylePrompt` |
| regression / non-mutation | `debug.semanticEntitiesUsed` echoes the plan's entities (Earth); `debug.culturalReferencesProvided` reflects enrichment (Shark Week) while `culturalReferencesUsed` is `[]`; the fact's stored `enrichment` is byte-for-byte unchanged after a preview call |

### Rendered-fact-text invariant (read this)

The generator's user message is explicitly labelled *"RENDERED FACT
TEXT (subject/pronouns already resolved)"* (`generator.ts`). The preview
route therefore personalizes the fact template with the brand
protagonist (`renderPersonalized(text, "David", "he/him")`) **before**
prompt generation, and returns that string as `renderedFactText`.

The production render path (`imagePromptJobs.ts`) currently passes the
raw `{NAME}` template into `input.factText` — a latent bug. This PR adds
a `TODO(prompt-rendering)` comment there but does **not** change
production render behavior (that needs its own user-identity wiring +
UAT). The preview feature is self-contained.

---

## C — Frontend (overhype-me)

```bash
cd artifacts/overhype-me && \
  pnpm exec vitest run src/__tests__/RuntimePromptPreview.test.tsx
```

Pass criterion: **6 tests pass, 0 fail.** Covers:

- Panel is collapsed by default; expands to reveal controls + Generate.
- Generate POSTs to `/api/admin/image-prompt/preview` with
  `factId`/`subjectRenderMode`/`persist:false` and renders the compiled
  prompt (`compiledPrompt.imagePrompt`) + the input-summary grid.
- Control changes map into the request body: switching to
  `t2i_fallback` drops the synthetic `sourceImageAnalysis` and sends
  `renderControls.fallbackSubjectGender`/`aspectRatio`; ticking the
  opt-in checkbox flips `persist:true`.
- A 400 `fact_enrichment_invalid` response renders the friendly
  "run Backfill enrichment first" message.
- The collapsible visual-plan debug pane renders the plan JSON.
- `EnrichmentSummary` shows the relabeled **"Preview-only example I2I /
  T2I prompts"** summary.

---

## D — Manual API smoke (optional, real OpenAI)

The automated backend test mocks the generator. To see a real plan,
call the route as an admin against a fact that already has enrichment:

```bash
curl -s -X POST http://localhost:<api-port>/api/admin/image-prompt/preview \
  -H "Cookie: <admin-session>" -H "Content-Type: application/json" \
  -d '{ "factId": <id>, "subjectRenderMode": "human_identity_i2i" }' | jq '.'
```

Pass criterion: 200 with `renderedFactText`, `inputSummary`,
`compiledPrompt`, `visualPlan`, `debug`. This costs one OpenAI call.
Unauthenticated → 401; non-admin → 403; unknown fact → 400.

---

## E — Pre-existing failures that are NOT this work's regressions

- A full `tsc -p tsconfig.json --noEmit` on either package reports
  `TS6305 "Output file … has not been built from source"` for workspace
  `dist/*` outputs (`@workspace/db`, `@workspace/api-zod`,
  `@workspace/api-client-react`, …). These are a project-reference build-
  ordering artifact present on `main`, not type errors in this change.
  Build the referenced packages first (`tsc -p lib/db/tsconfig.json`,
  etc.) for a clean run, or scope the check to the touched files:
  `adminImagePrompt.ts`, `imagePromptJobs.ts`, `imagePromptPreview.test.ts`,
  `RuntimePromptPreview.tsx`, `facts.tsx`, `EnrichmentEditor.tsx` — all 0
  errors.
- `pnpm --filter @workspace/api-server test` uses
  `--test-isolation=none`, which this sandbox's node rejects. Invoke the
  single test file directly as in section B. (Flagged in prior sessions
  too.)

---

## What this work explicitly does NOT ship

- **Any change to production render behavior.** The
  `imagePromptJobs.ts` rendered-fact-text bug is annotated with a TODO
  and left for a dedicated follow-up; this PR only fixes the *preview*.
- **A cultural-references "used" echo.** The `visualPlan` has no echo
  array for cultural refs, so `debug.culturalReferencesProvided` (what
  the generator was given) is authoritative; `culturalReferencesUsed`
  is `[]`.
- **Removing the Phase 2A enrichment preview or the engine workbench.**
  Both stay; the enrichment "example" fields are only relabeled.
- **Taxonomy/strategy-map content, provider swaps, video prompting,
  auto-generating images.**
```
