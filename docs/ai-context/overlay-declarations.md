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
direct-push sweep), `agent-working-rules.md`, `working-modes.md` (the tier
table and Tier B routing), `code-review.md`.
**If unanswered:** migrations, auth and payments still route to the specialist
review — they are named in the shared rules — but everything below stops
getting it.

A change landing in any of these is **sensitive**: full ceremony plus the
relevant specialist review, and Tier B at minimum for a bug fix.

- **Payments, auth, permissions, security headers.**
- **The tokenizer, the grammar, and `render-fact`.**
- **The visual pipeline** — planner, compiler, render policy, Visual Concept.
- **The async job queue**, worker lanes, and any enqueue helper.
- **Enrichment and moderation source-of-truth** — `facts.*`,
  `resolveEnrichment`, the override layers.
- **The generated API-validation schemas** — `lib/api-zod/`, `lib/api-spec/`.
  See the next section: these are Tier B, and are *not* the database-schema
  trigger.
- **Dev-infra and build tooling** — Vite/esbuild config, the dev supervisor,
  the retry and reload paths, the CI workflows.

**Not on this list, and deliberately:** the *database* schema — Drizzle,
`lib/db`, migrations, table structure — which the shared rules already route by
name, at a higher tier than this list carries.

## Modules that generate API-validation schemas

**Asked by:** `working-modes.md` Tier B/C routing.
**If unanswered:** a schema change routes to the wrong tier.

**`lib/api-zod/` and `lib/api-spec/`.**

These generate the Zod **API-validation** schemas. They are **distinct from the
database schema**, and the distinction decides the tier: a fix confined to these
is Tier B, not Tier C. The trap they exist to flag is the codegen allowlist —
`lib/api-zod/src/index.ts` is rewritten from the allowlist in
`lib/api-spec/patch-generated.mjs`, so a hand-edit to it is silently reverted by
the next codegen run. That incident is
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

## Adding a further declaration

**A new question gets a new section here, never a new file**, and a matching row
in the handbook's consuming-repos document. The handbook gained the first four
one at a time, and each was installed separately or not at all — one document
with a growing list is the shape that cannot repeat that.

**Product truth is not declared here.** Where this repo's brief, direction,
roadmap, architecture map, glossary, subsystem docs and `decisions.md` live is
routed from `CLAUDE.md` and `AGENTS.md` directly — those are documents this repo
already owns, not facts it has to declare.
