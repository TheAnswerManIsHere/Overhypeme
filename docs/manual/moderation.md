# Chapter 3 · Moderation

> How a user-submitted fact gets reviewed and either published or rejected —
> the [three human gates](../ai-context/glossary.md#gate) it passes through, and why the process is shaped to spend
> money only on submissions a human has already vouched for.
>
> **Overhype.me has two separate moderation systems**, and this chapter is
> mostly about the first: *content quality* ("is this joke good enough to
> publish?"). The second is *[legal/safety](../ai-context/glossary.md#legalsafety-moderation)* ("is this content illegal?") — a
> completely separate track with different machinery, covered in its own
> section at the end.
>
> Deep specs: [`moderation-workflow.md`](../ai-context/moderation-workflow.md)
> (content quality),
> [`legal-safety-moderation.md`](../ai-context/legal-safety-moderation.md)
> (legal/safety).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

Every fact entering the system — a user submission, an admin/API [bulk import](../ai-context/glossary.md#bulk-import),
or a new [variant](../ai-context/glossary.md#variant) of an existing fact — lands in a [review queue](../ai-context/glossary.md#review-queue), not the live
catalogue. There is no other way in: a fact cannot be created directly. A
moderator walks it through three gates — **[Triage](../ai-context/glossary.md#triage)**, **[Visual Concept](../ai-context/glossary.md#visual-concept)**, and
**[Test Renders](../ai-context/glossary.md#test-renders)** — and only a fact that clears all three goes live. The whole
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
   a reason) or **[provisionally approves](../ai-context/glossary.md#provisional-approval)** it. Provisional approval is the moment
   the paid **[moderation prep](../ai-context/glossary.md#moderation-prep) and render work** — [enrichment](../ai-context/glossary.md#enrichment), visual-idea
   drafting, and the per-image test renders — is allowed to begin; before it,
   none of that moderation/render spend has happened. (Cheap pre-submit
   affordances the [submitter](../ai-context/glossary.md#submitter) already used — tokenizing the fact, suggesting
   pronouns, duplicate-checking — do touch utility LLMs and embeddings; what
   Triage gates is the expensive moderation pipeline, not every LLM call ever
   made about the fact.)

2. **Visual Concept.** After the AI has classified the fact, the review arrives
   here. The moderator works on the **Visual Concept** — the plain-language
   "describe the picture" scene that is the authoritative description of how the
   gag works visually. They can accept one of several AI-drafted idea cards, edit
   one, or write their own, then **"approve the [visual gag](../ai-context/glossary.md#visual-gag)."** Crucially, **no
   test renders have run yet** — this gate is deliberately free. Approving the gag
   is what unlocks render spend.

   Writing the concept (and the rest of the [Visual Strategy Override](../ai-context/glossary.md#visual-strategy-override), in
   Advanced Options) is plain-English authoring — naming the subject naturally
   is enough. Clicking Save [auto-tokenizes](../ai-context/glossary.md#tokenize) it and shows the moderator the
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

**A "refresh" (re-processing an already-live fact with updated [taxonomy](../ai-context/glossary.md#taxonomy) or
enrichment) is a separate case, and it is never a fact rejection.** The fact
already exists and stays published in the database no matter what happens to
the refresh — declining just means the proposed update isn't promoted; the
fact keeps its current, unchanged production content until a future refresh
succeeds. There's no "reason" picker for this (duplicate/spam/offensive
questions don't apply to a fact that's already live) — just an optional note
explaining why.

Throughout, the queue and the modal show live status at [two altitudes](../ai-context/glossary.md#two-altitudes) — a
per-fact "what's happening now" (Enriching… → Generating visual ideas… → Ready
for concept review → Rendering… → Renders ready) and an aggregate view — so a
moderator never has to guess whether [background work](../ai-context/glossary.md#background-work) is running, done, or stuck.

### Taking a fact down, and bringing it back

An admin can [deactivate](../ai-context/glossary.md#deactivate) a live fact at any time from the [Facts editor](../ai-context/glossary.md#facts-editor) — that
always works, immediately. Bringing one back is deliberately **not** a
same-click undo: the Active toggle can't be switched back on directly, because
doing so would skip the whole review this chapter describes. Instead, an
inactive fact gets a **"[Resubmit for Moderation](../ai-context/glossary.md#resubmit-for-moderation)"** button, which puts it back
through the same three-gate review under its existing history — it re-enrichs,
gets a fresh Visual Concept review, and needs production approval again before
it's live. Nothing about a deactivated fact is ever truly stuck: it's always
one resubmit away from re-entering the queue.

### Underneath (plain-language machinery)

A submission becomes a row in a review table with a coarse status
(`pending/approved/rejected`) and a fine-grained **[workflow stage](../ai-context/glossary.md#workflow-stage)** that drives
the three gates. Provisional approval creates an **inactive "[staging fact](../ai-context/glossary.md#staging-fact)"** — a
real catalogue row that isn't published yet — and all the paid prep (AI
classification, stock-image lookup, test renders) runs against *that*, so the
live catalogue is never touched by in-progress work. Approving for production
simply flips the staging fact to live.

Renders are **forced fresh** each time the gag is approved: the job that prepares
them deliberately does not reuse any prior batch, so bouncing a fact back to the
Visual Concept step and re-approving always re-renders from scratch — even if the
concept text didn't change.

## The other moderation system: legal and safety

Everything above is about whether a fact is *good enough* to publish.
Running alongside it, and sharing nothing with it, is a second system
asking a completely different question: **is this content illegal?**

### What it does

Images entering the product — a photo someone uploads to put their face
in a meme, and imagery the AI generates — are checked by automated
safety controls before they can become anything a user saves or shares.

**Those controls are not all the same thing, and the difference is worth
stating plainly.** Matching an image against known child sexual abuse
material is a specific capability that works by comparison against an
existing catalogue of it. Assessing a novel image for whether it looks
abusive is a different and weaker kind of judgment. Overhype.me uses both
kinds, but they don't apply uniformly to every path, and the second kind
should not be described — or relied on — as though it were the first.

If an image is [refused](../ai-context/glossary.md#refused), the person who uploaded it gets a plain,
deliberately unspecific message that the image can't be uploaded — it
never says which check objected or why. That's on purpose: a detailed
rejection reason is a free hint for anyone probing to find what gets
through.

### What happens to refused content

Refused content is **[quarantined](../ai-context/glossary.md#quarantine)**, which is a stronger thing than
"hidden." The image is preserved as evidence in storage that has no
serving path at all — no admin viewer, no share link, no way for anyone
to look at it through the product. The upload itself simply fails; no
meme is ever created from it.

**Preservation isn't currently universal, though.** Some refusal paths
block the content without keeping a copy of it, so "refused" and "kept as
evidence" aren't the same thing today. The blocking works either way;
what varies is whether there's a record afterward.

Quarantine is a **one-way door**. There's no appeal, no release, and no
re-review — by design, not by omission.

### Why the evidence is kept, and kept away from deletion

US law obliges a platform that becomes aware of apparent child sexual
abuse material to preserve the report and its supporting evidence for a
minimum period. Overhype.me implements that in a few deliberate ways:
storage refuses to delete anything in the protected area without an
explicit override, and the records deliberately survive even a full
account deletion — deleting a user detaches their name from the record
but never removes the record or the evidence.

The audit trail is protected in the opposite direction, too: a record
that has been acted on can't be deleted at all, and the log of *who* acted
on it deliberately isn't tied to their account — so removing an admin
account can't erase the trace of what that admin did.

### What's built, and what honestly isn't

This is the part worth being precise about, because safety infrastructure
described optimistically is worse than none.

**Working today:** the scanning, the refusal, the quarantine, and the
evidence preservation. Admin alerting exists but is only partially
wired — some quarantines raise an alert and some currently don't.

**Not working yet:** the actual reporting to the national clearinghouse
that handles these referrals. The plumbing for it has been built and
tested, but it's deliberately switched off and connected to nothing —
**no report has ever been filed from this system.** Several later stages
haven't been built at all: the worker that would submit reports, an admin
screen for reviewing any of this, and alerting for when a submission
*fails* (distinct from the partial alerting that exists today for some
refusals). The settings that would turn filing on are locked: the product
refuses to change them through the normal settings screen, precisely so
nobody can switch on live reporting before the rest of it exists.

**A gap worth naming:** a substantial share of refusals are recorded and
then seen by nobody — there's no screen anywhere that shows those
records, and alerting doesn't cover every case. The content is still
blocked, every time; what's missing is a human ever looking at what was
blocked, or being able to.

**A consequence worth naming too:** because refusals are automated,
permanent, and unreviewable, a false positive on an ordinary image is
currently unappealable. There is no path to have a wrongly-refused image
looked at by a person.

### Why it's separate from the review queue

The two systems never touch, and that's structural rather than
coincidental. Content quality is a judgment call a moderator makes about
whether a joke is worth publishing; this track is an automated call made
before a human is ever involved. A moderator can't approve their way past
a refusal — not because a rule forbids it, but because a refused upload
never becomes a reviewable item in the first place.

**Don't read "legal/safety" as meaning every refusal here is a finding
about legality.** The checks in this track aren't all the same kind of
thing: one is a comparison against known illegal material, while another
is an adjustable content-rating judgment that can even be affected by a
user's own content preferences. A refusal from the second kind means
"this tripped a content-safety filter," not "this was determined to be
illegal" — and the records it produces shouldn't be read, by an operator
or by anyone downstream, as if it did.

## Why it works this way

- **A refusal message says as little as possible, on purpose.** Telling
  someone precisely why an image was rejected tells them what to change —
  which is useful feedback for an ordinary mistake and an instruction
  manual for someone deliberately probing the system. For this specific
  category, the second concern wins.
- **Quarantine preserves rather than deletes**, because for this category
  the legal obligation runs the opposite direction from the usual privacy
  instinct: the evidence has to survive, including surviving the deletion
  of the account that produced it.
- **The reporting switches are locked rather than merely left off.**
  Being switched off and being impossible to switch on through the normal
  admin screen are very different guarantees, and only the second one
  prevents a well-meaning admin from activating a legally-consequential
  integration before its safeguards exist.
- **Cost-gating, in order.** Enrichment, image lookups, and renders all cost
  money. A cheap human triage gate first means no paid work runs on spam,
  duplicates, or low-quality submissions. → [Staged, cost-gated moderation](../ai-context/decisions.md)

- **The Visual Concept earned its own gate.** It used to be one control buried in
  a single bundled "visual review" step, and renders fired the instant
  classification finished. But with a strong [visual planner](../ai-context/glossary.md#visual-planner), the concept became
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
- **[Stock images](../ai-context/glossary.md#stock-image) and test renders are review aids, not hard gates.** A moderator
  can approve despite missing/[stale renders](../ai-context/glossary.md#stale-render), which records an [auditable waiver](../ai-context/glossary.md#waiver) —
  not a silent skip. (Whether any render should become a *hard* gate is an open
  product question.)
- **Visual ideas can fail or be absent.** Generation is a real AI call; a failed
  or never-generated state blocks gag approval with a clear "regenerate" action
  rather than a silent block — and a required step that never ran reads as "not
  generated," never as a spinner.

## Going deeper

- Spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md) — stages,
  staging facts, rejection paths, the refresh ([send-back](../ai-context/glossary.md#send-back-to-review)) cycle.
- Legal/safety spec:
  [`legal-safety-moderation.md`](../ai-context/legal-safety-moderation.md) —
  the scanning layers, quarantine, evidence retention, and the current
  built-vs-not state of NCMEC reporting. Note that specific detection
  values are deliberately omitted from that document, and from this
  chapter, so they aren't published in a public repo.
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

*Verified against `4fd4c66` (2026-08-09) · claim inventory in PR #381.*
