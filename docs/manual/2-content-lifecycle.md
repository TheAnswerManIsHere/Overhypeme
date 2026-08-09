# Chapter 2 · Content Lifecycle

> How a fact gets into Overhype.me in the first place — the two ways a fact
> is submitted (a signed-in user writes one, or an admin/external system
> imports a batch) and the one funnel both feed into. **[Variants](../ai-context/glossary.md#variant)** are not a
> third source of facts; they're how near-duplicate wordings get organized,
> and they're covered here because applying that link is a decision made on
> the way in. What happens once a fact is in the queue is
> [`3-moderation.md`](./3-moderation.md)'s chapter, not this one.
>
> Deep spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md#the-ingestion-funnel--one-entrance).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

A fact is submitted exactly two ways — a signed-in user submits one, or an
admin (or an external system, via API key) imports a batch — and both land in
the same place: a [pending review](../ai-context/glossary.md#pending-review), not the live catalogue. There is no third
source and no shortcut in the product itself: nothing in the running
application can create a fact directly outside this funnel. (Offline dev/ops
tooling — a database seed script, a reseed utility — can insert facts
directly; that's maintenance tooling, not a product ingestion path, and this
chapter doesn't cover it.) That single funnel is what lets
[`3-moderation.md`](./3-moderation.md) describe one review process and mean it for
every fact, regardless of how it arrived.

**Variants ride that same funnel rather than bypassing it.** A [variant](../ai-context/glossary.md#variant) is an
alternate phrasing of a fact that's already live, and it exists to solve a
clutter problem: near-duplicate wordings of the same joke shouldn't each take
up their own slot in the catalogue, but a reader should still be able to pick
the phrasing that lands best for them. A fact becomes a variant by being
*linked* to an existing fact — a decision a moderator makes at [Triage](../ai-context/glossary.md#triage) on a
flagged near-duplicate, or an admin makes when writing one directly. Either
way the fact itself is submitted, reviewed, and published like any other. See
*Variants* below.

This chapter covers the two entrances themselves — what a [submitter](../ai-context/glossary.md#submitter) sees, what
an importer sends — plus how and where the variant link gets applied, and the
cheap, pre-review checks each route runs before a fact ever reaches a human.
What happens after that hand-off ([triage](../ai-context/glossary.md#triage), [enrichment](../ai-context/glossary.md#enrichment), the [Visual Concept](../ai-context/glossary.md#visual-concept) and
[Test Renders](../ai-context/glossary.md#test-renders) gates, publication) belongs to [moderation](../ai-context/glossary.md#moderation) and taxonomy, and
this chapter links out rather than repeating it.

## How it works

### For the submitter (writing a fact)

Submitting is a two-step form: **write**, then **[preview](../ai-context/glossary.md#preview)**. While the
submitter is writing, a **[duplicate check](../ai-context/glossary.md#duplicate-detection)** runs automatically in the
background — no button needed — comparing the draft against existing facts
and, if it finds a likely match, showing it so the submitter can decide for
themselves whether to continue. It's advisory only: nothing stops a
submission that's flagged. It's also best-effort, not guaranteed — the check
re-runs against the finished template on Preview, but Submit stays clickable
while it's still in flight, so submitting before the check resolves reaches
the server with no duplicate flag attached at all, even against a real
match.

Moving from Write to Preview is a different kind of step — a **required,
blocking** one. Clicking Preview sends the draft through a [grammar pass](../ai-context/glossary.md#grammar-pass) that
resolves the fact's `{NAME}` and pronoun [placeholders](../ai-context/glossary.md#personalization-tokens) into a preview across
example names and [pronoun sets](../ai-context/glossary.md#pronoun-set), so the submitter can catch an awkward
conjugation before sending it in. A failed pass leaves the submitter on
Write with an error rather than letting them continue; only a successful one
reaches Preview.

That normal path to Preview also fetches AI-suggested [hashtags](../ai-context/glossary.md#hashtags) to pre-fill
the (editable) hashtags field — a non-blocking suggestion the submitter can
keep, edit, or clear. (A submitter picking up an [autosaved draft](../ai-context/glossary.md#autosaved-draft) skips
straight to Preview with their saved template and doesn't trigger a fresh
suggestion fetch.)

Submitting requires being signed in. A onetime step also applies before a
first fact can be submitted: anyone who isn't an admin or an existing
[Legendary](../ai-context/glossary.md#legendary) member must complete [onboarding](../ai-context/glossary.md#onboarding) (which includes a captcha check)
first; admins and Legendary members skip it. On submit, the server
re-normalizes the fact's grammar independently of what the client already
checked — a submission that reached the server without going through the
Write-to-Preview grammar pass (an API client, a stale front-end) still gets
the same cleanup applied, so every fact that reaches the [review queue](../ai-context/glossary.md#review-queue) has
been through the same grammar pass regardless of how it arrived. (One
submitter's own pending facts are also protected from flooding the queue —
see *Boundaries & known limitations* below.)

Successful submission notifies admins and logs an [activity-feed](../ai-context/glossary.md#activity-feed) entry for
the submitter, who is later notified again when their fact clears or is
rejected.

### For the admin (bulk import)

Bulk import exists in two forms that both do the same thing — turn a batch
of fact texts into pending reviews — with different callers in mind:

- **From the [admin console](../ai-context/glossary.md#admin-console)**, an admin pastes facts as JSON, CSV, or one
  fact per line and imports them in one action.
- **Via API key**, an external system posts the same kind of batch
  programmatically, with an optional dry-run mode that validates without
  writing anything.

Both paths run every text through the same grammar normalizer a user
submission uses, so an imported fact's stored text is cleaned up identically
to a hand-submitted one — though the rows aren't otherwise identical: an
admin-console import attributes the acting admin as submitter and always
queues an empty hashtag list; an API-key import has no submitter at all but
can carry caller-chosen hashtags; only a user submission carries
duplicate-match metadata. Both import paths
also **[dedupe](../ai-context/glossary.md#exact-text-dedupe) by exact (normalized) text** — against every existing fact row
with that text, active or not, and against every review still waiting on a
decision — before inserting anything, so re-running the same import twice,
importing a fact someone already submitted, or importing a fact that used to
be live and was later taken down, all queue nothing new for the ones that
match. This is a narrower check than the submitter's duplicate warning: it
catches identical (post-normalization) text, not a reworded near-duplicate,
and it silently skips rather than flagging for a human — there's no
moderator-style judgment call to make on an exact match. The admin-console
path is interactive: the admin sees a skipped-as-duplicate count whenever a
run actually skips any. The API-key path is the one actually meant to run
unattended.

**Importing only loads the review queue — it never publishes anything.**
An imported fact is exactly as unpublished as a hand-submitted one; it
still has to clear every gate in [`3-moderation.md`](./3-moderation.md) before
it goes live.

### Variants: organizing near-duplicate wordings

A [variant](../ai-context/glossary.md#variant) is an alternate phrasing of a joke that's already live, linked to
that joke — its **[root](../ai-context/glossary.md#root)** — by a parent reference. The link buys exactly two
things: near-duplicate wordings stop competing for the same space in the
catalogue, and a reader who prefers a different phrasing can pick one.
Everything else about a variant is ordinary-fact machinery.

**Where the link gets applied.** Three places, and all are a decision by
staff, never by the submitting user:

- **At Triage, on any submission carrying a similarity match.** The duplicate
  check attaches its nearest match to the submission whenever it finds one
  with positive confidence — not only when that match was strong enough to
  show the submitter a duplicate warning. The moderator's triage screen shows
  **Prep as Variant of #N** whenever a match is attached, so the moderator is
  making this call on more candidates than the submitter ever saw flagged;
  choosing it accepts the submission and records the matched fact as its
  parent. This is the path the clutter problem is actually named after: a
  reworded near-duplicate becomes an alternate phrasing of the fact it echoes,
  instead of either a rejection or a second near-identical entry in the feed.
- **From the [Facts editor](../ai-context/glossary.md#facts-editor), writing a new variant.** An admin can write a
  variant directly against a specific root. That's an authoring convenience,
  not a separate kind of content: the text goes through the same grammar
  normalization as a fresh fact, and it enters at the same first review step
  as anything else.
- **From the Facts editor, reparenting an existing fact.** An admin can also
  set (or clear) the **Parent ID** field on a fact that already exists,
  turning an already-published root into a variant of another root, or a
  variant back into a root. Unlike the other two, this doesn't go through
  review — it's a direct edit to a live fact, gated only by the same
  active-root invariant activation enforces.

The first two both run **a variant through review like any other fact** — it
earns its own classification, its own Visual Concept, and its own images, and
none of that carries over from its parent. Reparenting is different: it acts
on a fact that already cleared review, so nothing re-runs — only the parent
link changes. In every case the parent link is revalidated before the fact can
actually go (or stay) live: see
[`moderation-workflow.md`'s activation chokepoint](../ai-context/moderation-workflow.md#the-activation-chokepoint--one-exit).

**What the grouping changes.** Variants are kept out of the main fact list and
the home-page hero, so a root and its rewordings never crowd each other on
those surfaces. The "more facts you'll like" rail keeps them out of its own
fact's group (a variant never recommends its own siblings or root) but not
globally — see *Boundaries* below for the gap. On the root fact's own page
variants are listed under **Alternate Phrasings**, each linking to its own
fact page; a variant's page carries a banner back to its root. The grouping is
one level deep — a variant of a variant isn't allowed, so a new variant's
target always has to be a root.

**What the grouping deliberately does not change.** A variant is otherwise a
fully independent fact: its own page, its own votes and score, its own
comments and memes, its own classification and Visual Concept, inheriting no
metadata from its root. That independence was a deliberate call — see
[Variants are independent facts](../ai-context/decisions.md#2026-07-24--variants-are-independent-facts--parent_id-is-kinship--showhide-only-never-metadata-inheritance).
The practical consequence is that a variant is not a cheap alias for the same
row: it goes through the same paid moderation prep, and the engagement it
earns (votes, comments, rank) is its own rather than the root's.

**What a reader can and can't do.** Readers pick among the alternate phrasings
a moderator or admin has already approved; they can't write or edit one
themselves. (Personalizing a fact to a name and pronoun set is a different,
always-available thing that works on any fact — see
[`1-personalization-and-grammar.md`](./1-personalization-and-grammar.md).) A user
who wants a wording that doesn't exist yet submits it like any other fact; it
becomes a variant only if a moderator links it at Triage.

### Underneath: one funnel, one cost gate

Every route in — the submit route, both import routes, and the admin variant
route — calls the same function to create a pending review row, and nothing
else in the codebase does. That row starts at the very first stage
of the review pipeline; no route can hand a fact a head start.
The **[moderation-prep pipeline](../ai-context/glossary.md#moderation-prep)** — AI classification, image lookups, no
renders yet — never runs at intake; that work only begins once a human moderator
provisionally accepts a submission at Triage. (The cheap pre-submit
affordances a submitter already used on the way in — the grammar/[tokenize](../ai-context/glossary.md#tokenize)
pass, the duplicate check, hashtag suggestions — do call utility models;
[`3-moderation.md`](./3-moderation.md) draws this same distinction. What's
gated at Triage is the paid moderation-prep pipeline specifically, not every
model call ever made about the fact.) Intake itself is just: normalize the
grammar and queue the review — a duplicate check runs on some routes (the
submitter's own advisory check, the import routes' exact-text dedupe) but
not all of them; the admin variant route, for one, does neither, since an
admin writing a variant has already decided what it's a variant of.
See [`moderation-workflow.md`](../ai-context/moderation-workflow.md#why-staged-moderation-exists)
for what happens from there, and
[`moderation-workflow.md`'s ingestion-funnel section](../ai-context/moderation-workflow.md#the-ingestion-funnel--one-entrance)
for the funnel itself.

## Why it works this way

- **One funnel, so "every fact gets reviewed" is actually true.** If
  submission, import, and the admin variant route each wrote to the facts table
  in their own way, "nothing goes live without review" would be three separate
  promises to keep in sync instead of one function to trust. Routing every
  route through the same primitive means a change to how review starts —
  a new required field, a new starting stage — only has to be made once and
  is automatically true for every way a fact can arrive. See
  [Fact lifecycle closed: one entrance, one exit](../ai-context/decisions.md#2026-07-23--fact-lifecycle-closed-one-entrance-one-exit--activation-is-moderation-only-and-deactivation-is-reversible-through-moderation-not-a-direct-toggle).
- **The duplicate check at submission warns; it doesn't refuse.** A
  same-meaning fact phrased differently is a legitimate call for a human to
  make, not a machine — if the check catches it and finishes in time, the
  submitter sees the possible match and decides whether to send it anyway,
  and a moderator sees the same flag at Triage. Blocking automatically would
  either reject real variants or need the exact wording match bulk import
  uses, which is far too blunt for something a human wrote from scratch. It
  runs best-effort rather than being made to block Submit for the same
  reason it isn't a hard gate at all — the cost of occasionally missing a
  flag is lower than the cost of holding up every submission on an AI call
  that isn't authoritative anyway.
- **Bulk import's dedupe is exact-text and silent, because there's no
  judgment call to make on an exact match.** An automated re-run of the same
  import, or a second import that overlaps with an earlier, already-finished
  one, is the normal case this guards — the match is unambiguous, so there's
  nothing for a human to weigh either way, whether or not one is actually
  watching. A stricter, silent, exact match fits that; a softer semantic
  check that occasionally guesses wrong would not. (The check happens before
  the insert, not as a database constraint, so it guards sequential runs —
  two imports racing at the exact same instant could each pass it before
  either has written anything; see *Boundaries* below.)
- **Variants are a grouping decision, not a lighter kind of fact.** The link
  could have been built as a wording swap stored on the root — one fact, several
  strings — which would have made an alternate phrasing free. It wasn't, because
  a rewording is still a different joke to classify and to picture: the same
  concept phrased differently can want a different image, a different
  classification, its own memes. So the link does the one job it's good at —
  keeping near-duplicates from cluttering the browse surfaces while leaving the
  wording choice available — and stops there. The cost of that choice is real
  and accepted: each variant is separately reviewed, separately prepped (paid),
  and accumulates its own votes and comments rather than pooling them with its
  root.
- **Grammar normalization runs again at the server, even though the client
  already showed a preview of it.** The preview is for the submitter's
  benefit; the server-side pass is what actually determines what gets
  stored, so a submission that skipped the client (any path other than the
  standard form) can't reach the queue with an unexpanded token or an
  un-conjugated verb.

## Boundaries & known limitations

- **Duplicate detection at submission is advisory, not a gate — and not even
  guaranteed to reach Triage.** A submitter can send a fact flagged as a
  likely duplicate; nothing stops them, and nothing stops a moderator from
  approving it anyway if they disagree with the flag. It's also racing the
  submitter: hitting Submit before the check resolves reaches the server
  with no flag at all, even against a genuine match.
- **Bulk import's dedupe only catches exact, post-normalization text.** Two
  imports of the same fact queue separately unless they normalize to
  identical stored text — a trailing-space or grammar-cleanup difference can
  still collapse to the same match and get caught; a difference that
  survives normalization does not.
- **Bulk import's dedupe is a same-request guard, not a database
  constraint.** It checks before it writes rather than relying on a
  uniqueness rule the database itself enforces, so two imports that overlap
  by coincidence — not one waiting for the other to finish — can each pass
  the check before either has inserted, and both queue.
- **A submitter's own pending facts are protected from flooding the review
  queue** — see `artifacts/api-server/src/lib/rateLimit.ts` for how.
- **The variant grouping is applied per surface, not globally, and even
  "excludes variants" is a per-branch guarantee, not a per-surface one.** The
  main fact list and the hero filter to root facts outright. The related
  rail only excludes a fact's own group (its root and siblings) — its
  tag-overlap ranking branch has no root-only filter, so a variant belonging
  to a *different* root can still surface there on a shared hashtag; only the
  fallback (no-hashtag-overlap) branch is root-only. The **Fact of the Day**
  email picks from every active fact, so a variant can go out as the day's
  fact on its own. A profile's submitted/liked lists also include variants —
  arguably correct there, since they're that user's own submissions, but it's
  the same unfiltered read. Any new surface that lists facts has to opt into
  whatever filtering it wants; there's no shared root-only filter to inherit.
- **A near-duplicate match can point at a fact that is itself a variant, and
  Triage sees it more often than a submitter's duplicate warning would
  suggest.** The duplicate check searches every active fact, variants
  included, and attaches its nearest match whenever confidence is positive —
  not only when that match was strong enough to warn the submitter. So Triage
  can offer *Prep as Variant of #N* where #N is a variant, on submissions the
  submitter never saw flagged at all. Nothing refuses either case at that
  point — the one-level-deep rule is enforced at the final activation gate,
  after the fact has already been through paid prep, and the moderator has to
  re-parent it to the root to get it live.

## Going deeper

- Spec: [`moderation-workflow.md`](../ai-context/moderation-workflow.md) — the
  [ingestion funnel](../ai-context/glossary.md#ingestion-funnel), the activation chokepoint, and everything that happens
  to a fact after it's queued.
- Related: [`3-moderation.md`](./3-moderation.md) (the three-gate review a
  queued fact goes through), [`4-taxonomy-and-enrichment.md`](./4-taxonomy-and-enrichment.md)
  (what a fact's classification means and how it's produced), and
  [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues)
  (the async [lanes](../ai-context/glossary.md#lane) that run a fact's prep work once it's accepted).
- Rationale: the fact-lifecycle entries in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 3 — [`3-moderation.md`](./3-moderation.md), the three human
gates a queued fact walks through before it can go live.

*Verified against `b720d6f` (2026-08-08) · claim inventory in PR #355. The
variants section re-verified against `60827dc` (2026-08-09).*
