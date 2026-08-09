# Admin Console

> Where the team runs Overhype.me day to day — reviewing content,
> managing accounts, tuning how the product behaves, and watching its
> machinery run.
>
> Deep spec: [`admin-console.md`](../ai-context/admin-console.md).
> Field-level reference for the enrichment editor specifically:
> [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md) (generated, never
> hand-edited).

## What it does

Everything an admin does to operate the product — reviewing submitted
facts and comments, managing users, adjusting what each membership tier
can do, watching background jobs and render quality, handling billing
questions — happens behind one gated console, reachable only to
signed-in admin accounts.

## How it works

This chapter is a map, not a walkthrough — several of these areas
already have their own full chapter, which this one links to rather than
repeats.

### Getting in and finding your way around

Admins sign in the same way anyone does (see
[`accounts-and-auth.md`](./accounts-and-auth.md)); the console itself
checks that role and turns visitors away otherwise. A sidebar groups
every admin surface together, with a live counter on the moderation
section so the team can see at a glance whether anything's waiting.

### Reviewing content

New facts and comments both go through a review step before they're
public — covered in full in [`moderation.md`](./moderation.md) and
[`community-and-engagement.md`](./community-and-engagement.md). Beyond
that review queue, there's a separate, broader facts screen for directly
searching, editing, or removing any fact already in the system, plus
tools for bulk-importing a batch of new facts at once and for
re-running classification on facts that predate it.

### Managing people

The users screen covers everything from finding an account to changing
its role, deactivating or removing it (see
[`accounts-and-auth.md`](./accounts-and-auth.md)) — plus a few things
that live only here: manually granting or revoking a lifetime membership
independent of any payment, manually marking an email verified, and
creating an account directly rather than through normal sign-up.

### Money

Separate screens cover the product's Stripe-facing side: billing
configuration and plan pricing, and a log of refunds and disputes as
they happen.

### Tuning how the product behaves

Two different screens exist for two different questions. One is a
general settings editor for the product's overall configuration. The
other is specifically about what each membership tier is allowed to do
— a grid of features against tiers, so "can a free user do X" is always
one clear answer in one place rather than scattered across code.

### Watching the machinery

A handful of screens exist purely to keep an eye on things running in
the background: the health of the job queues that do async work, the
quality of AI-rendered images against a curated reference set, and which
pages are actually getting traffic.

## Why it works this way

- **Centralizing admin work in one gated place, rather than scattering
  it, keeps oversight legible.** Anyone on the team can go to one place
  and find every lever, instead of hunting for a one-off internal tool
  built for a single task.
- **Product-wide settings and tier-specific permissions are split into
  two screens because they answer different questions.** One is "how does
  the product behave in general," the other is "what does this
  particular membership unlock" — keeping them apart means changing one
  doesn't risk quietly touching the other.
- **The enrichment field reference is generated instead of hand-written**
  because those fields are technical, numerous, and change as the
  taxonomy evolves — a hand-maintained version would drift the moment
  someone added a field and forgot to update a doc; a generated one
  can't drift, and a build check catches it if it ever tries to.

## Boundaries & known limitations

- **The console's real footprint is a little smaller than what exists in
  the codebase.** A couple of older admin screens are still present as
  files but aren't actually reachable anymore — their replacements
  absorbed the same functionality and the old ones were never cleaned
  up. Nothing to route around; just don't be surprised if a stray file
  doesn't correspond to a live page.
- **There's no dedicated screen for browsing or managing every meme the
  way there is for facts.** The only meme-facing admin surfaces today
  are the ones tied to moderation and to a legal/safety review path that
  doesn't yet have a purpose-built interface of its own.
- **A small handful of settings tied to legal/safety reporting are
  visible in the general settings screen but can't actually be changed
  yet** — the machinery they'd configure isn't live, so those particular
  fields exist ahead of what they control. They look like any other
  setting in the list; nothing currently marks them as different.
- **The "flagged comments" review tab's own description overstates what
  populates it** — see
  [`community-and-engagement.md`](./community-and-engagement.md#boundaries--known-limitations)
  for the underlying gap.

## Going deeper

- Spec: [`admin-console.md`](../ai-context/admin-console.md) — the full
  page inventory, exact routes, and the specific dead/misleading
  surfaces found while writing this chapter.
- Field reference: [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md)
  (enrichment fields only — generated, not a general admin index).
- Related: [`moderation.md`](./moderation.md),
  [`community-and-engagement.md`](./community-and-engagement.md),
  [`accounts-and-auth.md`](./accounts-and-auth.md),
  [`payments-and-membership.md`](./payments-and-membership.md),
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).

**Next:** chapter 12 — [`background-work.md`](./background-work.md),
async jobs, the scheduling lanes, and how status is surfaced.

*Verified against `4fd4c66` (2026-08-09) · claim inventory in PR #379.*
