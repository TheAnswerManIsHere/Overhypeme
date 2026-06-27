# Moderation render-review fixes — user acceptance testing

Follow-up to PR #139. Two bugs you found in UAT are fixed here. Engineering
checklist: `docs/PR140_MODERATION_RENDER_REVIEW_FIXES_TEST_RUN.md`.

## What you're verifying
1. The **Pexels images** in a review render as proper thumbnails (not crushed
   horizontal strips).
2. **Generate runtime prompt preview** and **Render AI background** no longer fail
   with the `t2i_fallback ... "neutral"` error in the normal flow.

## Where to look
Admin → **Moderation** → open a review in **Production review** → the
**Runtime Compiled Prompt Preview** and **Pexels images pulled** sections.

## Setup
Use a review already in **Production review** (e.g. the one from the PR #139 UAT).
If you don't have one, provisionally-approve a submission and let enrichment finish.

## 1. Pexels thumbnails render correctly
1. Expand **Pexels images pulled**.
2. Switch between the **male / female / neutral** tabs.
3. **Expect:** each image is a normal rectangular thumbnail in a tidy grid that
   **scrolls** when there are many; photographer credit shows on hover; the
   "Photos provided by Pexels" link is at the bottom.
4. **Expect NOT:** images crushed into thin horizontal bands stacked on top of each
   other (the old bug).

## 2. Runtime prompt preview works with the default gender
1. Expand **Runtime Compiled Prompt Preview**.
2. Set **Sample name** + **Sample pronouns** (e.g. `David Franklin`, `he/him`).
3. Watch the **Fallback gender** dropdown: it should auto-set to **male** when you
   type `he/him` (try `she/her` → **female**, `they/them` → **neutral**).
4. Click **Generate runtime prompt preview**.
5. **Expect:** a compiled prompt appears — **no** `prompt_generation_failed:
   t2i_fallback prompt missing fallbackSubjectGender "neutral"` error.

## 3. Render AI background works
1. With the same assumptions, click **Render AI background**.
2. **Expect:** the render row goes `queued → rendering → done` and the AI background
   image appears (no neutral-gender error).

## 4. Manual gender override sticks
1. Manually change **Fallback gender** to **neutral**.
2. Change **Sample pronouns** back to `he/him`.
3. **Expect:** the dropdown **stays neutral** — once you pick a gender yourself, the
   pronouns stop changing it. (Re-opening the review remembers your choice.)
4. Note: if you *deliberately* generate with **neutral**, it may still occasionally
   fail — that's the known pre-existing limitation below, not this fix.

## Regression smoke
| Check | Expect |
| --- | --- |
| Pexels tabs switch (male/female/neutral) | Counts + thumbnails update, grid scrolls |
| Pexels still seeding | "seeding…" + live fill, no crush |
| Preview with i2i mode (Facts page) | Unchanged from before |
| Render AI background, second render | Both rows tracked independently |
| Approve flow | Unchanged |

## Known non-bugs / limitations
- **Choosing `neutral` for a t2i render can still fail** the prompt generator
  occasionally — the underlying generator strictly wants the literal gender word and
  "neutral" is awkward for the model. Hardening that everywhere (incl. production
  abstract facts) is a separate, deferred change. The default no longer lands on
  neutral, so the normal flow is unaffected.
- Pexels thumbnails are fixed-height (cropped to fill) — slight crop of tall/wide
  photos is expected, not a bug.

## Bug report template
```
Section: [Pexels thumbnails | Runtime prompt preview | Render AI background]
Sample name / pronouns: ...
Fallback gender shown: ...
What I did: ...
Expected: ...
Got (incl. any red error text): ...
Screenshot: ...
```
