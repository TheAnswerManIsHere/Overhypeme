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
one, an admin or an external system imports a batch, or an admin creates a
variant of a fact that's already live — and all three land in the same
place: a pending review, not the live catalogue. There is no fourth path and
no shortcut in the product itself: nothing in the running application can
create a fact directly outside this funnel. (Offline dev/ops tooling — a
database seed script, a reseed utility — can insert facts directly; that's
maintenance tooling, not a product ingestion path, and this chapter doesn't
cover it.) That single funnel is what lets [`moderation.md`](./moderation.md)
describe one review process and mean it for every fact, regardless of how it
arrived.

This chapter covers the entrances themselves — what a submitter sees, what
an importer sends, what a variant inherits from its parent — and the
cheap, pre-review checks each one runs before a fact ever reaches a human.
What happens after that hand-off (triage, enrichment, the Visual Concept and
Test Renders gates, publication) belongs to moderation and taxonomy, and
this chapter links out rather than repeating it.

## How it works

### For the submitter (writing a fact)

Submitting is a two-step form: **write**, then **preview**. While the
submitter is writing, a **duplicate check** runs automatically in the
background — no button needed — comparing the draft against existing facts
and, if it finds a likely match, showing it so the submitter can decide for
themselves whether to continue. It's advisory only: nothing stops a
submission that's flagged. It's also best-effort, not guaranteed — the check
re-runs against the finished template on Preview, but Submit stays clickable
while it's still in flight, so submitting before the check resolves reaches
the server with no duplicate flag attached at all, even against a real
match.

Moving from Write to Preview is a different kind of step — a **required,
blocking** one. Clicking Preview sends the draft through a grammar pass that
resolves the fact's `{NAME}` and pronoun placeholders into a preview across
example names and pronoun sets, so the submitter can catch an awkward
conjugation before sending it in. A failed pass leaves the submitter on
Write with an error rather than letting them continue; only a successful one
reaches Preview.

That normal path to Preview also fetches AI-suggested hashtags to pre-fill
the (editable) hashtags field — a non-blocking suggestion the submitter can
keep, edit, or clear. (A submitter picking up an autosaved draft skips
straight to Preview with their saved template and doesn't trigger a fresh
suggestion fetch.)

Submitting requires being signed in. A onetime step also applies before a
first fact can be submitted: anyone who isn't an admin or an existing
Legendary member must complete onboarding (which includes a captcha check)
first; admins and Legendary members skip it. On submit, the server
re-normalizes the fact's grammar independently of what the client already
checked — a submission that reached the server without going through the
Write-to-Preview grammar pass (an API client, a stale front-end) still gets
the same cleanup applied, so every fact that reaches the review queue has
been through the same grammar pass regardless of how it arrived. (One
submitter's own pending facts are also protected from flooding the queue —
see *Boundaries & known limitations* below.)

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
submission uses, so an imported fact's stored text is cleaned up identically
to a hand-submitted one — though the rows aren't otherwise identical: an
admin-console import attributes the acting admin as submitter and always
queues an empty hashtag list; an API-key import has no submitter at all but
can carry caller-chosen hashtags; only a user submission carries
duplicate-match metadata. Both import paths
also **dedupe by exact (normalized) text** — against every existing fact row
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
uses later to keep the two facts grouped for show/hide and kinship — see
[`moderation-workflow.md`'s activation chokepoint](../ai-context/moderation-workflow.md#the-activation-chokepoint--one-exit)
for how that link is revalidated before the variant can actually go live.

### Underneath: one funnel, one cost gate

All three entrances — the submit route, both import routes, and variant
creation — call the same function to create a pending review row, and
nothing else in the codebase does. That row starts at the very first stage
of the review pipeline; none of the entrances can hand a fact a head start.
The **moderation-prep pipeline** — AI classification, image lookups, renders
— never runs at intake; that work only begins once a human moderator
provisionally accepts a submission at Triage. (The cheap pre-submit
affordances a submitter already used on the way in — the grammar/tokenize
pass, the duplicate check, hashtag suggestions — do call utility models;
[`moderation.md`](./moderation.md) draws this same distinction. What's
gated at Triage is the paid moderation-prep pipeline specifically, not every
model call ever made about the fact.) Intake itself is just: normalize the
grammar and queue the review — a duplicate check runs on some entrances (the
submitter's own advisory check, the import routes' exact-text dedupe) but
not all of them; variant creation, for one, does neither.
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

*Verified against `b720d6f` (2026-08-08) · claim inventory in PR #355.*
