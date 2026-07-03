# PR160 — Versioned Enrichment Core (Stale-Fact Refresh PR1) · UAT

> **What this PR delivers:** the *plumbing* for refreshing a live fact's
> enrichment without ever unpublishing it or touching its existing memes. A
> refresh runs as a **candidate version** the moderation Step-2 tooling reviews;
> approving promotes it into the live fact, rejecting keeps everything exactly
> as it was (and keeps the rejected candidate as history).
>
> **Heads-up on scope:** the "Send back to review" **button is PR2**. For this
> UAT, a refresh cycle is started with a one-line command you ask Replit (or
> Claude) to run — everything AFTER that point is normal in-app clicking.
>
> **Companion:** `docs/PR160_VERSIONED_ENRICHMENT_TEST_RUN.md` (Replit's
> automated checklist — run that first; it should be fully green before you
> start here).

---

## Part A — Regression smoke (nothing existing should have changed)

The refresh machinery is guarded behind `candidate_version_id` on the review
row, so every normal flow must behave exactly as before.

| # | Where | Do | Expect |
|---|---|---|---|
| A1 | Submit page | Submit a new fact | Lands in admin Reviews at triage, as always |
| A2 | Admin → Reviews | Provisionally approve it | Prep runs (enrichment + Pexels pills), review reaches Step 2 with the default render grid auto-populating |
| A3 | Step 2 | Approve for production | Fact goes live with hashtags; submitter gets the usual activity + email |
| A4 | Admin → Reviews | Reject a different submission at Step 2 | Normal rejection; submitter notified as always |
| A5 | Admin → Facts | Open a live fact, edit an enrichment override, save | Works as before |
| A6 | Admin → Facts → Prompt Diagnostics | Generate a preview for a live fact | Works as before (this endpoint gained a review-context mode; the plain fact path is unchanged) |
| A7 | Public site | Browse the feed, open facts, view memes | Everything renders; no blank enrichment anywhere |

Any deviation in A1–A7 is a bug — report it.

## Part B — The refresh cycle, end to end

### B1. Start a refresh (the PR2-pending step)

Pick a **live** fact you can recognize (note its id, its current look in the
feed, and any memes it already has). Ask Replit/Claude to run:

```
sendFactBackToReview({ factId: <THE ID> })
```

(§5 of the TEST_RUN doc has the exact command.)

**Expect immediately after:**
- The fact is **still live and unchanged** on the public site. No flicker, no
  unpublish, memes untouched. ✅ This is the single most important check.
- Admin → Reviews shows a **new pending review** with the fact's text, in prep
  ("working" enrichment pill). *Known PR2 gap: it looks like an ordinary
  review — the distinct "Refresh review" label comes in PR2.*

### B2. Watch prep finish

Within a minute or two (worker cadence), the review reaches **Step 2
(Production review)** and the default render scenario grid starts populating on
its own, exactly like a fresh submission.

**Expect:** renders in the grid reflect the fact's **newly re-classified**
enrichment (the candidate), and the Prompt Diagnostics panel inside the
moderation modal matches what the grid shows. The live fact on the public site
is *still* serving its old enrichment — that's correct: candidate and active
are isolated until you approve.

### B3. Reject path first (safe to try on the real cycle)

Click **Reject** (any reason, e.g. "lame").

**Expect:**
- The fact on the public site: completely untouched — enrichment, memes,
  Pexels, score, hashtags, visibility all exactly as before B1.
- No email/activity goes to whoever originally submitted the fact (a refresh
  rejection means "don't promote this refresh," never "your fact was removed").
- You can start a **new** refresh for the same fact afterwards (B1 again) — the
  rejected one doesn't block it.

### B4. Approve path (promote)

Run B1–B2 again on the same or another live fact, and this time click
**Approve for production** at Step 2 (waive render scenarios if you choose not
to wait for them, same as a normal approval).

**Expect:**
- Success — and the fact's enrichment (visible in Admin → Facts) now matches
  what you reviewed at Step 2. Any manual overrides you'd made on the fact
  earlier are **still applied** on top of the new AI baseline.
- The fact never left the public site during any of this; **existing memes and
  Pexels images are bit-for-bit untouched**. Only renders built *from now on*
  use the new enrichment.
- No "your fact was approved" email/activity is sent to the original submitter
  (it was already live — nothing new happened from their point of view).
- Approving the same review again does nothing new (idempotent).

### B5. Edge cases worth clicking

| # | Do | Expect |
|---|---|---|
| B5a | Start a refresh, then immediately try to start a second one for the same fact | Refused: "a refresh is already in progress" |
| B5b | While a refresh sits at Step 2, edit the fact's **text** in Admin → Facts, then approve the refresh | Refused with a stale-text error (409 `REFRESH_STALE_TEXT`); nothing changes. Reject the cycle and start a fresh one |
| B5c | Try a refresh on a fact that has active variants | Refused — refresh the variants individually instead |
| B5d | Reject a refresh while the enrichment pill is still "working" | Works; the in-flight job quietly discards its result; fact untouched |
| B5e | While a refresh is at Step 2, try editing the fact's enrichment (override editor, visual concept, or "Re-run classification") from Admin → Facts or the moderation modal | Blocked with "refresh in review — its live enrichment is frozen" (409). Approve or reject the cycle first; after that, edits work again |

## Bug report template

```
Fact id:
Step (A#/B#):
What I did:
What I expected:
What happened:
Public-site state of the fact (unchanged / changed how?):
Screenshot:
```

## Known limitations (NOT bugs in this PR)

1. **No "Send back to review" button** — the trigger is command-only until PR2.
2. **No version-history list** on the fact editor (PR2) — history rows are in
   the DB (`fact_enrichment_versions`) but have no UI yet.
3. **Refresh reviews aren't labeled** differently in the moderation list (PR2).
4. **No staleness tracking yet** — the Taxonomy Health "stale for reprocess"
   card, engine-revision marker, and signature stamps are PR3 (signatures are
   deliberately null in PR1).
5. **No bulk re-process** — PR4.
6. Refresh reviews show no submitter — by design (admin-initiated).
