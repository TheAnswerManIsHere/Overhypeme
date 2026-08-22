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

### 2. A variant's Pexels panel is now visible in the Facts editor

**Do:** Open a variant (not a root) in the admin Facts editor.

**Expect:** The "Pexels Image Pipeline" panel is visible and usable for the
variant — previously it was hidden entirely, root-only.

### 3. A variant can refresh its own images

**Do:** Click "Refresh images" on the variant from the previous step.

**Expect:** It succeeds and generates the variant's own stock images,
independent of its root's.

### 4. A variant can generate its own AI meme background

**Do:** As a legendary user, try generating an AI meme background for a
variant fact.

**Expect:** It's accepted and generates — previously rejected with "AI meme
generation only supported on root facts."

### 5. Editing a root's text no longer blocks on its variants

**Do:** Edit a root fact's text (with the confirmation phrase) while one of
its variants has an unresolved review or an active enrichment job in flight.

**Expect:** The root edit goes through immediately — it's no longer blocked
waiting on the variant.

### 6. Editing a root's text no longer marks its variants stale

**Do:** After the edit in the previous step, check the variant's own
enrichment / `stale_for_reprocess` state.

**Expect:** It is untouched by the root edit. Previously, a confirmed root
edit would mark every child variant stale, forcing them to re-enrich for no
reason.

### 7. Bulk Media Backfill panel is on Taxonomy Health

**Do:** Go to Admin → Taxonomy Health.

**Expect:** A new "Bulk Media Backfill" section appears near the top, with
three buttons: Backfill images, Backfill Pexels, Backfill AI memes. It's
visible regardless of which health card filter is selected.

### 8. Backfill images enqueues durable jobs

**Do:** Click "Backfill images".

**Expect:** A confirmation dialog appears; confirming enqueues durable jobs
for every active fact (root or variant) missing images, and a live status
line shows "N of M done" as jobs complete.

### 9. Re-clicking Backfill images while jobs run is safe

**Do:** Re-click "Backfill images" while jobs from the previous step are
still running.

**Expect:** It's safe — already-queued facts dedupe onto their existing job
rather than double-running.

### 10. Backfill AI memes follows the same pattern

**Do:** Click "Backfill AI memes" and confirm.

**Expect:** The same confirm → enqueue → live status pattern as Backfill
images; the confirmation message notes this one calls paid OpenAI/fal.ai
APIs.

### 11. A root with an active variant can be sent back to review

**Do:** Find a root fact that's stale for reprocess (Taxonomy Health →
"Stale for reprocess" card) and has an active variant, then click "Send
back to review" on that root.

**Expect:** It succeeds — sending a root back to review no longer requires
touching its variants first, since the root's refresh can no longer
invalidate them. (Previously this failed with "This fact has active
variants. Refresh the variants individually instead of the root.")

### 12. Bulk send-back now picks up roots with active variants

**Do:** Click "Send next 50 stale" (the corpus-wide bulk button).

**Expect:** It now picks up roots with active variants too, instead of
silently skipping them forever.

### 13. Repeated-failure protection flags a fact after 3 failures

**Do:** Find a fact whose send-back has failed 3 times in a row (uncommon
in normal use — most testers won't hit this naturally) and look at its
Taxonomy Health row.

**Expect:** It shows a "3 failed attempts" badge next to the send-back
button, and it's no longer picked up by "Send next 50 stale" automatically.

### 14. A flagged fact can still be retried deliberately

**Do:** Check that fact's row box and use "Send selected".

**Expect:** It works normally, with no special rejection — this is the only
way to clear the flag.

### 15. Bulk send-back reports any facts it excluded

**Do:** Run "Send next 50 stale" when it would exclude any facts under
repeated-failure protection.

**Expect:** The status line calls it out explicitly ("N fact(s) excluded
after repeated failures — investigate before considering the migration
complete") so it's never silently missed.

## Regression

### R1. Root fact images, memes, and enrichment are unchanged

**Do:** Check images, memes, and enrichment for a root fact.

**Expect:** Unchanged — still works exactly as before.

### R2. The public fact feed / detail page for roots is unchanged

**Do:** View the public feed and detail page for a root fact.

**Expect:** Unchanged.

### R3. Send-back for a root with no variants is unchanged

**Do:** Send a root fact with no variants back to review.

**Expect:** Unchanged.

### R4. Single-fact "Refresh images" on a root is unchanged

**Do:** Click "Refresh images" on a single root fact (not the bulk panel).

**Expect:** Unchanged.

### R5. The Facts editor for a root fact is unchanged

**Do:** Open the Facts editor for a root fact.

**Expect:** Unchanged.

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
