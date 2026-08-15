# PR #276 — A failed Stripe sync stays visible — UAT

Your in-app acceptance test, David. This is the fix for the thing that actually
cost us four rounds of investigation on the "only Forever shows" bug.

**The bug wasn't the pricing page.** The Stripe sync had failed, and the admin
Billing page threw the error away. It showed the failure only *while a sync was
running* — so the moment you reloaded the page, the error vanished and you were
left looking at *"1 product found · Last synced: 10m ago"*, which reads exactly
like everything is fine. The failure was recorded in the database the whole
time. Nothing displayed it.

Your catalog itself is already fixed — re-running the sync restored all three
plans. **This PR makes sure the next failure announces itself.**

Companion engineering checklist:
the transient engineering checklist (deleted after execution) and the
[checklist handoff](./CLAUDE_CHECKLIST_HANDOFF_2026-08-09.md).

## What to expect

Everything here is on **Admin → Billing**, in the **"Plans from Stripe"**
section. Nothing on this PR touches the customer-facing pricing page.

### 1. The status panel is always there now, not just mid-sync

- Go to Admin → Billing and expand **"Plans from Stripe"**. Don't click
  anything.
- ✅ You see the per-resource panel — Products, Prices, Plans, Customers, and
  so on — each with its own state, plus a **coloured summary line at the top**.
- Previously this whole panel only appeared while a sync was actively running,
  and disappeared on reload. That disappearing act is the bug.

### 2. A green summary when the last sync worked

- Click **"Sync Stripe data"** and let it finish.
- ✅ Green line: *"Last sync completed successfully. Last synced just now."*
- **Now reload the page.** ✅ The green line is **still there**, and still says
  it synced. It doesn't revert to a bare product count.

### 3. A failed sync stays on screen after a reload — the main event

This is the one that matters. The safest way to see it is the simulated
failure the engineering checklist drives, but you can also trigger it for real
by temporarily breaking the Stripe key.

- Cause a sync to fail (see the TEST_RUN doc, or ask Replit to run the
  simulate step).
- ✅ A **red** summary line: *"Last sync failed — plans did not complete:
  &lt;the actual Stripe error&gt;. Catalog data may be stale."*
- ✅ The **Plans** row itself shows a red ✗ and the error text.
- **Reload the page.** ✅ Both are **still there.** This is the entire point —
  before this PR the red line and the ✗ both vanished on reload and you'd see a
  cheerful product count instead.
- ✅ Note the summary names *which* resource failed, so you know whether it's
  your catalog (products/prices/plans) or something peripheral
  (charges/invoices).

### 4. "Partial" is reported as failed, not as success

- If a sync fails on one resource but succeeds on others: ✅ the summary is
  **red**, not green, even though most rows show ✓.
- The "Last synced" stamp still appears, because both facts matter — something
  did sync, and something didn't. It should never round up to "all good."

### 5. A never-synced install says so, in amber

- Hard to see on your live install (you've synced plenty), so this one is
  mostly for the engineering checklist. On a database that has never run a
  sync: ✅ amber line — *"Never synced — run a full sync to populate the
  catalog."*
- ✅ Crucially it is **amber and actionable**, not a spinner and not blank.
  "Never ran" and "still working" are different things and must not look alike.

### 6. The "Last synced" stamp survives a server restart

- After a sync, have Replit restart the server (or just come back after a
  deploy), then reload Admin → Billing.
- ✅ The **"· Last synced: …"** stamp in the Plans header is still correct.
  It's read from each resource's own timestamp rather than from an in-memory
  value that resets on restart.

## Regression smoke

Quick passes to confirm nothing next door broke. All on Admin → Billing.

| Check | Expected |
|---|---|
| Click **Sync Stripe data** | Rows animate pending → syncing → ✓ as before; button disables then re-enables |
| Click **Full sync** | Same, across all eight resources |
| **LIVE / TEST** badge in the Plans header | Still shows the right mode |
| **N products found** count | Still accurate after a sync |
| Product list below the panel | Names, descriptions, prices render as before |
| **Setup Checklist** rows | Unchanged by this PR |
| Toggle live/test mode | Behaves as it did before — untouched here |
| Customer **/pricing** page | **Completely unchanged.** If anything differs, that's a bug — this PR is admin-only |

## Known limitations — not bugs

- **The Setup Checklist can still read green on a one-plan catalog.** Its
  "Membership prices available" row is an OR across three slots and doesn't
  apply the membership filter. Real, known, and deliberately **not** in this PR
  — it's §1.5 of the plan we set aside.
- **The pricing page still can't show a quarterly or a duplicate one-time
  price.** Also real, also deliberately out of scope (Phase 2). If you add a
  quarterly price in Stripe it will sync fine and show in admin, but the
  customer page will still mishandle it.
- **Admin doesn't yet tell you which Stripe account the catalog belongs to.**
  That was §1.2, set aside.
- **The summary shows the first error's message when several resources fail**,
  with a count of the rest ("and 2 other resources"). Reading every message
  means looking at the individual rows. Intentional — the summary is a
  headline.

## If something's wrong

```
What I did:
What I expected:
What actually happened:
Which resource row / summary line:
Was it before or after a page reload?
Screenshot:
```

The reload detail matters more than usual here — before/after is precisely
what this PR changes.
