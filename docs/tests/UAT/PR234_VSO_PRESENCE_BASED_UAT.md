# PR234 — VSO presence-based activation + required Visual Concept — UAT

In-app acceptance test for David. This does three things you asked for:

1. **Removes the "Enable Overrides" toggle.** There's no on/off switch anymore —
   any field you fill in just applies. Leave a field blank and it does nothing.
2. **Makes the Visual Concept required.** A fact can't be **saved** or **approved
   for production** without a Visual Concept, because the image and video engines
   need a scene to make a meme from.
3. **One place to write the scene.** The Visual Concept is edited only in the
   prominent card now — the duplicate copy that lived down inside "Advanced
   Options" is gone.

The transient engineering checklist was deleted after execution; see the
[checklist handoff](./CLAUDE_CHECKLIST_HANDOFF_2026-08-09.md) for its recorded
result.

## What changed, in plain terms

- **No more toggle.** Before, you had to flip "Enable Overrides" on before any of
  your art-direction took effect — a field could be filled in but silently
  ignored because the switch was off. Now presence *is* the switch: a filled
  field applies, a blank field doesn't. To "turn something off", clear it.
- **Visual Concept is required and blocking.** The card shows a red `*`. If it's
  empty, you'll see a "Required — describe the picture before saving or
  approving" warning, and the **Save** and **Approve** actions are blocked until
  you write one.
- **Single surface.** The Visual Concept card at the top of the concept step (and
  on the Facts page) is the only place you edit the scene. The old Core Scene box
  inside Advanced Options is removed — same underlying field, just one home for it
  now.

## How to check it

**On the Moderation page (Step 2 — the concept step):**

1. Open a fact at the concept step. The **Visual Concept** card is near the top,
   with a red `*` in its header. ✅
2. Clear the Visual Concept (delete all its text) and try to **Save**. You get a
   blocking "Required — describe the picture before saving or approving" message
   and the save is refused. ✅
3. With the concept still blank, try to **Approve the visual gag** — it's blocked
   too. ✅
4. Type a real scene (e.g. "David rides a giant rubber duck down a waterfall"),
   Save → it saves; Approve → it advances to Step 3 as before. ✅
5. Open **Advanced Options** — there is **no** Core Scene field down there
   anymore. The other override fields (required/forbidden details, role
   assignments, bubbles, policies) are still there, and each one applies on its
   own when filled — **no toggle to flip first**. ✅

**On the Facts page (editing an existing fact's enrichment):**

6. The same **Visual Concept** card appears, required the same way. Blanking it
   and saving is refused with the same message. ✅

**Presence-based behavior (the toggle removal):**

7. Fill in, say, a Forbidden Visual Detail with the Visual Concept present, Save.
   It takes effect in renders without you enabling anything. ✅
8. Clear that Forbidden Visual Detail and Save — it stops applying. Clearing is
   how you turn a field off now. ✅

## What you should NOT see

- Any "Enable Overrides" / master on-off toggle anywhere in the override UI.
- A **second** Core Scene / Visual Concept box inside Advanced Options.
- Being able to Save or Approve a fact with a blank Visual Concept.
- A filled-in override field being ignored because "the override wasn't enabled."

## Regression smoke table

| Where | Visual Concept | Save | Approve for production |
|-------|----------------|------|------------------------|
| Moderation Step 2 | non-empty | Saves | Advances to Step 3 |
| Moderation Step 2 | blank | **Blocked** ("required") | **Blocked** (`CONCEPT_MISSING`) |
| Facts page | non-empty | Saves | — |
| Facts page | blank | **Blocked** ("required") | — |
| Advanced Options | — | Fields apply by presence; no toggle; no Core Scene box | — |

## Known non-bugs / limitations

- **Any enrichment save now needs a Visual Concept.** This is intentional and the
  blast radius you accepted: a partial edit (say, only tweaking hashtags) on a
  fact that has no concept yet will be refused until you also give it a concept.
- **Existing facts that already have a legacy "enabled" flag stored are fine.**
  The old flag is quietly ignored — no data migration, nothing to clean up
  (you're re-doing all facts pre-launch anyway).
- **This PR is the moderation-flow half ("Head 1").** The system-wide guarantee
  that a fact can't go *live* without a concept — and that *every* ingestion path
  (manual, bulk, future API) drops facts at the front of the triage → enrich →
  activate pipeline — is the deferred fast-follow ("Head 2"), not in this PR.

## If something's wrong

Tell me which surface (Moderation Step 2 or Facts), whether the Visual Concept
was blank or filled, and what Save/Approve did — and if any *other* override
field misbehaved (applied when blank, or ignored when filled), name the field.
