# Plan — Duplicate checker: triage shows a verdict, not a similarity score

Workstream: #1003

```plan-oracle
# Oracle — duplicate-verdict (agreed with David, 2026-11-17; workstream #1003)

## Direction
Moderation's triage gate is the cheap human first pass (docs/ai-context/glossary.md, Triage). Its duplicate context must be trustworthy enough that a moderator can act on it at a glance.

## Product intent (this increment)
A moderator at triage sees whether the submission duplicates an existing fact as a verdict ("Duplicate of #N" / "Not a duplicate" / "Couldn't check"), not as a raw similarity percentage presented as a likelihood. The motivating case: "{NAME} can hear sign languages" vs "{NAME} can hear sign language." shown at 77% "Duplicate Likelihood" and nearly hidden by the 80% threshold.

## Agreed scope (David approved 2026-11-17, verbatim from the chat)
1. The LLM verdict becomes what triage shows: "Duplicate of #N" or "Not a duplicate", stored on the review. The similarity number drops to small print or disappears.
2. Widen the exact-match shortcut to ignore punctuation, so trivially identical wording is caught for free.
3. The "flag threshold %" setting stops driving whether the match is shown; the verdict does. The 65% floor that decides what the LLM looks at stays as an internal constant.
4. Unchanged: detection stays advisory and never blocks a submission.
Plus, taken on my recommendation in that message: when the LLM call fails, the screen says "couldn't check" and shows the nearest match, instead of guessing from the number.

## Must not change
- Detection is advisory; it never blocks or auto-rejects a submission.
- Two stages: vector recall (top 5, floor 0.65) then one LLM call; LLM cost per submission stays bounded regardless of catalogue size.
- The bulk-import exact-text dedupe (glossary: Exact-text dedupe) keeps its own behaviour.
- A triage wording edit is compared with other content, never with itself.

## Settled in conversation
- Keep cosine similarity as the recall filter; the LLM is the precision judge (David asked, I recommended, he approved).
- No vector index now; at 10k facts a sequential scan is cheap. Revisit at hundreds of thousands.

## Ceremony tier
Product code, production phase, with a schema migration (migration review applies).
```

## Problem

Review #6897, "{NAME} can hear sign languages", showed **Duplicate Likelihood: 77%** against "{NAME} can hear sign language." It came within 3 points of being hidden behind the 80% threshold. The number is embedding cosine similarity (`routes/ai.ts:301`, `Math.round(best.similarity * 100)`), and that is not a probability. The checker already asks an AI model "same fact or joke?" on every submission whose nearest match clears 0.65, but the answer is never stored on the review: `routes/reviews.ts:198-205` saves only the match and the percentage, and `routes/reviews.ts:903` keeps only the percentage.

## Direction

The triage gate (glossary, *Triage*) should let a moderator decide in seconds. This increment makes its duplicate signal a judgement the moderator can trust, instead of a number they have to interpret.

## Product Intent

Wherever a duplicate signal appears (the triage modal, the moderation queue row and the submit page), it is the AI's verdict on the exact wording being judged, computed by the server. It shows one of five states:

- **Duplicate of #N**: the matched fact, with a link.
- **Duplicate of pending review #N**: matches a submission still awaiting a decision.
- **Not a duplicate**: the closest fact is available behind "Show closest fact".
- **Couldn't check**: the AI step failed; the closest fact is shown straight away when the search found one.
- **Not checked yet**: no result exists for this wording, such as a review from before this change or a bulk import. A stored *Duplicate* whose target no longer supports it reads the same way and is rechecked (see *Stale matches*).

No raw percentage is shown anywhere.

## Must Not Change

- Detection is advisory. Nothing here blocks, delays or auto-rejects a submission; the moderator decides.
- The two-stage shape and its bounds: top-5 vector recall, a 0.65 floor for what reaches the AI, and one batched AI call per check.
- Bulk import's exact-text dedupe (glossary, *Exact-text dedupe*) keeps its own normalization and skip behaviour.
- A triage wording edit is compared with other content, never with its own review. A matching *other* pending review still counts (`__tests__/reviewWording.test.ts:103-112`).
- Wording is locked once a review is accepted (`reviewWording.ts`, `assertAtTriage`), and a duplicate check never edits wording.

## Settled Decisions

- **Two stages stay** (David, 2026-11-17): vector search is for recall and the AI is for precision. No vector index at today's scale.
- **The result is server-owned** (Astra S1). The server ignores any match, similarity or verdict sent by a browser. The submission schema still *accepts* those optional fields, so an older open tab does not get a 400, but they are discarded.
- **A result belongs to one wording.** It is written only if the review's wording is still the wording that was checked. A wording edit replaces wording and result in one transaction.
- **Stale matches are never shown as valid** (Astra R1). A stored *Duplicate* is displayed only while its target still supports it:
  - a pending-review target must still be a pending triage review whose current wording still matches under the same normalization;
  - a fact target must still exist and be active.

  Otherwise the queue row, the modal and the check response all present it as *Not checked yet*, and opening it rechecks. This applies whether the target changed before or after the check finished.
- **Three outcomes plus absence** (Astra S2):
  - *Duplicate* comes from an exact match (fact or pending review), or from a validated positive AI answer that names one of the supplied candidates.
  - *Distinct* comes from a validated negative AI answer, or from a successful search with no candidate at or above 0.65.
  - *Unavailable* covers a failed embedding, a failed search, a failed AI call, or a malformed AI answer (missing or non-boolean verdict, or a positive verdict without a valid candidate index).
  - *Not checked* (no row value) never reads as Distinct.
  - The 0.75 vector-only fallback is retired, since it guessed.
- **Exact match ignores punctuation and runs of whitespace** as well as case. Template tokens (`{NAME}`, `{does|do}`) keep their meaning: braces and the pipe are not punctuation for this purpose. This normalization lives only inside the duplicate check; bulk import's dedupe is untouched. Singular/plural and other rewordings stay with the AI judgement; no stemming.
- **The "Duplicate Flag Threshold (%)" setting is retired** (scope item 3). It no longer gates the modal, the queue row or the submit page, and the config key is removed from the seed, the admin Configuration list and the database.
- **Affected-surface inventory.** The class is "every reader or writer of the review's duplicate match, and every consumer of the duplicate threshold". The oracle: `git grep -n -E "matchingSimilarity|matching_similarity|review_duplicate_threshold|duplicateThreshold|checkDuplicateInternal|isDuplicate"` on this branch, excluding migration snapshots. It found:
  - writers: `routes/reviews.ts` (submit, wording adapter) and `lib/moderationStaging.ts` (`createTriageReview`), which is also called by `routes/admin.ts:1489` and `routes/import.ts:140`, both writing no match;
  - the detector: `routes/ai.ts`;
  - readers: `pages/admin/moderation.tsx` (modal and queue rows) and `pages/SubmitFact.tsx`;
  - the config: `lib/seed.ts`, `pages/admin/config.tsx` and `__tests__/codeOwnedPrompts.test.ts`;
  - test fixtures: the acceptance driver and the e2e stubs.

  The implementation re-runs the oracle and works from its output.

## Repo Context Inspected

- `artifacts/api-server/src/routes/ai.ts` (detector, `/ai/check-duplicate`)
- `artifacts/api-server/src/lib/embeddings.ts` (`findSimilarFacts`, no index)
- `artifacts/api-server/src/routes/reviews.ts` (submit, wording route)
- `artifacts/api-server/src/lib/reviewWording.ts` (`editTriageWording`)
- `artifacts/api-server/src/lib/moderationStaging.ts` (`createTriageReview`)
- `artifacts/api-server/src/routes/import.ts` and `routes/admin.ts` (bulk import paths)
- `lib/db/src/schema/reviews.ts`
- `artifacts/overhype-me/src/pages/admin/moderation.tsx` and `pages/SubmitFact.tsx`
- `docs/ai-context/glossary.md` (*Duplicate detection*, *Exact-text dedupe*, *Triage*)
- `docs/ai-context/decisions.md` (no fact-to-fact linking; a near-duplicate is rejected or accepted on its own)

## Current Behavior

- The submit form debounces a call to `/ai/check-duplicate` and sends `matchingFactId`, `matchingSimilarity` and `isDuplicate` with the submission. These values are client-supplied and may be for earlier wording, or missing if the user submits first.
- The server stores the first two and uses `isDuplicate` only in the submitter's activity message.
- Triage shows the percentage and shows the match only at ≥ threshold (80) or on a click.
- The queue row shows "N% match" only at ≥ threshold.
- A triage wording edit re-runs the check server-side but keeps only the percentage.
- Bulk imports get no check at all.

## Source-of-Truth Analysis

- **The duplicate result:** the review row's result columns are the single source. They are written only by the server's check for the review's current wording. The submit page's live warning remains a preview computed from the same detector, not stored.
- **The wording:** `pending_reviews.submitted_text`, unchanged. The result is valid only alongside the wording it was computed for, enforced by the conditional write.
- **No new duplicate source is created.** The old percentage column stays as a stored detail (the queue and modal stop showing it). Dropping it is *next*.

## Proposed Design

1. **One result contract** from the detector: outcome (duplicate / distinct / unavailable), and when known, the matched or nearest fact id, the matched pending review id, and the similarity. `/ai/check-duplicate` returns it, so the submit page uses the same states. Its outer failure returns *unavailable*, never "not a duplicate".
2. **One server operation, "check this review's wording"**:
   - It reads the review's current wording and runs the detector, excluding the review itself.
   - It writes the result only if the wording is unchanged and the review is still at triage.
   - It is idempotent: re-running it on the same wording overwrites the result with a fresh one and never changes wording or stage.

   Three triggers call it:
   - **After a user submission commits.** It is fire-and-forget, so the submitter's response never waits on the AI (scope item 4).
   - **Inside a triage wording edit.** The check runs before the transaction, as today, and the result is written with the new wording under the review lock.
   - **On demand from triage.** An admin-only endpoint runs it when the modal opens a review whose state is *Not checked yet* or *Couldn't check* (Q1). A *Couldn't check* result is retried each time it is opened.
3. **The submitter's activity message** uses the existing neutral submission wording (Astra R3). The server's verdict does not exist at insert time, and a browser-derived claim could contradict it.
4. **A displayed verdict belongs to the displayed wording** (Astra R3).
   - On the submit page, the preview belongs to the current input. Changing the text or the advanced template invalidates the previous preview, and a late response never replaces a newer one.
   - In the modal, the verdict belongs to the saved wording. Loading detail refreshes it, a completed on-demand check updates the modal and the queue, and a response superseded by a wording save cannot restore the old match.
5. **The API contract** for the duplicate response and the review's result fields (including the wording-saved response) is updated in the OpenAPI spec, and the generated client and schema are regenerated from it.
6. **UI** per *Admin/User UX Impact* below.

## Data Model and Migration Impact

New migration (next free number) on `pending_reviews`:

- `duplicate_outcome`: a nullable enum `duplicate | distinct | unavailable`. Null means not checked.
- `matching_review_id`: a nullable integer, FK to `pending_reviews(id)` `ON DELETE SET NULL`.
- `duplicate_checked_at`: a nullable timestamp.
- The `review_duplicate_threshold` row is deleted from `admin_config`.

No backfill. Every existing row stays null and reads *Not checked yet*. It is never inferred from `matching_similarity`, including 0 (Astra S3).

Row-state matrix:

| Row | After migration |
|---|---|
| old | null outcome, reads *Not checked yet* |
| new | written by its trigger |
| partial | the async check never landed, so it stays null and the on-open check covers it |
| failed | *unavailable*, retried on open |
| skipped | the review left triage before the check finished, so the conditional write writes nothing |
| no-op | wording edited back to the same text: unchanged, as today |

**Rollback:** the old code ignores the new columns, and the config row is reinserted by the seed if the old code runs. The migration is additive except that one row delete.

## Runtime Behavior

- An exact match (case, whitespace and punctuation ignored) against an active fact or another pending review gives *Duplicate* with no AI call.
- Otherwise the server embeds, takes the top 5 and sends the candidates at or above 0.65 to the AI:
  - a validated positive answer gives *Duplicate* of the indexed candidate;
  - a validated negative answer gives *Distinct* with the nearest fact kept;
  - none at or above 0.65 gives *Distinct*;
  - any failure or malformed answer gives *Unavailable*, keeping the nearest fact if the search succeeded.
- If a wording edit lands while an async check for the old wording is in flight, the old check writes nothing.
- If the review is accepted or rejected before the async check finishes, the check writes nothing.
- If the matched fact is later deleted or deactivated, or the matched pending review is edited, resolved or rejected, the result reads *Not checked yet* and is rechecked on open (*Stale matches*). This replaces today's "Original fact no longer available" branch, which after the FK nulls the id actually falls into the pending-submission message.

## Admin/User UX Impact

- **Triage modal:** "Duplicate Likelihood: 77%" is replaced by a verdict line with the per-state copy from *Product Intent*. The match panel shows the matched item on *Duplicate*. On *Couldn't check* it shows the nearest fact immediately when the search found one, with "Try again", and the fact stays visible while retrying (Astra R2). On *Distinct*, "Show closest fact" is offered. *Not checked yet* triggers the check and shows "Checking for duplicates…". If that request fails, the modal shows *Couldn't check* with a "Try again" button (async status rule).
- **Queue row:** a "Possible duplicate" label on *Duplicate*, with the matched text beneath as today. Nothing on other states.
- **Submit page:** the warning shows when the preview outcome is *Duplicate* (previously at ≥ threshold). The text no longer quotes a percentage. *Couldn't check* shows no warning, matching today's silent failure.
- **Admin Configuration:** the "Duplicate Flag Threshold (%)" entry disappears.

## Security, Permissions, and Validation

- The on-demand check endpoint is `requireAdmin`, rate-limited like the other paid AI admin actions, and takes only a review id.
- Client-supplied match fields are discarded server-side. This closes today's path where a submitter could choose the match shown to moderators.
- The AI's answer is validated before it can produce *Duplicate* or *Distinct*.

## Testing Plan

**Automated tests:**

- Detector contract: every outcome path, including malformed answers (`{}`, a non-boolean verdict, a positive answer with a missing or out-of-range index), an embedding failure, and no candidates at or above 0.65.
- Exact match: punctuation, whitespace and case variants match; a token-different template does not.
- Pending-review self-exclusion is preserved.
- Submit route: client fields are ignored and the async check writes. A stale check skips after a wording edit, and skips after the review leaves triage.
- Wording edit: replaces wording and result together.
- On-demand endpoint: admin-only, and *Not checked yet* becomes a result.
- UI component tests: each of the five states in the modal and queue row, and the submit warning on *Duplicate* only.
- The migration applies to a database with existing reviews; every existing row reads null.
- The upgrade rehearsal lists the `review_duplicate_threshold` deletion as its one permitted settings change, still protects every other setting, and passes on a snapshot with the key and on one without it (Astra R4).
- Stale matches: a pending target edited before, and after, the check finishes; a fact target deleted. None displays a valid *Duplicate* of unrelated wording.
- Browser state: out-of-order preview responses; an advanced-template edit invalidating the preview; an on-demand check overlapping a wording save.
- A *Couldn't check* result with a nearest fact below the old 80% shows that fact without a click.

**Live check, post-merge (a few cents of AI calls):** run the real detector so it actually reaches the AI step, excluding the existing pending Review #6897 so the exact shortcut cannot answer:
- the motivating pair ("{NAME} can hear sign languages" vs "{NAME} can hear sign language."), similarity around 77%: expected *Duplicate*;
- a pair above 80% similarity that is a different joke: expected *Distinct*.

Together they show similarity no longer decides. Mocks prove the wiring; this proves the model's judgement.

**UAT (judgement only):** open Review #6897 and a clearly different submission; read whether the verdict lines tell you what to do at a glance.

## Docs

The current descriptions of duplicate detection are updated in the same PR: the glossary (*Duplicate detection*), the moderation workflow doc, the admin configuration doc and the content-lifecycle Manual chapter.

## Rollout

One PR. No feature flag.

## Next (recorded, not in this plan)

- Drop the `matching_similarity` column.
- Run the check at bulk-import time if Q1's on-open approach proves slow in practice.
- Have the AI stage also consider pending reviews, not only exact matches.
- Add a vector index at hundreds of thousands of facts.

## Questions for David

**Q1. When do reviews that have no verdict get checked?** This covers the ~44 already in the queue (there is no stored verdict to recover) and every bulk import (today they get no check at all).

1. **On first open of the review at triage** (recommended). The modal shows "Checking for duplicates…" for a second or two the first time, then stores the result. The cost is one cheap AI call only for reviews someone actually looks at. The queue list shows no verdict for these until opened.
2. **Ahead of time.** A one-off background run checks every review currently at triage (not inside the database migration), and bulk import checks each imported fact as it lands. The queue shows verdicts immediately. The cost is one AI call per imported fact, including ones later rejected for other reasons, and a slower import.

Recommendation: 1. It pays only for checks a moderator actually uses. The same path also retries *Couldn't check*; each retry is a fresh, cheap AI call.

**Answered (David, 2026-11-17): 1** — on first open at triage.
