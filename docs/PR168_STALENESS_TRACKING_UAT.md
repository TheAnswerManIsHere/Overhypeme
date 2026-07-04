# PR168 — Stale-Fact Refresh PR3 (Staleness Tracking & Taxonomy Health) · UAT

> **What this PR delivers:** the "which facts haven't had the latest thinking?"
> half of the refresh feature. Taxonomy Health now has a **Stale for reprocess**
> card that lists old-but-good facts, each with a one-click **Send back to
> review**, plus a **Mark major update** button that flags the whole corpus as
> stale after an engine/LLM swap. Everything is clickable — no console commands.
>
> **Companion:** `docs/PR168_STALENESS_TRACKING_TEST_RUN.md` (Replit's checklist —
> should be fully green before you start).

---

## Part A — The stale-for-reprocess card (~4 minutes)

Go to **Admin → Taxonomy Health**.

| # | Where | Do | Expect |
|---|---|---|---|
| A1 | Header (top-right) | Look | **"Engine revision 1"** readout + a **"Mark major update"** button, next to the existing "Current versions" line |
| A2 | Summary cards | Look | A new **"Stale for reprocess"** card (amber). On an existing corpus its count is large — every valid fact approved before this feature is on a null signature. That's expected, not a bug |
| A3 | Click the **Stale for reprocess** card | | The explanation panel reads "enrichment is valid… hasn't benefited from the latest thinking" and says to **send it back** (refresh-first; no direct Re-enrich offered). The list fills with valid facts |
| A4 | A row in that list | Look at the Actions cell | A **"Send back to review"** button — and **NO "Re-enrich"** button, even though many of these are also "Stale enrichment". This is deliberate: a direct re-enrich would bypass moderation and wouldn't clear the flag |
| A5 | Click **Send back to review** on a row | | The button shows a brief spinner, then flips to **"Refresh #N — in review"** and disables. The row **stays listed** (it's still stale until the refresh is promoted) |
| A6 | Admin → Moderation | Find Review #N | It's a normal refresh cycle (blue "Refresh review" badge) — the exact same thing the Facts-page "Send Back" produces. Promote it from here (waive renders if you don't want to wait) |
| A7 | Back to Taxonomy Health → refresh the list | | The promoted fact has **dropped off** the Stale-for-reprocess card — its signature is now current |

## Part B — Mark major update (~3 minutes)

| # | Where | Do | Expect |
|---|---|---|---|
| B1 | Header | Click **"Mark major update"** | A confirm modal: "Engine revision 1 → 2", an amber **corpus-wide** warning, and an **optional note** textarea |
| B2 | Modal | Type a note (e.g. "switched to the new enricher") and click **Bump engine revision** | Modal closes; header now reads **"Engine revision 2"** |
| B3 | The fact you refreshed in A6/A7 | Refresh the Stale-for-reprocess list | It's **back on the list** — you just moved the goalposts; its signature carries engine revision 1, current is 2. Send it back again to re-clear it |
| B4 | Modal (reopen, then Cancel) | Click **Mark major update**, then **Cancel** | Nothing happens — no bump, revision stays where it was |

## Part C — Edge cases worth clicking

| # | Do | Expect |
|---|---|---|
| C1 | Send back a fact from the stale list that already has a refresh in flight (or double-click the button) | The button is pre-disabled / shows "in review" — never two cycles for one fact |
| C2 | Send back a fact that has active variants | An inline error explaining why (e.g. "has active variants") — no mystery failure |
| C3 | Mark major update with a very long note (>2000 chars) | Rejected with a clear message; the revision does NOT change |
| C4 | Approve a brand-new fact (normal first-time flow), then check the Stale-for-reprocess card | It does **NOT** appear — newly approved facts are stamped fresh, so the card reflects the shrinking legacy backlog rather than growing with every approval |
| C5 | Open the **missing_enrichment** card | Those broken facts are NOT in the Stale-for-reprocess card (they have their own error card + Re-enrich); stale-for-reprocess is old-but-*good* facts only |

## Part D — Regression smoke (existing lenses unchanged)

Click through the other Taxonomy Health cards — **Missing enrichment**,
**Stale enrichment**, **Projection mismatch**, **Needs admin review** — and
confirm their counts, lists, and row actions (Re-enrich / Repair) work exactly
as before. Facts-page send-back (PR2) and first-time moderation are unchanged.

## Bug report template

```
Fact id / Review id:
Part (A#/B#/C#/D):
Engine revision shown:
What I did:
What I expected:
What happened:
Did the fact drop off / return to the stale list as expected?:
Screenshot:
```

## Known limitations (NOT bugs)

1. On day one nearly the whole corpus is "Stale for reprocess" — that's the
   intended "hasn't been through the current pipeline" signal, not an alarm. It
   shrinks as you send facts back and as new approvals stamp fresh.
2. **Stale for reprocess** and **Stale enrichment** overlap a lot on legacy
   facts — they're different lenses (pipeline signature vs. embedded prompt
   version). Stale-for-reprocess rows only offer Send-back.
3. No **bulk** "reprocess all stale" yet — that's **PR4** (with live per-item
   progress). For now you send facts back one at a time from the list.
4. An engine-revision bump can't be "un-done" — if you bumped by mistake, bump
   again; the audit log records every transition and who made it.
5. The stale-for-reprocess status is info-level, so a fact whose only issue is
   staleness still shows overall **healthy** — the dedicated card is the surface,
   by design (so it doesn't swamp the real attention pill).
