# PR206 — Auto-tokenize admin Visual-Concept authoring · UAT (click-through)

> **For David.** In-app acceptance test for the plain-English-then-auto-tokenize
> authoring flow. Companion engineering checklist:
> `docs/PR206_AUTHORING_AUTO_TOKENIZE_TEST_RUN.md`.
>
> **What changed:** authoring the Visual Concept and the rest of the Visual
> Strategy Override used to require hand-typing personalization tokens
> ({NAME}, {SUBJ}, possessive/reflexive pairs) via "insert token" chips —
> error-prone, and the source of the double-naming bug PR192 cleaned up on
> the compiler side. Now you **write plain English** — the subject's name
> naturally, not a token — and clicking **Save** tokenizes it automatically
> (reusing the same tokenizer fact submission uses) and **shows you the
> tokenized result** right in the field so you can verify it before it
> persists. Chips still exist in the toolbar as a manual fallback, but you
> shouldn't need them.

---

## Where to go

Admin → Moderation → open any review at Step 2 (**Visual Concept**), or
Admin → Facts → expand a fact's **Visual Taxonomy Enrichment** → Advanced
Options → **Visual Strategy Overrides**.

## The main thing to confirm: type a name, click Save, see tokens

| # | Do this | Expect |
|---|---------|--------|
| 1 | In the **Visual concept — describe the picture** card, type a scene naming the subject naturally, e.g. `David leans against the bar counter, unfazed.` | The field just shows what you typed — no auto-tokenizing while you type. |
| 2 | Click **Save** (or **Save Visual Concept & Continue**). | Briefly shows **"Tokenizing and saving…"**, both the card and the Advanced Options panel lock (nothing else is clickable), then the field updates to show `{NAME} leans against the bar counter, unfazed.` and the save completes normally. |
| 3 | Hard-refresh the page (or close and reopen the modal) and look at the same field. | **It still shows the tokenized version** — this is the important regression check: the persisted value is the tokenized one, not the plain English you typed. |
| 4 | Confirm the render still works (Test Renders, any mode). | Renders exactly as before — the tokenized text resolves to the subject's real name/pronouns per render. |

## Second character stays a plain role, not a token

| # | Do this | Expect |
|---|---------|--------|
| 1 | Write a Visual Concept naming the subject **and** a role for someone else, e.g. `David hands his mother a participation trophy.` (do NOT name the second person). | — |
| 2 | Save. | Tokenizes to `{NAME} hands {POSS} mother a participation trophy.` — "mother" is a role reference, not a second subject name, so it's untouched. |
| 3 | In **Scene Role Assignments**, add a row: entity = `mother`, visual role = `receiving the trophy with exaggerated pride`. Save. | The visual role tokenizes if it names the subject; the entity field stays exactly `mother` (entity is never tokenized). |

## Typing a token — or the subject's name — into a role's entity field

| # | Do this | Expect |
|---|---------|--------|
| 1 | In **Scene Role Assignments**, type `{NAME}` directly into an **entity** field (not visual role) and click Save. | Save **blocks** with a clear error on that row: personalization tokens aren't allowed in an entity — it's a label like "subject" or "mother", not rendered prose. The row is red-bordered. |
| 2 | Fix it: type the subject's actual name (e.g. `David Franklin`) into the same entity field and Save. | It auto-normalizes to `subject` — typing the subject's own name is treated the same as typing "subject". |
| 3 | Confirm a chip **cannot** be inserted into the entity field. | Clicking a token chip while focused in the entity field does nothing to it (chips only target prose fields like Visual Concept, Required Visual Details, and Visual Role). |

## Hashtags aren't dropped by a Visual Concept save (Facts page)

| # | Do this | Expect |
|---|---------|--------|
| 1 | On the live Facts page, change **only** the suggested hashtags (leave Visual Strategy alone) and Save. | Save completes. Hard-refresh — the hashtag edit persisted. |
| 2 | Change **both** hashtags and a Visual Strategy prose field in the same sitting, then Save once. | Both persist — hard-refresh shows the new hashtags AND the tokenized VSO text. |

## While tokenizing, nothing else can touch the same fields

| # | Do this | Expect |
|---|---------|--------|
| 1 | Start a Save on a Visual Concept edit, and *immediately* try to type in another VSO field, click a chip, or click Approve/Reject/Back. | Everything in the Visual Concept card and the Advanced Options VSO panel is disabled/greyed out until the save completes — no double-submit, no racing edit. |

## Regression smoke

| Area | Check |
|------|-------|
| Manual "insert token" chips | Still work for prose fields (Visual Concept, Required/Forbidden Visual Details, Visual Role, policy guidance) if you prefer to type tokens directly — nothing removed, just no longer required. |
| Existing tokenized content | A field that's already correctly tokenized and doesn't mention the subject by name re-saves without a wasted AI call (an internal cost-skip, invisible to you — just confirm Save still completes normally on an already-tokenized field). |
| Non-VSO enrichment fields | Archetype, subtype, hashtags, etc. — unaffected; Save still disables on a genuinely invalid enrichment (e.g. clearing all hashtags). |
| Review-candidate (refresh) flow | Same tokenize-then-save behavior when editing a refresh candidate's Visual Concept, not just a first-time fact. |

## Known non-bug limitations

- **A second *named* character in your prose can still render literally.**
  The tokenizer only recognizes the personalized subject; if you type
  another real name instead of a role, it's left as plain text in the
  compiled prompt. Write roles ("the bartender") for everyone except the
  subject.
- **The tokenizer is a real AI call** (skipped only when the field is
  already fully tokenized or clearly has nothing personalizable in it), so
  Save can take a beat longer than before on a freshly-typed field.
- **Old, already-saved VSO content is untouched** until you next edit and
  save that field — nothing was migrated or retroactively re-tokenized.

## If something's off, report it like this

> **Fact / Review:** which fact, which review ID
> **Field:** which VSO field (Visual Concept / Required Visual Details /
> role entity / role visual role / composition / policy guidance / etc.)
> **What you typed:** the plain-English text
> **What you expected vs. got:** e.g. "expected `{NAME}`, got the name left
> literal" or "expected the row to block, it saved anyway"
> **After hard-refresh:** does the persisted value match what Save showed you?
