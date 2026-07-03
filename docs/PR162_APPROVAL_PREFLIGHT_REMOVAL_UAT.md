# PR162 — Faster moderation (instant Approve + live test-renders pill) · UAT

> **What this PR delivers:**
> 1. **Approving a fact is now instant.** The old multi-minute spinner (and the
>    *"Render check failed; please retry approval shortly"* error) is gone —
>    approval no longer re-runs the AI visual planner. The **test renders you
>    already ran** are the renderability check.
> 2. **The render-problem waiver is now a true override.** If you explicitly
>    "Approve anyway" past missing/failed/stale renders, the fact ships — no
>    hidden second check can block you after you've said yes.
> 3. **The moderation list shows when test renders are running.** Re-run a test
>    render and the row behind the modal lights up a "Test renders · working…"
>    pill, just like the enrichment/images prep pills.
>
> **Companion:** `docs/PR162_APPROVAL_PREFLIGHT_REMOVAL_TEST_RUN.md` (Replit's
> automated checklist — should be green before you start here).

---

## Part A — Regression smoke (nothing existing should break)

| # | Where | Do | Expect |
|---|---|---|---|
| A1 | Submit page | Submit a new fact | Lands in admin Reviews at triage, as always |
| A2 | Admin → Reviews | Provisionally approve it | Prep runs (enrichment + images pills); review reaches Step 2 with the default render grid auto-populating |
| A3 | Admin → Reviews | Reject a submission at Step 2 | Normal rejection; submitter notified as always |
| A4 | Public site | Browse the feed, open facts, view memes | Everything renders; no blank enrichment |

Any deviation in A1–A4 is a bug.

## Part B — Instant approval (the headline)

**B1. Approve a clean fact.**
1. Take a fact in **Production review** whose required test renders (Generic,
   Male, Female) are **done/green** in the Step-2 grid.
2. Click **Approve for Production**.
3. **Expect:** approval returns **within a second or two** — no multi-minute
   spinner, no *"Render check failed; please retry approval shortly."* The fact
   goes live, gets its hashtags, and the submitter gets the usual notification.

> Before this PR, step B1 spun for 1–3 minutes and sometimes failed with the
> retry error even though the renders were fine. That is exactly what's fixed.

**B2. The renderability gate still protects you (unwaived).**
1. Take a Production-review fact whose required renders are **missing, failed,
   or stale** (e.g. edit an enrichment field after rendering to make them stale).
2. Click **Approve for Production** *without* waiving.
3. **Expect:** approval is **blocked** with the named problem scenarios and an
   "Approve anyway (waive)" option — unchanged from before. You cannot ship a
   fact whose renders don't match what will publish.

## Part C — Waiver is now a true override

1. From the blocked state in B2, click **Approve anyway** and confirm the waiver.
2. **Expect:** the fact is approved **immediately**. There is **no** second
   "Render check failed" step after you waive.

> **This is the intended behavior change.** Previously a waiver could still be
> vetoed by the hidden preflight. Now "Approve anyway" means what it says. The
> waiver is still recorded for audit on the review.

## Part D — Live "test renders" pill in the list

1. Open a Production-review fact's modal and, under **Run test renders**, select
   one scenario and click **Run selected** (or use a per-tile re-run).
2. Look at the **row behind the modal** in the moderation list (or close the
   modal and watch the row).
3. **Expect:** a **"Test renders · working…"** pill (spinner) appears on that
   row while the render is in flight, and clears once it finishes. The list
   keeps itself up to date without a manual refresh.
4. The same pill appears automatically for the auto-batch when a fact first
   enters Production review.

## Regression smoke table

| Area | Check | Expect |
|---|---|---|
| Approve (clean) | B1 | Instant, no spinner, goes live |
| Approve (unwaived, bad renders) | B2 | 409 with named problems |
| Approve (waived) | Part C | Ships immediately, waiver audited |
| List pill | Part D | "working…" pill during renders, auto-clears |
| Refresh cycle (#160) | Approve a refresh candidate whose renders are green/waived | Promotes instantly, no preflight wait |

## Known non-bugs / limitations
- **No "unrenderable: <reason>" message at approve time anymore.** That signal
  now comes *earlier* — a genuinely un-renderable fact shows a failed/blocked
  test render in the Step-2 grid (with its reason) during review, not as an
  approve-time popup.
- The pill only shows in **Production review** rows (that's the only place test
  renders exist).
- A waiver intentionally ships past render problems with no further check —
  that's the point of the waiver.

## Bug report template
```
Screen:            (e.g. Admin → Reviews → Review #____ modal)
Fact / review id:
Step:              (B1 / B2 / C / D / …)
What I did:
What I expected:
What happened:
Approve timing:    (instant / spun for ___ / errored with ___)
Screenshot:
```
