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

**Expect:** the Visual Concept card sits near the top, with a red `*` in
its header.

**Lane:** human

**Deferred:** #631 — 7b — the red * required marker in the Visual Concept card header — `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx`; increment 8 (capture and read) — Moderation Step 2 shows the Visual Concept card near the top of the step with a red * in its header

### 2. A blank Visual Concept blocks Save

**Do:** Clear the Visual Concept (delete all its text) and try to Save.

**Expect:** a blocking "Required — describe the picture before saving or
approving" message, and the save is refused.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.candidateEnrichmentEditing.test.ts:PATCH refuses`

**Deferred:** #631 — 7b — the staging fact's enrichment PATCH, the route Moderation Step 2 saves through, refusing a blank Visual Concept — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`; 7b — the card's blocking Required wording when the concept is blank — `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx`

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

**Check:** `artifacts/api-server/src/__tests__/routes.approveVisualConcept.test.ts:succeeds with a non-empty saved Visual Concept (presence-based — no enable toggle)`

**Deferred:** #631 — 7b — Save stores the typed scene text itself as the stored Visual Concept — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### 5. The Core Scene field is gone from Advanced Options

**Do:** Open Advanced Options.

**Expect:** there is no Core Scene field anymore, and no master on/off
toggle anywhere in the override UI. The other override fields
(required/forbidden details, role assignments, bubbles, policies) are
still there, and each applies on its own when filled — no toggle to flip
first.

**Lane:** ci

**Deferred:** #631 — 7b — the override panel shows no Core Scene field and no master toggle while the other override fields remain — `artifacts/overhype-me/src/components/admin/VisualStrategyOverrideTokens.test.tsx`

### 6. The Facts page enforces the same requirement

**Do:** On the Facts page, open an existing fact's enrichment, blank its
Visual Concept, and Save.

**Expect:** the same Visual Concept card appears, required the same way,
and the save is refused with the same message.

**Lane:** human

**Deferred:** #631 — 7b — the Facts-page enrichment PATCH refusing a blank Visual Concept with visual_concept_required — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`; increment 8 (capture and read) — the Facts page enrichment view shows the Visual Concept card with its required marker

### 7. A filled override field applies without any toggle

**Do:** With the Visual Concept present, fill in a Forbidden Visual Detail
and Save.

**Expect:** it takes effect in renders without you enabling anything.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:a populated override emits its section regardless of any (removed) toggle`; `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:forbidden details + negative additions become STRICT 'Do not' lines without double-prefixing`

### 8. Clearing an override field turns it off

**Do:** Clear that Forbidden Visual Detail and Save.

**Expect:** it stops applying — clearing is how you turn a field off now.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:KEYSTONE: an empty override compiles byte-identically to no override (presence-based)`

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
