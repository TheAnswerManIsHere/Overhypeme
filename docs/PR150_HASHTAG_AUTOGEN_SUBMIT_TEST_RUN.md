# PR150 — AI-suggested hashtags on fact submission (that survive approval) — Test Run (Replit)

Engineering / automated checklist. In-app click-through: `PR150_HASHTAG_AUTOGEN_SUBMIT_UAT.md`.

## What this PR does

Auto-fills the **Submit-a-Fact** screen's (previously manual-only) Hashtags field
with AI suggestions when the user reaches the Preview step, and makes the
**submitter's tags the source of truth** at moderation approval. Previously the
background enrichment's `suggestedHashtags` *overrode* whatever the user typed;
now they're a **fallback** used only when the submitter left no valid tags.

Goal: every new fact ends up with good discovery tags with minimal user effort,
and a submitter's chosen tags survive onto the live fact.

## Where the change lives

- `artifacts/api-server/src/lib/hashtags.ts` **(new, server-only)** —
  - `sanitizeHashtagsForPersistence(tags, { limit })`: string-only → trim →
    `normalizeHashtag` → drop empty → `stripDeniedHashtags` → dedupe (first-seen)
    → cap. `limit` is required (no hidden default).
  - `resolveTagsForApproval(reviewHashtags, enrichmentHashtags)`: sanitizes BOTH
    sources, returns submitter tags when non-empty, else enrichment fallback.
  - The subject/app-name denylist (`stripDeniedHashtags`) **moved here** from
    `factEnrichment.ts`.
- `artifacts/api-server/src/lib/factEnrichment.ts` — denylist constants removed;
  `stripDeniedHashtags` now imported from `./hashtags` and **re-exported** (so
  existing importers, incl. `factEnrichment.test.ts`, are unaffected).
- `artifacts/api-server/src/routes/ai.ts` —
  - `suggestHashtagsForText(text, callModel = callUtilityLLM)` (exported, pure):
    `renderCanonical` → prompt → parse → `sanitizeHashtagsForPersistence({limit:6})`.
    Always returns an array; never throws.
  - `__setSuggestHashtagsForTest(fn)` test seam (mirrors `__setPlanGeneratorForTest`).
  - `POST /ai/suggest-hashtags` (mounted at **`/api/ai/suggest-hashtags`**):
    `requireAuth` + `createRateLimiter("ai_suggest_hashtags", 20, RATE_WINDOW_MS)`.
    `400` bad body · `401` unauthed · `200 { hashtags: [] }` on model failure.
- `artifacts/api-server/src/routes/reviews.ts` —
  - submit-review ingress sanitizes `hashtags` before storing on the review.
  - approve bodies (`approve-for-production` / `approve` / `approve-variant`) gain
    an optional `hashtags` (the moderator's curated FINAL list).
  - approval resolves the final list via `resolveFinalApprovalTags` (approve-body
    wins when present, else `resolveTagsForApproval` fallback), **rejects with
    `400 / HASHTAGS_REQUIRED` before any mutation** when it's empty, and
    `attachHashtags` runs **inside the activation transaction** (executor param) so
    a fact is never live-but-untagged. The approve response returns the attached
    tags.
- `artifacts/overhype-me/src/pages/SubmitFact.tsx` — race-safe pre-fill of the
  Hashtags field (latest-request ref + field-edited ref; functional update so it
  only fills an empty field), "Suggesting tags…" status, updated helper copy.
- `artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx` — **review
  mode** (when `onFinalHashtagsChange` is passed) renders an editable
  **"Final hashtags — these ship"** list + read-only **"AI suggested"** source
  chips (`+ add` / Add all); the editable `suggestedHashtags` editor shows only on
  the live Facts page.
- `artifacts/overhype-me/src/pages/admin/moderation.tsx` — `finalHashtags` state
  (separate `finalHashtagsDirtyRef`) seeded from the submitter's tags, else the AI
  suggestions (re-seeds when enrichment arrives late, until edited); sent in every
  approve body; Approve is **disabled with a warning when the final list is empty**.

## Commands

```bash
pnpm --filter @workspace/api-server run typecheck     # tsc -b + cycles + no-console
pnpm --filter @workspace/overhype-me run typecheck    # tsc -b

# Touched test files (run against the test DB):
#   src/__tests__/hashtags.test.ts            — sanitizer + resolveTagsForApproval + resolveFinalApprovalTags (pure)
#   src/__tests__/routes.ai.test.ts           — suggestHashtagsForText helper + /ai/suggest-hashtags route (test seam, no live OpenAI)
#   src/__tests__/routes.reviews.test.ts      — submit-review ingress sanitization (+ existing approval suite)
#   src/__tests__/factEnrichment.test.ts      — existing stripDeniedHashtags suite (via the re-export)
pnpm --filter @workspace/api-server test      # full sharded suite
```

Local results at authoring time: typecheck clean (both packages); `hashtags.test.ts`
**18 pass / 0 fail** (12 sanitizer/precedence + 6 `resolveFinalApprovalTags`);
`routes.ai.test.ts` **18 pass** (8 new: 4 helper, 4 route); `routes.reviews.test.ts`
+ `routes.ai.test.ts` together **70 pass** (incl. the new ingress test).

The approve-time required-hashtags gate is covered by `resolveFinalApprovalTags`
unit tests (present-empty → empty → caller 400; present-denied-only → empty;
absent → fallback; absent-with-nothing → empty). The full approve **route** path
(production_review + staging fact + render waiver) is not unit-covered — the
existing suite deliberately omits it — so the gate + in-transaction attach are
verified via these unit tests + the UAT click-through.

## DB / schema checks

- **No migration, no schema change.** `pending_reviews.hashtags`,
  `hashtags`, and `fact_hashtags` are unchanged; only the *values* written change
  (now normalized at ingress, and submitter-sourced at approval).
- Confirm an approved fact's `fact_hashtags` rows match the **moderator's final
  list** sent in the approve body (join `fact_hashtags` → `hashtags`).
- Confirm a fact **cannot be approved with an empty final list** — the approve
  request returns `400 / HASHTAGS_REQUIRED` and the staging fact stays inactive
  (`facts.is_active = false`, review still `production_review`).
- Confirm a submitted-with-NO-tags fact seeds the moderator's list from the AI
  suggestions (so the moderator can approve immediately).

## Gotchas

- `suggest-hashtags` is a deliberate, **non-blocking pre-submit** affordance
  (like tokenize / duplicate-check), NOT moderation prep — it does not enqueue
  any paid enrichment/Pexels work. The COST GATE test still holds.
- The frontend pre-fills the Hashtags field **only when it is empty and the user
  hasn't edited it**, and ignores stale/superseded responses — verify by typing a
  tag immediately after Preview (the AI response must not overwrite it).
- Normalization now unifies on `normalizeHashtag` (strips underscores too).
  `attachHashtags`'s old `[^a-z0-9_]` regex (which kept underscores) is gone.

## Deliberately not shipped

- No per-chip AI-vs-user provenance badges (provenance doesn't matter to the
  outcome; the two-list layout already shows the sources).
- No suggestions for admin direct-insert (`POST /facts`) or bulk import — those
  keep their current normalization (future consistency follow-up).
- The final-hashtags editor lives inside Advanced Options for now (not a
  top-level production-review field — future polish).
- No suggestion-on-restore for a restored draft landing on Preview, and no
  historical backfill of already-approved facts.
