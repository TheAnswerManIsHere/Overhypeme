# Taxonomy and Enrichment

> How a submitted fact gets classified — its joke mechanism, tone, and
> content-safety fit — and how that classification stays current as the
> classification model, prompts, and code evolve, without ever silently
> overwriting a human's edits.
>
> Deep spec: [`taxonomy-and-enrichment.md`](../ai-context/taxonomy-and-enrichment.md).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

Every fact carries **enrichment** — structured metadata describing *how the
joke works*, not what picture to draw for it. That includes its primary
archetype (which of eleven joke mechanisms it uses), a subtype, tone
modifiers, how strong the "overhype" fit is, adult-suitability, cultural
references, named entities, suggested hashtags, and the AI's confidence in
its own read. It's produced once at moderation time and can be **refreshed**
later — deliberately, by a human — as the classification model and prompts
improve, without disturbing a fact's live content or any manual edit an admin
made to it.

Enrichment is explicitly **not** an image prompt. What the picture looks like
is a separate concern, owned by the Visual Concept and the render pipeline
(see [`visual-pipeline.md`](../ai-context/visual-pipeline.md)) — this area only answers
"what kind of joke is this, and is it safe/on-brand?"

**A variant is classified entirely on its own wording.** A variant fact
(alternate phrasing of the same joke as a "root" fact, linked for kinship and
show/hide grouping only) gets its own enrichment, taxonomy, Visual Concept,
and images — never its root's. Re-wording a root does **not** invalidate or
re-enrich its variants. See *Variants are independent facts* in the
[deep-spec doc](../ai-context/taxonomy-and-enrichment.md#variants-are-independent-facts).

## How it works

### For the reader / user

Nothing about enrichment is directly visible to a reader — it's the metadata
that lets Overhype.me filter, tag, and reason about facts (suggested
hashtags, content-safety gating, archetype-based curation). A user only feels
its effects indirectly: an accurately classified fact renders the right kind
of joke.

### For the admin (Taxonomy Health)

**Admin → Taxonomy Health** is where enrichment quality is monitored and
repaired. Every active fact rolls up into overlapping cards — a fact can
appear under more than one at once:

- **Missing / invalid enrichment** — no classification exists, or it fails
  validation. Fixed with **Re-enrich** (a real model call).
- **Needs admin review** — low confidence, a questionable content fit, a
  cultural reference or named entity flagged for human judgment.
- **Projection mismatch** — the four "promoted" columns (archetype, subtype,
  fit, suitability) drifted from what's actually stored in the enrichment
  JSON. Fixed with **Repair projections** — instant, no model call, safe to
  run repeatedly.
- **Stale enrichment version** — the fact was classified under an older
  prompt version.
- **Stale for reprocess** — the fact's enrichment is *good*, but it was
  produced under an older pipeline revision (see "Staleness has two different
  meanings," below). Its only remediation is **Send back to review**.

Each card's panel spells out exactly what the issue means, what fixing it
costs (model call vs. free, safe-to-repeat vs. overwrite-risk), and which
button does what — an admin should never have to guess whether an action is
safe to click twice.

### Refreshing a fact (the "send back to review" cycle)

A fact's classification doesn't have to be right forever — an admin can send
any live fact **back into moderation** for a fresh pass, one at a time from
the Facts page or the Taxonomy Health list, or **in bulk**, bounded per click
(see "A bulk send-back run is deliberately limited per click," below), from
the Stale-for-reprocess card. Sending a fact back:

- Keeps it fully live the whole time — the public feed and every reader-facing
  surface keep showing its current content, unaffected, until the refresh is
  actually approved.
- Preserves everything a human already decided about it — manual overrides
  and the moderator-authored Visual Concept both carry forward into the
  refresh candidate; only the AI's baseline classification is regenerated.
- Puts the fact through the **same two human gates** every submission clears
  — Visual Concept, then Test Renders — before the refreshed version can go
  live. **Sending a fact back only starts that cycle; it never finishes it on
  its own.** This holds whether it's one fact or fifty: bulk send-back is
  strictly a faster way to *queue* refreshes, never a way to skip the humans
  reviewing them.
- Works the same whether or not the fact has active variants. Root facts with
  active variants used to be blocked from bulk send-back, on the assumption
  that refreshing a root could invalidate its variants' classification —
  that assumption no longer holds now that a variant classifies from its own
  text only, so the block was removed.

### Staleness has two different meanings

Taxonomy Health tracks staleness two different ways, and they're easy to
conflate:

1. **The classification prompt moved.** A fact was classified under an older
   version of the AI prompt — the older, narrower signal.
2. **The processing pipeline moved.** A fact's *entire* processing
   fingerprint — engine revision, taxonomy version, classification version,
   image-prompt and visual-strategy code versions — is older than the current
   one. This is "**stale for reprocess**": the fact's enrichment is perfectly
   valid, it just hasn't benefited from the latest thinking.

They overlap heavily on older facts (most legacy facts are both), but they
clear differently. A direct **Re-enrich** can clear the first — it's a quick
model call straight to the fact's columns. It **cannot** clear the second,
because only a moderated refresh (send back → promote) actually re-stamps a
fact's processing fingerprint. That's why the Stale-for-reprocess card offers
only "Send back to review," never a direct Re-enrich button, even for facts
that are also flagged stale-enrichment-version.

Most of a fact's processing fingerprint moves automatically with the code
(a prompt or pipeline release bumps a version constant). One piece is
**manual**: an "engine revision" number an admin bumps by hand — via **Mark
major update** in the Taxonomy Health header — after a genuine LLM/engine
swap that no code version would otherwise capture. Bumping it is corpus-wide:
every fact processed under the old revision immediately reads as stale for
reprocess again, which is exactly the point (a fresh model deserves a fresh
pass), but it's a real, audited action, never something that happens as a
side effect of an unrelated config change.

## Why it works this way

- **AI-derived values and human edits never collapse into one blob.** An
  admin's manual edit to, say, the primary archetype is stored separately
  from the AI's own answer for that field, and the *effective* value an admin
  sees is always the human edit if one exists. This is what lets a
  re-classification refresh the AI's read without silently overwriting a
  decision a human already made — the single most important invariant in this
  area.
- **A refresh never touches the live fact until a human approves it.** The
  refreshed classification lives in a separate candidate row, not on the live
  fact, precisely so an in-progress refresh (queued, mid-review, or even
  rejected) can never leak into what readers see.
- **Bulk send-back only initiates, on purpose.** Early in planning this
  feature, the instinct was that "bulk reprocessing" shouldn't exist at all —
  moderation is deliberately human-gated, and a bulk action that skipped that
  gate would undermine the whole design. The resolution: because the Visual
  Concept and manual overrides carry forward on a refresh (they're not
  rebuilt from scratch), queuing many refreshes at once doesn't weaken the
  human review — it just saves an admin from clicking one button hundreds of
  times. See the [PR #168/#205 decision](../ai-context/decisions.md).
- **Engine/model identity is deliberately excluded from automatic
  staleness.** If which specific engine or model ID a fact was processed
  under counted toward staleness automatically, a routine config change could
  silently mark the entire corpus stale. Only a genuine, admin-acknowledged
  "major update" should do that — hence the manual engine-revision bump
  instead of an automatic one.

## Boundaries & known limitations

- **No automatic promotion, ever.** Nothing in this area — single-fact or
  bulk — promotes a refreshed fact on its own. A human approves the Visual
  Concept, then the Test Renders, exactly as for a first-time submission.
- **A bulk send-back run is deliberately limited per click.** On a corpus with
  a larger backlog (common right after a "Mark major update" bump, which
  can make most of the corpus stale at once), an admin clicks the button more
  than once over time. This is deliberate — it keeps the moderation queue
  from being flooded in one action. The limit itself is in
  [`taxonomy-and-enrichment.md`](../ai-context/taxonomy-and-enrichment.md).
- **A fact whose recent send-back attempts have repeatedly failed drops out
  of bulk runs.** This stops a persistently-broken fact from silently eating
  a bulk run's capacity forever, and stops an admin from being able to declare a
  bulk migration "complete" while that fact sits invisibly excluded — its
  failure streak (`repeatedFailureCount`) shows on the Taxonomy Health row
  list and the bulk-action response. The only way to clear the streak is to
  target that fact directly (single-fact or `scope: selected`), which is also
  the only path that resets the count.
- **The exact number of eligible facts isn't known before you click "send."**
  The confirm dialog states an upper bound rather than an exact count,
  because computing the exact number requires the same server-side work as
  actually running the batch. The real numbers show up immediately after.
- **A sent-back fact stays flagged stale until its refresh is actually
  promoted** — sending it back doesn't clear the flag by itself, only
  finishing the review cycle does.
- **No version rollback yet.** Every past enrichment version is kept as
  history, but there's no admin action to revert a fact to an older version —
  tracked as deferred work.

## Going deeper

- Spec: [`taxonomy-and-enrichment.md`](../ai-context/taxonomy-and-enrichment.md)
  — source-of-truth boundaries, the versioning model, the full Processing
  signature spec, and the async job/queue wiring behind bulk send-back.
- Related: [`moderation-workflow.md`](../ai-context/moderation-workflow.md)
  (the two human gates a refresh passes through),
  [`visual-pipeline.md`](../ai-context/visual-pipeline.md) (the Visual Concept a refresh
  carries forward), [`async-ui-status.md`](../ai-context/async-ui-status.md)
  (the two-altitude status rule bulk send-back follows).
- Rationale: the staleness/bulk-send-back entry in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 5 — *visual pipeline*, how an authored Visual Concept becomes
a rendered image. [Not yet written](./README.md#contents).
