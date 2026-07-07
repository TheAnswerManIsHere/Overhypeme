# The Overhype.me Manual

> A living, human- and AI-readable manual for how Overhype.me works **and why
> it works that way** — the canonical *narrative* of the system. It exists so
> that during development sprints everyone (David, Claude, Codex, future
> collaborators) shares one picture of the system, and so the reasoning behind
> each design survives the chats it was decided in.
>
> **This is the charter + scaffold, not the manual's content.** No substantive
> chapters exist yet. Chapters are written incrementally by the `/document`
> ceremony (or the deferred backfill); the table below lists the planned ones.

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

Planned chapters, mapped from the system's functional areas. *(None written
yet — each gets created by the first `/document` run that clears the quality
bar for its area, or by the deferred backfill.)*

| Chapter | Covers | Status |
| --- | --- | --- |
| `content-lifecycle.md` | A fact's journey: submission → enrichment → moderation → publish | not yet written |
| [`moderation.md`](./moderation.md) | The moderation workflow: review steps, approvals, overrides, render checks | ✅ written |
| `visual-pipeline.md` | How a fact becomes an image: planner, Visual Concept, compiler, render modes | not yet written |
| [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md) | Classification, hashtags, enrichment versioning, staleness | ✅ written |
| `personalization-and-grammar.md` | Tokens, pronouns, verb conjugation — how facts adapt to the reader | not yet written |
| `admin-console.md` | The admin surfaces and what each is for (companion: the generated [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md)) | not yet written |
| `background-work.md` | Async jobs and how their status is surfaced (two altitudes) | not yet written |

When a chapter is added or an area renamed, update this table in the same
commit.
