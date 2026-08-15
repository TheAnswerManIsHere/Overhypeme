# The Overhype.me Manual

> A living, human- and AI-readable manual for how Overhype.me works **and why
> it works that way** — the canonical *narrative* of the system. It exists so
> that during development sprints everyone (David, Claude, Codex, future
> collaborators) shares one picture of the system, and so the reasoning behind
> each design survives the chats it was decided in.
>
> **Read it front to back and you get the whole product.** The chapters below
> are ordered to follow the core loop, not the codebase's module boundaries —
> see *How to read this manual*. The one-time backfill that brought every
> chapter to first-version coverage is complete; the *Contents* table below
> stays the live record of what's written, not restated here as a count that
> would only go stale again as the manual keeps growing.

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

### The one bounded exception: naming machinery without quantifying it

Some areas' product story *is* their machinery — background work, the visual
pipeline, enrichment. For those, a pure link leaves a chapter that reads
"there are some moving parts; see the spec," which fails this manual's own
quality bar. So chapters may cross the line in exactly one direction
(David, 2026-07-30):

- **Allowed — what a component is, who it serves, and what is at stake.**
  *"A lane for admin actions where someone clicked a button and is waiting to
  see it take effect; another for batches nobody is watching."* Audience and
  consequence are what a reader needs to follow the story, and they change
  only when the **product** changes.
<!-- tuning-ok:start -->
- **Not allowed — how it is configured.** Not a number, and **not a
  qualitative stand-in for one**: *fast*, *frequently*, *serialized*, *a few
  at a time*, *capped*, *about half an hour* are all values wearing prose.
  Counts, intervals, concurrency bounds, timeouts, thresholds, retry budgets,
  defaults, and queue-to-component assignments live **only** in
  `docs/ai-context/`.

The test: **could someone change a constant — by any amount, including an
order of magnitude — without making this sentence wrong?** If not, it is over
the line. Naming the audience and the stake survives any constant change;
describing the tuning does not, even in words.

| Over the line | Fine |
| --- | --- |
| "five lanes" | "independent lanes" |
| "polls every 2 seconds" / "polls frequently" | "for work someone is waiting on" |
| "serialized to one job at a time" | "for work that spends money at an external provider" |
| "recovered after about half an hour" / "not promptly" | "recovered automatically, on a deliberate delay" |

The rightmost column stays true whether the interval is two seconds or two
hours — which is the whole point. Note the last row: *"not promptly"* is over
the line too. It sounds qualitative but it is a claim about magnitude, and
shrinking the delay would falsify it. *"On a deliberate delay"* says the thing
a reader actually needs — recovery is not instant, and that is a choice, not a
bug — without betting on how long.
<!-- tuning-ok:end -->

**There is no "but the product changed" escape.** An earlier draft of this
rule said that if a constant change would falsify the narrative phrasing, the
product had changed and the chapter should be rewritten. That let any tuning
drift be relabelled a product change, which is the loophole the rule exists to
close. The test is mechanical: **if the sentence's truth depends on the value,
it belongs in the spec** — no matter how the change is characterised.

This is an exception, not a general licence — it applies to the narrative
sections of a chapter whose subject is machinery, and it never extends to
restating a whole spec section.

**Part of this boundary is CI-enforced, not just reviewer-enforced.**
`scripts/check-manual-tuning-language.mjs` fails the build on the value forms
it's taught to detect anywhere in `docs/manual/` (the `<!-- tuning-ok -->`
escape hatch above is how this section's own deliberate quotations pass it).
It is lexical and deliberately narrow, not a semantic or exhaustive check: it
cannot catch a fact with two homes, a paraphrased spec section, or a value
phrased in a form its rules don't yet cover — only the specific value and
stand-in shapes named in the script's own comments. A green run means no
*detected* violation, never that the chapter is fully compliant, so it
doesn't replace review, only automates part of it. See
[`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#fixing-the-flagged-site-and-leaving-its-siblings)
for what it still can't do.

## How the manual grows

Written incrementally by the **`/document` ceremony**
([`docs/ai-context/documentation-workflow.md`](../ai-context/documentation-workflow.md)):
at the end of a feature build, the chapter for the touched area is created or
updated as part of locking in that feature's learnings. There is no separate
big-bang writing project as a matter of course — the one exception was a
**one-time backfill** (approved by David 2026-07-30, closed out 2026-08-09)
that brought the manual from 3 written chapters to the full **12** in reading
order, plus 6 new `docs/ai-context/` subsystem specs for the areas that had
none to link into; see
[`current-roadmap.md`](../ai-context/current-roadmap.md#recently-merged-or-completed-work)
for that pass's history. From here on, growth is incremental only.

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

### Link each glossary term once per chapter

A reader who lands mid-manual shouldn't have to already know what a *Visual
Concept*, a *staging fact*, or a *recipe* is. So the **first** time a chapter
uses a term defined in [`glossary.md`](../ai-context/glossary.md), it links to
that term's anchor:

```markdown
a moderator authors the [Visual Concept](../ai-context/glossary.md#visual-concept)
```

**First occurrence only** — linking every mention turns a chapter into link
soup. Later mentions stay plain text.

This matters most for the ordinary English words that mean something specific
here — *preview*, *grammar*, *recipe*, *root*, *lane*, *skipped*, *remove*,
*rendering* — where a reader who doesn't follow the link may never realize
they've misread the sentence. Several of those words name **more than one**
thing (a submit-form *Preview*, a shared link's *rich preview*, the admin
*compiled-prompt* preview), so link the sense the sentence actually means.

Glossary anchors are generated from its `###` headings, so renaming a heading
breaks every chapter link into it — rename deliberately and update the
chapters in the same commit. `pnpm run check:docs` verifies that a linked
*file* exists but **not** that an anchor within it does, so anchors are
review-checked, not CI-checked.

## Contents

In reading order. A chapter file appears only once it holds real content, so
*not yet written* rows are honest gaps rather than placeholders.

| # | Chapter | Covers | Status |
| --- | --- | --- | --- |
| 1 | [`1-personalization-and-grammar.md`](./1-personalization-and-grammar.md) | **Personalize** — tokens, pronouns, verb conjugation: how a fact adapts to whoever is reading it | ✅ written |
| 2 | [`2-content-lifecycle.md`](./2-content-lifecycle.md) | **Submit** — the two ways a fact is submitted (user submission, admin/API-key bulk import), the one funnel they hand off into review through, and how variants group near-duplicate wordings | ✅ written |
| 3 | [`3-moderation.md`](./3-moderation.md) | **Moderate** — the three human gates, approvals, overrides, and taking a fact down | ✅ written |
| 4 | [`4-taxonomy-and-enrichment.md`](./4-taxonomy-and-enrichment.md) | **Enrich** — classification, hashtags, enrichment versioning, staleness | ✅ written |
| 5 | [`5-visual-pipeline.md`](./5-visual-pipeline.md) | **Render** — the shared image machinery: Visual Concept, planner, compiler, render modes, frozen inputs | ✅ written |
| 6 | [`6-meme-and-video-studio.md`](./6-meme-and-video-studio.md) | **Render** — what an end user actually makes: photo memes, AI image and video memes, tier gates, where media lives | ✅ written |
| 7 | [`7-public-site-and-sharing.md`](./7-public-site-and-sharing.md) | **Share** — home, search, hashtags, leaderboard, profiles, OG cards, merch — the surfaces the loop closes through | ✅ written |
| 8 | [`8-community-and-engagement.md`](./8-community-and-engagement.md) | Ratings, comments, comment hearts, meme hearts, and the activity feed | ✅ written |
| 9 | [`9-accounts-and-auth.md`](./9-accounts-and-auth.md) | Sign-in methods, the account lifecycle, verification and password journeys | ✅ written |
| 10 | [`10-payments-and-membership.md`](./10-payments-and-membership.md) | Free vs. Legendary, plan shapes, and what a membership unlocks | ✅ written |
| 11 | [`11-admin-console.md`](./11-admin-console.md) | The admin surfaces and what each is for (companion: the generated [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md)) | ✅ written |
| 12 | [`12-background-work.md`](./12-background-work.md) | Async jobs, the scheduling lanes, and how status is surfaced (two altitudes) | ✅ written |

**This table is the source of truth for chapter numbers**, and the number now
appears in two other places that must agree with it: each chapter's own `#
Chapter N · Title` heading, and the `**Next:** chapter N — …` footer of the
chapter before it. Inserting or reordering a chapter therefore renumbers a run
of files, not just this table — do it in the same commit, and check the
footers, which are the easiest of the three to miss. (Nothing enforces this
yet; a consistency check is a good candidate for the Build job if it ever
drifts.)

Deliberately **not** written anywhere: "chapter N **of 12**." A total restated
across twelve files is exactly the kind of count that goes stale the moment a
chapter is added — this table stays the one place that knows how many there
are.

## Outside this manual

This manual covers the **product**. Some things deliberately live elsewhere —
named here so their absence reads as a decision rather than a gap:

- **Operations and diagnostics** — error reporting in [`SENTRY.md`](../SENTRY.md);
  the health and route-stats endpoints in
  [`architecture-map.md`](../ai-context/architecture-map.md#health-and-route-stats-endpoints).
- **Edge and CDN behavior** — [`cloudflare-rate-limits.md`](../cloudflare-rate-limits.md)
  and [`cloudflare-gaesa-og-fix.md`](../cloudflare-gaesa-og-fix.md).
- **Local dev tooling** — `scripts/dev-supervisor.sh` and the
  [testing guide](../tests/TESTING.md).
- **The agent-facing spec layer** — [`docs/ai-context/`](../ai-context/), which
  these chapters link into rather than restate.
- **Field-level admin truth** — the generated
  [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md), never hand-edited.

**Citing code in a chapter:** use a **root-relative path** —
`artifacts/overhype-me/src/pages/Home.tsx`, not a bare `Home.tsx` — so the
docs-accuracy gate actually checks it. Bare filenames are silently skipped by
the checker, which would let a chapter keep a confidently wrong reference under
green CI.
