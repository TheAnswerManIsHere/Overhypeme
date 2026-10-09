# Overlay declarations — what the shared rules ask this repo

The vendored contract under `.agents/core/` is written for any product. Where a
rule needs a fact about *this* product, it defers to "the overlay" rather than
naming Overhype's modules itself. **This file is where those answers live**, and
both `CLAUDE.md` and `AGENTS.md` route here — one document rather than a copy in
each, because two hand-maintained lists of one thing drift.

**None of these fail loudly when missing.** Every one degrades into less
ceremony or weaker review, silently. That is why they are written here rather
than discovered when something goes wrong.

Each answer below was carried over from the text Overhype already carried before
the handbook cutover, so nothing about how this repo is reviewed changed on the
day the contract arrived.

---

## Sensitive subsystems

**Asked by:** `claude-core.md` (the feature-building ceremony, and the Replit
direct-push sweep), `agent-working-rules.md`, `working-modes.md` (the artifact
tier table under *Feature mode*, and Q1 under *Bugfix mode*), `code-review.md`.
Those rules name the universal classes themselves and say what each routing
changes; this section names only Overhype's own subsystems, and which of the
two routings each one takes.
**If unanswered:** these subsystems stop routing; the universal classes are
unaffected.

**Sensitive** — the tier table's "any subsystem the overlay marks sensitive"
row, and Q1:

- **The visual pipeline** — planner, compiler, render policy, Visual Concept.
  See [`visual-pipeline.md`](./visual-pipeline.md).

**Q1 only** — named for bugfix routing, not for the tier table's
sensitive row:

- **The tokenizer, the grammar, and `render-fact`**
  (`artifacts/overhype-me/src/lib/render-fact.ts`).
- **Enrichment and moderation source-of-truth** — `facts.*`,
  `resolveEnrichment`, the override layers. See
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md) and
  [`moderation-workflow.md`](./moderation-workflow.md).

That split is how each was routed before the handbook cutover: the old
`CLAUDE.md` gave the specialist review to the visual pipeline alone among
these, and the old `working-modes.md` named the other two in Q1.

## Modules that generate API-validation schemas

**Asked by:** `working-modes.md`, which says how these are routed and how they
differ from the database schema.
**If unanswered:** an agent cannot tell which directories that rule means.

**`lib/api-zod/` and `lib/api-spec/`.** The database schema is `lib/db/`.

The trap in these directories is the codegen allowlist:
`lib/api-zod/src/index.ts` is rewritten from the list in
`lib/api-spec/patch-generated.mjs` on every codegen run, so a hand-edit to the
index alone is silently reverted. That incident is
[`known-failure-patterns.md`](./known-failure-patterns.md)'s codegen-revert
pattern.

## The reference implementation for async status

**Asked by:** `async-ui-status.md`.
**If unanswered:** an agent re-derives a solved UI instead of copying the one
that already works.

**The Taxonomy Health panel** — `useTaxonomyHealthActions.ts` on the frontend.

It is the worked example of the two-altitude rule: per-item status and an
overall state, both live. **Copy it rather than re-deriving the pattern.**

Its transport is the `async_jobs` queue polled by job id, and the same helpers
are what a new async surface should reuse rather than inventing a second status
channel.

## Shared modules a reviewer should know

**Asked by:** `code-review.md`.
**If unanswered:** reuse stops being a review criterion, so reimplementation
goes unflagged.

A reviewer should ask whether a change reuses these rather than reimplementing
them:

- **`resolveEnrichment`** — enrichment resolution over `facts.*` and the
  override layers.
- **`render-fact`** — fact rendering.
- **`compileForSubjectRenderMode`** — the visual-pipeline compile path.
- **`useTaxonomyHealthActions`** — the async status pattern above.

Alongside the conventions, rather than modules: the generated API hooks on the
frontend, the Drizzle schema conventions, the async job queue, and the engines
catalogue.

---

## Feature phases

**Asked by:** `working-modes.md` *The prototype phase, per feature*; the
`prototype` skill; the entry routing in `.agents/core/claude-core.md` *Two
modes*.
**If unanswered:** every feature is treated as production phase, so a
prototype gets the full loop — the one declaration that fails toward *more*
ceremony, never less.

**No feature of Overhype.me is in prototype phase.** Every feature is in
production phase and takes the full ceremony. David declares a phase in words,
and the declaration is recorded here by its own one-line registry PR before the
first version's planning loop opens, as one row:

| Feature | Phase | Last changed | Regime / branch | Prototype directory |
| --- | --- | --- | --- | --- |
| *(none)* | | | | |

Overhype.me has users downstream of `main` once it launches (#628), so a
prototype declared after launch takes the **branch regime** —
`prototype/<feature>`, its own environment and database — and needs the
*Tester tier* declaration below before it starts.

---

## Tester tier

**Asked by:** `working-modes.md` *The prototype phase, per feature*; the
`prototype` skill.
**If unanswered:** no branch-regime prototype may start — the tier is built
through the normal pipeline first, so a missing declaration holds the
prototype rather than running it with a feedback rail nobody can see.

**Not yet declared.** Overhype.me has no tester tier and no branch-regime
prototype. When the first one is declared, this section names the user tier,
the configuration setting that switches it on, and the CI workflow's `push`
trigger on `prototype/**` (a branch that opens no PR fires no pull-request
run).

---

## Adding a further declaration

**A new question gets a new section here, never a new file**, and a matching row
in the handbook's consuming-repos document. The handbook gained the first four
one at a time, and each was installed separately or not at all — one document
with a growing list is the shape that cannot repeat that.

**Product truth is not declared here.** Where this repo's brief, direction,
roadmap, architecture map, glossary, subsystem docs and `decisions.md` live is
routed from `CLAUDE.md` and `AGENTS.md` directly — those are documents this repo
already owns, not facts it has to declare.
