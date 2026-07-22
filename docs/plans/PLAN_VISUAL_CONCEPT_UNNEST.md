# Plan — Visual Concept: one prominent surface, authoritative independent of the override toggle

**Status:** proposed (for review). Not approved. Only David approves.
**Mode:** feature-building. **Subsystem:** visual pipeline (high-risk — apply the
`overhype-visual-pipeline` review discipline).
**Verified against:** `origin/main` @ `de6ca1f` (post-#229 "Speech & thought bubble
controls" and post-#228). All line references below are current as of that commit.

**Revision log:**
- rev 2 — Codex round 1 (PR #232): P1 — candidate bubble picks must not activate a disabled
  base's stale advanced fields (decision 5 + §C refined; acceptance test added). P2 — a
  now-authoritative `enabled:false` scene must still pass the save-time rendered-budget gate
  (new §F + route tests). Verified P2's mechanism: `validateVisualStrategyOverrideForSave`
  already budget-checks the core scene independent of `enabled`; the only gap is the
  route-level `if (submittedVso?.enabled)` guard.

---

## Product intent (David)

"Visual Concept is included in the Visual Strategy Override section. It shouldn't be."
The Visual Concept should be **authoritative on its own**, not conditioned on the
override's enabled/disabled toggle (which is really meant to gate the *other* override
fields — role bindings, subject depiction, required/forbidden details, policy overrides,
and now speech/thought bubbles).

David's two scoping decisions for this build:

1. **Data risk: not a concern.** We are pre-launch and David is re-doing all facts
   anyway, so no audit query and **no migration** — un-nest and ship. Any leftover
   `enabled:false` fact with a stray `coreSceneOverride` newly becoming authoritative is
   acceptable.
2. **Scope: Option 1 — one prominent Visual Concept surface, on both admin pages.**
   David dislikes ambiguous UX ("the worst thing in the application is bad UX") and wants
   it *extremely clear what the admin needs to do*. So we do more than un-nest: we make the
   prominent `VisualConceptCard` the **only** place to edit the Visual Concept everywhere,
   and remove the duplicate copy from the Advanced Options panel.

### Why Option 1 (not just un-nesting)

There are two confusing situations today, not one:

- **Moderation review page** — the Visual Concept is editable in **two** places at once:
  the prominent `VisualConceptCard` in Step 2 (`moderation.tsx:1056`) **and** a second copy
  buried in Advanced Options → Visual Strategy Override panel
  (`EnrichmentEditor.tsx:1336-1352`).
- **Facts admin page** — there is **no** prominent card; the Visual Concept exists *only*
  inside Advanced Options (`facts.tsx` renders `EnrichmentEditor` but not
  `VisualConceptCard`), so the single most important lever is buried in the advanced
  machinery.

Merely un-nesting the panel copy (making it always visible) would make the moderation page
show the same field **twice, both always-editable** — worsening exactly the UX David wants
fixed. Option 1 resolves both: one prominent card, one place, on both pages; Advanced
Options becomes strictly the advanced override machinery.

---

## Must not change (invariants)

Per `docs/ai-context/visual-pipeline.md` and the `overhype-visual-pipeline` skill:

1. **The Visual Concept remains the AUTHORITATIVE scene.** When present it still wins over
   the AI plan, is emitted verbatim (token-rendered, warn-not-strip on compiler-owned
   language), and leads the prompt / seeds the de-dupe haystack. This change makes it
   authoritative in *more* cases (regardless of `enabled`), never fewer.
2. **No duplicate prompt channels.** Still one Visual Concept blob
   (`coreSceneOverride`) rendered through one CORE SCENE section. The bubble channel and
   its dedupe-exemption (#229) are untouched.
3. **Bubbles, role bindings, subject depiction, required/forbidden details, and policy
   overrides stay `enabled`-gated.** Only the Visual Concept decouples from `enabled`.
4. **Preview matches runtime.** The admin "Runtime Compiled Prompt" preview and the real
   compiler read the scene the same way after the change.
5. **Tokenization / canonicalization of `coreSceneOverride` is unchanged.** The shared
   `collectRenderedTextEntries` collector (used by tokenize routes, dirty-detection, and
   budget) keeps returning `coreSceneOverride`. We do **not** edit that collector.
6. **Staleness / processing-signature hashing is unchanged** — it already hashes the whole
   override regardless of `enabled`.

---

## Settled decisions

1. No data audit, no migration (David — pre-launch, facts being redone).
2. Option 1: single prominent card on both pages; remove the panel's scene field.
3. After the change, `enabled` means *"the advanced override machinery is active."* The
   Visual Concept is authoritative whenever non-empty, independent of `enabled`.
4. The moderation approval gate ("approve visual gag") drops its `enabled` requirement and
   gates on a **non-empty saved Visual Concept** only — both in the UI affordance and the
   server-authoritative check.
5. Typing a scene in the card no longer auto-enables the override. Picking an AI candidate
   enables the override **only if the candidate carries bubbles** (the only gated content a
   candidate brings); a scene-only candidate leaves `enabled` as it was. **Critically (Codex
   P1):** when a bubble pick transitions `enabled` from false→true, it must NOT drag along
   the disabled base's stale advanced fields (role bindings, required/forbidden details,
   subject-depiction override, policy overrides, composition/style/negative additions).
   Because `enabled` is the single shared gate, activating it would otherwise emit all that
   previously-dormant content. So a false→true pick resets the advanced fields to empty and
   carries **only** the candidate's scene + bubbles. This preserves the "never silently
   activate unreviewed override fields" principle while ensuring the picked candidate's
   bubbles still render.

## Open product questions

None. Intent is settled; the remaining decisions above are engineering-correctness calls
within David's stated intent.

## External-claim verification

Not applicable — this is a purely internal refactor (admin UI + prompt-compiler wiring). No
external API / SDK / model / pricing / rate-limit claims.

---

## The change, grouped

### A. Decouple render-time (backend)

- **`artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts:1290`** — derive
  `moderatorCoreRaw` from the **raw** enrichment override, not the enabled-gated
  `activeOverride()`. Keep `ov = activeOverride(input)` for bubbles/role-bindings/etc.
  (unchanged). The verbatim/warn-not-strip handling, the `detectOwnedLanguage` warning, and
  the `hasBubbles && BUBBLE_DIRECTIVE_LANGUAGE_RE` warning (`:1304-1321`) stay as-is —
  `hasBubbles` still rides `ov`, so a scene present while the override is disabled simply
  won't trip the bubble-doubling warning (correct: no bubbles are active).
- **`artifacts/api-server/src/lib/imagePrompt/generator.ts:226-228`** —
  `hasAuthoritativeCoreScene`: drop the `override?.enabled &&` conjunct; test only for a
  non-empty `coreSceneOverride`. (This flag tells the planner its additive delta
  collections may legally be empty.)
- **`artifacts/api-server/src/lib/imagePrompt/generator.ts:370-372`** —
  `resolveModeratorContextScene`: read `ovb?.coreSceneOverride?.trim()` directly, without
  the `ovb?.enabled ?` gate.

### B. Decouple approval-time (backend + UI gate)

- **`artifacts/api-server/src/lib/moderationStaging.ts:182-189`** —
  `resolveSavedCoreSceneForReview`: remove the `CONCEPT_DISABLED` branch (`!ov ||
  ov.enabled !== true`). Read `ov?.coreSceneOverride?.trim() ?? ""` and keep the
  `CONCEPT_MISSING` check for an empty scene. (Retire the `CONCEPT_DISABLED` code; confirm
  no other caller depends on it — the only reference is the route + its test.)
  Called from `artifacts/api-server/src/routes/reviews.ts:1058`
  (`POST /admin/reviews/:id/approve-visual-concept`).
- **`artifacts/overhype-me/src/pages/admin/moderation.tsx:729`** — `draftHasConcept`: drop
  `conceptOverride?.enabled &&`; gate on `conceptOverride?.coreSceneOverride?.trim()` only.
  This flows into `canApproveGag` (`:740`), `canSaveConceptAndContinue` (`:741`), and
  `ideasStaleButSaved` (`:736`) — all now correctly independent of the toggle.

### C. Remove the coupling mechanisms (frontend / shared)

- **`artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx:1190-1201`** —
  `withCoreSceneOverride`: drop the `enabled: base.enabled || canonical.trim().length > 0`
  side effect. Return `{ ...base, coreSceneOverride: canonical }` (preserves `base.enabled`
  unchanged). Typing a scene no longer flips the override on.
- **`lib/api-zod/src/visualConcepts.ts:288-299`** — `withCandidateConceptDraft`: replace the
  blanket `enabled: true` with a rule that (a) enables only when the candidate brings bubbles
  and (b) does not activate a disabled base's stale advanced fields (Codex P1). Shape:

  ```ts
  const hasBubbles = (candidate.bubbles?.length ?? 0) > 0;
  const nextEnabled = base.enabled || hasBubbles;
  // On a false→true transition, start advanced fields from EMPTY so a bubble pick
  // never activates role bindings / policy / additions the moderator never reviewed.
  const advancedBase = !base.enabled && nextEnabled ? EMPTY_VISUAL_STRATEGY_OVERRIDE : base;
  return {
    ...advancedBase,
    enabled: nextEnabled,
    coreSceneOverride: candidate.sceneDescription,
    bubbles: (candidate.bubbles ?? []).map(({ type, entity, text }) => ({ type, entity, text })),
  };
  ```

  (Function-body change only — no new `lib/api-zod` export, so the codegen/`index.ts`
  regeneration gotcha from PR #230 does not apply. Run codegen once and confirm
  `git diff --exit-code lib/api-zod/src/index.ts` is clean regardless.)

### D. Option 1 UI — single prominent surface

- **`artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx:1336-1352`** — remove
  the Core Scene field `<div>` from `VisualStrategyOverridePanel` (label, textarea,
  counter, tokenize error). `BubbleEditor` (`:1450`) and every other field stay inside the
  `{ov.enabled && (…)}` block (`:1300`) — bubble gating is unchanged.
- **`artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx:1274-1276`** — the
  "enabled but has no renderable content" warning must **exclude** `coreSceneOverride` now
  that the scene isn't a panel field and isn't what `enabled` is about. Add a small,
  tested helper (e.g. `hasRenderableOverrideContentBesidesCoreScene(ov)`) in
  `lib/api-zod/src/visualStrategyOverride.ts` and use it **only** for this warning. Do
  **not** modify `hasRenderableVisualStrategyOverrideContent` or `collectRenderedTextEntries`
  (invariant 5).
- **`artifacts/overhype-me/src/pages/admin/facts.tsx`** — add `VisualConceptCard` above the
  `EnrichmentEditor` render (`:322`), mirroring `moderation.tsx:1056-1063`. Wiring already
  exists in scope: `value={enrichment?.visualPromptStrategyOverride}`, `disabled` from
  `vsoTokenizing`/`committing`, `tokenizeError={vsoTokenizeErrors["coreSceneOverride"]}`,
  `onChange` → `draft.setValue({ ...enrichment, visualPromptStrategyOverride: next })`.
- **`artifacts/overhype-me/src/components/admin/VisualConceptCard.tsx:1-9`** — update the
  doc-comment: the field no longer "also appears inside the Visual Strategy Override panel";
  this card is the single editing surface, on both the moderation and Facts pages.
- **`artifacts/overhype-me/src/pages/admin/moderation.tsx`** — reconcile copy that implies
  the scene is editable in Advanced Options: the Step 2 hint (`:1047-1050`), the
  `ideasStaleButSaved` note ("your latest Advanced Options edit … the saved Visual Concept
  below", `:1114-1116`), and the card's own comment (`:1052-1055`). Point them at the card.

### E. Regenerate-seed gate (frontend)

- **`artifacts/overhype-me/src/pages/admin/moderation.tsx:527-529`** — `coreSceneDraft` in
  `onGenerateConcepts`: drop the `?.enabled ?` gate so the regenerate context is seeded from
  the saved scene regardless of the toggle.

### F. Save-time budget gate for the disabled-but-authoritative scene (Codex P2)

Once a scene can persist with `enabled:false` (typing no longer auto-enables), the two save
routes must still budget-check the now-authoritative scene. Today they skip validation
entirely when the override is disabled:

- **`artifacts/api-server/src/routes/admin.ts:1179`** and
  **`artifacts/api-server/src/routes/reviews.ts:1403`** — both wrap
  `validateVisualStrategyOverridePersistence(submittedVso)` in `if (submittedVso?.enabled)`.
  Change the guard to run the validator whenever a VSO with a **non-empty `coreSceneOverride`**
  is submitted, even when `enabled:false` (e.g. `if (submittedVso && (submittedVso.enabled ||
  submittedVso.coreSceneOverride?.trim()))`).
- **No validator-internals change needed.** `validateVisualStrategyOverrideForSave`
  (`lib/api-zod/src/promptBudget.ts:190`) already checks the core scene's raw cap
  (`CORE_SCENE_RAW_MAX`) and rendered budget (`CORE_SCENE_RENDERED_MAX`) independent of
  `enabled`; the additions/bubbles measures (`measureModeratorAdditionsEmission:194`,
  `measureBubbleDirectivesEmission:215`) already return `0` when disabled, so additions and
  bubbles **stay** enabled-gated exactly as before. The over-budget scene is rejected with the
  existing `visual_strategy_override_over_budget` 400, never silently dropped at render.

---

## Tests (assert the invariant, not one example)

Update existing assertions of the old coupled behavior, and add negative/general cases:

**Backend (`artifacts/api-server/src/__tests__/`):**
- `nanoBanana2Compiler.test.ts` — `:1398` (and siblings) currently assert a disabled
  override is ignored; flip to assert the Visual Concept renders **authoritatively even when
  `enabled:false`**, while bubbles/role-bindings under a disabled override are still ignored.
- `imagePromptUserMessage.test.ts` — `:420-454` (`enabled:false` at `:441`): planner message
  now injects the scene when present regardless of `enabled`.
- `routes.approveVisualConcept.test.ts` — `:226-239`: the `409 CONCEPT_DISABLED` case is
  retired; add a case proving approval **succeeds with `enabled:false` + non-empty scene**
  and still `409 CONCEPT_MISSING` on an empty scene.
- `visualStrategyOverride.test.ts` — `:197-223`: cover the new
  `hasRenderableOverrideContentBesidesCoreScene` (a scene-only override reports **no**
  besides-core content; adding a role binding / bubble / policy flips it true);
  `hasRenderableVisualStrategyOverrideContent` and `collectRenderedTextEntries` behavior
  **unchanged**.
- `generator` coverage for `hasAuthoritativeCoreScene` true when `enabled:false` + scene.
- `visualConcepts.test.ts` — `:338-348`: candidate→draft mapping now enables only when the
  candidate carries bubbles; a scene-only candidate preserves prior `enabled`. **Codex P1
  acceptance test:** a base with `enabled:false` **plus** stale role bindings + a policy
  override, picking a **bubble-bearing** candidate → result has `enabled:true` and carries
  **only** the candidate's scene + bubbles (the stale role/policy fields are reset to empty).
  Pair it with a compiler assertion (in `nanoBanana2Compiler.test.ts`) that the resulting
  override emits only the CORE SCENE + SPEECH & THOUGHT BUBBLES sections — no ROLE DETAILS /
  policy content from the discarded stale fields.
- **Codex P2 route tests** — `routes.admin.test.ts` (fact enrichment PATCH) and the
  review-candidate PATCH in `routes.reviews.test.ts`: an `enabled:false` override with an
  **over-budget `coreSceneOverride`** now returns `400 visual_strategy_override_over_budget`
  (previously skipped); a within-budget `enabled:false` scene still saves; a disabled override
  with over-budget *additions/bubbles* still passes (those stay enabled-gated → measured 0).

**Frontend (`artifacts/overhype-me/src/components/admin/`):**
- `VisualConceptCard.test.tsx` — remove/flip the auto-enable-on-type assertions
  (`withCoreSceneOverride` no longer touches `enabled`).
- `VisualStrategyOverrideTokens.test.tsx` — `:186-206` renders the panel and asserts a
  tokenize error beside the panel's coreScene field; move that coverage to the card (the
  panel no longer hosts the field).
- Add: Facts page renders `VisualConceptCard`; the panel's "enabled but empty" warning does
  **not** fire for a scene-only enabled override.
- `candidatePickGate.test.ts` / `useFactEnrichmentEditing.test.tsx` — confirm still green
  (pick-blocking already strips `enabled`; tokenize baseline still includes coreScene).

---

## Docs

- **`artifacts/overhype-me/src/components/admin/fieldDocs/visualStrategy.ts:278-293`** —
  update the `vso.coreSceneOverride` doc: remove ":285 Typing a non-empty concept
  auto-enables the override," restate authority as independent of `enabled`, note the single
  card surface. Then **regenerate** `docs/ADMIN_FIELD_REFERENCE.md` via
  `npm run generate:field-docs` so `fieldDocs.test.ts:143-146` (sync check) stays green.
- **`docs/ai-context/visual-pipeline.md`** — the "Visual Concept" section (`:181-194`):
  state it is authoritative whenever present, edited in one prominent card on both pages,
  and that `enabled` gates only the advanced machinery.
- **`docs/ai-context/moderation-workflow.md:102-107`** — reconcile the gag-gate description:
  requires a **saved non-empty Visual Concept** (drop the implicit "enabled" requirement).
- **`docs/ai-context/decisions.md`** — add a short entry recording the decouple + Option 1
  single-surface decision and the pre-launch "no migration" call.

---

## Risk & review notes

- **Highest-risk edits:** `nanoBanana2.ts` (compiler) and `generator.ts` (planner context) —
  the subsystem flagged in `known-failure-patterns.md`. The compiler edit is a one-line
  source change (raw override vs. gated helper) but sits on the authoritative-scene path;
  tests must prove "Visual Concept wins" holds with `enabled:false` and that no bubble/role
  content leaks from a disabled override.
- **Behavior change on existing data:** accepted (David, pre-launch). Any `enabled:false`
  fact with a stray non-empty `coreSceneOverride` will render that scene as authoritative.
- **Server gate change** (`moderationStaging.ts`) is the one with real teeth — it is the
  authoritative approve-gag preflight. Retiring `CONCEPT_DISABLED` must be matched in the
  route error handling and the client's error surface.
- **Candidate-pick reset (P1)** is the subtle correctness point: the single shared `enabled`
  gate means enabling for bubbles must not resurrect a disabled base's dormant advanced
  fields. The acceptance test above is the guard.
- **Save-gate widening (P2)** closes the render-safety hole opened by allowing
  `enabled:false` authoritative scenes; the validator already handles the measurement, so
  the risk is only in getting the two route guards' new condition right (both must change).
- **No new external vendor, no schema/migration, no new `lib/api-zod` export.**

---

## Verification (before opening the implementation PR)

- `pnpm --filter @workspace/api-server test` (or the targeted runner for the touched
  suites) — green, including the flipped compiler/planner/approval assertions.
- `pnpm --filter @workspace/overhype-me exec vitest run` — green, including the new card /
  panel / warning tests.
- `pnpm --filter @workspace/overhype-me run build` and both typechecks — clean.
- `npm run generate:field-docs` then `git diff --exit-code docs/ADMIN_FIELD_REFERENCE.md` —
  clean (regenerated, committed).
- `git diff --exit-code lib/api-zod/src/index.ts` after codegen — clean.
- Manual (UAT): edit the Visual Concept in the card on **both** moderation and Facts pages;
  confirm the Advanced Options panel no longer shows a scene field; approve a visual gag with
  the override toggle **off** and a scene present; render and confirm the scene is
  authoritative; pick a scene-only candidate (override stays off) vs. a bubble-bearing
  candidate (override turns on and bubbles render).
