# PR179 — Moderation three-step flow · UAT (click-through)

> **For David.** In-app acceptance test for the new three-step moderation flow
> (**Triage → Visual Concept → Test Renders**). Companion engineering checklist:
> `docs/PR179_MODERATION_THREE_STEP_FLOW_TEST_RUN.md`.
>
> **What changed:** the old single "Visual review" step is now **two** steps. A
> fact must clear a **Visual Concept** gate — you accept/edit/write the concept
> and *approve the visual gag* — **before any renders run**. Renders then
> auto-fire on the **Test Renders** step. Sending a fact back from Test Renders to
> Visual Concept and re-approving always re-renders a **fresh** batch.
>
> **Prereq:** a live OpenAI key (enrichment + Visual-Idea generation are real
> calls). If ideas never generate, check that first — it's environment, not the UI.

---

## Where to go

1. Open **Admin → Moderation → Fact Reviews**.
2. The wizard now shows **three** numbered steps: **Triage · Visual Concept ·
   Test Renders**.

## The happy path (new fact)

| # | Do this | Expect |
|---|---------|--------|
| 1 | Provisionally-approve a pending fact (**Triage**). | Row shows **Preparing…** then, when enrichment finishes, **Generating visual ideas…** (spinner), then **Ready for concept review**. It never jumps straight to renders. |
| 2 | Open the review. | It opens on **Step 2 · Visual Concept**. You see the **Visual Concept** field, the three **Visual ideas** cards, and **Advanced Options** — but **no test-render grid**. |
| 3 | Pick an idea (or type your own concept) and click **Save Visual Concept & Continue**. | It saves, then advances to **Step 3 · Test Renders** and renders **auto-fire** ("Rendering test images…"). No separate "Run" click needed. |
| 4 | Wait on Step 3. | The render grid fills in. Row/queue reads **Rendering test images…** then **Renders ready — needs review**. |
| 5 | Tweak enrichment/concept in Advanced Options, Save, re-run tiles as needed, then **Approve for Production**. | Same final gate/waiver as before — the fact goes live. |

**The gag button is gated.** On Step 2, **Approve the Visual Gag** is disabled
until there is a **saved** concept *and* the visual ideas finished. If your
concept edit is unsaved, the button reads **Save Visual Concept & Continue**
instead (it saves first, then approves — never on a browser-only draft).

## The bounce path (Test Renders → Visual Concept)

| # | Do this | Expect |
|---|---------|--------|
| 1 | On **Step 3**, click **Back to Visual Concept**. | The modal **stays open** and flips to **Step 2**; the queue row flips back to concept review. In-flight renders are left to finish but are no longer the active set. |
| 2 | Change nothing, re-click **Approve the Visual Gag**. | It advances to Step 3 and **re-renders a fresh batch** — even though the concept text is identical. (The old renders are superseded, not reused.) |
| 3 | Bounce again *while renders are still running*, then re-approve. | Still fine — a fresh batch is forced; the old in-flight renders don't block or merge into it. |

## Refresh (send a live fact back to review)

| # | Do this | Expect |
|---|---------|--------|
| 1 | From a live fact, **Send back to review**. | The modal copy says it lands at **Visual Concept (Step 2)**. |
| 2 | Let it prep. | Lands on **Step 2** with the concept carried over and **fresh** Visual ideas generated. Editing the candidate works on Step 2 *and* Step 3. |
| 3 | Repeat but tick **"Clear my manual edits"** on send-back. | The concept comes back **blank**. Step 2 **blocks** advancement (the gag button stays disabled) until you save a concept — even though the ideas are fresh. |

## Old pre-deploy rows

| Scenario | Expect |
|----------|--------|
| A fact that was already sitting in **production review** before this deploy | Opens directly on **Step 3 · Test Renders** and approves via the **existing** render/enrichment gate — the new concept gate does **not** retroactively block it. |
| You voluntarily bounce that old row **Back to Visual Concept** | Now the new concept gate applies: re-approval requires a saved concept (regenerate ideas if the row never had them). |

## What should NOT happen

- Renders must **never** fire in Step 2 (Visual Concept) — no spend before the gag
  is approved.
- **Approve the Visual Gag** must **never** enable on an unsaved-only draft, a
  blank concept, or while ideas are still generating / failed.
- A double-click (or two admins) on Approve must **never** create two render
  batches — exactly one fires; the loser gets a clear "already advanced" message.
- **Back to Visual Concept** and **Approve the Visual Gag** must **never** close
  the modal — they update the step in place.

## Regression smoke (unchanged behavior)

- Triage (provisional approve / variant / reject) is unchanged.
- The final **Approve for Production** gate + waiver on Step 3 is unchanged.
- Advanced Options (Enrichment Editor, Runtime Compiled Prompt preview, test-render
  grid) behave as before — just relocated across Steps 2/3.
- Reject works from every step and records the same reasons.

## Known non-bugs / limitations

- **Renders are Step-3 only, by design.** Step 2 never shows the grid — that's the
  whole point (no spend before the gag is approved).
- **No render version history.** A bounce + re-approve discards the old batch and
  renders fresh; superseded in-flight jobs finish but are ignored.
- **Stale-but-saved is allowed.** If you edit Advanced Options *after* ideas were
  generated, a non-blocking note appears — the **saved concept** (not the AI
  cards) is what drives renders, so approval stays enabled.
- **Queue "Renders ready" is coarse.** The queue chip is a cheap aggregate; the
  modal/grid remains the authoritative place for per-scenario staleness.

## Bug report template

```
Fact / review id:
Step: (Triage / Visual Concept / Test Renders)
Action: (approve gag / save & continue / back to concept / bounce+re-approve / refresh / old row)
Expected:
Actual:
Screenshot:
```
