# PR150 — AI-suggested hashtags on fact submission (that survive approval) — UAT (David)

In-app click-through. Engineering checklist: `PR150_HASHTAG_AUTOGEN_SUBMIT_TEST_RUN.md`.

## What changed, in one breath

When you submit a fact and reach the **Preview** step, the Hashtags field now
**auto-fills with a few AI-suggested tags** — you can edit, add, or remove them
freely. Whatever tags you submit are the ones that **survive** onto the live fact
after moderation. If you leave the field empty, the fact still gets sensible tags
from the AI enrichment (so nothing is ever untagged).

## Important scope note

This is forward-looking: it affects **new submissions** going through the Submit
screen. It does **not** retroactively re-tag facts already in the database.

## Walkthrough

1. **Suggestions appear.** Go to **/submit**, write a fact, click **Preview**.
   The Hashtags field should briefly show **"Suggesting tags…"** and then fill
   with **3–6 sensible, topic-based tags** (e.g. `strength, coffee, legendary`).
   They should never include the person's name or `overhype`/`overhypeme`.
2. **You're in control.** Edit the field — add a tag, remove one, retype it.
   Your edits stick; the AI won't overwrite them.
3. **Typing immediately doesn't get clobbered.** Hit Preview and *immediately*
   start typing your own tag. The AI's suggestion must **not** replace what you
   typed.
4. **Moderator curates the final list.** Submit the fact, then (as admin) open it
   in moderation → **Visual review → Advanced Options → enrichment**. The
   **"Final hashtags — these ship on approval"** list starts with **your submitted
   tags**. Remove one, add one manually, and **+ add** an **"AI suggested"** chip
   from the source list below. Approve. Open the live fact and confirm it carries
   **exactly the moderator's final list**.
5. **No tags → seeded from AI.** Submit a fact with **all tags cleared**. In
   moderation, the Final hashtags list should be **pre-seeded with the AI
   suggestions** (ready to approve), not empty.
6. **Can't approve with zero tags.** In moderation, **remove every tag** from the
   Final hashtags list. The **Approve button is disabled** with a warning ("Add at
   least one hashtag…"). Add one back — Approve re-enables. (If you bypass the UI
   and approve with no tags, the server rejects with "add at least one hashtag".)
7. **Junk-only is treated as empty.** Put only a name / `overhype` in the Final
   list and approve — the server strips them and blocks approval (no zero-tag fact
   can ship).

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| Hashtags field auto-fills with 3–6 topic tags on Preview | The name or `overhype`/`overhypeme` suggested |
| You can freely edit/add/remove the suggestions | Your edits being overwritten by a late AI response |
| Moderator's final list ships exactly as approved | Enrichment silently replacing the curated tags |
| Approve disabled / blocked when the final list is empty | A fact going live with zero hashtags |
| No-tag submissions seed the moderator list from AI | An empty, un-approvable final list with no help |
| Submission works even if suggestions are slow/fail | The Submit button blocked waiting on suggestions |

## Regression smoke

| Area | Check |
| --- | --- |
| Submit flow | Write → Preview → Submit still works end to end |
| Duplicate check | The "similar fact" warning on Preview still fires |
| Draft restore | Leaving and returning still restores your fact + tags |
| Moderation | Approving/declining a fact still works; enrichment editor still saves |
| Existing facts | Already-live facts keep their current hashtags |

## Known non-bugs (this version)

- **The final-hashtags editor lives in Advanced Options.** It's inside the
  enrichment panel for now, even though tags aren't a "visual" control. Moving it
  to a top-level production-review field is future polish.
- **Manually-typed name/app tags vanish on approval.** If you type `alex` or
  `overhype` into the Final list, the server strips them — if they were the only
  tags, approval is blocked (a fact can't ship tagless).
- **A restored draft doesn't auto-suggest.** If you come back to a saved draft
  that's already on Preview with an empty Hashtags field, suggestions don't
  re-fire automatically — type or re-Preview to get them. (Deferred on purpose.)
- Suggestions are best-effort: if the model hiccups, the field just stays empty
  and you tag manually.

## Bug report template

```
Path: (suggestion on Preview / editing tags / approval survival / empty fallback / junk fallback / moderation editor)
Fact id / text:
Tags I submitted:
Tags on the live fact after approval:
What was wrong:
Screenshot:
```
