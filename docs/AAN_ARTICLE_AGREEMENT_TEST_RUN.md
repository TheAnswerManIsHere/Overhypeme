# Indefinite-article (a/an) agreement around {NAME} — automated test run

Engineering-side checklist for Replit (the technical safety net). The in-app
walkthrough for David is in
[`AAN_ARTICLE_AGREEMENT_UAT.md`](./AAN_ARTICLE_AGREEMENT_UAT.md).

## What changed (and why it's a *render-time* fix, not a tokenizer change)

A fact template stores a generic `{NAME}` placeholder; the actual name is
substituted per viewer. So "Sharks have a {NAME} Week" must render
**"an Alex Week"** for a viewer named *Alex* but **"a David Week"** for *David*.
English indefinite-article agreement is decided by the **word that follows** the
article — which here is the name, and the name isn't known until render time.

That means the correct place to fix a/an is the **renderer**, not the
tokenizer. The tokenizer keeps the author's plain "a"/"an" as-is (it already
does — articles are plain text in the token grammar). Every renderer now, right
before it fills `{NAME}`, rewrites a standalone indefinite article that sits
**immediately before** `{NAME}` so it agrees with the resolved name:

- Article directly before `{NAME}` only — agreement is local, so
  "a famous {NAME}" is left alone (it agrees with "famous", not the name).
- "a" ⇄ "an" both directions ("an {NAME}" → "a David").
- Capitalization preserved: sentence-initial "A {NAME}" → "An Alex".
- Vowel test is first-letter (`a/e/i/o/u`, case-insensitive). Rare phonetic
  exceptions ("a Uma", "an Hugo") are **not** special-cased — see "Deliberately
  NOT shipped".

Touched renderers (all four share the same tiny helper, duplicated per package
because frontend/backend don't share a module):

- `artifacts/overhype-me/src/lib/render-fact.ts` — `renderFact` and
  `renderFactSegments` (the colored-name segment renderer).
- `artifacts/api-server/src/lib/renderCanonical.ts` — `renderCanonical`
  (embedding/canonical form, fixed name "Alex") and `renderPersonalized`
  (per-user render used by memes / OG / video / share copy / workbench).
- `scripts/src/reseed-facts.ts` — the inline `renderCanonical` mirror used at
  seed time, kept consistent.

**No schema/migration changes. No new env vars. No new template token.** Because
the fix lives in the renderer, every existing stored fact (which contains a
literal "a {NAME}") gets the corrected output automatically — no re-tokenize or
backfill needed.

---

## TL;DR

```bash
# Repo-wide typecheck (build libs first; the artifacts depend on lib dist,
# otherwise you'll see unrelated TS6305 "has not been built" errors).
pnpm run typecheck:libs
( cd artifacts/api-server  && tsc -p tsconfig.json --noEmit )
( cd artifacts/overhype-me && tsc -p tsconfig.json --noEmit )

# Backend renderer unit tests (pure — no DB/LLM).
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/renderCanonical.test.ts

# Frontend renderer unit tests.
cd artifacts/overhype-me && pnpm exec vitest run src/__tests__/renderFact.test.ts
```

All green ⇒ stop. Sections below break out anything that fails.

---

## A — Typecheck

`tsc --noEmit` for the artifacts requires the workspace libs to be built first
(otherwise you'll see spurious `TS6305 Output file ... has not been built`
errors that are unrelated to this change):

```bash
pnpm run typecheck:libs
( cd artifacts/api-server  && tsc -p tsconfig.json --noEmit )   # exits 0
( cd artifacts/overhype-me && tsc -p tsconfig.json --noEmit )   # exits 0
```

The two files this change touches (`renderCanonical.ts`, `render-fact.ts`) must
report zero errors.

## B — Backend renderer tests

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/renderCanonical.test.ts
```

Pass criterion: **33 tests pass, 0 fail** (3 new `renderCanonical` cases +
4 new `renderPersonalized` cases on top of the existing suite). The new ones:

- `renderCanonical("Sharks have a {NAME} Week")` → `"Sharks have an Alex Week"`
  (canonical name "Alex" starts with a vowel).
- `renderCanonical("A {NAME} legend")` → `"An Alex legend"` (capitalized).
- `renderCanonical("a unicorn met a {NAME}")` → `"a unicorn met an Alex"` —
  only the article directly before `{NAME}` is touched; "a unicorn" is left
  alone.
- `renderPersonalized("… a {NAME} Week", "Alex", …)` → `… an Alex Week`;
  with `"David"` → `… a David Week`.
- `renderPersonalized("It was an {NAME} moment", "David", …)` →
  `"It was a David moment"` (an → a).
- `renderPersonalized("A {NAME} legend", "Owen", …)` → `"An Owen legend"`.

## C — Frontend renderer tests

```bash
cd artifacts/overhype-me && pnpm exec vitest run src/__tests__/renderFact.test.ts
```

Pass criterion: **66 tests pass, 0 fail** (10 new cases in the
"indefinite article agreement around {NAME}" block). Notable ones:

- `renderFact("Sharks have a {NAME} Week", "Alex")` → `"Sharks have an Alex Week"`
  (David's reported case) and `"David"` → `"Sharks have a David Week"`.
- a→an / an→a both directions; "A"/"An" capitalization preserved.
- empty name → placeholder uses "a" (`"Sharks have a ___ Week"`).
- `"a unicorn met a {NAME}"` + "Alex" → `"a unicorn met an Alex"` (only the
  name-adjacent article changes).
- `"extra {NAME}"` + "Alex" → `"extra Alex"` (a trailing "a" inside a word is
  not mistaken for an article).

---

## Deliberately NOT shipped

- **Phonetic vowel-sound detection.** Agreement is decided from the first
  letter only. Names where the letter and the sound disagree —
  "a Uma" (sounds "Yoo-"), "a Eugene" (sounds "Yoo-"), "an Hour"-style silent
  letters — are not special-cased. First-letter agreement is correct for the
  overwhelming majority of names; a pronunciation dictionary is out of scope.
- **No new template token / grammar change.** We did not introduce an `{a}`
  article token. The article stays plain text in the stored template and is
  reconciled at render time, which keeps existing facts working with no
  migration and nothing new for the tokenizer (AI or legacy regex) to emit.
- **Articles not adjacent to {NAME}.** Only the indefinite article immediately
  before `{NAME}` is reconciled. The author's other articles (and articles
  before adjectives, e.g. "a famous {NAME}") are left exactly as written —
  English agreement is with the immediately following word.
- **No backfill of stored `canonicalText`.** New/edited facts compute the
  corrected canonical form on write; previously embedded `canonicalText` values
  are left as-is (the difference is one character, "a Alex" vs "an Alex", which
  is immaterial to the fuzzy duplicate-check embedding).
