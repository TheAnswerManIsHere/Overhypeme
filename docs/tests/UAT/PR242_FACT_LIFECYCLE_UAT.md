# PR #242 — Close the fact lifecycle — UAT

This PR makes two of your rules impossible to bypass: **a fact can only go
live through moderation with a Visual Concept ("one exit"), and every fact
enters at the front of the moderation queue ("one entrance").** Nothing a
normal *user* sees changes — submitting a fact works exactly as before.
The changes are on the admin/moderation side.

**Your decision that step 7 checks deliberately:** an admin can no longer
flip a deactivated fact back to Active directly — bringing it back live
goes through moderation again (see steps 9–13).

## Setup

- [david] Sign in as admin — most checks are in Admin → Facts and
  Admin → Reviews.
- [claude] Confirm the public submit form is reachable (signed out or as a
  normal user) for step 1.

## Steps

### 1. A normal user submission still works

**Do:** Submit a fact as a normal user via the public submit form.

**Expect:** it's accepted and lands in the moderation queue as before; you
get the normal "submitted for review" confirmation.

**Lane:** scripted

**Deferred:** #631 — increment 2 (ordinary test users + test mailbox)

### 2. Bulk import reports facts as queued, not imported

**Do:** Go to Admin → Facts → Import, paste a few fact lines (or
JSON/CSV), and import.

**Expect:** the success message reads "Queued N fact(s) for moderation
(…skipped as duplicates). They'll appear after review." — not "imported."

**Lane:** scripted

**Deferred:** #631 — increment 7 (burn-down)

### 3. Imported facts land in the moderation queue at triage, not live

**Do:** Check the live fact list, then check Admin → Reviews for the facts
you just imported.

**Expect:** the imported facts do not appear in the live fact list; in
Admin → Reviews they're at Stage 1 (triage), waiting to be triaged →
enriched → activated like any submission.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.import.test.ts:queues valid items as Stage-1 SYSTEM reviews (submittedById=null), no facts, and skips invalid ones`

### 4. Re-importing the same text is skipped as a duplicate

**Do:** Re-import the same fact text from step 2.

**Expect:** it's skipped as a duplicate — the import dedups against both
existing facts and things already in the queue.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.import.test.ts:skips items whose text already exists as an UNRESOLVED review`

### 5. Adding a variant queues it instead of publishing instantly

**Do:** Open a fact in the admin Facts editor, click Add Variant, enter
variant text, and save.

**Expect:** you get "Variant queued for review. It'll appear under this
fact once it's approved through moderation." — it no longer appears
instantly.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:queues the variant as a Stage-1 review carrying the parent (no active variant fact)`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 6. A queued variant carries its parent and nests only after approval

**Do:** Check the moderation queue for the variant from step 5.

**Expect:** it shows up carrying its parent fact, and only appears nested
under the parent after you approve it for production.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:queues the variant as a Stage-1 review carrying the parent (no active variant fact)`

### 7. Toggling an inactive fact to Active is rejected

**Do:** In the admin Facts editor, find an inactive fact and try to toggle
it Active.

**Expect:** it's rejected with a message like "A fact can only be
activated through moderation. Deactivated facts must be re-moderated to go
live again."

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:rejects flipping an INACTIVE fact to active — activation is moderation-only`

### 8. Toggling an active fact to inactive still works

**Do:** Toggle an active fact to inactive.

**Expect:** it works as before — deactivation is always allowed.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/factLifecycleClosure.test.ts:cascades: deactivating an active root also deactivates its active children`

### 9. An inactive fact shows a Resubmit for Moderation button

**Do:** Open an inactive fact in the admin Facts editor.

**Expect:** you see a "Resubmit for Moderation" button (where "Send Back
to Review" shows for active facts instead).

**Lane:** scripted

**Deferred:** #631 — increment 7 (burn-down)

### 10. Resubmitting puts the fact back in the queue at Stage 1

**Do:** Click "Resubmit for Moderation".

**Expect:** you get "Resubmitted for moderation — Review #… is back in the
queue at Stage 1."

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.resubmitForModeration.test.ts:re-enters the SAME fact at prep_pending: no new fact, enrichment job queued`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 11. The resubmitted review reuses the same fact id

**Do:** Go to Admin → Reviews and find the review from step 10.

**Expect:** the review is listed as "AI prep running" (enrichment running
again), reusing the same fact id — not a duplicate.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.resubmitForModeration.test.ts:re-enters the SAME fact at prep_pending: no new fact, enrichment job queued`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 12. A second resubmit while one is in progress is rejected

**Do:** Click "Resubmit for Moderation" again before finishing the review
from step 10.

**Expect:** you get a 409 — a review is already in progress for this
fact; no duplicate reviews stack up.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.resubmitForModeration.test.ts:409 REVIEW_ALREADY_IN_PROGRESS naming the in-flight review on a second click`

### 13. Resubmit isn't available on an active fact

**Do:** Open an active fact in the admin Facts editor and look for a
Resubmit for Moderation button (or attempt the resubmit call directly,
e.g. via the API).

**Expect:** the button doesn't appear on active facts — "Send Back to
Review" shows instead; a direct attempt is rejected, pointing you at Send
Back to Review.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.resubmitForModeration.test.ts:404 for a missing fact; 409 ALREADY_ACTIVE`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 14. Production approval is still blocked without a Visual Concept

**Do:** Take a fact through moderation to the production-approval step
without a Visual Concept saved, and try to approve.

**Expect:** approval is blocked ("Save a non-empty Visual Concept before
approving for production"). Adding a concept and approving then goes
live.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/factLifecycleClosure.test.ts:throws ConceptMissingError and does NOT activate a conceptless fact`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 15. Existing live facts stayed live, with placeholders backfilled

**Do:** Browse the site and spot-check a few existing facts, especially
ones that previously had no Visual Concept.

**Expect:** your existing facts are still there; any that had no Visual
Concept were backfilled with the visible placeholder scene "{NAME} stands
there confidently." (greppable, to replace at your leisure).

**Lane:** live

**Check:** read-only SQL via the Replit connector: `SELECT count(*) FROM facts WHERE is_active AND enrichment IS NULL` (expect 0), then spot-check the placeholder scene

### 16. Facts with no usable enrichment were deactivated, not silently kept

**Do:** Look for any old facts that had no usable enrichment at all.

**Expect:** they were deactivated (they couldn't be made into good memes);
re-add any worth keeping via import, which now routes through moderation.

**Lane:** live

**Check:** read-only SQL via the Replit connector: list facts with `is_active = false` and no usable enrichment (`SELECT id, text FROM facts WHERE NOT is_active AND enrichment IS NULL`)

## Regression

### R1. The public fact feed and related surfaces are unchanged

**Do:** Check the public fact feed, a fact detail page, rating, comments,
and share.

**Expect:** unchanged; active facts are visible as before.

**Lane:** scripted

**Deferred:** #631 — increment 7 (burn-down)

### R2. The moderation flow itself is unchanged

**Do:** Take a fact through triage → enrich → concept → approve.

**Expect:** unchanged — still the only way a fact goes live.

**Lane:** scripted

**Deferred:** #631 — increment 7 (burn-down)

### R3. Refresh / send-back of a live fact is unchanged

**Do:** Send a live fact back to review (refresh).

**Expect:** unchanged; it never touches active state.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.sendBackToReview.test.ts:starts a refresh cycle: candidate + new review, createdBy = the admin, ids echoed`

### R4. Re-running "Backfill enrichment" keeps the moderator's Visual Concept

**Do:** Re-run "Backfill enrichment" on an active fact that already has a
moderator-written Visual Concept.

**Expect:** the moderator's Visual Concept is kept — it's no longer wiped.

**Lane:** scripted

**Deferred:** #631 — increment 7 (burn-down)

## Not bugs

- Bulk import and variants **not appearing immediately** is intended —
  they're in the moderation queue now.
- The **"{NAME} stands there confidently."** placeholder concept is
  intentional (the grandfather marker) — not a bug.
- The admin Active toggle refusing to activate is intended (step 7).
