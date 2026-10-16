# PR #234 — VSO presence-based activation + required Visual Concept — UAT

This does three things you asked for:

1. **Removes the "Enable Overrides" toggle.** There's no on/off switch
   anymore — any field you fill in just applies, and a blank field does
   nothing. To turn something off, clear it.
2. **Makes the Visual Concept required.** A fact can't be saved or
   approved for production without a Visual Concept, because the image and
   video engines need a scene to make a meme from.
3. **One place to write the scene.** The Visual Concept is edited only in
   the prominent card now — the duplicate copy that lived inside "Advanced
   Options" is gone.

## Setup

- [claude] Confirm a fact is available at the concept step in Moderation
  (Step 2), and another fact with existing enrichment is available on the
  Facts page.

## Steps

### 1. The Visual Concept card shows as required

**Do:** Open a fact at the concept step in Moderation (Step 2).

**Expect:** the Visual Concept card sits near the top of the step, with
only the submitted fact and the one-line instruction above it and the
speech bubbles and visual ideas below it, and a red `*` in its header.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminScreens.spec.ts:Moderation Step 2 shows the Visual Concept card near the top with a red * in its header`

**Deferred:** #631 — 7b — the red * required marker in the Visual Concept card header — `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx`

### 2. A blank Visual Concept blocks Save

**Do:** Clear the Visual Concept (delete all its text) and try to Save.

**Expect:** a blocking "Required — describe the picture before saving or
approving" message, and the save is refused.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.candidateEnrichmentEditing.test.ts:PATCH refuses`

**Deferred:** #631 — 7b — PATCH /admin/facts/:id/enrichment for a new submission's staging fact, the route Moderation Step 2 saves through, refusing a blank Visual Concept with 400 visual_concept_required and storing nothing — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`; #631 — 7b — VisualConceptCard with a blank concept renders its visual-concept-required line reading the Expect's exact text, Required then describe the picture before saving or approving — `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx`

### 3. A blank Visual Concept blocks Approve

**Do:** With the concept still blank, try to Approve the visual gag.

**Expect:** it's blocked too, with the `CONCEPT_MISSING` reason.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.approveVisualConcept.test.ts:409 CONCEPT_MISSING when the concept is blank`

### 4. A real Visual Concept saves and advances normally

**Do:** Type a real scene (e.g. "David rides a giant rubber duck down a
waterfall"), Save, then Approve.

**Expect:** Save saves it; Approve advances the review to Step 3 as
before.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.approveVisualConcept.test.ts:succeeds with a non-empty saved Visual Concept (presence-based — no enable toggle)`; `artifacts/api-server/src/__tests__/routes.approveVisualConcept.test.ts:advances to production_review and force-enqueues a no-dedupe prepare job` asserts a review with a saved concept moves to production_review (Step 3)

**Deferred:** #631 — 7b — PATCH /admin/facts/:id/enrichment with a typed scene stores that exact text as visualPromptStrategyOverride.coreSceneOverride on the staging fact — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### 5. The Core Scene field is gone from Advanced Options

**Do:** Open Advanced Options.

**Expect:** there is no Core Scene field anymore, and no master on/off
toggle anywhere in the override UI. The other override fields
(required/forbidden details, role assignments, bubbles, policies) are
still there, and each applies on its own when filled — no toggle to flip
first.

**Lane:** ci

**Deferred:** #631 — 7b — VisualStrategyOverridePanel renders no Core Scene field and no enable toggle, yet still renders the required and forbidden details, role assignments, bubbles and policies fields — `artifacts/overhype-me/src/components/admin/VisualStrategyOverrideTokens.test.tsx`; #631 — 7b — each override field (details, role assignments, bubbles, policies) saved alone through PATCH /admin/facts/:id/enrichment is stored and reaches the compiled prompt with no enable flag — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### 6. The Facts page enforces the same requirement

**Do:** On the Facts page, open an existing fact's enrichment, blank its
Visual Concept, and Save.

**Expect:** the same Visual Concept card appears, required the same way,
and the save is refused with the same message.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminScreens.spec.ts:the Facts page enrichment view shows the Visual Concept card with its required marker`

**Deferred:** #631 — 7b — PATCH /admin/facts/:id/enrichment, the Facts page save, refusing a blank Visual Concept with 400 visual_concept_required and leaving the stored concept unchanged — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`; #631 — 7b — VisualConceptCard with a blank concept renders its visual-concept-required line reading the Expect's exact text, Required then describe the picture before saving or approving — `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx`

### 7. A filled override field applies without any toggle

**Do:** With the Visual Concept present, fill in a Forbidden Visual Detail
and Save.

**Expect:** it takes effect in renders without you enabling anything.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:a populated override emits its section regardless of any (removed) toggle`; `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:forbidden details + negative additions become STRICT 'Do not' lines without double-prefixing`

**Deferred:** #631 — 7b — a non-empty forbiddenVisualDetails saved through PATCH /admin/facts/:id/enrichment is stored and appears as a Do not line in that fact's compiled prompt — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### 8. Clearing an override field turns it off

**Do:** Clear that Forbidden Visual Detail and Save.

**Expect:** it stops applying — clearing is how you turn a field off now.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:KEYSTONE: an empty override compiles byte-identically to no override (presence-based)`

**Deferred:** #631 — 7b — clearing forbiddenVisualDetails to [] through PATCH /admin/facts/:id/enrichment stores [] and that fact's compiled prompt no longer has the Do not line — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

## Regression

### R1. A non-empty Visual Concept still saves normally on the Facts page

**Do:** On the Facts page, open a fact whose Visual Concept is already
filled in, and Save without blanking it.

**Expect:** it saves normally, same as Moderation Step 2.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts:accepts a PATCH that leaves tracked fields unchanged (visual override / hashtags)`

## Not bugs

- **Any enrichment save now needs a Visual Concept.** This is intentional,
  and the blast radius you accepted: a partial edit (say, only tweaking
  hashtags) on a fact that has no concept yet will be refused until you
  also give it a concept.
- **Existing facts that already have a legacy "enabled" flag stored are
  fine.** The old flag is quietly ignored — no data migration, nothing to
  clean up (you're re-doing all facts pre-launch anyway).
- **This PR is the moderation-flow half ("Head 1").** The system-wide
  guarantee that a fact can't go live without a concept — and that every
  ingestion path (manual, bulk, future API) drops facts at the front of
  the triage → enrich → activate pipeline — is the deferred fast-follow
  ("Head 2"), not in this PR.
