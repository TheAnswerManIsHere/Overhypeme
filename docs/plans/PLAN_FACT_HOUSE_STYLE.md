# Plan: fact wording house style

```plan-oracle
# Scope agreed with David, 2026-11-23 (chat; workstream Issue #1174)

## Direction
One house style for fact wording, applied by the system and never asked of the submitter.

## Product Intent
- Every stored fact starts with a capital letter (or a token, which supplies its own) and ends with terminal punctuation. Exceptions (David, 2026-11-24): a first word with a capital after its first letter is left as written (Q3); an emoji ending is left as written (Q4).
- An existing `.`, `!`, `?` or `…` is kept; a trailing `,`, `;` or `:` is replaced by `.` (Q5); otherwise a `.` is added, placed correctly around a closing quote or bracket.
- Ends are trimmed and runs of spaces collapsed.
- The submitter and the moderator see the tidied wording, not what was typed.
- Existing facts and pending submissions are brought to the same rule in a one-time pass (David, Q1: 1).

## Must Not Change
- What the duplicate check treats as identical (it already ignores case and punctuation: `duplicateMatchText`).
- The token grammar.
- Any word inside a fact, or its internal capitals and punctuation.
- Memes already made: baked meme images and frozen captions never change. A meme that still reads its fact's live wording shows the tidied wording, like its fact (David, Q6: 1).
- The wording lock (migration 0141, David 2026-11-14), for everything except this one pass.

## Settled Decisions
- The wording lock: once a submission is accepted, the fact's wording never changes (David, 2026-11-14).
- Identical wording is refused at submission (decisions.md, 2026-11-21).
- Q1: 1 — existing facts are included in a one-time pass (David, 2026-11-23).
- Q2: 1 — the one-time pass may change locked wording as a single named exception: the migration lifts the lock for its own update only and restores it in the same transaction. Only a first-letter capital and an ending mark change, so enrichment, gags and pictures built from the wording stay valid (David, 2026-11-23).
- Q3: 1 — a first word with a capital after its first letter (`iPhone`, `eBay`) is left as written (David, 2026-11-24).
- Q4: 1 — an emoji ending is left as written, with no period added (David, 2026-11-24).
- Q5: 1 — a trailing comma, semicolon or colon is replaced by a period (David, 2026-11-24).
- Q6: 1 — a meme with no frozen caption or baked image shows its fact's tidied wording; no preservation is built (David, 2026-11-24).

## Now / Next / Never
- Now: the tidy rule in the shared clean-up step every new wording passes through; the one-time pass over facts and pending submissions, keeping each fact's stored plain-name version in step; tests for the rule and the pass.
- Never: auto-correcting grammar, commas or internal capitals.

## Ceremony tier
Product code, full plan with Astra's review, plus the migration review.
```

Workstream: Issue #1174 — Fact wording house style: every fact starts with a capital and ends with punctuation.

## Problem
Fact wording is stored as typed. Some facts start lower-case, some have no ending mark, some carry stray spaces. The fact card hides the first with all-caps type, but a missing period shows everywhere, and share text, link previews and emails show both.

## Direction
One house style for fact wording, applied by the system. This increment makes it true for every wording written from now on and for the wording already stored.

## Product Intent, Must Not Change, Settled Decisions
As in the oracle block above, verbatim.

## Repo Context Inspected
- `lib/api-zod/src/templateGrammar.ts` (`applyDeterministicGrammar`, the closed token set), shared with the frontend.
- `artifacts/api-server/src/lib/normalizeFactTemplateForStorage.ts`, `reviewWording.ts`, `moderationStaging.ts`, `factTokenizer.ts`, `renderCanonical.ts`, `splitTokenIndex.ts`, `duplicateText.ts`, `embeddings.ts`.
- `artifacts/api-server/src/routes/memes.ts` (the two fallbacks that read live fact wording), `lib/visualConcepts/inputHash.ts`, `lib/visualConceptJobs.ts`.
- `lib/db/migrations/0141_wording_lock.sql`, `lib/db/src/migrate.ts`, `docs/engineering/migrations-and-backfills.md`.
- `artifacts/overhype-me/src/pages/SubmitFact.tsx`, `components/facts/FactCard.tsx`.
- `docs/ai-context/token-rendering-and-grammar.md`, `decisions.md`, `glossary.md`.

## Current Behavior
- Every new wording passes one clean-up-and-validate step (`normalizeFactTemplateForPendingReview` at submission and triage edit). It repairs token grammar only; it does not touch the first letter, the ending or spacing.
- Acceptance copies the review's wording into a new fact row (`ensureStagingFact`); from then the database refuses any change to `facts.text` (trigger `facts_text_is_locked`).
- The duplicate check's exact stage compares text with case, punctuation and spacing ignored, so it is already blind to everything this plan changes.

## Source-of-Truth Analysis
- **The rule:** one pure function, `applyHouseStyle`, beside the token grammar in `lib/api-zod` so the server and the submit page run the same code. No second TypeScript implementation.
- **A fact's wording:** `facts.text`. **Its plain-name version:** `facts.canonical_text`, always what `renderCanonical` gives for the wording.
- **A submission's wording:** `pending_reviews.submitted_text`; `submitted_text_original` stays the wording as typed.
- **The one-time pass** is SQL (the runner takes SQL files), so the rule exists a second time inside that one migration. A test holds the two equal (Testing Plan).

## Proposed Design

### The rule (product semantics; this table is the specification)
Applied in this order. Pure, and applying it twice gives the same result as once.

1. **Spacing.** Trim both ends. Any run of whitespace becomes one space.
2. **Start.** Look at the first character after any opening quote or bracket.
   - A lower-case letter becomes its capital: `chuck norris…` → `Chuck norris…`; `"when…` → `"When…`.
   - `{NAME}` and `{NAME_POSSESSIVE}` are left alone. A lower-case pronoun token becomes its capitalized variant: `{SUBJ}…` → `{Subj}…`.
   - A conjugation pair at the start has both branches capitalized: `{does|do} {SUBJ} ever lose` → `{Does|Do} {SUBJ} ever lose.` This stays inside the existing grammar.
   - A digit or symbol is left alone.
   - A first word with a capital after its first letter is left as written: `iPhone fears {NAME}`, `eBay…` (Q3).
3. **End.** Set aside any closing quotes and closing brackets at the very end; look at the character before them.
   - `.`, `!`, `?` or `…`: nothing changes. `...` counts, since it ends in `.`.
   - `,`, `;` or `:`: replaced by `.` (Q5): `…divide by zero,` → `…divide by zero.`
   - An emoji: nothing changes (Q4): `{NAME} wins 🏆`.
   - Anything else: a `.` is added. It goes inside closing quotes (`said "no"` → `said "no."`) and after a closing bracket (`zero (really)` → `zero (really).`; `("no")` → `("no.")`). It is never placed inside a token: `…beats {NAME}` → `…beats {NAME}.`
   - A final `'` or `’` is a closing quote only when an opening single quote earlier in the wording is still unclosed (`said 'no'` → `said 'no.'`); otherwise it is an apostrophe and the period follows it (`the Joneses'` → `the Joneses'.`).
4. Nothing between the first letter and the ending changes.

### Where it applies
- **I1. Every write of a fact wording runs the rule**: submission, the triage wording edit, and the copy into a fact at acceptance.
- **I2. Fact wording only.** Gag scenes, bubbles and other visual-strategy text that share the tokenizer are not touched.
- **I3. What a person is about to save is shown tidied**: the tokenizer's response for a fact, and the submit page's preview after advanced edits or a restored draft. The text box is not rewritten while they type.
- **I4. The server enforces it** whatever the client sent.

### Two increments, and why
A release's old instances keep serving while its migrations run (`migrations-and-backfills.md`, *Why the previous release matters*). If the pass shipped with the rule, an old instance could accept an untidied submission after the pass and lock it in. So:

- **Increment 1: the rule and the tolerant readers. No stored wording changes.** I1 to I4, plus:
  - **R1.** Every draft-ideas set written from now on records the wording it was made for, and the freshness check uses that record in place of the fact's wording only while the fact's wording is the tidied form of it. Every other freshness input is compared as today.
- **Increment 2: the one-time pass.** Released only where increment 1 is already the running release, so every writer alive during the pass tidies and every reader understands R1. Its PR states that as a release precondition, and its post-release check is a count of facts and awaiting-decision submissions that do not satisfy the rule: zero.

### The one-time pass (increment 2)
One new migration, a `backfill` under the migration policy.
- **M0. Inventory first.** Read from production and development how many facts, awaiting-decision submissions, memes without a frozen caption or baked file, and draft-ideas sets the pass touches. Informational: the design does not depend on it. Currently `unable to verify: these counts; the Repl Agent's read-only production query would settle it and has timed out three times`.
- **M1.** It applies the rule above and nothing else. No grammar repair runs.
- **M2.** It lifts `facts_text_is_locked` for its own update and restores it before the migration's transaction commits; a failure rolls back with the lock in place. After it, an ordinary wording update is refused exactly as before.
- **M3.** The final wording is the authority for `canonical_text`: for every changed fact it equals `renderCanonical(text)`. A null stays null. `split_token_index` and `has_pronouns` do not move (checked by test over the rule's whole table, not assumed).
- **M4. Submissions:** `submitted_text` is tidied for every review still awaiting a decision. Decided reviews and every `submitted_text_original` are history and are not touched.
- **M5. Every fact is tidied. No fact is skipped.** A baked meme image file is never touched and a frozen caption is kept. A meme with neither still reads its fact's live wording, and so shows the tidied wording, like its fact (Q6).
- **M6. Draft gag ideas keep their standing.** The pass records the pre-pass wording on existing idea sets of the facts it changes that lack R1's record; the existing checks then decide. Current sets stay current, stale stay stale, a later real change still stales, and regeneration replaces the record.
- **M7.** Re-running changes nothing. The migration prints counts: facts examined, changed, already tidy; submissions changed; idea sets recorded.
- **Not recomputed:** embeddings. The second duplicate stage is advisory and a capital and a period do not move a similarity meaningfully.

## Data Model and Migration Impact
- One optional field inside the existing ideas blob (R1). No table or column is added.
- Row states after the pass: tidied; already tidy (no write); null canonical (text tidied, canonical left null). No partial state: one transaction.
- Previous release: for increment 2 it is increment 1, which tidies what it writes and reads R1.
- Rollback: the migration is forward-only data. The way back for one fact is a second sanctioned migration; nothing else depends on the old spelling.
- Live counts: M0.

## Runtime Behavior
A submitter types `chuck norris can divide by zero`; the preview, the saved submission, the moderation screen and the eventual fact all read `Chuck norris can divide by zero.` Identical-wording refusal and the duplicate verdict behave as today.

## Admin/User UX Impact
No new screen, state or copy. The preview shows the tidied wording. A triage edit comes back tidied.

## Security, Permissions, and Validation
No route, role or validation change. Length limits are checked on the tidied wording.

## Testing Plan
- **The rule:** every row of the table above, plus idempotence over all of them, in the shared package's tests.
- **Must-not-change:** for every test wording, `duplicateMatchText` is equal before and after the rule; the result still passes `validateTemplate`; `split_token_index` and `has_pronouns` are equal before and after.
- **The pass:** run the migration against seeded rows covering each row state; each changed `text` equals `applyHouseStyle` of the old one, and `canonical_text` equals `renderCanonical` of the new one. The lock refuses an update after a successful run and after a forced failure. A second run writes nothing.
- **Memes:** a baked file and a frozen caption are unchanged by the pass.
- **Ideas:** a current set stays current; a stale set stays stale; a later real input change still stales; regeneration replaces the record; a job that started before the pass and finishes after it yields a current set.
- **Canonical:** equality with `renderCanonical` of the new wording over token-led and token-ended wording.
- **Screen:** the submit preview shows the tidied wording after an advanced edit (browser assertion in the same PR).
- UAT residue: one judgement step, David reads a handful of tidied facts on the site and says whether any reads wrong.

## Implementation Steps
0. M0's inventory.
1. **Increment 1 (its own PR):** `applyHouseStyle` and its tests; the three write paths and the fact tokenizer's response; the submit preview; R1; docs.
2. **Increment 2 (its own PR, after increment 1 is released):** the migration and its tests; `decisions.md` records the lock exception.

## Risks and Mitigations
- **The SQL and the TypeScript rule drift.** The migration test compares them row by row; the SQL is used once.
- **A first word that should stay lower-case and has no inner capital** is capitalized. Accepted: it is the house style.
- **Increment 2 is released together with increment 1** (production takes several merges in one publish). The precondition is in the PR and in the publish check; if it cannot be met, the pass waits for the next publish.

## Questions for David
None open. Q1 to Q6 are answered and recorded in the oracle (David, 2026-11-23 and 2026-11-24).

## Definition of Done
- A lower-case, unpunctuated submission is shown and saved tidied, and becomes a tidied fact.
- After the pass, the count of facts and awaiting-decision submissions that do not satisfy the rule is zero, with each fact's plain-name version in step.
- The wording lock refuses an ordinary edit.
- No baked meme image or frozen caption changed; no current idea set went stale.
- The duplicate check gives the same answers as before.
