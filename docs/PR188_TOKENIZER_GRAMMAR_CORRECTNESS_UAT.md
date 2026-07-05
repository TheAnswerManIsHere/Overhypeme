# PR188 — Grammar reads right for every viewer · UAT (click-through)

> **For David.** In-app acceptance test for five grammar fixes: possessive names
> now render ("James's"), sibilant verbs conjugate right ("They pass", not "They
> passe"), the never-valid "They's" is gone (renders "They are"), a coordinated
> verb after a name+object collapses to singular, and every way a fact gets into
> the system now runs the same grammar cleanup. Engineering checklist:
> `docs/PR188_TOKENIZER_GRAMMAR_CORRECTNESS_TEST_RUN.md`.

## Before you start

The backfill must have been applied (Replit runs it per the TEST_RUN doc). Until
then, *old* facts can still show "They's" or a raw `{NAME_POSSESSIVE}` — that's
expected pre-backfill, a real bug post-backfill. New facts are correct
immediately (the fix runs at write time).

## Part A — Possessive names (`{NAME_POSSESSIVE}`) (~2 min)

1. Find or submit a fact that uses the person's name possessively — e.g. "⟨Name⟩'s
   legend keeps growing." (In the submit flow, write "David's legend…" and let it
   tokenize.)
2. View it with any name set.
   **Expect:** the possessive renders with the name — "David's legend…",
   "Alex's legend…". You should **never** see a literal `{NAME_POSSESSIVE}` on
   screen.
3. Try a name that ends in **s** (James, Chris, Lucas).
   **Expect:** "James's", "Chris's" — we always add `'s` (not "James'").
4. If the fact shows the name in a highlight colour (meme preview / card), the
   whole "James's" is highlighted as the name, not just "James".

## Part B — "They's" is gone (~3 min)

1. Find or submit a fact phrased as a contraction of the person + is: "⟨Name⟩'s
   unstoppable.", "⟨Name⟩'s always late." (plain English "He's unstoppable").
2. View it as **he/him** and **she/her**.
   **Expect:** "He's unstoppable." / "She's unstoppable." (the contraction is
   fine for singular).
3. View the same fact as **they/them** (or a custom plural set).
   **Expect:** "They are unstoppable." — a proper sentence. You must **never**
   see "They's".
4. New submissions: after the AI tokenize step, the template preview for "He's
   unstoppable" should read `{Subj} {is|are} unstoppable` — not `{Subj}'s`.

## Part C — Sibilant verbs (~1 min)

1. Find or submit a fact where the **pronoun** is the subject of a verb like
   *passes*, *misses*, or *kisses*: "⟨Name⟩ never misses.", "⟨Name⟩ passes every
   test."
2. View as **they/them**.
   **Expect:** "They never miss.", "They pass every test." — clean base verbs.
   You must **never** see "They passe", "They misse", "They kisse".
3. View as he/him → "He never misses.", "He passes…" (singular unchanged).

## Part D — Coordinated verb after a name + object (~1 min)

1. Find or submit a fact like "⟨Name⟩ eats cake and drinks soda." (name is the
   subject; there's an object "cake" between the verbs).
2. View as **they/them**.
   **Expect:** "David eats cake and drinks soda." — both verbs singular (the
   name never pluralizes). You must **never** see "…and drink soda".
3. Counter-check the boundary: a fact like "⟨Name⟩ eats and gremlins bark." must
   render "…and gremlins bark" for they/them (a *different* subject after "and"
   is left completely alone).

## Part E — Every entry point is consistent (admin, ~2 min)

1. Admin → Facts → add a fact directly, pasting an already-tokenized template
   that skips the AI step, e.g. `{Subj} keeps it locked in {POSS} back yard.`
   **Expect:** it saves, and viewing as they/them reads "They keep it locked in
   their back yard." (the missed conjugation was repaired on save, not left as
   "They keeps").
2. Admin → Facts → bulk import (JSON or CSV): include one good line and one with
   a bad token like `{FOO}`.
   **Expect:** the good line imports; the response reports the bad one as failed
   (it is skipped, not silently stored, and doesn't block the good one).
3. Editing a fact's text in the admin editor with a bad token → rejected with a
   grammar error (not saved).

## Part F — Regression smoke

| Check | Expect |
| --- | --- |
| "Sharks have a ⟨Name⟩ Week." for they/them | "Sharks have…" — non-person subjects never re-conjugate |
| "⟨Name⟩'s legend keeps growing." (possessive, not contraction) | "…keeps…" stays singular; possessive renders with the name |
| They/them fact with a pronoun subject | "They keep / They don't / They were" — plural still works |
| he/him + she/her render of any fact | unchanged from before this PR |
| A plain (untokenized) fact with no pronouns | renders exactly as written |

## Bug report template

```
Fact id / review id:
Viewer pronoun set:
Name used:
What I saw (exact rendered sentence):
What I expected:
Where (fact page / submit preview / admin add / bulk import):
```

## Known limitations (NOT bugs)

- "⟨Name⟩ eats cake and **drinks** soda" where the **pronoun** (not the name) is
  the subject and the second verb was left un-wrapped by the AI: the deterministic
  net won't retro-wrap a verb across an object+conjunction (it can't tell it from
  a new subject). The AI tokenizer is instructed to wrap both; this only matters
  if the model misses one on an object-separated coordination. Rare.
- A `*_TEST_RUN.md` doc missing from `main` is expected — you delete it after
  Replit runs it. The UAT (this file) is the durable half.
- Old facts still showing "They's" or a raw `{NAME_POSSESSIVE}` **before** the
  backfill has been applied — run the backfill, then re-check.
