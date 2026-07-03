# PR166 — Candidate Visual concepts · UAT (click-through)

> **For David.** This is the in-app acceptance test for the whole candidate
> Visual-concepts feature (backend #163 + this frontend #166). Companion
> engineering checklist: `docs/PR166_VISUAL_CONCEPT_PICKER_TEST_RUN.md`.
>
> **What this feature is:** while a fact is in production review, the planner
> auto-drafts **three distinct "describe the picture" ideas**. You scan them and
> optionally drop one into the **Visual concept** field as a starting point.
> Picking is a *draft* — you still Save, exactly like typing the field yourself.
> It's **optional**: the field works empty just like today.
>
> **Prereq:** this needs a live OpenAI key configured (the concept call is real).
> If concepts never generate, check that first — it's environment, not the UI.

---

## Where to go

1. Open **Admin → Moderation → Fact Reviews**.
2. Provisionally-approve a pending fact so it enters prep, and wait for it to
   reach **production review** (the Prep pills go "ready").
3. Open the review and go to **Step 2 · Visual review**. The picker sits just
   under the **"Visual concept — describe the picture"** field.

## The happy path

| # | Do this | Expect |
|---|---------|--------|
| 1 | Reach Step 2 on a freshly-prepped fact. | A **"Visual ideas"** pill appears in the prep row (marked *optional*), and under the Visual concept field a **"Visual ideas"** panel shows a spinner "Drafting three ideas…", then **three cards**. No refresh needed — it updates live. |
| 2 | Read a card. | Each card shows a short **title** and a one-line "why it works". The full scene is hidden. |
| 3 | Click **"Show scene"** on a card. | The full "describe the picture" paragraph expands. It refers to the person as **{NAME}** (not a real name). |
| 4 | Click **"Use as draft"** on a card you like. | The card's scene drops into the **Visual concept field** above. An **"Unsaved changes"** bar appears (same as if you'd typed it). The other cards stay visible. |
| 5 | Edit the field if you want, then click **Save**. | Saves normally. Any test renders flag **stale** — re-run them to see the new scene. |
| 6 | Click **Regenerate** (top-right of the Visual ideas panel). | Status flips to "Drafting…", then **three fresh, different** ideas appear. If you had text in the Visual concept field, the new ideas are *distinct alternatives* to your direction (not copies of it). |

## Edge cases to spot-check

| Scenario | Expect |
|----------|--------|
| A fact with **no ideas yet** (older fact, or the job didn't run) | The panel shows a **"Generate visual ideas"** button instead of cards. Clicking it drafts three. |
| Concept drafting **fails** (e.g. transient model error) | A **muted, non-blocking** note ("Couldn't draft ideas this time… write the Visual concept yourself or Regenerate") — *not* an alarming red error. The pill reads "unavailable", never blocks approval. |
| You **change the fact's enrichment** (or the fact text) after ideas were drafted | Reopen Step 2: the ideas show a **stale** note ("The fact or its enrichment changed since these ideas were drafted") and the cards are hidden. **Regenerate** for fresh ones. |
| A card that can't be used | Its **"Use as draft"** button is greyed out with a tooltip explaining an invalid personalization token. (Rare — the server validates tokens; this is a safety net.) |

## What should NOT happen

- The picker must **never block approval** — you can approve a fact with the
  Visual ideas panel failed, empty, or ignored.
- Picking a card must **never** save on its own — it only fills the draft; you
  Save.
- Picking must **never overwrite** a Visual concept you've already typed without
  you clicking "Use as draft".
- The panel must **never** spin forever — if no ideas exist it shows a Generate
  button, not an endless spinner.

## Regression smoke (existing Step-2 behavior unchanged)

- The **Visual concept** field itself works exactly as before (type, token chips,
  char counter, Save/Discard).
- Test-render tiles, Advanced Options, and the approve/reject flow are unchanged.

## Known non-bugs / limitations

- **Optional by design.** Ideas are a starting point, not a requirement — a
  failed/absent job is expected to be quiet, not loud.
- **Ideas are render-mode-agnostic.** They describe the scene only (no reference
  photo / identity / style language) so a picked idea works across every render
  mode. That's intentional — the compiler adds the rest.
- **Draft context on Regenerate is best-effort.** If you regenerate the instant a
  prior draft is mid-flight, the new ideas may not reflect your latest draft;
  regenerate once more if so.

## Bug report template

```
Fact / review id:
Step: (reaching Step 2 / cards appearing / Show scene / Use as draft / Save / Regenerate / stale / failed)
Expected:
Actual:
Screenshot:
```
