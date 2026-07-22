# Plan — Retire the VSO enable toggle: presence-based activation + required Visual Concept

**Status:** proposed (for review). Not approved. Only David approves.
**Mode:** feature-building. **Subsystem:** visual pipeline (high-risk — apply the
`overhype-visual-pipeline` review discipline).
**Verified against:** `origin/main` @ `de6ca1f` (post-#229 / #228). All line references
current as of that commit.
**Supersedes:** the earlier converged plan `PLAN_VISUAL_CONCEPT_UNNEST.md` (which decoupled
only the *scene* from the toggle while keeping the toggle for advanced fields). David chose to
go further and remove the toggle entirely, which subsumes that plan and deletes most of its
machinery — see "Why this replaces the earlier plan."

**Revision log:**
- rev 3 — Codex round 2: P2 — the Step-3 client affordance `canApproveProduction`
  (`moderation.tsx:723`, used `:1349/:1356/:1370`) checks enrichment validity + hashtags but
  **not** the scene, so after rev 2's server publish gate a stale blank-scene row would show an
  enabled Approve/Promote button that then fails server-side. Add the non-empty-scene check to
  the affordance + locked copy + test so UI-required matches the final gate.
- rev 2 — Codex round 1 (PR #233): P1 — the required-scene admin gate must reject a blank scene
  **including when the VSO is absent** (it's optional; a no-override save slipped through). P1 —
  the required-scene gate must also cover the **final production-approval** paths
  (`approveForProduction` / `approveRefreshCandidateForProduction`), not just the Step-2
  `approve-visual-concept` transition, or a stale/pre-existing Step-3 row could publish blank.
  §F expanded + tests added.

---

## Product intent (David)

Two decisions, in order:

1. **The Visual Concept must be required and blocking.** It "cannot be left blank," enforced
   as a hard, **server-side** validation error (not a soft warning), blocking the admin's
   **save and approve** actions on **both** surfaces (the Facts admin page and the moderation
   review). The card shows a required-field state.
2. **Remove the "Enable Overrides" toggle entirely; move to presence-based activation.**
   David: *"Shouldn't it just be that if the fields are blank, they're not overridden?"* Yes.
   Every override field applies **whenever it is non-empty**; there is no separate on/off gate.

### Why this replaces the earlier plan

The earlier plan (`PLAN_VISUAL_CONCEPT_UNNEST`) decoupled the *scene* from `enabled` but kept
the toggle gating the advanced fields — which forced a `serverBaseEnabled` reset mechanism, an
"enabled but empty" warning, a new `hasRenderableOverrideContentBesidesCoreScene` helper, and a
careful audit of auto-enable side effects. **All of that existed only to defend against
"disabled-but-populated" hidden state** — the exact bug class the Codex review kept surfacing
(a bubble pick or a shared-gate flip resurrecting unreviewed fields). Presence-based activation
**dissolves the bug class**, so this plan *deletes* that machinery rather than adding it. It
touches more files, but the runtime logic is simpler and has one activation model, not two.

---

## Settled decisions (David)

1. **Required, blocking Visual Concept** — server-enforced on the admin save **and** approve
   paths, both surfaces; card shows required state. Enforced at the **routes + UI**, not the
   zod schema (see decision 4).
2. **Remove the `enabled` toggle; presence-based activation** for every VSO field.
3. **`enabled` is removed from the VSO zod schema.** A `z.object` strips unknown keys on parse,
   so existing stored rows (jsonb) that still carry `enabled` parse cleanly with the key
   dropped — **no data migration.** (Alternative considered: keep it optional-and-ignored;
   rejected — a vestigial field is exactly the hidden-state footgun we're removing.)
4. **Required-scene enforcement lives in the routes + UI, not the schema.** A schema-level
   `coreSceneOverride.min(1)` would reject *automated* enrichment writes (classification /
   archetype) that legitimately run **before** a moderator authors the scene. So the schema
   keeps `coreSceneOverride` optional; the **admin save/approve routes** and the **card**
   enforce non-blank. Net effect is identical: no fact reaches a saved/approved state without a
   Visual Concept.
5. **Accepted consequences (pre-launch, David is redoing all facts):**
   - Existing `enabled:false` rows with populated fields **activate on ship** (same risk class
     David already accepted for the scene).
   - Removing `enabled` from the serialized override **changes the render/ideas input hash for
     every fact carrying a VSO**, marking those renders/candidate-ideas stale corpus-wide on
     deploy (a one-time regenerate, not wrong output). Acceptable given the fact redo. (If we
     later wanted to avoid this, the lever is to exclude `enabled` from `renderAffectingEnrichment`
     while keeping it in the blob — not chosen here, since we're removing the field outright.)
6. **Option 1 single prominent surface (carried from the superseded plan):** the
   `VisualConceptCard` is the *only* scene editor, on moderation Step 2, moderation Step 3, and
   the Facts page; the scene field is removed from the Advanced Options panel. With the toggle
   gone, the panel simply shows the advanced fields (inside the already-collapsed Advanced
   Options), no on/off switch.

## Open product questions

None. Intent is settled; remaining choices are engineering-correctness calls within it.

## External-claim verification

Not applicable — purely internal refactor (admin UI + prompt-compiler wiring). No external
API / SDK / model / pricing / rate-limit claims.

---

## Must not change (invariants)

Per `docs/ai-context/visual-pipeline.md` and the `overhype-visual-pipeline` skill:

1. **The Visual Concept remains the AUTHORITATIVE scene** — emitted verbatim (token-rendered,
   warn-not-strip), leads the prompt, seeds the de-dupe haystack, wins over the AI plan. Now
   *required*, so it is authoritative on every fact.
2. **Compiler output is byte-identical for an all-empty override and today's `null`.** Verified
   field-by-field: every consumer of `activeOverride()` already no-ops on empty (empty list →
   no section; `mode==="use_ai_plan"` → `""`; empty string → AI-scene fallback). Presence-based
   `activeOverride()` returning `ov` for an empty override must produce the same prompt as the
   old `null`. This is the highest-value regression test.
3. **No duplicate prompt channels;** the bubble channel + its dedupe-exemption (#229) are
   untouched. Bubbles still apply only when present (they already filter incomplete rows).
4. **Preview matches runtime.** The admin "Runtime Compiled Prompt" preview and the real
   compiler read the override the same way after the change.
5. **Tokenization / canonicalization of every rendered field is unchanged** — the shared
   `collectRenderedTextEntries` collector is not touched.

---

## The change, grouped

There are **two** independent `enabled` gates; **both** must move to presence-based, or a field
silently dies:

- **Gate 1 — `activeOverride()`** (`nanoBanana2.ts`): scene, role bindings, subject realization,
  required/forbidden/additional/composition lists, bubbles.
- **Gate 2 — `resolveRenderPolicy()`** (`imagePromptGeneration.ts`): the two policy overrides
  (`supportingTextPolicyOverride`, `violencePolicyOverride`).

### A. Schema (`lib/api-zod/src/visualStrategyOverride.ts`)

- **`:107`** remove `enabled: z.boolean(),` from `visualPromptStrategyOverrideBase` (drops it
  from the `VisualPromptStrategyOverride` type at `:143`). Every `{ …ov, enabled: … }` writer
  and every fixture that sets `enabled` then becomes a type error and is updated (that is the
  bulk of the mechanical surface below).
- **`:479-489`** `EMPTY_VISUAL_STRATEGY_OVERRIDE` — delete `enabled: false` (`:481`); fix the
  "disabled-but-present" comment (`:478`).
- **`:470-476`** `hasRenderableVisualStrategyOverrideContent(ov)` — **unchanged body** (it never
  read `enabled`); it becomes the natural "is anything active" predicate for presence-based
  callers.

### B. Compiler gate 1 (`artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts`)

- **`:489-492`** `activeOverride()` → `return ov ?? null;` (drop the `?.enabled ?` check). All
  consumers at `:1276, :1290, :1351, :1366, :1422, :1433, :1442, :1453, :1490` already no-op on
  empty (verified) — no consumer change needed. Add the byte-identical regression test
  (invariant 2).

### C. Policy gate 2 (`lib/api-zod/src/imagePromptGeneration.ts`)

- **`:328-344`** `resolveRenderPolicy` — change `:332` `if (!ov?.enabled) return DEFAULT_RENDER_POLICY;`
  to `if (!ov) return DEFAULT_RENDER_POLICY;`. The field-presence checks at `:334-343` already
  default each policy on absence — trivial. Fix the stale `hasAuthoritativeCoreScene?` doc at
  `:605-614`.

### D. Planner (`artifacts/api-server/src/lib/imagePrompt/generator.ts`)

- **`:225-228`** `hasAuthoritativeCoreScene` — drop `override?.enabled &&`; keep the non-empty
  scene test.
- **`:368-372`** `resolveModeratorContextScene` — `raw = ovb?.coreSceneOverride?.trim() ?? "";`
  (drop the `enabled` gate).
- **`:407-414`** `moderatorBubbleLines` — delete the `if (!ov?.enabled) return [];` early-return
  (`:414`); the existing `bubbles.filter(...)` at `:415-416` is the presence gate. Fix stale
  doc `:408-409`.

### E. Budget measurement (`artifacts/api-server/src/lib/imagePrompt/promptBudget.ts`)

- **`:130`** `EMPTY_ENABLED_OVERRIDE` → collapses to `EMPTY_VISUAL_STRATEGY_OVERRIDE` (drop the
  `enabled: true` spread); update the `:199, :216, :243` uses.
- **`:140-149`** `projectAdditionsOverride` — drop `enabled: true` from the `:143` projection.
- **`:193-203`** `measureModeratorAdditionsEmission` — **delete** the `:194` `if (!ov.enabled)
  return 0;` (the delta-vs-empty-baseline method self-zeroes for an empty override).
- **`:214-247`** `measureBubbleDirectivesEmission` — change `:215` to gate only on
  `(ov.bubbles ?? []).length === 0` (drop `!ov.enabled ||`).
- **`:260-268`** `validateVisualStrategyOverridePersistence` — body unchanged; fix the stale
  "Disabled overrides validate trivially" comment (`:258-259`).
- `lib/api-zod/src/promptBudget.ts` — `validateVisualStrategyOverrideForSave` (`:190`) and the
  naive lower-bounds already never read `enabled`; no change.

### F. Save / approval routes — including the REQUIRED-BLOCKING scene

- **`artifacts/api-server/src/routes/admin.ts:1178-1184`** (fact-enrichment PATCH) and
  **`artifacts/api-server/src/routes/reviews.ts:1402-1404`** (review-candidate PATCH): the
  budget gate is currently `if (submittedVso?.enabled)`. Change to run
  `validateVisualStrategyOverridePersistence` whenever a VSO is submitted (presence), so an
  over-budget scene/additions can't skip validation.
- **NEW — required-scene block (decision 1). Three enforcement points, all server-side:**

  1. **Admin enrichment save (`admin.ts` Facts PATCH + `reviews.ts` candidate PATCH).** Reject
     when the submitted enrichment's scene is blank — **including when the VSO is absent**
     entirely (Codex round 1). The VSO is optional, so a hashtag-only Facts save or a moderation
     save starting from no override would otherwise persist a blank Visual Concept. Gate on
     `submitted.visualPromptStrategyOverride?.coreSceneOverride?.trim()` being empty →
     `400 visual_concept_required`. This is an **admin-authored** save gate; automated enrichment
     jobs write through the enrichment worker (a different path) and are **not** blocked
     (decision 4). *Behavioral consequence to surface at approval: an admin can no longer save a
     fact's enrichment on the Facts page without a Visual Concept — this is the literal intent of
     "required, cannot be left blank," but it means partial/hashtag-only admin saves now require a
     scene.*
  2. **Step-2 concept approval (`moderationStaging.ts:182-189` `resolveSavedCoreSceneForReview`).**
     Retire the `CONCEPT_DISABLED` branch (`:183-184`); gate solely on a non-empty saved
     `coreSceneOverride` (`CONCEPT_MISSING` at `:187-188` stays and *is* the blocking gate).
     Confirm the only `CONCEPT_DISABLED` references are this route + its test. Reached from
     `reviews.ts:1055-1059`.
  3. **Final production approval — the actual publish gate (Codex round 1).** The publish paths
     `approveForProduction` (`reviews.ts:613`) and `approveRefreshCandidateForProduction`
     (`:514`) — routes `/approve-for-production` (`:803`), `/approve` (`:821`), `/approve-variant`
     (`:826`) — currently validate enrichment shape + render/hashtag gates but **not** the scene.
     A pre-existing Step-3 row, refresh candidate, or stale tab could reach promotion with a blank
     persisted scene. Add the same server-side non-empty `coreSceneOverride` re-check on the
     cycle's resolved enrichment before promotion (reuse `resolveSavedCoreSceneForReview` / a
     shared helper so Step-2 and publish can't drift), returning `CONCEPT_MISSING`. This is the
     backstop that makes "cannot be published blank" true regardless of which tab/row/state the
     admin came from.

### G. Candidate concepts (`lib/api-zod/src/visualConcepts.ts`)

- **`:288-299`** `withCandidateConceptDraft` — **drop `enabled: true` (`:295`).** Presence-based
  removes the shared gate, so the whole `serverBaseEnabled` / stale-field-reset design from the
  superseded plan is **unnecessary** — a pick simply sets scene + bubbles, and only those apply
  (any pre-existing advanced fields already applied by presence, independently). This is the
  central simplification the toggle-removal buys. Drop the third-arg design entirely.
- **`:189`, `:235-238`** `sanitizeCandidateSceneText` / `sanitizeCandidateBubble` probes — drop
  the `enabled: true` key from the `firstOverrideTokenError` probe objects (mechanical).
- `isCandidateConceptPickable` (`:271-273`) — no `enabled` read; unchanged.

### H. Frontend UI

- **`EnrichmentEditor.tsx`**:
  - **`:1289-1297`** remove the **toggle button** entirely.
  - **`:1300`** remove the `{ov.enabled && ( … )}` gate — the panel body (advanced fields) is
    always rendered inside the already-collapsed Advanced Options.
  - **`:1262-1276`** remove the **"enabled but has no renderable content" warning** (and its
    `ov.enabled` wrapper) — meaningless without a toggle.
  - **`:1190-1201`** `withCoreSceneOverride` — drop the `enabled:` auto-enable (`:1199`); return
    `{ ...base, coreSceneOverride: canonical }`.
  - **`:1336-1352`** remove the **Core Scene field** from the panel (Option 1 — the card is the
    single scene surface).
- **`BubbleEditor.tsx:47-57`** `withBubbles` — drop the `enabled:` auto-enable (`:55`).
- **`VisualConceptCard.tsx`** — add the **required-field state** (visual indicator + block/flag
  when blank); update the doc-comment (`:1-9`) and the **visible help text (`:72-76`)** which
  currently says compiler-owned instructions "will strip them" — runtime *warns*, not strips
  (carried from the earlier plan's round-4 fix).
- **`facts.tsx`** — add `VisualConceptCard` above `EnrichmentEditor` (`:322`), inheriting the
  panel's read-only `disabled` state and guarding `onChange` (`if (!disabled) …`), mirroring the
  moderation wiring.
- **`moderation.tsx`**:
  - **`:1125-1150` (Step 3 / Test Renders)** — add `VisualConceptCard` (before `{DraftSaveBar}`)
    so the scene is editable where renders are evaluated.
  - **`:723` `canApproveProduction` (Codex round 2)** — this Step-3 production affordance
    (`isApprovable(enrichment) && (isRefreshCycle || finalHashtags.length > 0)`, used at the
    Approve/Promote buttons `:1349/:1356` and the disabled-note `:1370`) must **also** require a
    non-empty saved scene (`&& !!enrichment?.visualPromptStrategyOverride?.coreSceneOverride?.trim()`),
    so a stale/pre-existing `production_review` row with a blank scene shows a *disabled*
    Approve/Promote (matching the new server publish gate in §F point 3) instead of an enabled
    button that fails server-side. Add the missing-concept reason to the disabled-note copy
    (`:1370-1372`).
  - **`:527-529`** `coreSceneDraft` — drop the `?.enabled ?` gate.
  - **`:728-729`** `draftHasConcept` — drop `conceptOverride?.enabled &&`; gate on non-empty
    scene only (drives `canApproveGag`, `canSaveConceptAndContinue`, `ideasStaleButSaved`,
    locked-approve copy at `:1315`). This is where the **client-side required/blocking** save &
    approve affordance lives.
  - Reconcile Advanced-Options copy that implies the scene is editable there (`:1047-1050`,
    `:1114-1116`, `:1052-1055`).
- **`candidatePickGate.ts:28-29`** — drop `enabled: _e` from the destructure (it already
  excluded `enabled` from the block predicate; behavior unchanged).

### I. Telemetry booleans (don't silently report "false")

- **`lib/api-zod/src/enrichmentOverrides.ts:254`** and
  **`artifacts/api-server/src/lib/enrichmentOverrideLayers.ts:184`** —
  `hasVisualStrategyOverride: Boolean(...?.enabled)` → switch to a presence signal
  (`hasRenderableVisualStrategyOverrideContent(...)` or "VSO present with content"), else these
  log fields report `false` for every fact once the field is gone.

### J. Hash / staleness (decision 5)

- **`artifacts/api-server/src/lib/factRenderScenarios.ts:123-133`** `renderAffectingEnrichment`
  serializes the whole override (`:132`) into the scenario input hash; `visualConcepts/inputHash.ts:56`
  reuses it. Removing `enabled` from the object changes the hash shape → one-time corpus-wide
  render/ideas staleness (accepted). Update the affected hash-snapshot test expectations.

---

## Tests (assert the invariant, not one example)

**The keystone test:** an all-empty override compiles byte-identically to `null`/no-override
(invariant 2) — add to `nanoBanana2Compiler.test.ts`.

**Flip every `enabled:false`-is-ignored assertion to applies-when-present:**
- `nanoBanana2Compiler.test.ts` — `:861/:867` (REQUIRED DETAILS), `:1398` (core scene): a
  populated field now emits regardless of any (removed) toggle; an empty field still emits
  nothing.
- `imagePromptUserMessage.test.ts` — `:441` (scene), `:505` (bubbles): planner message injects
  when present.
- `visualStrategyOverride.test.ts` — `:42` schema parse no longer requires `enabled`; `:233/:237`
  render pair becomes presence-based; policy-override render via `resolveRenderPolicy` with **no**
  toggle.
- `promptBudget.test.ts` — `:104` (the `enabled:false ⇒ 0` early-return test) is retired; add
  additions/bubbles measured by **presence**; empty override still measures 0.
- `routes.approveVisualConcept.test.ts` — `:229-238`: `CONCEPT_DISABLED` retired; **approval
  succeeds with a non-empty scene and no toggle**, still `409 CONCEPT_MISSING` on blank.
- `visualConcepts.test.ts` — `:334/:347`: `withCandidateConceptDraft` no longer flips `enabled`;
  assert a pick sets only scene + bubbles and that pre-existing advanced fields are untouched
  (they apply by presence, independently — no reset, no resurrection, because there is no shared
  gate).

**New behavior:**
- **Required-blocking scene — all three enforcement points:**
  1. *Admin save* (`admin.ts` Facts PATCH + `reviews.ts` candidate PATCH): reject a blank scene
     `400 visual_concept_required` — with a case where the **VSO is entirely absent** (Codex round
     1) and a case where it's present-but-blank; a non-blank save succeeds; a background automated
     enrichment write without a scene is **not** blocked (decision 4).
  2. *Step-2 approval*: `CONCEPT_MISSING` on blank, succeeds on non-blank; `CONCEPT_DISABLED`
     retired.
  3. *Production approval* (`/approve-for-production`, `/approve`, `/approve-variant`, and the
     refresh-candidate path): a cycle whose persisted `coreSceneOverride` is blank is rejected at
     **publish** (`CONCEPT_MISSING`), even when the Step-2 gate was somehow bypassed (stale
     row/tab); a non-blank cycle promotes.
- **Presence-based budget gate** — an over-budget scene/additions on a VSO with no (removed)
  toggle is still rejected `visual_strategy_override_over_budget`.
- **Two-gate coverage** — a policy override (`resolveRenderPolicy`) applies with no toggle; the
  compiler gate and the policy gate are independently exercised.

**Frontend:**
- Remove the auto-enable assertions in `VisualConceptCard.test.tsx` (`:39-78`) and
  `BubbleEditor.test.tsx` (`:32-37`); remove the toggle-render assertions in
  `EnrichmentEditor.dualMode.test.tsx:203`, `VisualStrategyOverrideTokens.test.tsx` (the
  `enabledOverride()` helper + panel-render cases) — the panel body renders without a toggle.
- Add: the card shows a **required** state and **blocks** save when blank (client affordance);
  Facts + Step 3 render the card; read-only mode disables the card and its `onChange` is guarded.
- Add (Codex round 2): with a blank saved scene, the **Step-3 Approve/Promote button is
  disabled** (`canApproveProduction` false) with the missing-concept note shown — the client
  affordance matches the server publish gate; a non-blank scene enables it.

**Hashing:** update `factRenderScenarios.test.ts` (and any inputHash snapshot) expected hashes
for the new serialized shape; assert the hash no longer depends on a (removed) `enabled`.

---

## Docs

- `artifacts/overhype-me/src/components/admin/fieldDocs/visualStrategy.ts:244, :263-265` — remove
  the "enabled toggle is the master switch" prose + the "disable the toggle" worked example;
  state presence-based activation + required Visual Concept. Regenerate `docs/ADMIN_FIELD_REFERENCE.md`
  via `pnpm --filter @workspace/overhype-me run generate:field-docs` (`:961, :984-985` update;
  `fieldDocs.test.ts:143-146` sync check stays green).
- `docs/ai-context/visual-pipeline.md:187-220` — presence-based activation; Visual Concept
  required + single-card surface.
- `docs/ai-context/moderation-workflow.md` — reconcile the Step-2 concept-approval gate (no
  `enabled` requirement; scene required + blocking).
- `docs/ai-context/decisions.md:393-394` — supersede **D1** ("saved, **enabled**, non-empty"):
  now "saved, non-empty" + record the toggle removal and the required-scene decision.

---

## Risk & review notes

- **Highest risk — the compiler (`activeOverride`).** The change is one line, but it sits on the
  authoritative path. The byte-identical-to-`null` regression test (invariant 2) is the guard;
  it must cover a genuinely empty override across all subject render modes.
- **The second gate (`resolveRenderPolicy`) is easy to miss** — this plan names it explicitly so
  policy overrides don't silently die.
- **Required-scene enforcement is three points, not one** (Codex round 1): admin save (incl.
  **absent** VSO), Step-2 approval, and **final production approval** — all server-enforced, but
  **not** automated enrichment writes (decision 4). The publish gate is the real backstop; the
  admin-save gate is the first line. Getting the location wrong either blocks background jobs or
  lets a blank scene reach production via a stale row/tab.
- **Mass staleness on deploy** (decision 5) is expected, one-time, and acceptable (fact redo) —
  but the release note/UAT should say renders/ideas will show stale until regenerated.
- **No new external vendor; no data migration; no new `lib/api-zod` export** (removing a field —
  still run codegen once and confirm `git diff --exit-code lib/api-zod/src/index.ts` is clean).

## Verification (before opening the implementation PR)

- `pnpm --filter @workspace/api-server test` — green, including the byte-identical compiler
  proof, the retired-toggle flips, the required-scene route rejections, and both-gate coverage.
- `pnpm --filter @workspace/overhype-me exec vitest run` — green, including panel-without-toggle
  and required-card tests.
- `pnpm --filter @workspace/overhype-me run build` + both typechecks — clean (every `enabled`
  writer updated).
- `pnpm --filter @workspace/overhype-me run generate:field-docs` then
  `git diff --exit-code docs/ADMIN_FIELD_REFERENCE.md` — clean.
- `git diff --exit-code lib/api-zod/src/index.ts` after codegen — clean.
- Manual (UAT): with no toggle anywhere, populate a role binding / policy / bubble and confirm it
  renders; clear it and confirm it stops; a blank Visual Concept blocks save **and** approve on
  Facts and moderation; a formerly-`enabled:false` fact with populated fields now renders them.
