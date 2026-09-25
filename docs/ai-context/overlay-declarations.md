# What the shared rules ask this repo

The shared working contract (`.agents/core/`, `docs/ai-context/`,
`docs/engineering/`) is written for every product David builds. Where a rule
needs a product-specific answer, it asks the overlay rather than naming one
product's modules. This file answers those questions for Overhype.me. Both
`CLAUDE.md` and `AGENTS.md` route here, so Codex and every other agent see the
same answers.

**Nothing complains when an answer here goes missing.** Each one degrades into
weaker review or less ceremony without an error. A new question from the
handbook gets a new section here, not a new file.

The answers were taken from what the shared docs said about Overhype before
the 2026-09 cutover to the handbook, when they still named this repo's
modules directly. The point was to keep today's review behaviour unchanged,
neither stronger nor weaker.

## Sensitive subsystems

Asked by `working-modes.md` (feature ceremony, and bugfix Tier B, Q1),
`code-review.md`, `agent-working-rules.md` and `claude-core.md`.

**Sensitive: full ceremony plus the relevant specialist review.** In
addition to the universal entries (migrations, backfills, auth, payments):

- **The visual pipeline**: planner, compiler, render policy, Visual Concept.
  See [`visual-pipeline.md`](visual-pipeline.md).

**Tier B for a bugfix, not specialist review for feature work.** Before the
cutover, these subsystems made a bugfix Tier B (Q1) without adding a
specialist review to feature work. They keep exactly that routing:

- **The tokenizer, grammar and render-fact**
  (`artifacts/overhype-me/src/lib/render-fact.ts`). See
  [`token-rendering-and-grammar.md`](token-rendering-and-grammar.md).
- **Enrichment and moderation source of truth**: `facts.*`, the override
  layers, and `resolveEnrichment` in `lib/api-zod/src/enrichmentOverrides.ts`.
  See [`taxonomy-and-enrichment.md`](taxonomy-and-enrichment.md) and
  [`moderation-workflow.md`](moderation-workflow.md).

The shared Q1 list already names payments, auth, permissions and security
headers; the async job queue, worker lanes and enqueue helpers; generated
API-validation schemas; and dev-infra.

## Generated API-validation schemas

Asked by `working-modes.md` (Tier B Q1, and the Tier C boundary).

`lib/api-zod/` and `lib/api-spec/`. Codegen rewrites
`lib/api-zod/src/index.ts` from a hardcoded list in
`lib/api-spec/patch-generated.mjs` on every run, so a hand-edit to the index
alone is silently reverted. That is the codegen allowlist trap in
[`known-failure-patterns.md`](known-failure-patterns.md). A fix confined to
these directories is Tier B, not Tier C. Tier C is the **database** schema:
`lib/db/`, migrations and table structure.

## Reference implementation for async status

Asked by [`async-ui-status.md`](async-ui-status.md).

**The Taxonomy Health panel**, driven by
`artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts`.
Copy it before designing a new status surface.

## Shared modules a reviewer should know

Asked by `code-review.md` (*Repository fit*). A change that reimplements one of
these instead of reusing it is a finding:

- `resolveEnrichment`, in `lib/api-zod/src/enrichmentOverrides.ts`
- render-fact, `artifacts/overhype-me/src/lib/render-fact.ts`
- `compileForSubjectRenderMode`, in
  `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts`
- `useTaxonomyHealthActions`,
  `artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts`

The repo's other established patterns belong here too: the generated API
hooks on the frontend, the Drizzle schema conventions, the async job queue
(`async_jobs`) and the engines catalogue.
