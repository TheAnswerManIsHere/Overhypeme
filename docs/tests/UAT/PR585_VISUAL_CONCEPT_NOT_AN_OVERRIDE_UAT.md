# PR #585 — The "Overridden" badge only shows when someone actually overrode something — UAT

**Workstream:** #584

The admin enrichment editor was telling you a fact had a moderator override
when it had none. The badge keyed off the Visual Concept — the "describe the
picture" text — which every fact is *required* to have. So it lit up on
essentially every fact that had reached concept review, which is most of them,
and the one signal meant to say "a human touched this one" said it about
everything.

You found this yourself during PR #582's UAT: review #6880 showed
**"Overridden: Visual Strategy"** while its entire Visual Strategy Override
panel was empty. Your call was that the Visual Concept should be omitted from
the check, and that is exactly what shipped.

**The risk this run is really checking** is the other direction. The Visual
Concept is still sent to the image engine and still has its `{NAME}` tokens
validated — it just no longer counts as *evidence of an override*. Those are
two different jobs for one field, and the way this fix could have gone wrong is
by removing the field from both. **Steps 3 and 4 are the load-bearing ones**:
they confirm the picture-prompt still carries the scene and tokens are still
checked. Steps 1 and 2 confirm the badge itself.

Steps 1–4 and R1–R2 are read-only. **Step 5 is the only one that writes**, and
it is written to undo itself.

## Setup

- [claude] Confirm `main` is synced to the Repl and the checked-out SHA matches the merge commit, before anything is read.
- [claude] Capture the count of facts carrying a Visual Concept — the size of the set that was showing the incorrect badge — so "it's fixed" has a number behind it.
- [claude] Identify and name in the preview: one fact whose override panel is genuinely empty (review #6880 is the known case), and one with real override content. Steps 1, 2, 5 and R2 each need a known subject rather than a hunt.
- [claude] Before step 5 runs, capture the current stored `visualPromptStrategyOverride` for the fact step 5 will edit, and record it in the run record — so the restore below has a real captured value rather than a guess.
- [david] Sign in to the admin console as yourself; every step is an admin screen.
- [restore] The visual override on the fact edited in step 5 — restore it to the value captured before that step. Step 5 ends by removing what it added, so this is the backstop if the run is interrupted mid-step, not the normal path.

## Steps

### 1. The badge is gone where nothing was overridden

**Do:** Go to **Admin → Moderation** and open the review I name in the preview
(the fact with an empty override panel — review #6880 unless I say otherwise).
Expand **Advanced Options** and look at the **AI Visual Classification** block,
just under the amber "Ambiguous sentence-initial entity" note.

**Expect:** There is **no** orange `Overridden: Visual Strategy` bar. The
classification fields below it (Joke Mechanism, Depiction Style, Overhype Fit
and so on) are unchanged and still populated.

### 2. The badge still appears where something really was overridden

**Do:** Open the review I name in the preview as having real override content —
a required visual detail, a speech bubble, or a composition note. Expand
**Advanced Options** and look at the same **AI Visual Classification** block.

**Expect:** The orange `Overridden: Visual Strategy` bar **is** shown. This is
the case that must not have been broken by the fix.

### 3. The Visual Concept still reaches the picture prompt

**Do:** On the same review as step 2, read the text in the **Visual Concept —
describe the picture** field, then open **Prompt Diagnostics** in the same
Advanced Options section and read the compiled prompt it shows. (This panel
recomputes and displays the prompt an image engine would receive; it does not
render anything and does not save.)

**Expect:** The compiled prompt contains a **CORE SCENE** section carrying the
Visual Concept text you just read. The Visual Concept is still reaching the
engine — which is what the fix had to avoid breaking.

### 4. A bad token in the Visual Concept is still caught

**Do:** In the **Visual Concept — describe the picture** field on any fact, type
`{NOPE}` at the end of the existing text. **Do not save.**

**Expect:** A token warning appears under the field flagging the unknown token,
the same validation as before this PR. **Then delete the `{NOPE}` you typed**,
leaving the field exactly as you found it, and close the editor without saving.

### 5. Saving a real override raises the badge — then clearing it lowers it again

**Do:** Open the fact I name in the preview as having an empty override panel.
In **Advanced Options → Visual Strategy Override**, add one **Required visual
detail** with the text `uat-585-scratch`, and save. Observe the badge. Then
**remove that same entry and save again.**

**Expect:** After the first save the `Overridden: Visual Strategy` bar
**appears** — the badge tracks the override you just made. After removing the
entry and saving again, the bar is **gone**. The distinctive text makes the
entry unmistakable if anything is left behind; tell me if the second save does
not clear it and I will restore from the value captured in setup.

## Regression

### R1. The enrichment editor still opens on a normal fact

**Do:** Open **Admin → Moderation**, pick any fact with completed enrichment,
and open its enrichment editor.

**Expect:** The editor loads with its classification fields populated —
archetype, subtype, fit — and no error banner.

### R2. Real override content still reaches the prompt alongside the scene

**Do:** On the fact from step 2 (the one with real override content), open
**Prompt Diagnostics** and read the compiled prompt.

**Expect:** The prompt carries **both** the CORE SCENE **and** that fact's
override content — its required detail, bubble, or composition note. This is
the "a core scene must not mask real override content" invariant seen end to
end rather than in a unit test.

## Not bugs

- **A fact whose override panel is empty shows no badge even though its Visual
  Concept is long and detailed.** That is the entire point of the fix: the
  Visual Concept is required on every fact, so it can never distinguish one
  fact from another. Only the fields under **Visual Strategy Override** count.
- **The Facts page "Overridden" filter is unchanged by this PR.** It filters on
  the taxonomy override map (`enrichmentOverrides`), which is a different thing
  from the visual override and is not touched here — so its result set should
  look exactly as it did before. An earlier draft of this doc claimed the list
  would shrink; that was wrong and there is nothing to check there.
- **There is no way to tell an AI-drafted Visual Concept from one you wrote
  yourself.** The field stores both identically and nothing records which it
  was, which is *why* it is excluded rather than refined. If distinguishing
  them is worth having, that is a product decision and a separate piece of
  work, not a defect here.
- **A recovered enrichment job still shows its old error text on Queue
  Health.** Unrelated to this PR — a known observability gap recorded on #579.
