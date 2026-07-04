# Documentation workflow — the `/document` end-of-feature ceremony

> **Shared, cross-agent contract.** Claude Code and Codex both follow this.
> Claude additionally has a thin skill (`.claude/skills/document/SKILL.md`) that
> enacts it with Claude tooling; Codex reads this doc directly. Same
> relationship as [`working-modes.md`](./working-modes.md) ↔ the `bugfix` skill.

When David judges a feature done, the durable learnings from building it —
decisions and their *why*, gotchas, the new shape of a subsystem — should be
locked into the repo's versioned docs before the chat that holds them
evaporates. This is that ceremony. It turns the standing "memory lives in
files" habit into an explicit, David-triggered fold-in pass, and it is how the
human-facing [Overhype.me Manual](../manual/README.md) gets written,
incrementally, one area at a time.

## Relationship to the other two memory mechanisms

The repo has **three** related-but-distinct memory behaviors. Keeping them
separate is the whole point — don't collapse them:

1. **Targeted persistence ("remember this").** David says "remember this"
   about **one specific item** — a preference, a rule, a fact, a gotcha — and
   the agent persists *that item* immediately to its right durable file. This
   is unchanged and is **not** this ceremony. (For Claude: CLAUDE.md's
   "When David says 'remember this'" rule.)
2. **Area working notes ("memory lives in files").** While building, the agent
   proactively keeps a running working-notes doc for the area, capturing
   decisions and subsystem shape *as work progresses*. This ceremony **relies
   on** those notes as a harvest source but does not replace them.
3. **The `/document` ceremony (this doc).** At a feature's *end*, David
   triggers a harvest across the agent-facing docs and — when warranted — the
   human manual. This is the heavyweight, whole-feature pass.

### Trigger semantics — decide by what "this" refers to

The decisive factor is the **referent**, not just the phrase:

| David's phrasing | Referent | Action |
| --- | --- | --- |
| `/document`, "document this feature", "lock in the learnings from this feature", "write up what we learned", "commit this feature's learnings to memory" | a **feature, PR, slice, build, or set of learnings** | **Full ceremony** (this doc) |
| "remember this: …", "commit this to memory" | **one** specific preference, rule, fact, or gotcha | **Targeted persistence** (mechanism 1 — persist that item now) |
| "document this" / "commit this to memory" with **no clear referent** | unclear | Ask **one numbered question**: targeted persistence, or the full ceremony? |

Worked classifier examples (a fresh agent should sort these without guessing):

- "Remember this: don't use `-B` for bugfix branches." → **targeted
  persistence** (one rule).
- "Commit this feature's learnings to memory." → **full ceremony** (a build's
  worth of learnings).
- "Document this." (bare, no referent) → **ask one numbered question.**

## Step 1 — Harvest

Gather candidate learnings, richest source first:

1. **The build session** — decisions David made and the *why* behind them,
   dead ends we hit and why we rejected them, behavior we discovered, scope we
   deliberately cut.
2. **The feature's diff** — `git diff origin/main...HEAD` on the feature
   branch (or the merged PR's diff if the branch is gone). What changed in the
   system's actual shape, data flow, or source-of-truth boundaries?
3. **The area's working-notes doc**, if one was kept during the build.
4. **The plan doc + PR/bot-review discussion** — including a bot-review finding
   that revealed a real, generalizing pattern.

If `/document` runs in a **fresh chat** with no build context, ask David which
feature/PR to document (numbered options from recent merges) rather than
reconstructing from a cold diff and guessing intent.

**The bar for a durable learning:** *would a fresh agent or a new human
collaborator need this to work in the area?* Qualifying kinds:

- A settled decision + rationale (especially "tried X, rejected it because Y").
- A change to a subsystem's shape, data flow, or source-of-truth boundary.
- A gotcha that cost real time and generalizes beyond the one instance.
- A new term of art.
- A retired mistake that must not be reintroduced.
- Roadmap movement: a slice shipped, a new open question.

**Do NOT document:** transient run details, speculation about undecided future
work, per-PR checklists (that's what TEST_RUN/UAT docs are for), restatements
of already-documented truth (link instead), or anything invented rather than
observed — an unverifiable product claim is marked **Needs David confirmation**,
same as the roadmap does.

**Proportionality.** Output scales to what was actually learned. If a feature
produced nothing durable, the run says so and stops — it does not manufacture
doc churn to look busy.

## Step 2 — Route each learning to its one canonical home

Single source of truth: each learning lands in exactly **one** place; every
other mention links to it.

| Learning | Canonical home |
| --- | --- |
| Subsystem truth changed (architecture, pipeline, data flow) | The matching `docs/ai-context/<subsystem>.md` (`visual-pipeline.md`, `taxonomy-and-enrichment.md`, `token-rendering-and-grammar.md`, `moderation-workflow.md`, `architecture-map.md`, …) |
| Settled decision + why | [`decisions.md`](./decisions.md) — append-only, newest first, its **date · title — Decision / Why / Reference / Revisit if** format |
| Product-level failure pattern / retired mistake | [`known-failure-patterns.md`](./known-failure-patterns.md) |
| Engineering/repo gotcha (build, tests, codegen, env) | A note in `.agents/memory/` **plus** its one-line entry in `.agents/memory/MEMORY.md` |
| New term of art | [`glossary.md`](./glossary.md) |
| Shipped slice / new open question | [`current-roadmap.md`](./current-roadmap.md) (move shipped work to "recently merged"; trim per its header) |
| Engineering practice changed (testing, migrations, review) | The matching `docs/engineering/` doc |
| A brand-new context doc was created | Add it to [`AGENTS.md`](../../AGENTS.md) routing |
| How the area works + why, for humans | The area's chapter in [`docs/manual/`](../manual/README.md) (Step 3) |

Worked routing examples:

| Example learning | Where it goes |
| --- | --- |
| "The Visual Concept is now the authoritative scene." | `decisions.md` (the decision + why) **+** `visual-pipeline.md` (the spec); the manual chapter links both |
| "Never hand-edit the generated admin field reference." | Link to [`ADMIN_FIELD_REFERENCE.md`](../ADMIN_FIELD_REFERENCE.md); no restatement anywhere |
| "A command failed because the test DB was missing." | `.agents/memory/` **only if it recurs / generalizes**; a one-off run detail is not durable |
| "We coined the term 'candidate concept'." | `glossary.md` |
| "We want a manual-chapter backfill, but later." | `current-roadmap.md` deferred work |

**Edit the existing docs in place** — extend and correct them so they describe
*current* truth. Do **not** append "learnings from PR #N" journal sections; the
chronology lives in `decisions.md` and git history.

## Step 3 — Update the manual chapter (only when it clears the quality bar)

The manual is human-facing narrative — what an area does, how it behaves, and
**why it's built that way** — governed by [`docs/manual/README.md`](../manual/README.md)
(audience, tone, chapter template, TOC). Follow that charter.

**Quality bar — no empty chapters.** Create a chapter *only* when there is
enough durable product/process/subsystem truth to write useful present-tense
narrative across the template's sections. A small, localized learning updates
the relevant ai-context / decision / roadmap / memory doc (or an existing
chapter) — it does **not** spawn a skeletal chapter with headings and no
substance. When a real chapter is added, add it to the README's TOC in the
same commit. **Link, don't fork:** deep spec stays in `docs/ai-context/` and
generated references stay generated ([`ADMIN_FIELD_REFERENCE.md`](../ADMIN_FIELD_REFERENCE.md));
the chapter links to them.

## Step 4 — Cross-check before committing

- Every learning has exactly **one** canonical home; other mentions are links.
- The manual and `docs/ai-context/` do not contradict each other — if the
  feature changed truth, *both* sides of any overlap got updated.
- `AGENTS.md` routing and the manual TOC point to any new files.
- No invented product truth: unverified claims carry **Needs David
  confirmation**.
- **Generated docs were not hand-edited.** If generated content
  (e.g. `ADMIN_FIELD_REFERENCE.md`) is wrong, fix the generator / source
  registry and regenerate — never the output file.

## Step 5 — Report & commit

**Report timing** — proportional, so the ceremony neither invents friction nor
commits ambiguous truth:

- If routing is **unambiguous and every claim is repo/session-grounded**, write
  the docs and report the *completed* routing (file → one-line gist) in the
  final summary. No mandatory pause for mechanical doc routing.
- If any claim needs **product judgment** — an unverifiable product claim, a
  "was that a decision or a deferral?" call — stop before committing *that*
  claim and ask David, as **numbered** questions.
- If David explicitly asks to **review the proposed routing before commits**,
  report the plan first and wait.

**Commit** as one docs-only commit (or a few, if ai-context vs. manual
separation aids review). Placement:

- Feature's PR **still open** → commit to that same branch so the learnings
  ship and get reviewed with the feature.
- Feature already **merged** → per the repo's squash-merge workflow, a small
  docs-only PR. Docs PRs have no product-visible behavior, so **no
  TEST_RUN/UAT docs** — a short verification note in the PR body suffices.

## Boundaries

- This is **write-down-what-happened**, not a design session. An unresolved
  product question surfaced during harvest goes into the report (and possibly
  the roadmap's "Open product questions") — it is not silently settled into
  `decisions.md`.
- It does not replace the in-build habits (pause-and-ask during the build; the
  running working-notes doc). `/document` is the backstop and the fold-in.
- **Docs-only.** If harvesting reveals a *code* problem, that's a report item
  for David (bugfix mode or new feature work) — never a drive-by code change
  inside a `/document` run.
