# Chapter 2 · Content Lifecycle

> How a fact gets into Overhype.me in the first place — the two ways a fact
> is submitted (a signed-in user writes one, or an admin/external system
> imports a batch) and the one funnel both feed into. What happens once a
> fact is in the queue is
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

This chapter covers the two entrances themselves — what a [submitter](../ai-context/glossary.md#submitter) sees, what
an importer sends — and the cheap, pre-review checks each route runs before a fact ever reaches a human.
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

Submitting requires being signed in with an account that has verified its
email and completed [onboarding](../ai-context/glossary.md#onboarding) — the one-time screen every account
finishes before it can act at all (see
[chapter 9](./9-accounts-and-auth.md#verify-then-onboard-then-act)). Onboarding
includes a Turnstile challenge, so an onboarded account is not challenged
again when it submits. On submit, the server
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

### Near-duplicates: one fact per joke

The duplicate check attaches its nearest match to a submission whenever it
finds one with positive confidence — not only when that match was strong
enough to show the submitter a warning — so a moderator at
[Triage](../ai-context/glossary.md#triage) sees more candidates than the
submitter ever saw flagged. The moderator has two choices: reject the
submission as a duplicate, or accept it as a fact of its own. A different
wording of a joke that's already live is the same joke, so the usual call is
the first. Every fact stands alone: nothing links one fact to another, and
each fact earns its own classification, gags, images, votes and comments.

### Underneath: one funnel, one cost gate

Every route in — the submit route and both import routes — calls the same function to create a pending review row, and nothing
else in the codebase does. That row starts at the very first stage
of the review pipeline; no route can hand a fact a head start.
The **[moderation-prep pipeline](../ai-context/glossary.md#moderation-prep)** — AI classification, no
renders yet — never runs at intake; that work only begins once a human moderator
provisionally accepts a submission at Triage. (The cheap pre-submit
affordances a submitter already used on the way in — the grammar/[tokenize](../ai-context/glossary.md#tokenize)
pass, the duplicate check, hashtag suggestions — do call utility models;
[`3-moderation.md`](./3-moderation.md) draws this same distinction. What's
gated at Triage is the paid moderation-prep pipeline specifically, not every
model call ever made about the fact.) Intake itself is just: normalize the
grammar and queue the review — a duplicate check runs on some routes (the
submitter's own advisory check, the import routes' exact-text dedupe).
See [`moderation-workflow.md`](../ai-context/moderation-workflow.md#why-staged-moderation-exists)
for what happens from there, and
[`moderation-workflow.md`'s ingestion-funnel section](../ai-context/moderation-workflow.md#the-ingestion-funnel--one-entrance)
for the funnel itself.

## Why it works this way

- **One funnel, so "every fact gets reviewed" is actually true.** If
  submission and import each wrote to the facts table
  in their own way, "nothing goes live without review" would be separate
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
  either reject jokes that only look alike or need the exact wording match
  bulk import uses, which is far too blunt for something a human wrote from scratch. It
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
near-duplicate section rewritten when the link between facts was retired
(2026-11-15).*
