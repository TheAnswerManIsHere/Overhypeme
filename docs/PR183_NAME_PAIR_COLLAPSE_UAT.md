# PR183 — Names always keep singular verbs · UAT (click-through)

> **For David.** In-app acceptance test for the grammar fix: a verb whose
> subject is the person's *name* now always renders in its singular form
> ("David gives…"), no matter which pronoun set the viewer picked — including
> they/them, which used to see "David give…". Also covers the small UI polish
> carried from PR #181. Engineering checklist:
> `docs/PR183_NAME_PAIR_COLLAPSE_TEST_RUN.md`.

## Before you start

The backfill must have been applied (Replit runs it per the TEST_RUN doc).
Until then, *old* facts can still show the bug — that's expected pre-backfill,
a real bug post-backfill.

## Part A — The core fix (~3 minutes)

1. Open any fact page as a viewer whose pronoun set is **they/them** (or a
   custom plural set).
2. Read facts where the sentence has the person's **name doing something**:
   "When ⟨Name⟩ gives you the finger…", "⟨Name⟩ keeps…", "⟨Name⟩ runs…".
3. **Expect:** the verb right after the name reads singular — "gives", "keeps",
   "runs". **Never** "give", "keep", "run".
4. Switch the same fact to **he/him** or **she/her**. Expect the same singular
   verb — the name's verb should not change across pronoun sets at all.
5. Sentences where the *pronoun* is the subject must still flip: "They keep
   it…" for they/them vs. "He keeps it…" for he/him. That behavior is
   unchanged and must keep working.

## Part B — New submissions

1. Submit a new fact whose plain-English text has the name as subject, e.g.
   "Alex runs and hides whenever Monday starts."
2. After the AI tokenize step, check the template preview: the verbs after
   `{NAME}` should be plain ("runs and hides"), **not** `{runs|run}`.
3. Approve it through moderation, then view it as they/them.
   **Expect:** "Alex runs and hides…" — both verbs singular.

## Part C — Moderation modal polish (carried from #181)

1. Open Admin → Moderation, open a review deep enough to scroll the modal body.
2. Scroll to the bottom, then click **Continue to Visual Concept** (or the
   stage advances on its own).
   **Expect:** the modal body glides back to the top of the new step.
3. Now click **Back** to return to Triage.
   **Expect:** also scrolls to top (this transition was missed in #181).
4. The review list behind the modal must NOT lose your scroll position.
5. In the review list rows, the prep pill formerly labeled "Images" now reads
   **"Stock photos"**.
6. In the Visual Concept card, each token chip shows a grey example beside it
   ({NAME} David, {SUBJ} he, …).

## Part D — Regression smoke

| Check | Expect |
| --- | --- |
| "Sharks have a ⟨Name⟩ Week." for they/them | "Sharks have…" — other subjects never re-conjugate |
| "⟨Name⟩'s legend keeps growing." | possessive untouched, "keeps" stays |
| They/them fact with pronoun subject | "They keep / They don't / They were" — plural still works |
| he/him + she/her render of any fact | unchanged from before this PR |
| Admin → Facts direct add with an already-tokenized template | still saves; grammar errors still 422 |
| Draft editing in the review modal (leave + reopen) | unsaved visual-strategy edits restored; other fields never show phantom "unsaved changes" |

## Bug report template

```
Fact id / review id:
Viewer pronoun set:
What I saw (exact rendered sentence):
What I expected:
Where (fact page / submit preview / moderation modal):
```

## Known limitations (NOT bugs)

- "⟨Name⟩ eats cake **and drinks** soda" — if an object sits between two
  coordinated verbs, a wrapped second verb isn't auto-collapsed. Rare shape;
  same reach limit as the existing conjugation net.
- A `*_TEST_RUN.md` doc missing from `main` is expected — you delete it after
  Replit runs it. The UAT (this file) is the durable half.
- Old facts still showing "David give…" **before** the backfill has been
  applied — run the backfill, then re-check.
