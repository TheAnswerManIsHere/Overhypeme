# PR164 — Stale-Fact Refresh PR2 (Send-back UI, Version History, Candidate Editing) · UAT

> **What this PR delivers:** the refresh feature end-to-end, in the product. The
> button that started this whole feature exists now — everything is clickable,
> no console commands anywhere.
>
> **Companion:** `docs/PR164_VERSIONED_ENRICHMENT_UI_TEST_RUN.md` (Replit's
> checklist — should be fully green before you start).

---

## Part A — The happy path, end to end (~5 minutes)

Pick a **live** fact you recognize (note how it looks in the feed and which
memes it has).

| # | Where | Do | Expect |
|---|---|---|---|
| A1 | Admin → Facts → select the fact | Find **"Send Back to Review"** (blue, above Delete Fact) | Visible for live facts only, with a one-line explanation under it |
| A2 | Click it | Confirm modal | Fact recap; "the fact **stays live**" copy; **"Clear my manual edits" checkbox — default OFF**; Start Refresh / Cancel |
| A3 | Click **Start Refresh** | | Green toast naming the new **Review #N**; the list row's pill flips to **"classifying…"**; the button becomes disabled **"Refresh in review"**; an **amber notice** appears above the enrichment editor linking to the Moderation queue; the editor is **read-only** (inspectable, but Save / override chips / Re-run are gone) |
| A4 | Same panel | Open **"Enrichment Version History"** | "Current active" (+ "manually overridden" chip if you'd edited it) and "**In review — refresh from ⟨today⟩ (classifying…)**" with a Review #N link |
| A5 | Public site | Check the fact | **Completely unchanged** — still live, same enrichment behavior, memes untouched. The single most important check |
| A6 | Admin → Moderation | Find Review #N | Row shows a blue **"Refresh review"** badge and "by admin refresh"; within ~a minute it reaches **Visual review** and the test-render grid auto-populates |
| A7 | Open the review, Step 2 | Look around | Header has the Refresh badge; the fact panel is titled **"Live Fact (being refreshed)"** with an explainer line; **no Final-hashtags section** (refreshes never touch tags); **no "Re-run classification"** button |
| A8 | Step 2 | **Edit the candidate**: change a tracked field (e.g. Overhype Fit) in Advanced Options, and/or edit the Visual concept + Save | Saves work normally — chips, Revert to AI, the grid marks affected renders stale. Now check Admin → Facts in another tab: the live fact **did not change** (that's the candidate isolation) |
| A9 | Step 2 | Click **"Promote Refresh"** (waive renders if you don't want to wait) | Success. Facts page: pill back to normal, freeze lifted, history shows "**Promoted refresh from ⟨today⟩**" + "**Previous active (archived ⟨today⟩)**"; your A8 edit is now on the live fact; feed/memes/hashtags untouched |

## Part B — The reject path

Run A1–A6 on another (or the same) fact, then at Step 2 click **"Don't Promote
Refresh"** (pick any rejection reason; note the hint: "rejects the refresh
candidate only — the live fact stays published and unchanged").

**Expect:** the fact is bit-for-bit as it was; the freeze lifts on the Facts
page (editor editable again, button back to "Send Back to Review"); history
shows "**Rejected refresh from ⟨today⟩**"; no email/activity to the original
submitter; a new refresh can be started immediately.

## Part C — Edge cases worth clicking

| # | Do | Expect |
|---|---|---|
| C1 | With a refresh in flight, try editing the fact's enrichment from the Facts page | Everything is visibly read-only with the amber pointer to Moderation (no mystery errors) |
| C2 | With a refresh in flight, click where "Send Back to Review" was | Disabled "Refresh in review" — no double cycles |
| C3 | Edit the fact's **text** while its refresh sits at Step 2, then Promote | Refused with a clear "text changed after this refresh was prepared" message; reject + re-send |
| C4 | "Clear my manual edits" checked at send-back (on a fact with overrides) | The candidate arrives at Step 2 with a clean AI baseline (no override chips); the live fact keeps its overrides either way |
| C5 | Keep the Step-2 modal open in a stale tab, promote/reject from another tab, then try editing in the stale tab | A clear "already promoted/rejected" style message — not a silent failure |
| C6 | Re-run classification on a NORMAL long-approved fact from the Facts page | **Now works** (this PR fixed a latent bug where it silently stranded on "classifying…" forever for any moderation-approved fact) |

## Part D — Regression smoke (first-time flow unchanged)

Submit a new fact → triage → provisional approve → Step 2 (hashtag curation
IS there for first-time reviews, approve button still "Approve for
Production") → approve → live with tags + submitter notifications. Reject
path unchanged. Facts-page enrichment editing on ordinary facts unchanged.

## Bug report template

```
Fact id / Review id:
Step (A#/B#/C#/D):
What I did:
What I expected:
What happened:
Public-site state of the fact (unchanged / changed how?):
Screenshot:
```

## Known limitations (NOT bugs)

1. Version history is read-only — no rollback UI yet (schema supports it; future).
2. Rejection reasons are the standard list (duplicate/spam/offensive/lame) even
   for refreshes; the copy makes the meaning clear. A refresh-specific reason
   is a possible follow-up.
3. No "Re-run classification" at Step 2 — deliberate (it was already broken
   there). Facts page / Retry Prep / reject-and-resend cover every case.
4. Staleness tracking ("which facts need a refresh?") is **PR3**; bulk
   re-process is **PR4**. For now you pick facts to refresh manually.
5. Deleting/deactivating a fact with an in-flight refresh leaves the cycle to
   be rejected manually from Moderation.
