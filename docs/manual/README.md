# The Overhype.me Manual

> A living, human- and AI-readable manual for how Overhype.me works **and why
> it works that way** — the canonical *narrative* of the system. It exists so
> that during development sprints everyone (David, Claude, Codex, future
> collaborators) shares one picture of the system, and so the reasoning behind
> each design survives the chats it was decided in.
>
> **Read it front to back and you get the whole product.** The chapters below
> are ordered to follow the core loop, not the codebase's module boundaries —
> see *How to read this manual*. Three chapters are written today; the rest are
> being filled in by the one-time backfill, and the table marks exactly which
> is which.

## How to read this manual

Overhype.me runs one loop, and the manual follows it:

**Personalize → submit → moderate & enrich → render → share → the next visitor
personalizes.** A visitor types their name and every fact on the site becomes
about them; a registered user submits their own fact; a human moderator triages,
enriches, and approves it with an authored visual concept; the fact renders into
an image or video meme; the shared meme pulls the next visitor into the loop.
(Fuller version: [`product-brief.md`](../ai-context/product-brief.md).)

Chapters **1–7** walk that loop in order. Chapters **8–10** cover the reader's
own relationship to the product — what they do once inside it, who they are, and
what they pay for. Chapters **11–12** are the machinery underneath, last because
you don't need them to understand the product. Each chapter ends by pointing at
the next, so reading straight through works.

Dipping in for one area works too — every chapter stands on its own and links
into [`docs/ai-context/`](../ai-context/) for the deep spec.

## How this manual relates to `docs/ai-context/`

Two layers, one truth, no forking:

- **`docs/ai-context/`** is the *operational spec* — dense, agent-facing,
  optimized for loading into a model's context before working on a subsystem.
- **`docs/manual/`** (this directory) is the *narrative* — chapters a human can
  read without opening the code: what each area does, how it behaves for users
  and admins, and the reasoning behind its design.

The manual **lives alongside** `docs/ai-context/` permanently; it does not
replace or absorb it. A fact lives in exactly **one** canonical place and the
other side links to it: chapters link into `docs/ai-context/` (and
[`decisions.md`](../ai-context/decisions.md) for rationale history) for deep
spec; they never restate it wholesale. Docs that are **generated from code** —
like [`ADMIN_FIELD_REFERENCE.md`](../ADMIN_FIELD_REFERENCE.md), the first step
toward this manual — stay generated; chapters link to them and never
hand-restate their content.

## How the manual grows

Written incrementally by the **`/document` ceremony**
([`docs/ai-context/documentation-workflow.md`](../ai-context/documentation-workflow.md)):
at the end of a feature build, the chapter for the touched area is created or
updated as part of locking in that feature's learnings. There is no separate
big-bang writing project — though a one-time **backfill of chapters for the
areas below** is tracked as deferred work in
[`current-roadmap.md`](../ai-context/current-roadmap.md) to bring the manual to
full first-version coverage.

Chapters describe the system **as it is now**. History and chronology belong to
`decisions.md` and git — no "changelog" sections accumulate here.

## Chapter quality bar — no empty chapters

A chapter file exists **only** when it holds meaningful present-tense content
across the template below. If a feature produced only a small, localized
learning, that goes to the relevant `docs/ai-context/` doc, decision log,
roadmap, or memory note — **not** a skeletal chapter with headings and no
substance. The TOC may list a planned chapter as *not yet written*; the actual
file appears only once there's real content to fill it.

## Chapter template

Every chapter (once it exists) follows this shape:

1. **What it does** — the area's job, in product terms.
2. **How it works** — user-visible behavior, admin-visible behavior, and a
   plain-language sketch of the machinery underneath.
3. **Why it works this way** — the design rationale: constraints, rejected
   alternatives, and links to the relevant `decisions.md` entries.
4. **Boundaries & known limitations** — what it deliberately does not do, and
   the known rough edges (non-bugs).
5. **Going deeper** — links to the `docs/ai-context/` spec for the area, any
   generated references, and **only stable, high-value code entry points**.
   A chapter is narrative, not a code map — exhaustive code routing belongs in
   [`architecture-map.md`](../ai-context/architecture-map.md) and the subsystem
   docs, which don't drift when files move.

Style: written for a smart reader who has never opened the repo. Plain
sentences over jargon; product terms per
[`glossary.md`](../ai-context/glossary.md); explain the *why*, not just the
*what*. Unverified claims are marked **Needs David confirmation** rather than
stated as fact.

## Contents

In reading order. A chapter file appears only once it holds real content, so
*not yet written* rows are honest gaps rather than placeholders.

| # | Chapter | Covers | Status |
| --- | --- | --- | --- |
| 1 | `personalization-and-grammar.md` | **Personalize** — tokens, pronouns, verb conjugation: how a fact adapts to whoever is reading it | not yet written |
| 2 | `content-lifecycle.md` | **Submit** — a fact's journey from its two entrances through enrichment to publication | not yet written |
| 3 | [`moderation.md`](./moderation.md) | **Moderate** — the three human gates, approvals, overrides, and taking a fact down | ✅ written |
| 4 | [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md) | **Enrich** — classification, hashtags, enrichment versioning, staleness | ✅ written |
| 5 | `visual-pipeline.md` | **Render** — the shared image machinery: Visual Concept, planner, compiler, render modes, frozen inputs | not yet written |
| 6 | `meme-and-video-studio.md` | **Render** — what an end user actually makes: photo memes, AI image and video memes, tier gates, where media lives | not yet written |
| 7 | `public-site-and-sharing.md` | **Share** — home, search, hashtags, leaderboard, profiles, OG cards, merch — the surfaces the loop closes through | not yet written |
| 8 | `community-and-engagement.md` | Ratings, comments, comment hearts, and the activity feed | not yet written |
| 9 | `accounts-and-auth.md` | Sign-in methods, the account lifecycle, verification and password journeys | not yet written |
| 10 | `payments-and-membership.md` | Free vs. Legendary, plan shapes, and what a membership unlocks | not yet written |
| 11 | `admin-console.md` | The admin surfaces and what each is for (companion: the generated [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md)) | not yet written |
| 12 | [`background-work.md`](./background-work.md) | Async jobs, the scheduling lanes, and how status is surfaced (two altitudes) | ✅ written |

When a chapter is added or an area renamed, update this table in the same
commit.

## Outside this manual

This manual covers the **product**. Some things deliberately live elsewhere —
named here so their absence reads as a decision rather than a gap:

- **Operations and diagnostics** — error reporting in [`SENTRY.md`](../SENTRY.md);
  the health and route-stats endpoints in
  [`architecture-map.md`](../ai-context/architecture-map.md).
- **Edge and CDN behavior** — [`cloudflare-rate-limits.md`](../cloudflare-rate-limits.md)
  and [`cloudflare-gaesa-og-fix.md`](../cloudflare-gaesa-og-fix.md).
- **Local dev tooling** — `scripts/dev-supervisor.sh` and the
  [testing guide](../engineering/testing-guide.md).
- **The agent-facing spec layer** — [`docs/ai-context/`](../ai-context/), which
  these chapters link into rather than restate.
- **Field-level admin truth** — the generated
  [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md), never hand-edited.

**Citing code in a chapter:** use a **root-relative path** —
`artifacts/overhype-me/src/pages/Home.tsx`, not a bare `Home.tsx` — so the
docs-accuracy gate actually checks it. Bare filenames are silently skipped by
the checker, which would let a chapter keep a confidently wrong reference under
green CI.
