# Two-gate fact moderation — user acceptance testing

**PR:** #128 · **Companion:** [`PR128_MODERATION_TWO_GATE_TEST_RUN.md`](./PR128_MODERATION_TWO_GATE_TEST_RUN.md)

## What you're verifying

Fact moderation is now a **two-gate, cost-gated** flow instead of one approve
button:

1. **Submit is cheap.** A submitted fact lands as **Needs first pass** — no AI
   classification, no Pexels images, nothing paid has run.
2. **Gate 1 — Provisional approve ("Start prep").** This is the first time any
   paid work runs. It creates an inactive **staging fact** and kicks off two
   prep jobs on it: **enrichment** (the gate) and **Pexels images**
   (best-effort, alongside).
3. **Prep runs with live status.** You watch enrichment and images move
   `working… → ready / failed` per item, live, without refreshing.
4. **Gate 2 — Approve for production.** Once enrichment is ready the fact moves
   to **Production review**, where you tune the enrichment and then flip it
   live. If Pexels images aren't ready you get a **soft warning** — you can
   still approve.

You are NOT verifying that submission auto-approves anything, and you are NOT
verifying that a Pexels failure blocks going live (it never should).

## Where to look

- **Admin → Moderation → Fact Reviews.** Everything below happens here.
- A submitted fact needs a submitter; use the normal `/submit` flow as a
  non-admin, or seed a review, then switch to an admin account to moderate.

## 1. A fresh submission is cheap (Needs first pass)

1. Submit a fact (e.g. `{NAME} bench-presses a city bus on leg day`).
2. In Moderation it shows the **Needs first pass** stage chip. There are **no**
   enrichment/image status pills on the row yet.
3. Open it. The actions are **Provisional Approve — Start Prep**, **Prep as
   Variant of #X** (only if a duplicate was flagged), and **Reject**. There is
   no "approve straight to live" — that's intended.

**Expect:** no AI/image work has happened; the modal shows the submitted fact
and (if flagged) the potential duplicate.

## 2. Provisional approve starts prep with live status

1. Click **Provisional Approve — Start Prep**.
2. The row moves to **AI prep running** and shows two pills:
   **Enrichment · working…** and **Pexels images · working…** (spinners). A blue
   banner up top reads e.g. *"1 fact is in AI prep — updating live."*
3. Open the row. The modal shows the same two-step prep panel with an aggregate
   line (`Prep: 0 of 2 ready · 2 working`) and a *"this view updates live; you
   don't need to refresh"* note.
4. Wait. Within a few seconds **Enrichment** flips to **ready** (green check)
   and the row advances to **Production review**. **Pexels images** flips to
   **ready** once photos land (may take a little longer — that's fine).

**Expect:** status updates on their own, per item, with no page refresh and no
timeout. "working", "ready", and "failed" are visually distinct.

## 3. Production review — tune, then approve for production

1. On a **Production review** row, open it.
2. You can re-run classification and edit the enrichment (this edits the
   **staging fact**), and the runtime prompt preview reflects it.
3. Click **Approve for Production**.
   - If **Pexels images = ready**: it approves immediately. The fact goes live;
     the row becomes **Live** and links to the live fact; the submitter gets the
     approval notification.
   - If **Pexels images = failed or still working**: you get an amber
     **soft-warn** ("images aren't ready… meme builder falls back to its other
     image sources"). The button becomes **Approve Anyway**; click it to confirm.

**Expect:** approval is blocked only by an **invalid enrichment** (with a clear
message), never by Pexels. The live fact is the staging fact you prepped.

## 4. Prep failed → retry

1. If enrichment fails after retries, the row shows **Prep failed** with
   **Enrichment · failed**.
2. Open it → **Retry Prep** re-runs enrichment (and images); **Reject** is also
   available.

**Expect:** retry returns the row to **AI prep running**; you don't have to
re-submit.

## 5. Reject at any stage

- **Needs first pass → Reject** is a cheap triage rejection.
- **AI prep running / Prep failed / Production review → Reject** is a *production*
  rejection: the staging fact is left inactive (never reaches users) and the
  submitter is notified. A rejection **reason** is required.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Moderation list | open Pending | rows show **stage** chips (not raw pending/approved) |
| Needs first pass | open modal | Provisional approve / variant / reject; no live-approve |
| Provisional approve | click | row → AI prep running; both prep pills "working…"; live banner |
| AI prep running | wait | enrichment → ready advances row to Production review; no refresh |
| Production review | approve, images ready | goes live immediately; row → Live; submitter notified |
| Production review | approve, images not ready | amber soft-warn → **Approve Anyway** confirms |
| Production review | invalid enrichment | Approve disabled with reason; re-run/fix to enable |
| Prep failed | Retry Prep | row returns to AI prep running |
| Any prep stage | Reject (with reason) | staging fact stays inactive; submitter notified |
| Approved row | open | read-only summary + **View Live Fact** link |

## Known non-bugs / deferred

- **Pexels never gates production.** A failed/slow image library does not block
  going live by design (the meme builder has other image sources). The soft-warn
  is the only friction — chosen over a hard block so a Pexels outage can't stall
  moderation.
- **In-progress enrichment edits and the admin note aren't autosaved to your
  browser** during production review — they're committed when you approve. If
  you close the modal mid-edit without approving, those edits are not kept. (The
  prior single-gate modal autosaved a draft; this is a deliberate simplification
  for the two-gate rewrite and can be restored if you want it back.)
- **The list filter is still coarse** (Pending / Approved / Rejected / All). The
  fine-grained stage lives on each row's chip; there is no per-stage filter yet.
- **Images "working…" covers both queued and running** — the column can't tell
  them apart; both show as working with a spinner until the job is terminal.

## Bug report template

```
Where: Moderation → which stage (Needs first pass / AI prep / Prep failed / Production review / resolved)
Fact: <text>
What I did: <provisional approve / wait / approve for production / reject / retry>
What I expected (per this doc): …
What happened: …
Per-item status shown (enrichment / images): …
Console / network errors (if any): …
```
