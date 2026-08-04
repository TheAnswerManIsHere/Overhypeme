# Moderation

> How a user-submitted fact gets reviewed and either published or rejected —
> the three human gates it passes through, and why the process is shaped to spend
> money only on submissions a human has already vouched for.
>
> Deep spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

Every fact entering the system — a user submission, an admin/API bulk import,
or a new variant of an existing fact — lands in a review queue, not the live
catalogue. There is no other way in: a fact cannot be created directly. A
moderator walks it through three gates — **Triage**, **Visual Concept**, and
**Test Renders** — and only a fact that clears all three goes live. The whole
design exists to answer two questions cheaply and in order: *does this fact
deserve to exist?*, then *does its joke work as a picture?*, and only then to
spend the (real, per-image) money on rendering it.

Going live is gated just as strictly on the way out: a fact cannot be
published, by any code path, without a saved, non-empty Visual Concept — the
database itself refuses to store an active fact without one.

## How it works

### For the moderator (three steps)

The review opens as a three-step wizard:

1. **Triage.** The cheap first pass. The moderator sees the submitted fact, any
   near-duplicate it resembles, and who sent it, and either **rejects** it (with
   a reason) or **provisionally approves** it. Provisional approval is the moment
   the paid **moderation prep and render work** — enrichment, visual-idea
   drafting, and the per-image test renders — is allowed to begin; before it,
   none of that moderation/render spend has happened. (Cheap pre-submit
   affordances the submitter already used — tokenizing the fact, suggesting
   pronouns, duplicate-checking — do touch utility LLMs and embeddings; what
   Triage gates is the expensive moderation pipeline, not every LLM call ever
   made about the fact.)

2. **Visual Concept.** After the AI has classified the fact, the review arrives
   here. The moderator works on the **Visual Concept** — the plain-language
   "describe the picture" scene that is the authoritative description of how the
   gag works visually. They can accept one of several AI-drafted idea cards, edit
   one, or write their own, then **"approve the visual gag."** Crucially, **no
   test renders have run yet** — this gate is deliberately free. Approving the gag
   is what unlocks render spend.

   Writing the concept (and the rest of the Visual Strategy Override, in
   Advanced Options) is plain-English authoring — naming the subject naturally
   is enough. Clicking Save auto-tokenizes it and shows the moderator the
   personalized version before it persists, so the same scene works correctly
   no matter who the fact ends up rendered for.

3. **Test Renders.** On arrival, the test-render images **fire automatically**.
   The moderator inspects the rendered memes, tweaks the concept or enrichment and
   re-runs as needed, and finally **approves for production** (which publishes the
   fact). From here they can also **send the fact back to Visual Concept** if
   the gag itself needs rethinking.

**Rejection only happens at Triage.** Once a submission clears that first
pass, it can no longer be rejected — a failed prep, an unfinished Visual
Concept, or a render that isn't working just leaves the fact **pending**. It's
on the moderator/admin to fix the underlying issue (retry prep, rework the
concept, fix the render); the fact only ever moves forward to production once
that's done, never sideways into rejected.

**A "refresh" (re-processing an already-live fact with updated taxonomy or
enrichment) is a separate case, and it is never a fact rejection.** The fact
already exists and stays published in the database no matter what happens to
the refresh — declining just means the proposed update isn't promoted; the
fact keeps its current, unchanged production content until a future refresh
succeeds. There's no "reason" picker for this (duplicate/spam/offensive
questions don't apply to a fact that's already live) — just an optional note
explaining why.

Throughout, the queue and the modal show live status at two altitudes — a
per-fact "what's happening now" (Enriching… → Generating visual ideas… → Ready
for concept review → Rendering… → Renders ready) and an aggregate view — so a
moderator never has to guess whether background work is running, done, or stuck.

### Taking a fact down, and bringing it back

An admin can deactivate a live fact at any time from the Facts editor — that
always works, immediately. Bringing one back is deliberately **not** a
same-click undo: the Active toggle can't be switched back on directly, because
doing so would skip the whole review this chapter describes. Instead, an
inactive fact gets a **"Resubmit for Moderation"** button, which puts it back
through the same three-gate review under its existing history — it re-enrichs,
gets a fresh Visual Concept review, and needs production approval again before
it's live. Nothing about a deactivated fact is ever truly stuck: it's always
one resubmit away from re-entering the queue.

### Underneath (plain-language machinery)

A submission becomes a row in a review table with a coarse status
(`pending/approved/rejected`) and a fine-grained **workflow stage** that drives
the three gates. Provisional approval creates an **inactive "staging fact"** — a
real catalogue row that isn't published yet — and all the paid prep (AI
classification, stock-image lookup, test renders) runs against *that*, so the
live catalogue is never touched by in-progress work. Approving for production
simply flips the staging fact to live.

Renders are **forced fresh** each time the gag is approved: the job that prepares
them deliberately does not reuse any prior batch, so bouncing a fact back to the
Visual Concept step and re-approving always re-renders from scratch — even if the
concept text didn't change.

## Why it works this way

- **Cost-gating, in order.** Enrichment, image lookups, and renders all cost
  money. A cheap human triage gate first means no paid work runs on spam,
  duplicates, or low-quality submissions. → [Staged, cost-gated moderation](../ai-context/decisions.md)

- **The Visual Concept earned its own gate.** It used to be one control buried in
  a single bundled "visual review" step, and renders fired the instant
  classification finished. But with a strong visual planner, the concept became
  *the* description of how a gag works as a picture — so it now deserves a human
  eval on every fact, and renders shouldn't fire until that eval passes. That's
  why the flow was split into an explicit **Visual Concept** gate before **Test
  Renders**. → [Visual Concept is a mandatory human gate before any render spend](../ai-context/decisions.md)

- **The *saved* concept is the contract, not the AI's suggestions.** Approval
  checks the persisted scene, never an unsaved draft or the AI candidate cards —
  and a concept saved before a later tweak still counts (only missing/failed/
  still-generating ideas block approval). This keeps "what the moderator approved"
  unambiguous.

- **Bounce-and-re-approve renders fresh, on purpose.** Rather than track render
  "versions" or hard-cancel in-flight jobs, a re-approval just forces a new batch;
  superseded renders finish but are ignored. Simpler, and it never shows a
  moderator a stale image as if it were current. (Rejected alternative: a durable
  render-cycle token / batch table — deferred as unnecessary.)

- **Existing in-flight reviews were left where they were.** Facts already at the
  render step when this shipped keep working under the old gates; the new concept
  gate only applies if a moderator voluntarily sends one back. No risky
  back-migration of live moderation state.

- **Reactivating a fact always re-earns its way through review.** A direct
  "flip it back on" toggle would let a fact go live again without anyone
  re-checking its Visual Concept still holds up — so bringing a deactivated
  fact back always means resubmitting it through the same gates a brand-new
  fact goes through, never a shortcut. → [Fact lifecycle closed: one entrance,
  one exit](../ai-context/decisions.md#2026-07-23--fact-lifecycle-closed-one-entrance-one-exit--activation-is-moderation-only-and-deactivation-is-reversible-through-moderation-not-a-direct-toggle)

## Boundaries & known limitations

- **Renders are a Test-Renders-step concern only** — by design, the Visual
  Concept step never shows the render grid, because its whole point is to decide
  the gag *before* spending on images.
- **No render history.** A bounce discards the old batch and renders fresh; there
  is no "compare to the previous render" view.
- **Stock images and test renders are review aids, not hard gates.** A moderator
  can approve despite missing/stale renders, which records an auditable waiver —
  not a silent skip. (Whether any render should become a *hard* gate is an open
  product question.)
- **Visual ideas can fail or be absent.** Generation is a real AI call; a failed
  or never-generated state blocks gag approval with a clear "regenerate" action
  rather than a silent block — and a required step that never ran reads as "not
  generated," never as a spinner.

## Going deeper

- Spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md) — stages,
  staging facts, rejection paths, the refresh (send-back) cycle.
- Related: [`visual-pipeline.md`](../ai-context/visual-pipeline.md) (the Visual
  Concept and how it becomes an image),
  [`taxonomy-and-enrichment.md`](../ai-context/taxonomy-and-enrichment.md)
  (classification + versioned refresh),
  [`async-ui-status.md`](../ai-context/async-ui-status.md) (the two-altitude
  status rule the queue follows).
- Rationale: the moderation entries in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 4 — [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md),
what happens to an approved fact's classification and how a refresh keeps it
current.
