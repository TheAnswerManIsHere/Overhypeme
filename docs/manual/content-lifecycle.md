# Content Lifecycle

> How a fact gets into Overhype.me in the first place — the three entrances
> (a user's own submission, an admin or automated bulk import, and a new
> variant of an existing fact) and the one funnel every entrance feeds
> into. What happens once a fact is in the queue is
> [`moderation.md`](./moderation.md)'s chapter, not this one.
>
> Deep spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md#the-ingestion-funnel--one-entrance).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

A fact can enter Overhype.me exactly three ways — a signed-in user submits
one, an admin or an external system imports a batch, or someone creates a
variant of a fact that's already live — and all three land in the same
place: a pending review, not the live catalogue. There is no fourth path and
no shortcut; nothing anywhere in the codebase can create a fact directly.
That single funnel is what lets [`moderation.md`](./moderation.md) describe
one review process and mean it for every fact, regardless of how it arrived.

This chapter covers the entrances themselves — what a submitter sees, what
an importer sends, what a variant inherits from its parent — and the
cheap, pre-review checks each one runs before a fact ever reaches a human.
What happens after that hand-off (triage, enrichment, the Visual Concept and
Test Renders gates, publication) belongs to moderation and taxonomy, and
this chapter links out rather than repeating it.

## How it works

### For the submitter (writing a fact)

Submitting is a two-step form: **write**, then **preview**. While the
submitter is writing, two checks run automatically in the background,
neither of which blocks anything:

- A **duplicate check** compares the draft against existing facts and
  surfaces a possible match with a similarity score, so the submitter can
  see it and decide for themselves whether to continue. Flagging isn't
  refusing — the submission still goes through, just carrying a note that
  it may be a near-duplicate, which a moderator weighs at Triage.
- A **grammar preview** (tokenizing) shows how the fact's `{NAME}` and
  pronoun placeholders will read once personalized, with a live preview
  across a few example names and pronoun sets, so the submitter can catch
  an awkward conjugation before sending it in.

Moving to Preview also fetches AI-suggested hashtags to pre-fill the
(editable) hashtags field — a non-blocking suggestion the submitter can keep,
edit, or clear.

Submitting requires being signed in. A onetime step also applies before a
first fact can be submitted: anyone who isn't an admin or an existing
Legendary member must complete onboarding (which includes a captcha check)
first; admins and Legendary members skip it. On submit, the server
re-normalizes the fact's grammar independently of what the client already
checked — a submission that reached the server without going through the
tokenize preview (an API client, a stale front-end) still gets the same
cleanup applied, so every fact that reaches the review queue has been
through the same grammar pass regardless of how it arrived. A submitter can
only have a limited number of their own facts waiting for review at once;
past that, new submissions are refused until earlier ones are resolved —
the exact limit is a configured value, not a narrative fact (see
`FACT_SUBMIT_PENDING_CAP` in `artifacts/api-server/src/lib/rateLimit.ts`).

Successful submission notifies admins and logs an activity-feed entry for
the submitter, who is later notified again when their fact clears or is
rejected.

### For the admin (bulk import)

Bulk import exists in two forms that both do the same thing — turn a batch
of fact texts into pending reviews — with different callers in mind:

- **From the admin console**, an admin pastes facts as JSON, CSV, or one
  fact per line and imports them in one action.
- **Via API key**, an external system posts the same kind of batch
  programmatically, with an optional dry-run mode that validates without
  writing anything.

Both paths run every text through the same grammar normalizer a user
submission uses, so an imported fact is indistinguishable in the queue from
one a person typed in by hand. Both also **dedupe by exact text** against
both the live catalogue and every review still waiting on a decision, before
inserting anything — so re-running the same import twice, or importing a
fact someone already submitted, queues nothing new for the ones that match.
This is a narrower check than the submitter's duplicate warning: it catches
identical text, not a reworded near-duplicate, and it silently skips rather
than flagging for a human, because bulk import is explicitly meant to run
unattended.

**Importing only loads the review queue — it never publishes anything.**
An imported fact is exactly as unpublished as a hand-submitted one; it
still has to clear every gate in [`moderation.md`](./moderation.md) before
it goes live.

### Creating a variant

A variant is an alternate phrasing of a joke that's already live, created
from the Facts editor against a specific **root** fact (a fact that has no
parent of its own — a variant of a variant isn't allowed; the target has to
be the root). Creating one is a normal submission in every way that
matters: the variant's text goes through the same grammar normalization as
a fresh fact, it enters at the same first review step as anything else, and
it earns its own classification, its own Visual Concept, and its own
images — none of that carries over from its parent. The only thing a
variant inherits at creation is the link to its parent, which moderation
uses later to keep the two facts grouped for show/hide and kinship, and
which is re-checked at the moment the variant would go live (its parent has
to still be an active root then, not just when the variant was created).

### Underneath: one funnel, one cost gate

All three entrances — the submit route, both import routes, and variant
creation — call the same function to create a pending review row, and
nothing else in the codebase does. That row starts at the very first stage
of the review pipeline; none of the entrances can hand a fact a head start.
Nothing paid runs at intake — no AI classification, no image lookups, no
renders — because that work only begins once a human moderator provisionally
accepts a submission at Triage. Intake is deliberately just the cheap parts:
normalize the grammar, check for a duplicate, queue the review, and stop.
See [`moderation-workflow.md`](../ai-context/moderation-workflow.md#why-staged-moderation-exists)
for what happens from there, and
[`moderation-workflow.md`'s ingestion-funnel section](../ai-context/moderation-workflow.md#the-ingestion-funnel--one-entrance)
for the funnel itself.

## Why it works this way

- **One funnel, so "every fact gets reviewed" is actually true.** If
  submission, import, and variant creation each wrote to the facts table in
  their own way, "nothing goes live without review" would be three separate
  promises to keep in sync instead of one function to trust. Routing every
  entrance through the same primitive means a change to how review starts —
  a new required field, a new starting stage — only has to be made once and
  is automatically true for every way a fact can arrive. See
  [Fact lifecycle closed: one entrance, one exit](../ai-context/decisions.md#2026-07-23--fact-lifecycle-closed-one-entrance-one-exit--activation-is-moderation-only-and-deactivation-is-reversible-through-moderation-not-a-direct-toggle).
- **The duplicate check at submission warns; it doesn't refuse.** A
  same-meaning fact phrased differently is a legitimate call for a human to
  make, not a machine — the submitter sees the possible match and decides
  whether to send it anyway, and if they do, a moderator sees the same flag
  at Triage. Blocking automatically would either reject real variants or
  need the exact wording match bulk import uses, which is far too blunt for
  something a human wrote from scratch.
- **Bulk import's dedupe is exact-text and silent, because it's meant to run
  unattended.** An automated import re-run, or two overlapping imports, is
  the normal case this guards — not a judgment call, so there's nothing for
  a human to weigh. A stricter, silent, exact match fits that job; a
  softer semantic check that occasionally guesses wrong would not.
- **Grammar normalization runs again at the server, even though the client
  already showed a preview of it.** The preview is for the submitter's
  benefit; the server-side pass is what actually determines what gets
  stored, so a submission that skipped the client (any path other than the
  standard form) can't reach the queue with an unexpanded token or an
  un-conjugated verb.

## Boundaries & known limitations

- **Duplicate detection at submission is advisory, not a gate.** A
  submitter can send a fact flagged as a likely duplicate; nothing stops
  them, and nothing stops a moderator from approving it anyway if they
  disagree with the flag.
- **Bulk import's dedupe only catches exact text.** Two imports of the same
  fact with even a single character different both queue.
- **A submitter's pending cap is per-user, not per-fact-type or global** —
  it counts every submission of theirs still waiting anywhere in the review
  pipeline, not just ones stuck at the first step.
- **A rejected grammar template (422) tells the submitter what failed, but
  there's no in-line fix-it flow** — they have to edit the raw text and
  resubmit through the normal form.

## Going deeper

- Spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md) — the
  ingestion funnel, the activation chokepoint, and everything that happens
  to a fact after it's queued.
- Related: [`moderation.md`](./moderation.md) (the three-gate review a
  queued fact goes through), [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)
  (what a fact's classification means and how it's produced), and
  [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues)
  (the async lanes that run a fact's prep work once it's accepted).
- Rationale: the fact-lifecycle entries in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 3 — [`moderation.md`](./moderation.md), the three human
gates a queued fact walks through before it can go live.

*Verified against `b720d6f` (2026-08-08) · claim inventory in PR #<TBD>.*
