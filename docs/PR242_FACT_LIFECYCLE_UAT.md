# PR #242 — Close the fact lifecycle — UAT

Your in-app acceptance test, David. This PR makes two of your rules impossible to
bypass: **a fact can only go live through moderation with a Visual Concept ("one
exit"), and every fact enters at the front of the moderation queue ("one
entrance").** Nothing a normal *user* sees changes — submitting a fact works
exactly as before. The changes are on the admin/moderation side.

Companion engineering checklist: [`PR242_FACT_LIFECYCLE_TEST_RUN.md`](PR242_FACT_LIFECYCLE_TEST_RUN.md).

## What to expect

### 1. User submission — unchanged
- Submit a fact as a normal user (the public submit form).
- ✅ It's accepted and lands in the moderation queue as before; you get the normal
  "submitted for review" confirmation. No behavior change here.

### 2. Bulk import now loads the moderation queue (does NOT publish)
- Admin → Facts → Import. Paste a few fact lines (or JSON/CSV) and import.
- ✅ The success message now reads **"Queued N fact(s) for moderation (…skipped as duplicates). They'll appear after review."** — not "imported."
- ✅ The imported facts do **not** appear in the live fact list. Go to the moderation
  queue (Admin → Reviews) — they're there at Stage 1 (triage), waiting to be triaged
  → enriched → activated like any submission.
- ✅ Re-importing the same text is **skipped** as a duplicate (it dedups against both
  existing facts and things already in the queue).

### 3. Variants go through moderation too
- Open a fact in the admin Facts editor → Add Variant → enter variant text → save.
- ✅ You get **"Variant queued for review. It'll appear under this fact once it's
  approved through moderation."** — it no longer appears instantly.
- ✅ It shows up in the moderation queue carrying its parent, and only appears nested
  under the parent fact after you approve it for production.

### 4. Admin "Active" toggle can deactivate but NOT activate
- In the admin Facts editor, find an **inactive** fact and try to toggle it Active.
- ✅ It's **rejected** with a message like *"A fact can only be activated through
  moderation. Deactivated facts must be re-moderated to go live again."*
- ✅ Toggling an **active** fact to inactive still works (deactivation is always
  allowed).
- **This is the intended capability change** (you confirmed it): to bring a
  deactivated fact back, it goes through moderation again — see item 4a for how.

### 4a. "Resubmit for Moderation" puts a deactivated fact back through the pipeline
- Open an **inactive** fact in the admin Facts editor.
- ✅ You'll see a new **"Resubmit for Moderation"** button (where "Send Back to
  Review" shows for active facts instead).
- Click it.
- ✅ You get **"Resubmitted for moderation — Review #… is back in the queue at Stage
  1."**
- Go to Admin → Reviews. ✅ The fact is there at **Stage 1 prep** (enrichment running
  again), reusing the **same fact id** — not a duplicate. Take it through
  triage/enrichment → Visual Concept → production approval as normal to bring it back
  live.
- Click the button again before finishing that review. ✅ You get a 409 — a review is
  already in progress for this fact (no duplicate reviews stack up).
- Try it on an **active** fact via a direct API call (or just note: the button only
  appears on inactive facts in the first place) — it's rejected, pointing you at Send
  Back to Review instead.

### 5. Approving a fact for production still requires a Visual Concept
- Take a fact through moderation to the production-approval step **without** a Visual
  Concept saved.
- ✅ Approval is blocked ("Save a non-empty Visual Concept before approving for
  production"). Add a concept, approve → it goes live. (Same gate as before, now
  also enforced at the database as a backstop.)

### 6. Existing live facts stay live
- Browse the site. ✅ Your existing facts are still there. Facts that had no Visual
  Concept were **backfilled** with a visible placeholder — you'll spot it as the
  scene **"{NAME} stands there confidently."** Replace those with real concepts at
  your leisure (they're greppable).
- Any old facts that had **no usable enrichment at all** were **deactivated** (they
  couldn't be made into good memes) — re-add the ones worth keeping via import, which
  now routes them through moderation.

## Regression smoke table

| Area | Expected |
|---|---|
| User fact submission | Works exactly as before → moderation queue |
| Public fact feed / detail / rating / comments / share | Unchanged; active facts visible |
| Moderation flow (triage → enrich → concept → approve) | Unchanged, still the only way a fact goes live |
| Refresh / send-back of a live fact | Unchanged (never touches active state) |
| Re-running "Backfill enrichment" on active facts | Keeps the moderator's Visual Concept (no longer wiped) |

## Known non-bugs / limitations

- Bulk import and variants **not appearing immediately** is intended — they're in the
  moderation queue now.
- The **"{NAME} stands there confidently."** placeholder concept is intentional (the
  grandfather marker) — not a bug.
- The admin Active toggle refusing to activate is intended (item 4).

## Bug report template

> **Where:** (page / admin panel)
> **Did:** (steps)
> **Expected:** (what should happen per above)
> **Got:** (what actually happened)
> **Fact/review id (if any):**
