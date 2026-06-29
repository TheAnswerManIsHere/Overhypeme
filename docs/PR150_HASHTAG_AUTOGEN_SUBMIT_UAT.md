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
4. **Your tags survive approval.** Submit the fact, then (as admin) approve it
   through moderation. Open the live fact and confirm it carries **exactly the
   tags you submitted** (lowercased/cleaned), not a different AI set.
5. **Empty field → AI fallback.** Submit another fact but **clear all tags**
   before submitting. Approve it. Confirm the live fact still has **sensible AI
   tags** (the fallback) rather than no tags.
6. **Junk-only → still gets tags.** Submit a fact whose only tags are junk/banned
   (e.g. just the person's name + `overhype`). Approve it. Confirm it falls back
   to AI tags instead of ending up with **zero** tags.
7. **Moderation editor reads honestly.** In moderation **Advanced → enrichment**,
   the "Suggested Hashtags" section now says it's **fallback only** (used only if
   the submitter left no tags), and the user's submitted tags are labeled as the
   ones that **ship**.

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| Hashtags field auto-fills with 3–6 topic tags on Preview | The name or `overhype`/`overhypeme` suggested |
| You can freely edit/add/remove the suggestions | Your edits being overwritten by a late AI response |
| Submitted tags survive onto the approved fact | Enrichment silently replacing your tags |
| Empty/junk-only submission still gets AI fallback tags | A fact ending up with zero tags |
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

- **Moderators can't strip a single user tag at approval.** Because user tags
  win, the moderator's enrichment hashtag editor is now fallback-only. To remove
  a bad-but-valid user tag, a moderator declines the fact (or we add a dedicated
  final-tag editor — a flagged follow-up; tell me if you want it).
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
