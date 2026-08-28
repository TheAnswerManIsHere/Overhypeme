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
they confirm the picture still renders and tokens are still checked. Steps 1
and 2 confirm the badge itself.

## Setup

- [claude] Confirm `main` is synced to the Repl and the checked-out SHA matches the merge commit, before anything is read.
- [claude] Capture the count of facts carrying a Visual Concept — the size of the set that was showing the incorrect badge — so "it's fixed" has a number behind it.
- [claude] Identify one fact with a genuinely empty override panel (review #6880 is the known case) and one with real override content, so step 1 and step 2 each have a known subject and you are not hunting for one.
- [david] Sign in to the admin console as yourself; every step is an admin screen.
- [restore] None. Every setup action is read-only, and steps 3 and 4 use a scratch edit you discard rather than save — noted in the step itself.

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

### 3. The Visual Concept still reaches the picture

**Do:** Open any fact that has completed enrichment and is at concept review.
In the **Visual Concept — describe the picture** field, read the text that is
there. Then go to the **Test Renders** step and generate one render.

**Expect:** The render reflects the scene described in that Visual Concept text
— the subject and action you read are what you see. The Visual Concept is still
being sent to the image engine.

### 4. A bad token in the Visual Concept is still caught

**Do:** In the **Visual Concept — describe the picture** field on any fact, type
`{NOPE}` at the end of the existing text. Do not save.

**Expect:** A token warning appears under the field, flagging the unknown token
— the same validation as before this PR. **Then remove the `{NOPE}` you typed
and leave the field as you found it**, without saving.

### 5. Saving a real override still raises the badge

**Do:** On a fact whose override panel is empty, open **Advanced Options →
Visual Strategy Override**, add one **Required visual detail** (e.g.
`a red hat`), and save.

**Expect:** The save succeeds, and after saving the `Overridden: Visual
Strategy` bar now **does** appear on that fact — the badge tracks the override
you just made.

## Regression

### R1. The enrichment editor still opens on a normal fact

**Do:** Open **Admin → Moderation**, pick any fact with completed enrichment,
and open its enrichment editor.

**Expect:** The editor loads with its classification fields populated —
archetype, subtype, fit — and no error banner.

### R2. The Facts page "Overridden" filter still returns facts

**Do:** Go to **Admin → Facts** and click the **Overridden** filter button.

**Expect:** The filter applies without error and returns a list. It may be
**much shorter than before this PR** — that is the fix working, not a
regression; it now lists facts with real taxonomy/visual overrides rather than
nearly everything.

### R3. A fact sent back for a refresh still completes

**Do:** Send one fact back for a refresh from **Admin → Taxonomy Health**, then
watch its row on **Admin → Moderation**.

**Expect:** It reaches `Enrichment ✓ ready` with a concept-stage label, exactly
as PR #582 established. This fix touches the same resolver, so it is worth one
cheap confirmation that refreshes still work.

## Not bugs

- **A fact whose override panel is empty shows no badge even though its Visual
  Concept is long and detailed.** That is the entire point of the fix: the
  Visual Concept is required on every fact, so it can never distinguish one
  fact from another. Only the fields under **Visual Strategy Override** count.
- **The Facts page "Overridden" filter returns far fewer facts than it used
  to.** Same cause, and it was previously over-reporting. R2 covers this.
- **There is no way to tell an AI-drafted Visual Concept from one you wrote
  yourself.** The field stores both identically and nothing records which it
  was, which is *why* it is excluded rather than refined. If distinguishing
  them is worth having, that is a product decision and a separate piece of
  work, not a defect here.
- **A recovered enrichment job still shows its old error text on Queue
  Health.** Unrelated to this PR — a known observability gap recorded on #579.
