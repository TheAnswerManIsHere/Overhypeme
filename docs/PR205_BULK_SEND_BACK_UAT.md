# PR205 — Stale-Fact Refresh PR4 (Bulk Send-Back) · UAT

> **What this PR delivers:** the bulk version of PR3's "Send back to review"
> button. On the Stale-for-reprocess card you can now queue up to 50 stale
> facts at once, or check off specific rows and send just those — instead of
> clicking the button one fact at a time. **This only starts refresh cycles.**
> Every fact still needs a human to approve it at the Visual Concept step and
> the Test Renders step before it goes live — bulk just fills the moderation
> queue faster, it never bypasses review.
>
> **Companion:** `docs/PR205_BULK_SEND_BACK_TEST_RUN.md` (Replit's checklist —
> should be fully green before you start).

---

## Part A — Bulk send-back, corpus-wide (~4 minutes)

Go to **Admin → Taxonomy Health → Stale for reprocess** card.

| # | Where | Do | Expect |
|---|---|---|---|
| A1 | The filter/search row | Look | Two new buttons: **"Send next 50 stale"** and **"Send selected (0)"** (disabled while nothing's checked) — visible ONLY on this card |
| A2 | Click **"Send next 50 stale"** | | A confirm dialog: "Queue up to 50 eligible stale facts for refresh?…" — explains facts already in review or blocked by active variants are left out, and that every refresh still needs both approvals |
| A3 | Confirm | | Rows in the list start lighting up individually — **Queued → Working → Done** (or **Skipped**), each with its own spinner/icon, exactly like the existing "Backfill missing enrichment" bulk action |
| A4 | Watch the progress banner | | "Send back to review: N of M done · X skipped" — updates live as jobs complete, plus a line like "12 eligible stale facts remain in the corpus" |
| A5 | Wait for it to finish | | The list refreshes once, automatically |
| A6 | Admin → Moderation | | The facts you just sent back sit at **Visual Concept** (Step 2) with their concept carried forward from the live fact — approve the visual gag → they move to **Test Renders** (Step 3) → approve there → promoted, staleness cleared |

## Part B — Select specific facts (~3 minutes)

| # | Do | Expect |
|---|---|---|
| B1 | On the Stale-for-reprocess card, check the box next to 2–3 rows (only rows NOT already "in review" have a checkbox) | Button label updates to **"Send selected (3)"** and enables |
| B2 | Click **"Send selected (3)"** | No confirm dialog (you already made an explicit choice by checking boxes) — fires immediately, only those 3 rows light up |
| B3 | Check a row, then look at another un-checked stale row | Only the row you checked animates when you fire "Send selected" — everyone else is untouched |

## Part C — The single-row button still works, now unified (~2 minutes)

| # | Do | Expect |
|---|---|---|
| C1 | Click **"Send back to review"** on a single stale-for-reprocess row (no checkbox involved) | The row shows the same spinner → Done/Skipped sequence as a bulk-sent row (it's the same machinery under the hood now) |
| C2 | Once done, refresh the page/list | The row shows **"Refresh in review"** instead of the button |

## Part D — Edge cases worth clicking

| # | Do | Expect |
|---|---|---|
| D1 | Click **"Send next 50 stale"** again right after A6, before any promotions | Facts already sent back in Part A show as **"Skipped — already in review"** — never double-queued |
| D2 | Try selecting a row, then clicking "Send selected" twice quickly | The button disables itself while its own operation is running — no double-fire |
| D3 | Decline the confirm dialog in A2 | Nothing happens — no request sent, no rows change |
| D4 | Look at a fact that has an active variant (a spin-off fact) | If you check its box and click "Send selected," it shows **"Skipped — has active variants"**; under "Send next 50 stale" it's silently left out of the batch (no error — it just never appears as queued) |
| D5 | If your corpus has more than 50 stale facts | "Send next 50 stale" only ever queues 50 at a time — click it again after the first batch clears the queue backlog (or once those first 50 move past review) to work through the rest |

## Part E — Regression smoke (existing behavior unchanged)

- The direct **Re-enrich** button is still absent from stale-for-reprocess
  rows (refresh-first is still the only remediation offered there).
- Other cards' bulk actions (Backfill missing enrichment, Re-enrich stale
  facts, Repair projection mismatches) behave exactly as before.
- The Facts page's own "Send back to review" (with the "clear overrides"
  option) is unchanged — this PR only touched the Taxonomy Health row/bulk
  actions.

## Bug report template

```
Fact id(s):
Part (A#/B#/C#/D#):
What I did:
What I expected:
What happened:
Did the row show Queued → Working → Done/Skipped correctly?:
Screenshot:
```

## Known limitations (NOT bugs)

1. **"Done" means the refresh cycle started, not that it's finished.** A
   "Done" row has entered the moderation queue at the AI-prep stage — it still
   needs a human to approve the Visual Concept, then the Test Renders, before
   it's live. This is intentional: bulk never bypasses moderation.
2. **The exact "eligible" count isn't shown before you click "Send next 50
   stale."** The confirm dialog says "up to 50 eligible" rather than an exact
   number, because the eligible count depends on server-side facts (which are
   already in review, which have active variants) that would need a second
   round-trip to preview. The exact numbers show up in the progress banner
   right after you confirm.
3. **The Stale-for-reprocess count doesn't drop the moment you send facts
   back.** A sent-back fact is still stale (and still on the card) until it's
   fully **promoted** through both moderation gates — sending it back doesn't
   clear the flag by itself.
4. **A 50-fact cap per click, always.** If your backlog is bigger, you'll
   click "Send next 50 stale" more than once over time as the queue works
   through. This is deliberate — it keeps the moderation queue from being
   flooded in one click.
5. **No bulk approve/promote.** This PR is entirely about getting facts INTO
   the review queue faster — it does not touch, and will never touch, the
   human approval gates themselves.
