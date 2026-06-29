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
  - `attachHashtags` routes its input through the shared sanitizer (kills the old
    underscore-keeping regex drift).
  - approval attaches `resolveTagsForApproval(review.hashtags, enrichment.suggestedHashtags)`.
- `artifacts/overhype-me/src/pages/SubmitFact.tsx` — race-safe pre-fill of the
  Hashtags field (latest-request ref + field-edited ref; functional update so it
  only fills an empty field), "Suggesting tags…" status, updated helper copy.
- `artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx` — review-context
  copy: `suggestedHashtags` labeled fallback-only; user-submitted tags labeled "these ship".

## Commands

```bash
pnpm --filter @workspace/api-server run typecheck     # tsc -b + cycles + no-console
pnpm --filter @workspace/overhype-me run typecheck    # tsc -b

# Touched test files (run against the test DB):
#   src/__tests__/hashtags.test.ts            — sanitizer + resolveTagsForApproval (pure)
#   src/__tests__/routes.ai.test.ts           — suggestHashtagsForText helper + /ai/suggest-hashtags route (test seam, no live OpenAI)
#   src/__tests__/routes.reviews.test.ts      — submit-review ingress sanitization (+ existing approval suite)
#   src/__tests__/factEnrichment.test.ts      — existing stripDeniedHashtags suite (via the re-export)
pnpm --filter @workspace/api-server test      # full sharded suite
```

Local results at authoring time: typecheck clean (both packages); `hashtags.test.ts`
**12 pass / 0 fail** (new); `routes.ai.test.ts` **18 pass** (8 new: 4 helper, 4 route);
`routes.reviews.test.ts` + `factEnrichment.test.ts` together **84 pass** (1 new
ingress test; existing denylist tests still pass via the re-export).

## DB / schema checks

- **No migration, no schema change.** `pending_reviews.hashtags`,
  `hashtags`, and `fact_hashtags` are unchanged; only the *values* written change
  (now normalized at ingress, and submitter-sourced at approval).
- Confirm a submitted-with-tags fact, once approved, has `fact_hashtags` rows
  matching the submitter's normalized tags — **not** the enrichment's
  `suggestedHashtags` — by joining `fact_hashtags` → `hashtags` for the approved fact.
- Confirm a submitted-with-NO-tags fact, once approved, falls back to the
  enrichment's suggested tags (so it is never untagged).

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

- **No moderator override of the final tags** beyond fallback. With submitter
  tags winning, a moderator can't strip an individual user tag at approval (only
  approve/decline the whole fact). A real moderator final-tag editor (pre-seeded
  from the submitter) is a flagged follow-up, pending David's call.
- No suggestions for admin direct-insert (`POST /facts`) or bulk import — those
  keep their current normalization (future consistency follow-up).
- No suggestion-on-restore for a restored draft landing on Preview, and no
  historical backfill of already-approved facts.
