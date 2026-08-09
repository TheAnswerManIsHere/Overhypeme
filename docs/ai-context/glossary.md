# Glossary

> Fast lookup for Overhype.me's product-specific terms — what each one means
> here, with a pointer to the deep doc. When a term's meaning changes, fix it
> here **and** in the deep doc.
>
> **Every term is a `###` heading**, so each has a stable anchor the
> [manual](../manual/README.md) links into on first use. Renaming a heading
> breaks those links — rename deliberately, and update the manual in the same
> commit.
>
> Many entries are ordinary English words that mean something **specific**
> here: *preview*, *grammar*, *recipe*, *root*, *lane*, *skipped*, *remove*.
> Those are the ones worth checking even when you think you know them.

## Contents

- [Core content model](#core-content-model)
- [Personalization and grammar](#personalization-and-grammar)
- [Submission and intake](#submission-and-intake)
- [Moderation and review](#moderation-and-review)
- [Taxonomy and enrichment](#taxonomy-and-enrichment)
- [Visual pipeline and rendering](#visual-pipeline-and-rendering)
- [Memes and the studio](#memes-and-the-studio)
- [Public site and sharing](#public-site-and-sharing)
- [Community and engagement](#community-and-engagement)
- [Accounts and roles](#accounts-and-roles)
- [Payments and membership](#payments-and-membership)
- [Admin console](#admin-console)
- [Background work](#background-work)
- [Ways of working](#ways-of-working)

---

## Core content model

### Core loop

The single cycle the whole product runs on, and the order the
[manual](../manual/README.md) is written in: **personalize → submit →
moderate & enrich → render → share → the next visitor personalizes.** Each
verb in that chain is a term in this glossary with a specific local meaning.
→ [product-brief](./product-brief.md)

### Fact

The core content entity: an exaggerated, personalizable statement stored once
as a **tokenized template** (`facts` table, `text` column) and rendered on
demand for any name/pronoun set. Not stored per-name.
→ [product-brief](./product-brief.md), [token-rendering](./token-rendering-and-grammar.md)

### Overhype

The product's own joke premise, and a classification field: how strongly a
fact reads as an absurd, over-the-top exaggeration about a person. Enrichment
scores each fact's "overhype fit"; a weak fit is a signal for a moderator, not
an automatic rejection.
→ [product-brief](./product-brief.md), [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Variant

A fact that expresses **the same concept** as another fact in slightly
different words, linked by `facts.parent_id` to the **root**. The link exists
for exactly two purposes: recording that kinship, and letting the UI show or
hide variants. **A variant is otherwise a fully independent fact** — it owns
its own memes, taxonomy/enrichment, Visual Concept, and stock/AI images, and it
inherits **no** metadata from its root.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md#variants-are-independent-facts)

### Root

The primary example of a concept — a fact with no parent of its own. A variant
points at a root; a variant *of a variant* is not allowed, so the target of a
new variant always has to be a root. "Root" says nothing about quality or
seniority beyond that: it is a position in the kinship link, not a rank.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md#variants-are-independent-facts)

### Staging fact

A `facts` row with `isActive = false`: prepped but not published. Production
approval flips it `isActive = true` (live); published = an active row exists (no
status enum on `facts`).
→ [moderation-workflow](./moderation-workflow.md)

### Active

Whether a fact is published and visible on the public site (`facts.isActive`).
An admin can deactivate a live fact instantly, but **cannot** flip it back on
directly — reactivation goes through
[Resubmit for Moderation](#resubmit-for-moderation), so nothing returns to the
site without re-clearing review.
→ [moderation-workflow](./moderation-workflow.md#the-activation-chokepoint--one-exit)

---

## Personalization and grammar

### Personalization tokens

The closed set a template may use: `{NAME}`, `{NAME_POSSESSIVE}`, the pronoun
tokens (`{SUBJ}`/`{OBJ}`/`{POSS}`/`{POSS_PRO}`/`{REFL}` + capitalized variants),
and conjugation pairs like `{laughs|laugh}`.
→ [token-rendering](./token-rendering-and-grammar.md)

### Rendering

Substituting tokens with a name + pronoun set to produce natural text (the name
highlighted orange). **Distinct from *image* rendering** — the same word is used
for both, and which one is meant depends entirely on context. Where it matters,
the manual says "rendering a fact" or "test renders" rather than the bare word.
→ [token-rendering](./token-rendering-and-grammar.md)

### Tokenize

Turning plain English into a stored template — deciding which words become
placeholders and which verbs need to be able to change form. A one-time
decision made when text is written, deliberately kept separate from
[rendering](#rendering), which only ever fills in what tokenizing already
decided. Both fact submission and Visual Concept authoring run through the
*same* tokenizer, so the two can never drift apart.
→ [token-rendering](./token-rendering-and-grammar.md)

### Grammar pass

The fixed, code-owned correction pass that runs over every AI-proposed
template and fixes the specific mistakes a model makes (a verb marked
changeable that shouldn't be, and the reverse). "Grammar" in this product
almost always means **this deterministic pass**, not grammar in general. It
also runs on any template that reached storage by a path that skipped the AI
step, so a template can't be stored half-corrected.
→ [token-rendering](./token-rendering-and-grammar.md)

### Pronoun set

The group of pronouns applied together when rendering — she/her, he/him,
they/them, or a custom set. Overhype.me guesses one from a typed name and the
reader can always correct it. A registered user can save a default set on their
profile, which affects only **their own** reading of every fact, never how
anyone else sees facts that user submitted.
→ [token-rendering](./token-rendering-and-grammar.md)

### Conjugation pair

A two-form verb written into a template as `{laughs|laugh}` — singular form
first, plural second. The [grammar pass](#grammar-pass) decides *which* verbs
get wrapped this way (structure, decided once at write time); which form
actually renders for a given reader is a separate, later decision made fresh
by [rendering](#rendering) itself, based on whichever
[pronoun set](#pronoun-set) that reader ends up using (content).
→ [token-rendering](./token-rendering-and-grammar.md)

---

## Submission and intake

### Submitter

The account credited with submitting a fact. Not always a real end user: an
admin-console [bulk import](#bulk-import) attributes the acting admin as
submitter, and an API-key import has **no** submitter at all.
→ [content-lifecycle](../manual/content-lifecycle.md)

### Preview

**Step 2 of the submit form** — and a required, blocking step, not an optional
look. Clicking Preview runs the draft through a [grammar pass](#grammar-pass)
and shows the fact rendered across example names and pronoun sets; a failed
pass keeps the submitter on Write. Distinct from
[rich preview](#rich-preview) (what a shared link looks like elsewhere), the
admin [compiled-prompt preview](#compiled-prompt), and the merch product
preview — four different things called "preview."
→ [content-lifecycle](../manual/content-lifecycle.md#for-the-submitter-writing-a-fact)

### Autosaved draft

A submission in progress, kept so a submitter can come back to it. Picking one
up skips straight to [Preview](#preview) with the saved template and does
**not** re-fetch fresh hashtag suggestions.
→ [content-lifecycle](../manual/content-lifecycle.md#for-the-submitter-writing-a-fact)

### Onboarding

The one-time challenge (including a captcha) a fresh account completes **once**
before it can submit its first fact. Admins and existing Legendary members skip
it. It is not a separate account type — it is a step layered on top of an
ordinary account, and until it's done you can still sign in and browse.
→ [accounts-and-auth](./accounts-and-auth.md)

### Bulk import

Turning a batch of fact texts into pending reviews in one action — from the
admin console (JSON, CSV, or one per line) or programmatically via API key
(with an optional dry-run). **Importing only loads the review queue; it never
publishes anything.**
→ [content-lifecycle](../manual/content-lifecycle.md#for-the-admin-bulk-import)

### Exact-text dedupe

The check both [bulk import](#bulk-import) paths run before inserting: skip any
text that, after normalization, already exists as a fact row or a pending
review. Deliberately narrower and stricter than
[duplicate detection](#duplicate-detection) — it catches identical text, not a
reworded near-match, and it skips silently rather than flagging a human,
because an exact match leaves nothing to judge.
→ [content-lifecycle](../manual/content-lifecycle.md#for-the-admin-bulk-import)

### Duplicate detection

Near-duplicate flagging via a 384-dim OpenAI embedding on `facts.embedding`
(`pgvector`); a candidate match + similarity is recorded on the review and the
moderator decides. **Advisory, never a gate** — and best-effort: submitting
before the check resolves reaches the server with no flag at all.
→ [architecture-map](./architecture-map.md)

### Ingestion funnel

The rule that a fact can enter Overhype.me exactly three ways — user
submission, bulk import, variant creation — and that all three call the *same*
function to create a pending review. There is no fourth path in the running
product, which is what makes "every fact gets reviewed" one promise instead of
three.
→ [moderation-workflow](./moderation-workflow.md#the-ingestion-funnel--one-entrance)

---

## Moderation and review

### Moderation

The staged, cost-gated approval workflow for submissions, living in
`pending_reviews` with a `review_workflow_stage`. Three human gates:
`triage_pending → prep_pending/prep_failed → concept_review (Step 2: Visual
Concept) → production_review (Step 3: Test Renders) →
production_approved/production_rejected`. Renders fire only at Step 3.
→ [moderation-workflow](./moderation-workflow.md)

### Review queue

The set of submissions waiting on a moderator — where every fact lands
regardless of how it arrived, and the thing an imported fact loads rather than
bypasses. Comments have their own, much lighter queue that shares the name but
none of the three-gate machinery.
→ [moderation-workflow](./moderation-workflow.md)

### Pending review

The row every [ingestion funnel](#ingestion-funnel) entrance creates — the
thing a fact actually *becomes* on submission, as opposed to a live catalogue
entry. All three entrances call the same function to create one, and nothing
else in the running product does.
→ [moderation-workflow](./moderation-workflow.md#the-ingestion-funnel--one-entrance)

### Gate

One of the three human checkpoints a fact clears before publication —
[Triage](#triage), [Visual Concept](#visual-concept),
[Test Renders](#test-renders) — ordered so the cheapest judgment happens
first and money is only spent on a submission a human has already vouched
for. "Gate" always means a *human* checkpoint here; automated checks are
never called gates.
→ [moderation-workflow](./moderation-workflow.md)

### Comment moderation

The separate, much lighter review a comment goes through: still always a human
approval before it becomes visible, but with **no automated pre-screening at
all** — no AI assist in the loop the way fact submissions have, and none of the
three-gate machinery.
→ [community-and-engagement](./community-and-engagement.md)

### Legal/safety moderation

The **second, entirely separate** moderation system, asking "is this content
illegal?" rather than "is this joke good enough?" It shares nothing with
content-quality review: it runs automatically before a human is ever involved,
and a moderator cannot approve past it, because
[refused](#refused) content never becomes a reviewable item at all. Do **not**
read every refusal here as a finding about legality — one check compares
against known illegal material, another is an adjustable content-rating
judgment.
→ [legal-safety-moderation](./legal-safety-moderation.md)

### Refused

What the [legal/safety](#legalsafety-moderation) checks do to an image —
deliberately **not** the same word as *rejected*, which is what a moderator
does to a fact at [Triage](#triage). A refusal is automated, permanent, and
unappealable, and the uploader gets a deliberately unspecific message that
never says which check objected (a detailed reason is a free hint to anyone
probing).
→ [legal-safety-moderation](./legal-safety-moderation.md)

### Workflow stage

The fine-grained `review_workflow_stage` that drives the three gates —
distinct from the review's coarse `pending/approved/rejected` status. The
coarse status says whether a decision has been reached; the stage says where in
the pipeline it currently sits.
→ [moderation-workflow](./moderation-workflow.md)

### Triage

The cheap first gate: a moderator sees the fact, any near-duplicate, and who
sent it, then either rejects it with a reason or
[provisionally approves](#provisional-approval) it. **The only gate where
rejection is possible** — past Triage a fact can only move forward or sit
pending.
→ [moderation-workflow](./moderation-workflow.md)

### Provisional approval

Clearing [Triage](#triage) — the moment paid [moderation prep](#moderation-prep)
is allowed to begin. It also creates the inactive [staging fact](#staging-fact)
that all the prep work runs against, so the live catalogue is never touched by
in-progress work.
→ [moderation-workflow](./moderation-workflow.md)

### Moderation prep

The paid pipeline that runs only after [provisional approval](#provisional-approval):
AI classification, stock-image lookup, and visual-idea drafting — enqueuing
Visual-Idea candidates, with **no renders yet**. Per-image
[test renders](#test-renders) are a separate, later spend, unlocked only once
a moderator approves the [Visual Concept](#visual-concept); they are not part
of prep itself. What [Triage](#triage) gates is *this pipeline*, not every
model call ever made about a fact — the cheap pre-submit affordances
(tokenizing, duplicate checking, hashtag suggestions) already ran before a
moderator saw it.
→ [moderation-workflow](./moderation-workflow.md#why-staged-moderation-exists)

### Test Renders

The third gate. Test-render images fire automatically on arrival; the moderator
inspects them, re-runs as needed, and either approves for production (which
publishes the fact) or sends it back to the Visual Concept step. A
re-approval always renders **fresh** — no prior batch is ever reused.
→ [visual-pipeline](./visual-pipeline.md)

### Visual gag

How the joke works *as a picture* — what a moderator is approving when they
"approve the visual gag" at the [Visual Concept](#visual-concept) gate. This
gate is deliberately free: approving the gag is what unlocks render spend, so
no test render has run yet at the moment of the decision.
→ [moderation-workflow](./moderation-workflow.md)

### Waiver

An auditable record that a moderator approved despite missing or stale test
renders. Stock images and test renders are review *aids*, not hard gates — so
approving anyway is allowed, but it is recorded rather than silently skipped.
→ [moderation-workflow](./moderation-workflow.md)

### Send back to review

Returning an already-live fact to moderation for a fresh classification pass —
also called a **refresh**. The fact **stays fully live** the whole time,
manual overrides and the authored Visual Concept carry forward, and only the
AI baseline is regenerated. Sending back only *starts* the cycle; a human
still clears both remaining gates before anything is promoted. Declining a
refresh is never a fact rejection.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Resubmit for Moderation

The button on an inactive fact that puts it back through the full three-gate
review under its existing history. Deliberately **not** a same-click undo of
deactivation — a direct "flip it back on" toggle would let a fact go live again
without anyone re-checking that its Visual Concept still holds up.
→ [moderation-workflow](./moderation-workflow.md#the-activation-chokepoint--one-exit)

### Quarantine

Preserving a [refused](#refused) image as evidence — **a separate event from
the refusal itself**, and not every refusal produces it: some rejection paths
block the content without ever calling it. Where it happens, the ordinary
serve routes have no path to a quarantined object — no admin viewer, no share
link — but that is **not a proven absolute access-control guarantee**: other
code paths that accept a caller-supplied storage path are a known, tracked
gap, so "unreachable" is a goal, not something to build future safety code on
top of. A **one-way door** where it applies: no appeal, no release, no
re-review.
→ [legal-safety-moderation](./legal-safety-moderation.md)

---

## Taxonomy and enrichment

### Taxonomy

The controlled vocabulary a fact is classified against — archetype, subtype,
and the scene/tone/composition modifiers around them. "Taxonomy" is the set of
categories; [enrichment](#enrichment) is one fact's filled-in values.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Enrichment

The AI **classification** layer: durable structured taxonomy metadata for a
fact (archetype, subtype, entities, references, adult suitability, hashtags).
It is **not** an image prompt — what the picture looks like belongs to the
[Visual Concept](#visual-concept).
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Archetype

The single most important classification: one of 11 values (e.g.
`superhuman_physical_feat`) describing *how the joke works*, not its topic.
Each selects a hand-authored visual strategy.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Subtype

The narrower classification sitting under an [archetype](#archetype) — a second
level of "how the joke works," not a topic tag.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Enrichment override

`enrichmentAiDerived` is the immutable AI baseline; `enrichmentOverrides` are
path-keyed manual edits; `enrichment` is the merged effective blob runtime
reads. **Human overrides survive re-enrichment** — the single most important
invariant in this area.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Taxonomy Health

The admin surface where enrichment quality is monitored and repaired
(`evaluateFactTaxonomyHealth`, a pure function): flags missing/invalid/low-
confidence/stale/projection-mismatch facts and recommends re-enrich vs
repair-projections. Every active fact rolls up into overlapping cards — one
fact can appear under several at once. Also the reference implementation for
[two-altitude](#two-altitudes) async status.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md), [async-ui-status](./async-ui-status.md)

### Re-enrich

A direct, real model call that regenerates a fact's AI classification in place.
Clears [stale enrichment version](#stale-enrichment-version) but **cannot**
clear [stale for reprocess](#stale-for-reprocess) — only a moderated refresh
re-stamps a [processing signature](#processing-signature).
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Repair projections

Re-deriving the promoted columns (archetype, subtype, fit, suitability) from
what's actually stored in the enrichment JSON. Instant, no model call, and safe
to run repeatedly.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Promoted columns

The handful of enrichment values copied out of the enrichment JSON onto the
fact's own columns (archetype, subtype, fit, suitability) so they can be
queried and filtered directly. Being a *copy* is what lets them drift — which
is exactly what [projection mismatch](#projection-mismatch) detects and
[repair projections](#repair-projections) fixes.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Projection mismatch

The Taxonomy Health dimension where a fact's [promoted
columns](#promoted-columns) have drifted from the enrichment JSON they're
supposed to mirror. Fixed by [repair projections](#repair-projections).
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Needs admin review

The Taxonomy Health category for anything wanting a person's judgment rather
than a re-run — a questionable content fit, low AI confidence, a cultural
reference needing research. Several narrower cards break it down, but they all
mean the same thing: **re-running the model won't settle this.**
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Adult suitability

The enrichment field rating how a fact fits content-safety expectations. An
input to filtering and gating, not a moderation verdict on its own.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Repeated failure count

The failure streak (`repeatedFailureCount`) on a fact whose recent
[send-backs](#send-back-to-review) kept failing. Past a threshold the fact
drops out of [bulk send-back](#bulk-send-back) runs, so one broken fact can't
eat a bulk run's capacity forever — and the count is shown rather than hidden,
so an admin can't declare a migration "complete" while a fact sits invisibly
excluded. Only targeting that fact directly resets it.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Stale enrichment version

The older, narrower staleness lens: a fact classified under an earlier
`classificationPromptVersion`. Distinct from
[stale for reprocess](#stale-for-reprocess) — they overlap heavily on legacy
data but clear differently.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Stale for reprocess

A Taxonomy Health dimension: a valid, enriched fact whose
[processing signature](#processing-signature) is absent or behind current. Its
only remediation is [send back to review](#send-back-to-review) — a direct
[re-enrich](#re-enrich) never stamps a signature.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Processing signature

Stamp of the engine/prompt/code revision an enrichment was generated under:
`{engineRevision, taxonomyVersion, classificationVersion,
imagePromptGenerationVersion, visualStrategyVersion}`. A fact whose stamp
differs from the current one is **stale for reprocess**.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Engine revision

The manual, admin-bumped integer inside a [processing
signature](#processing-signature) (`admin_config.engine_revision`). Doesn't
move on its own; an admin bumps it via
[Mark major update](#mark-major-update) after an engine/LLM swap that no code
version constant would otherwise capture.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Mark major update

The Taxonomy Health header action that bumps the [engine
revision](#engine-revision). Corpus-wide by design: every fact processed under
the old revision immediately reads as stale for reprocess. A real, audited
action — never a side effect of an unrelated config change.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

### Bulk send-back

Queuing many [send back to review](#send-back-to-review) refreshes at once from
the Stale-for-reprocess card, bounded per click. Strictly a faster way to
*queue* refreshes — never a way to skip the humans reviewing them, and never a
path to automatic promotion.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

---

## Visual pipeline and rendering

### Visual Concept

The moderator-authored (or AI-drafted-then-picked) plain-English scene
description that is the **authoritative** picture for a render. Stored at
`enrichment.visualPromptStrategyOverride.coreSceneOverride`. The compiled
prompt always opens with it verbatim; everything the pipeline adds afterward
is mechanical setup or additive detail. A fact **cannot be published without
one** — the database itself refuses.
→ [visual-pipeline](./visual-pipeline.md)

### Candidate Visual Concepts

AI-drafted `{title, whyItWorks, sceneDescription}` options shown to a moderator
to avoid blank-page authoring; picking one adopts it **whole**, never
partially merged into what's already there.
→ [visual-pipeline](./visual-pipeline.md)

### Visual planner

The frontier-model step (`generateImagePromptPlan`) that realizes the Visual
Concept into a structured plan. It never throws — it falls back with a recorded
reason.
→ [visual-pipeline](./visual-pipeline.md)

### Compiler

The deterministic `compileForSubjectRenderMode` step that turns the plan into
the engine prompt and owns identity/reference/text-policy language. The current
image render path.
→ [visual-pipeline](./visual-pipeline.md)

### Compiled prompt

The final text sent to the image engine. An admin can preview it, but the
preview runs the same non-deterministic model call a real render does — so it
is a faithful preview of the *shape* of what will be sent, not a promise of
byte-identical wording.
→ [visual-pipeline](./visual-pipeline.md)

### Render mode

What the engine is asked to preserve: a real uploaded likeness, a non-human
subject from a reference image, or nothing at all (render from description
alone). Inferred automatically from available image material, with a human
override when the automatic read is wrong.
→ [visual-pipeline](./visual-pipeline.md)

### Render scenario

One required render variant a moderator approves at production review (e.g.
`generic_t2i`, `i2i_male_default`); each attempt is a durable
`image_prompt_attempts` row.
→ [visual-pipeline](./visual-pipeline.md)

### Visual Strategy Override

The moderator-authored block that carries the [Visual Concept](#visual-concept)
plus the rest of the scene controls exposed under Advanced Options. Authored in
plain English and auto-tokenized on save.
→ [visual-pipeline](./visual-pipeline.md)

### Speech and thought bubbles

A moderator marks that a character is speaking or thinking something; the
pipeline turns that into its own dedicated engine instruction. The
engine-facing wording for a balloon has **exactly one author — the pipeline**,
never the moderator's Concept prose, so two descriptions of the same balloon
can't diverge.
→ [visual-pipeline](./visual-pipeline.md)

### Look style

The named visual style applied to a render, contributing a suffix to the
compiled prompt. Frozen at attempt-construction as the [resolved-style
snapshot](#resolved-style-snapshot), so editing or deactivating a style can't
change a render already in flight.
→ [visual-pipeline](./visual-pipeline.md)

### Reference image

Image material the engine is asked to preserve something from — a real
uploaded likeness, or a non-human subject. Which one applies (or neither) is
what [render mode](#render-mode) decides.
→ [visual-pipeline](./visual-pipeline.md)

### Readable-text policy

**There is no ban on an image containing readable text.** What's excluded is
narrow and fixed: nothing that identifies or brands the image is baked in as
rendered text — a meme's caption and the fact's own wording among them, since
those belong to the meme layer on top, where they stay editable. Signage,
screens, and scoreboards that are genuinely part of the scene are allowed, and
a moderator can lean into or away from them.
→ [visual-pipeline](./visual-pipeline.md)

### Stale render

Render presentation state is derived at read time, never persisted: a
`reviewRenderInputHash` is compared to an attempt's stored hash; a mismatch
reads as "stale," prompting a re-run.
→ [visual-pipeline](./visual-pipeline.md)

### Prompt-identity snapshot

The render identity (name + pronouns, reduced to a short prompt-safe form)
resolved ONCE at attempt-construction and frozen on `render_controls`, so the
async worker never re-queries the live user. Distinct from the profile's own
stored name and the meme caption, which are untouched.
→ [visual-pipeline](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility)

### Resolved-style snapshot

The selected look-style's suffix, frozen at attempt-construction alongside the
prompt-identity snapshot, so a style edited or deactivated after a user clicks
generate can't change the pending render.
→ [visual-pipeline](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility)

### Engine

Any generative model the platform can call (`image | video | utility | llm`),
defined **code-first** in `artifacts/api-server/src/lib/engines/` and reconciled
into the `engines` table at boot. Admin owns `isActive`/`isDefault`/pricing.
→ [architecture-map](./architecture-map.md)

---

## Memes and the studio

### Meme

The rendered artifact (`memes` table): a fact rendered to an image or video.
Free tier = photo memes; Legendary = AI image and video memes.
→ [product-brief](./product-brief.md), [meme-and-video-studio](./meme-and-video-studio.md)

### Studio

Where a user actually builds a meme from a fact — choosing a background,
composing it with the fact's text, and saving it. Two studio interfaces
currently coexist during an unfinished migration to a newer guided builder;
which one you land in depends on the product version, not your account.
→ [meme-and-video-studio](./meme-and-video-studio.md)

### Recipe

How a photo/stock/template meme is stored: **not a finished picture**, but a
record of which background was chosen and what text goes with it, composed
fresh every time someone views it. This is why a composition improvement
retroactively upgrades existing memes. An AI-generated image or video *is* a
real file; its recipe just points at that file.
→ [meme-and-video-studio](./meme-and-video-studio.md)

### Background

What a meme is built on top of before the fact's text is composed over it — an
uploaded photo, a [stock image](#stock-image), a [template](#template), or an
AI-generated image or video. "Background" is the choice the
[studio](#studio) is organized around.
→ [meme-and-video-studio](./meme-and-video-studio.md)

### Stock image

A photo sourced from an external image provider, used as a meme
[background](#background) or as a moderation review aid. Costs nothing extra
per meme, so it needs no paid tier.
→ [meme-and-video-studio](./meme-and-video-studio.md)

### Template

A built-in background supplied by Overhype.me. A meme built on one stores **no
image of its own** — just a [recipe](#recipe) pointing back at the template.
→ [meme-and-video-studio](./meme-and-video-studio.md)

### Photo meme

A meme built from your own uploaded photo, a stock image, or a built-in
template. Available to anyone signed in — no paid plan required — because it
costs nothing extra per meme to produce.
→ [meme-and-video-studio](./meme-and-video-studio.md)

### AI image meme

A Legendary-gated meme whose background is generated around a source photo,
through the same [visual pipeline](#visual-concept) moderation uses. **It isn't
private to you** — it joins that fact's shared gallery, usable by anyone who
later makes a meme from the same fact. An AI *video* meme is the opposite:
tied to the one meme you made with it.
→ [meme-and-video-studio](./meme-and-video-studio.md)

---

## Public site and sharing

### Spotlight

The rotating single-fact feature on the home page. It favors better-rated facts
but leans random rather than always surfacing the single top-rated one, so
repeat visits don't show the same handful over and over.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Top Facts

The leaderboard page, ranking facts by rating. There is **no ranking of people**
anywhere on the site — only a fact leaderboard.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Wilson score

The confidence bound on a fact's up/down votes (`facts.wilsonScore`) that,
with score/comment/share counts, drives ranking.
→ [architecture-map](./architecture-map.md)

### Fact card

The repeated unit the home grid and search results are built from: one fact,
rendered for the current name and pronouns, with its
[hashtag pills](#hashtag-pill) and reaction controls.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Hashtags

Tags on a fact, AI-suggested at submission and editable by the submitter.
Browsing them happens two ways — a [hashtag pill](#hashtag-pill) on a fact card
runs a search, and the home page's hashtag rail and [Trending
Topics](#trending-topics) strip filter the feed in place. There is **no
dedicated hashtag directory page**: the idea exists in the codebase but isn't
reachable.
→ [taxonomy-and-enrichment](./taxonomy-and-enrichment.md), [public-site-and-sharing](./public-site-and-sharing.md)

### Hashtag pill

A tappable hashtag on a [fact card](#fact-card). Tapping one leaves the page
for a search on that tag — unlike [Trending Topics](#trending-topics), which
filters in place.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Trending Topics

The home-page strip (with the hashtag rail) that filters the home feed **in
place**, without navigating away. The other half of hashtag browsing, and the
reason no directory page is needed for the common case.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Library

Your own private collection — facts you submitted or liked, memes and images
you made, your search history — visible only to you. Overhype.me has **no
public profile pages**, so this is the only rounded-up per-person view that
exists, and it exists only for yourself.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Rich preview

The image/title/description card that appears when a **meme** link is shared
into a chat app or social post (the OG card). Respects the same privacy rule
the meme does, and exists **only** for meme links — sharing a fact, a search,
or the home page produces no rich preview. Not to be confused with
[Preview](#preview), the submit-form step.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Personalized share link

Sharing a *fact* rewrites the link so whoever opens it sees the fact
personalized with the name you typed for them. Deliberately different from
sharing a *meme*, which passes along a finished, already-rendered object as-is.
→ [public-site-and-sharing](./public-site-and-sharing.md)

### Merch

Ordering a meme printed on a shirt, mug, or sticker. Overhype.me shows a
product preview and then redirects to Zazzle, which owns checkout, sizing,
shipping, and payment. **The product and layout picked on Overhype.me is only a
preview** — only the meme image reaches Zazzle.
→ [public-site-and-sharing](./public-site-and-sharing.md)

---

## Community and engagement

### Rating

A simple up or down on a fact — not a star scale — and a toggle: tapping your
existing rating removes it, tapping the other flips it. Feeds a fact's standing
instantly, which drives [Top Facts](#top-facts) and the
[spotlight](#spotlight). Search does **not** factor rating in.
→ [community-and-engagement](./community-and-engagement.md)

### Heart

A single-tap approval of a meme or a comment. Hearting a meme and hearting a
comment are the **same mechanism** pointed at different content types.
→ [community-and-engagement](./community-and-engagement.md)

### Activity feed

A signed-in user's personal record of what happened to things *they* submitted
— a fact or comment approved or rejected. It deliberately never reports
reactions *received*: a heart or rating someone gave your content never appears
there.
→ [community-and-engagement](./community-and-engagement.md)

---

## Accounts and roles

### Role

Which standing category an account falls into — signed-out visitor,
[Registered](#registered), [Legendary](#legendary), or [admin](#admin).
Always computed fresh from actual account state, **never** trusted from
something stored on the session.
→ [accounts-and-auth](./accounts-and-auth.md), [security-model](./security-model.md)

### Registered

The free tier: the derived `registered` [membership tier](#membership-tier) —
**not** simply "has an account." An [unregistered](#unregistered) account
also has a row in the users table but is a distinct auth state the tier
derivation deliberately never promotes out of, precisely so an admin-created
unregistered account doesn't silently gain Registered's capabilities. A
Registered user can submit facts, comment, rate, and build
[photo memes](#photo-meme).
→ [membership-entitlements](./membership-entitlements.md)

### Unregistered

A distinct, persisted account state below Registered — reachable only when an
admin creates an account that way, not the normal signup default, and not the
same thing as being signed out or having skipped [onboarding](#onboarding).
→ [membership-entitlements](./membership-entitlements.md)

### Legendary

The paid tier, unlocking private memes, [AI image memes](#ai-image-meme), AI
video generation, higher rate limits, and a higher generation spend budget.
Bought as a subscription or as [Legendary for Life](#legendary-for-life), or
comped by an admin.
→ [membership-entitlements](./membership-entitlements.md)

### Admin

An account with access to the [admin console](#admin-console). Separate from
membership tier (the `is_admin` flag, not a tier value). An admin viewing the
site "as a regular user" keeps backend admin permissions the whole time — that
toggle only changes what the interface shows.
→ [accounts-and-auth](./accounts-and-auth.md)

### View as regular user

The admin toggle for checking what an ordinary member sees. It changes **only
what the interface shows** — backend admin permissions are never actually
dropped. A small number of narrower endpoints check the toggle directly and so
*would* treat a viewing-as-user admin as a non-admin; that's a known
inconsistency in a corner, not how authorization works generally.
→ [accounts-and-auth](./accounts-and-auth.md)

### Deactivate

Signing an account out everywhere, locking it out of signing back in, and
making a best-effort attempt to cancel any paid membership. Everything the
account created stays live; only the attribution stops showing. Reversible by
an admin [reinstating](#reinstate) it.
→ [accounts-and-auth](./accounts-and-auth.md)

### Remove

Going further than [deactivate](#deactivate): a best-effort deletion of the
account's own uploaded images and personal data. **Content it created — facts,
comments, memes — is kept**, just no longer tied to a real account. Not a
"right to be forgotten" erasure. A [quarantine](#quarantine) record's evidence
and row survive a hard delete too, by design — but not the attribution:
who it's tied to is nulled out along with the account, the same as ordinary
content. Preserved evidence and preserved *attribution* are different
guarantees; only the first one holds.
→ [accounts-and-auth](./accounts-and-auth.md)

### Email verification

The one-time link sent after registering with email and password. **Today it
unlocks nothing** — it's a trust signal shown to moderators and admins, not a
gate. The step that actually gates a first submission is
[onboarding](#onboarding).
→ [accounts-and-auth](./accounts-and-auth.md)

---

## Payments and membership

### Membership tier

User entitlement level: `unregistered | registered | legendary`. **Derived,
never assigned, post-creation** — `users.membership_tier` is a projection
computed from a user's [entitlement sources](#entitlement-source), recomputed
on every change to them. Account creation is a separate one-time
initialization write, not a competing writer. One narrow designed exception:
admin reinstatement writes it directly, fail-closed, when a source refresh
comes back incomplete.
→ [membership-entitlements](./membership-entitlements.md#the-one-thing-to-understand-before-anything-else)

### Entitlement source

A `membership_entitlements` row: one durable candidate for membership a user
has ever held, of type `stripe_subscription`, `stripe_lifetime_payment`, or
`admin_grant`. **Not** the same as "currently grants membership" — a cancelled,
refunded, or disputed source is retained, not deleted, and no longer qualifies.
A dispute closing anything but `lost` only clears the dispute hold; the source
still must pass its own lifecycle check. A user's tier is the **union** of
their qualifying sources, not a priority order — Legendary if *any* one
qualifies.
→ [membership-entitlements](./membership-entitlements.md#the-entitlement-model)

### Grace episode

The bounded window a `past_due` subscription keeps qualifying for — also called
the **grace window** — counted from the first failed charge on the earliest
still-unpaid invoice of the contiguous unpaid run. Not "however long Stripe
keeps retrying." If it can't be resolved and no deadline is already stored, the
source keeps qualifying without a deadline; if one *is* stored, an unresolvable
refresh leaves it in force, including past expiry.
→ [membership-entitlements](./membership-entitlements.md#grace-episodes--bounded-dunning-not-indefinite-retry)

### Cancel

Ending a subscription **at the end of the current billing period** — access
continues until then. Distinct from a refund, which is a separate event: a
subscription's access follows its own cancellation, not any refund issued
against it.
→ [membership-entitlements](./membership-entitlements.md)

### Reactivate

Undoing a pending [cancellation](#cancel) before it takes effect. **One of
three different "bring it back" actions, each on a different object** — this
one restores a *subscription*, [reinstate](#reinstate) restores a deactivated
*account*, and [Resubmit for Moderation](#resubmit-for-moderation) restores an
inactive *fact*. They are not interchangeable.
→ [membership-entitlements](./membership-entitlements.md)

### Switch to Annual

Moving a monthly subscriber to the annual plan, with a prorated charge shown
before confirming. Exact for the ordinary single-item subscription; a
subscription carrying a non-membership add-on **listed first** is a known
edge case, because the switch inspects the first item rather than finding the
membership one.
→ [membership-entitlements](./membership-entitlements.md)

### Dispute hold

The disqualification an unresolved chargeback puts on an [entitlement
source](#entitlement-source). A dispute closing anything *but* `lost` only
clears the hold — the source still has to pass its own lifecycle check, so a
cancellation or refund that happened while it was disputed stays disqualified
regardless. Only `lost` is a separate, permanent disqualification.
→ [membership-entitlements](./membership-entitlements.md)

### Allowlisted product

The requirement that a Stripe-backed [entitlement source](#entitlement-source)
point at a product tagged as conferring membership — one of the checks a source
must pass to qualify. Applies to the **two Stripe-backed source types only**;
an [admin grant](#admin-grant) is authorized by the admin's own action instead,
since no product was purchased.
→ [membership-entitlements](./membership-entitlements.md)

### Entitlement sweep

The scheduled background pass that recomputes stored membership tiers. **Not
the same as the [recovery sweep](#recovery-sweep)** that requeues crashed jobs
— different subsystem, different job. The stored tier column can lag reality
between sweeps, but *access* never does: a lapsed [grace
episode](#grace-episode) demotes on every request via a live deadline check,
regardless of what the column says.
→ [membership-entitlements](./membership-entitlements.md)

### Legendary for Life

The one-time purchase alternative to a recurring subscription. A **full** refund
removes access; a partial refund does not.
→ [membership-entitlements](./membership-entitlements.md)

### Admin grant

Comping Legendary by recording a grant — who granted it, when, and why —
rather than synthesizing a fake $0 payment. Shows up distinctly from real
revenue, so nobody mistakes a comp for a sale. Authorized by the admin's own
action, not by a purchased product.
→ [membership-entitlements](./membership-entitlements.md)

### Revoke

Ending an [admin grant](#admin-grant). It stays visible in history marked
revoked — a revoke only ends a grant, never deletes it.
→ [membership-entitlements](./membership-entitlements.md)

### Reinstate

Restoring a [deactivated](#deactivate) account, re-checking its actual Stripe
state before restoring its tier rather than trusting what was last stored — so
a subscription that lapsed during deactivation doesn't come back to life along
with the account.
→ [membership-entitlements](./membership-entitlements.md)

---

## Admin console

### Admin console

The single gated area where the team operates the product — reviewing content,
managing users, tuning behavior, and watching the machinery. Reachable only to
signed-in [admin](#admin) accounts.
→ [admin-console](./admin-console.md)

### Facts editor

The broad admin screen for searching, editing, deactivating, or removing any
fact already in the system — distinct from the [review queue](#review-queue),
which only holds submissions awaiting a decision. Also where a
[variant](#variant) is created and where
[Resubmit for Moderation](#resubmit-for-moderation) lives.
→ [admin-console](./admin-console.md)

### Tier permissions grid

The admin screen mapping features against membership tiers, so "can a free user
do X" is one clear answer in one place rather than scattered across code. Kept
deliberately separate from the general settings editor, which answers a
different question.
→ [admin-console](./admin-console.md)

### Admin Field Reference

The **generated** field-level reference for the enrichment editor
([`ADMIN_FIELD_REFERENCE.md`](../ADMIN_FIELD_REFERENCE.md)). Never hand-edited
— a build check catches drift.
→ [admin-console](./admin-console.md)

---

## Background work

### Background work

Slow, unreliable, or expensive work run outside the request that triggered it —
AI classification, image generation, email, image search, refresh cycles.
Recorded in the database rather than held in memory, so a restart mid-run
doesn't lose it.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Async job queue

The durable `async_jobs` table (queue discriminator + JSON payload + dedupe key
+ retries; status `pending → processing → done | failed`), polled by a worker.
**Enqueue is not completion.**
→ [architecture-map](./architecture-map.md#async-jobs-and-queues), [async-ui-status](./async-ui-status.md)

### Lane

One of the independent scheduling groups (`fast` / `render` / `bulk` /
`pexels` / `ai_meme_backfill`) the async-jobs worker splits queues into, each
with its own poll timer, re-entrancy guard, and concurrency bound, so slow work
in one lane can never delay another's *scheduling*. What separates them is who
is waiting and what each job costs. The isolation is at the scheduling level
only — all lanes share one database connection pool.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Claim

A worker taking a queued job so no other worker picks it up. An individual job
carries **no lease**, so a job whose worker crashed still *reads* as claimed
until the [recovery sweep](#recovery-sweep) reaches it — the queue table shows
recorded state, not live state.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Recovery sweep

The pass that puts a job whose process died mid-run back in the queue. Work is
never silently lost, but recovery runs **on a deliberate delay** — a job must
look stuck first — because a faster sweep would sometimes grab a job another
instance is still legitimately working on and run it twice (for an email, that
means a real person gets it twice). Not the same as the [entitlement
sweep](#entitlement-sweep).
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Retry ceiling

The maximum attempts a queue allows a job before it finalizes to `failed`.
Persisted onto the row at finalization rather than re-resolved live, so a row's
[abandoned-no-retry](#abandoned-no-retry) reading stays pinned to the ceiling
that actually applied rather than whatever the config says today.
→ [decisions.md](./decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live)

### Retention

The schedule on which old `done`/`failed` job rows are purged, per queue.
**Retention is not an audit log** — `async_jobs` is operational state, not
permanent history. The one deliberate exception is the alert about an abandoned
email, kept so the evidence outlives the thing it's evidence about.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Two altitudes

The rule that every admin surface triggering background work shows status at
**both** per-item level (queued → working → done/failed/skipped/still-running)
and in aggregate (a running tally). A single spinner with no per-item detail is
a bug, not a valid loading state.
→ [async-ui-status](./async-ui-status.md)

### Queue Health

The admin surface showing whether the whole background-work system is alive,
built on [worker lane heartbeats](#worker-lane-heartbeat). A third reference
implementation of the [two-altitude](#two-altitudes) contract, plus an
unauthenticated liveness probe whose value is turning the verdict into an HTTP
status code while the process is still up.
→ [architecture-map](./architecture-map.md#worker-liveness-heartbeats--the-queue-health-surface-phase-1-pr-288)

### Worker lane heartbeat

A `worker_lane_heartbeats` row, keyed `(instance_id, lane)`, that one worker
instance publishes to say a lane is still ticking and how many jobs it has in
flight. The queue table alone can't distinguish "about to be claimed" from
"every worker died an hour ago."
→ [architecture-map](./architecture-map.md#worker-liveness-heartbeats--the-queue-health-surface-phase-1-pr-288)

### Bulk Media Backfill

The admin panel (under Taxonomy Health) driving the corpus-wide stock-image and
AI-meme backfill queues — a second reference implementation of the
[two-altitude](#two-altitudes) contract.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Skipped

A job that completed **successfully** but whose handler found mid-run that its
work no longer applied. A `done` row does not always mean work happened — any
UI reading job status has to tell these apart from a plain success.
→ [async-ui-status](./async-ui-status.md)

### Terminal vs retryable

How the async-jobs worker classifies a handler failure. Terminal =
deterministic (re-running the same frozen inputs can't fix it) → the row fails
on the first attempt with a typed `code`. Retryable = the historical default →
backoff and retry up to `maxAttempts`.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Abandoned no retry

The derived state for a `failed` row the worker won't retry — defined by
**no retry being available**, not by attempts having reached the ceiling.
Reachable two ways: a deliberate terminal classification that gives up before
the ceiling (attempts *below* the max), or a single-attempt queue whose one
attempt failed, ceiling or not. A different story from having retried
repeatedly and exhausted the budget, which is why the two are reported
separately.
→ [architecture-map](./architecture-map.md#async-jobs-and-queues)

### Sentinel

The value `0` on an `async_jobs` row's `max_attempts`, meaning "resolve the
retry ceiling from the queue's live `admin_config` setting" rather than a fixed
per-row override. Replaced with the resolved number once a row finalizes to
`failed`, so its [abandoned-no-retry](#abandoned-no-retry) classification stays
pinned to the ceiling that actually applied.
→ [decisions.md](./decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live)

---

## Ways of working

### Workstream

One unit of work (a feature, a bugfix, a `/document` harvest) tracked
end-to-end by a single GitHub issue — except sensitive/disclosure-carve-out
work, which is a private draft Project item instead. Runs the full lifecycle
(Discovery→UAT) only when there's product-visible behavior to verify.
Deliberately **not** the same as a session or a PR: a workstream outlives both
and can span several PRs.
→ [workstream-tracking](./workstream-tracking.md)

### State of Play block

The standard block maintained in a workstream issue's body: current stage,
whose turn it is, the open question in plain language, artifact links, and how
to resume. It exists so a workstream can be picked up **cold in a fresh
session**.
→ [workstream-tracking](./workstream-tracking.md)

### David-gate

A lifecycle stage only David can move past, marked 🛑 in both the board's
Status options and the chat interruption banner: Plan approval, Merge, and UAT.
One glyph means "David" everywhere.
→ [workstream-tracking](./workstream-tracking.md)
