# PR #256 — Variant independence — UAT

Your in-app acceptance test, David. This is the fix for the rule you stated:
*"the only thing that we should be doing with variants is tracking them as
having a parent-child relationship to the master fact… I don't want them to
be dependent upon their parents for any metadata."* A variant now has its own
memes, its own visual taxonomy/enrichment, its own Visual Concept, its own
stock/AI images — none of it borrowed from or blocked by its root anymore.

## Setup

None.

## Steps

### 1. A variant with no images of its own now shows none — not the root's

**Do:** Find (or create) a variant of a fact whose root has Pexels/AI-meme
images, but which itself has never generated its own images, and open its
fact page / meme builder.

**Expect:** No stock/AI images show for the variant — not the root's. This
is correct, intended behavior: it means the variant hasn't been backfilled
yet (see step 8), not that something is broken.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.facts.test.ts:a variant with no images of its own shows none — it does NOT inherit its root's pexelsImages/aiMemeImages (variant independence)`; `artifacts/overhype-me/e2e/publicScreens.spec.ts:a variant with no images of its own shows no AI images on its fact page or in its meme builder`

**Deferred:** #628 — Phase 4 (Cut and prune) — the variant's stock images are Pexels images, removed with Pexels, so the no-stock-images half goes with it

### 2. A variant's Pexels panel is now visible in the Facts editor

**Do:** Open a variant (not a root) in the admin Facts editor.

**Expect:** The "Pexels Image Pipeline" panel is visible and usable for the
variant — previously it was hidden entirely, root-only.

**Lane:** scripted

**Deferred:** #628 — Phase 4 (Cut and prune) — the Pexels Image Pipeline panel is Pexels and is removed with it, so it is not scripted now

### 3. A variant can refresh its own images

**Do:** Click "Refresh images" on the variant from the previous step.

**Expect:** It succeeds and generates the variant's own stock images,
independent of its root's.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:a variant (parentId set) is accepted — images are no longer root-only (variant independence)`

**Deferred:** #628 — Phase 4 (Cut and prune) — the variant's own stock images are Pexels images, removed with Pexels, and the cited check shows the request is accepted but not that images were generated

### 4. A variant can generate its own AI meme background

**Do:** As a legendary user, try generating an AI meme background for a
variant fact.

**Expect:** It's accepted and generates — previously rejected with "AI meme
generation only supported on root facts."

**Lane:** scripted

**Check:** `artifacts/api-server/src/__tests__/memesGenerateGeneric.test.ts:a variant (parentId set) is accepted — AI image generation is no longer root-only (variant independence)`

**Deferred:** #631 — 7b — the paid user's POST /memes/ai/:id/generate on a variant fact reaches image_ready and the owner reads its generated image back — acceptance journey 6

### 5. Editing a root's text no longer blocks on its variants

**Do:** Edit a root fact's text (with the confirmation phrase) while one of
its variants has an unresolved review or an active enrichment job in flight.

**Expect:** The root edit goes through immediately — it's no longer blocked
waiting on the variant.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/confirmedFactTextEdit.test.ts:does NOT block a root edit when a child is mid-review`

**Deferred:** #631 — 7b — a confirmed PATCH /admin/facts/:id text edit on a root returns 200 and stores the new text while its variant has a pending review or a nonterminal enrichment job — `artifacts/api-server/src/__tests__/routes.admin.test.ts`

### 6. Editing a root's text no longer marks its variants stale

**Do:** After the edit in the previous step, check the variant's own
enrichment / `stale_for_reprocess` state.

**Expect:** It is untouched by the root edit. Previously, a confirmed root
edit would mark every child variant stale, forcing them to re-enrich for no
reason.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/confirmedFactTextEdit.test.ts:does NOT clear child variant signatures on a confirmed root edit`

**Deferred:** #631 — 7b — after a confirmed PATCH /admin/facts/:id text edit on a root, each variant's lastProcessedSignature and enrichment are unchanged and it is not stale for reprocess — `artifacts/api-server/src/__tests__/routes.admin.test.ts`

### 7. Bulk Media Backfill panel is on Taxonomy Health

**Do:** Go to Admin → Taxonomy Health.

**Expect:** A new "Bulk Media Backfill" section appears near the top, with
three buttons: Backfill images, Backfill Pexels, Backfill AI memes. It's
visible regardless of which health card filter is selected.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkMediaBackfill.test.tsx:is visible regardless of the selected card filter (not gated like send-back)`

**Deferred:** #628 — Phase 4 (Cut and prune) — two of the panel's three buttons (Backfill images, Backfill Pexels) drive Pexels and go with it, which rewrites this step, and the cited test also never selects a card filter; #631 — 7b — the bulk-media-backfill-panel renders above the health cards and still renders, with its Backfill AI memes button, after a different card filter is selected — `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkMediaBackfill.test.tsx`

### 8. Backfill images enqueues durable jobs

**Do:** Click "Backfill images".

**Expect:** A confirmation dialog appears; confirming enqueues durable jobs
for every active fact (root or variant) missing images, and a live status
line shows "N of M done" as jobs complete.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkMediaBackfill.test.tsx:'Backfill images' confirms before firing and posts to backfill-images`

**Deferred:** #628 — Phase 4 (Cut and prune) — Backfill images is Pexels image prep and goes with Pexels, and the cited check shows the confirm and the POST, not the enqueue for every active fact missing images

### 9. Re-clicking Backfill images while jobs run is safe

**Do:** Re-click "Backfill images" while jobs from the previous step are
still running.

**Expect:** It's safe — already-queued facts dedupe onto their existing job
rather than double-running.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/factPexelsJobs.test.ts:is stable per fact id`

**Deferred:** #628 — Phase 4 (Cut and prune) — the dedupe is on the Pexels job queue, removed with Pexels, and the cited check asserts only the dedupe key format

### 10. Backfill AI memes follows the same pattern

**Do:** Click "Backfill AI memes" and confirm.

**Expect:** The same confirm → enqueue → live status pattern as Backfill
images; the confirmation message notes this one calls paid OpenAI/fal.ai
APIs.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkMediaBackfill.test.tsx:'Backfill AI memes' posts to backfill-ai-memes`

**Deferred:** #631 — 7b — the AI memes confirmation names the paid OpenAI and fal.ai calls and its status line reads N of M done like Backfill images — `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkMediaBackfill.test.tsx`; #631 — 7b — clicking Backfill AI memes calls window.confirm before any POST to backfill-ai-memes, and declining that confirm sends nothing — `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkMediaBackfill.test.tsx`; #631 — 7b — POST /admin/facts/backfill-ai-memes as admin enqueues one durable job per active fact, root or variant, missing AI meme images — `artifacts/api-server/src/__tests__/routes.admin.auth.test.ts`

### 11. A root with an active variant can be sent back to review

**Do:** Find a root fact that's stale for reprocess (Taxonomy Health →
"Stale for reprocess" card) and has an active variant, then click "Send
back to review" on that root.

**Expect:** It succeeds — sending a root back to review no longer requires
touching its variants first, since the root's refresh can no longer
invalidate them. (Previously this failed with "This fact has active
variants. Refresh the variants individually instead of the root.")

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts:selected: a stale root with an active variant still enqueues — variants classify from their own text, so a root refresh can't invalidate them`; `artifacts/api-server/src/__tests__/factSendBackJob.test.ts:succeeds for a root with an active variant — variants classify from their own text, so a root refresh can't invalidate them` asserts the queued send-back job opens a refresh candidate for that root; `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkSendBack.test.tsx:the unified single-row 'Send back to review' posts through the bulk-send-back endpoint (not the old Facts-editor endpoint)` asserts the row button's route

### 12. Bulk send-back now picks up roots with active variants

**Do:** Click "Send next 50 stale" (the corpus-wide bulk button).

**Expect:** It now picks up roots with active variants too, instead of
silently skipping them forever.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts:all_stale: a stale root with an active variant is eligible — variants classify from their own text, so a root refresh can't invalidate them`

**Deferred:** #631 — 7b — POST /admin/taxonomy-health/actions/bulk-send-back with scope all_stale, not only pickSendBackTargets, enqueues a stale root that has an active variant — `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts`

### 13. Repeated-failure protection flags a fact after 3 failures

**Do:** Find a fact whose send-back has failed 3 times in a row (uncommon
in normal use — most testers won't hit this naturally) and look at its
Taxonomy Health row.

**Expect:** It shows a "3 failed attempts" badge next to the send-back
button, and it's no longer picked up by "Send next 50 stale" automatically.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts:all_stale: a 3-strike fact is excluded and counted in repeatedFailureCount; scope:selected still enqueues it normally (the only path that clears the streak)`

**Deferred:** #631 — 7b — a fact flagged after 3 failed send-backs shows the 3 failed attempts badge beside its send-back button — `artifacts/overhype-me/src/pages/admin/taxonomy-health.rows.test.tsx`; #631 — 7b — POST /admin/taxonomy-health/actions/bulk-send-back scope all_stale leaves out a 3-strike stale fact that would otherwise fall within its 50-fact batch, so the cap cannot hide a regression — `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts`

### 14. A flagged fact can still be retried deliberately

**Do:** Check that fact's row box and use "Send selected".

**Expect:** It works normally, with no special rejection — this is the only
way to clear the flag.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts:all_stale: a 3-strike fact is excluded and counted in repeatedFailureCount; scope:selected still enqueues it normally (the only path that clears the streak)`

**Deferred:** #631 — 7b — a row flagged for repeated failures can be ticked and Send selected posts its fact id with no rejection shown — `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkSendBack.test.tsx`; #631 — 7b — once the fact_send_back job Send selected queued for a 3-strike fact finishes, GET /admin/taxonomy-health/facts reports repeatedFailure false for it — `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.actions.test.ts`

### 15. Bulk send-back reports any facts it excluded

**Do:** Run "Send next 50 stale" when it would exclude any facts under
repeated-failure protection.

**Expect:** The status line calls it out explicitly ("N fact(s) excluded
after repeated failures — investigate before considering the migration
complete") so it's never silently missed.

**Lane:** ci

**Deferred:** #631 — 7b — the Send next 50 stale status line reads N fact(s) excluded after repeated failures, investigate before considering the migration complete — `artifacts/overhype-me/src/pages/admin/taxonomy-health.bulkSendBack.test.tsx`

## Regression

### R1. Root fact images, memes, and enrichment are unchanged

**Do:** Check images, memes, and enrichment for a root fact.

**Expect:** Unchanged — still works exactly as before.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 3: the baseline fact is tokenised, enriched, given a saved Visual Concept and review renders, then approved to an active fact; journey 6: its AI image generates and a private meme saves from it; journey 4: a public photo meme saves from it

**Deferred:** #628 — Phase 4 (Cut and prune) — a root fact's Pexels stock images are removed with Pexels, while enrichment and memes are the journeys cited

### R2. The public fact feed / detail page for roots is unchanged

**Do:** View the public feed and detail page for a root fact.

**Expect:** The feed lists the root fact as a card with its text and
hashtags. Its detail page shows the fact card (text, hashtags, votes), the
"Make a meme of this" button, "Memes from this fact" with its total, the
Community tab, the All / Images / Videos filters and the Sort control, the
fact's memes, the Comments section, "Alternate phrasings" listing its
variants, and "More facts you'll like". It shows no "Variant of" banner, no
error, and still returns its own AI meme images.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.facts.test.ts:returns the fact, its rank, and link/variant arrays on success`; `artifacts/overhype-me/e2e/publicScreens.spec.ts:the public feed and a root fact's detail page show every section`

**Deferred:** #631 — 7b — a root fact's detail still returns its own AI meme images unchanged — `artifacts/api-server/src/__tests__/routes.facts.test.ts`

### R3. Send-back for a root with no variants is unchanged

**Do:** Send a root fact with no variants back to review.

**Expect:** Unchanged.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.sendBackToReview.test.ts:starts a refresh cycle: candidate + new review, createdBy = the admin, ids echoed`

### R4. Single-fact "Refresh images" on a root is unchanged

**Do:** Click "Refresh images" on a single root fact (not the bulk panel).

**Expect:** Unchanged.

**Lane:** scripted

**Deferred:** #628 — Phase 4 (Cut and prune) — the single-fact Refresh images button and route are Pexels and are removed with it

### R5. The Facts editor for a root fact is unchanged

**Do:** Open the Facts editor for a root fact.

**Expect:** The editor opens headed "Edit fact #N" with its fields: ID,
created and updated dates, caption split, text, upvotes, downvotes, score,
Wilson score, comment count, share count, parent ID (blank for a root), use
case and submitted-by ID. Below them: Variants with its count, the Visual
Taxonomy Enrichment, Enrichment Version History, Approved text edit history
and Prompt Diagnostics sections, and the Save Changes, Discard, Cancel, Send
Back to Review and Delete Fact buttons. No error shows.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts` — the Admin · Facts route loads without a crash or reload loop (list page only, no fact opened); `artifacts/overhype-me/e2e/adminScreens.spec.ts:the Facts editor opened on a root fact shows its usual panels and fields with no error`

## Not bugs

- **A variant may show no images until you (or a bulk backfill) explicitly
  generate them.** This is the correct, intended change — a variant no
  longer silently borrows its root's images. Run "Backfill images" /
  "Backfill Pexels" from the Bulk Media Backfill panel to catch existing
  variants up.
- **The v6→v7 enrichment prompt-version bump** means every fact — root or
  variant — is now "stale for reprocess" until it's sent back through
  moderation again (send-back → promote). This is expected and is exactly
  what "Send next 50 stale" is for; run it repeatedly until `queued: 0`,
  `failed: 0`, `eligibleRemaining: 0`, **and** `repeatedFailureCount: 0` (or
  every flagged fact has been manually investigated via "Send selected") —
  all four together, not just the first three.
- **`factActivation.ts`'s reparenting guard is unchanged** — you still
  can't reparent a fact that itself has active children without
  deactivating them first. That's a structural rule (don't strand
  grandchildren), not part of this fix.
