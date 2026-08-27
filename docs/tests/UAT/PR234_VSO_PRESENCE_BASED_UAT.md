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

### 2. A blank Visual Concept blocks Save

**Do:** Clear the Visual Concept (delete all its text) and try to Save.

**Expect:** a blocking "Required — describe the picture before saving or
approving" message, and the save is refused.

### 3. A blank Visual Concept blocks Approve

**Do:** With the concept still blank, try to Approve the visual gag.

**Expect:** it's blocked too, with the `CONCEPT_MISSING` reason.

### 4. A real Visual Concept saves and advances normally

**Do:** Type a real scene (e.g. "David rides a giant rubber duck down a
waterfall"), Save, then Approve.

**Expect:** Save saves it; Approve advances the review to Step 3 as
before.

### 5. The Core Scene field is gone from Advanced Options

**Do:** Open Advanced Options.

**Expect:** there is no Core Scene field anymore, and no master on/off
toggle anywhere in the override UI. The other override fields
(required/forbidden details, role assignments, bubbles, policies) are
still there, and each applies on its own when filled — no toggle to flip
first.

### 6. The Facts page enforces the same requirement

**Do:** On the Facts page, open an existing fact's enrichment, blank its
Visual Concept, and Save.

**Expect:** the same Visual Concept card appears, required the same way,
and the save is refused with the same message.

### 7. A filled override field applies without any toggle

**Do:** With the Visual Concept present, fill in a Forbidden Visual Detail
and Save.

**Expect:** it takes effect in renders without you enabling anything.

### 8. Clearing an override field turns it off

**Do:** Clear that Forbidden Visual Detail and Save.

**Expect:** it stops applying — clearing is how you turn a field off now.

## Regression

### R1. A non-empty Visual Concept still saves normally on the Facts page

**Do:** On the Facts page, open a fact whose Visual Concept is already
filled in, and Save without blanking it.

**Expect:** it saves normally, same as Moderation Step 2.

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
