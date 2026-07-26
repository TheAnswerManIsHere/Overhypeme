# PR234 — VSO presence-based activation + required Visual Concept — TEST_RUN

Engineering checklist for Replit. This PR retires the Visual Strategy Override
(VSO) `enabled` toggle in favor of **presence-based activation** (every field
applies when non-empty), makes the **Visual Concept (`coreSceneOverride`)
required and blocking** at both admin save and production approval, and makes the
prominent `VisualConceptCard` the **single scene-editing surface** (the core-scene
field is removed from the Advanced Options panel).

Sibling doc: [`PR234_VSO_PRESENCE_BASED_UAT.md`](./PR234_VSO_PRESENCE_BASED_UAT.md).

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`). No new exemptions — this PR has no migration (see
  *Schema / DB* below).
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Typecheck (`typecheck:libs`, per-package `typecheck`) — pre-merge gates
  assumed green; spot-check only if something below fails.

## Full sharded suite (backend) — shared infra touched: no

No test runner, DB layer, migration runner, codegen pipeline, or shared
middleware change in this PR. The targeted backend suites below are
sufficient; skip the backend sharded run. (The frontend suite below is run in
full regardless — Vitest's whole-repo run is the normal way this repo runs
frontend tests, not a sharded-suite equivalent.)

## Commands

Build (from repo root):

```bash
pnpm --filter @workspace/overhype-me run build
```

Frontend suite (from repo root):

```bash
pnpm --filter @workspace/overhype-me exec vitest run
```

Expected: all typechecks exit 0; `build` succeeds; the frontend suite passes
with **0 failures** (locally: **833 passed, 78 files**).

Backend suites for the touched areas (from `artifacts/api-server`, using the
repo's runner — never raw `node --test`):

```bash
# First run: seed the test DB with --setup, then drop it for subsequent runs.
bash scripts/run-test.sh --setup \
  src/__tests__/nanoBanana2Compiler.test.ts \
  src/__tests__/promptBudget.test.ts \
  src/__tests__/imagePromptUserMessage.test.ts \
  src/__tests__/visualStrategyOverride.test.ts \
  src/__tests__/visualConcepts.test.ts

bash scripts/run-test.sh \
  src/__tests__/routes.approveVisualConcept.test.ts \
  src/__tests__/routes.adminFactsEnrichment.test.ts \
  src/__tests__/routes.candidateEnrichmentEditing.test.ts \
  src/__tests__/routes.reviews.test.ts \
  src/__tests__/enrichmentVersioning.refresh.test.ts
```

Expected: **0 failures.** (Replit owns the DB connection — the `--setup` flag
seeds whatever test DB Replit points the runner at; don't add `DATABASE_URL`
exports here.)

## What the tests prove

**Compiler / budget (the keystone invariant):**

- `nanoBanana2Compiler.test.ts` — the **keystone test**: an override whose every
  field is empty compiles **byte-identically** to having no override at all
  (`activeOverride()` now returns the override iff any field is present, not iff
  `enabled`). Populated fields still merge into their compiled sections.
- `promptBudget.test.ts` — the budget measurers (`measureModeratorAdditionsEmission`,
  `measureBubbleDirectivesEmission`) count emission based on **presence**, not an
  `enabled` flag; an empty override measures 0.
- `imagePromptUserMessage.test.ts` — the assembled user message reflects
  presence-based sections.

**Schema / helpers:**

- `visualStrategyOverride.test.ts` — `EMPTY_VISUAL_STRATEGY_OVERRIDE` has no
  `enabled` key; a stored row that still carries `enabled` parses cleanly (Zod
  strips the unknown key) — this is why no migration is needed.
- `visualConcepts.test.ts` — `withCandidateConceptDraft` and the token-error
  probes no longer set `enabled: true`.

**Required-concept gates (server-side, blocking):**

- `routes.adminFactsEnrichment.test.ts` — `PATCH /admin/facts/:id/enrichment`
  rejects a blank/absent `coreSceneOverride` with **`400 visual_concept_required`**,
  and the gate sits **after** the 404 / write-freeze / tracked-field checks so it
  never shadows them.
- `routes.candidateEnrichmentEditing.test.ts` — `PATCH
  /admin/reviews/:id/candidate-enrichment` rejects a blank concept
  (`400 visual_concept_required`) from **inside** the transaction, after the
  tracked-field check.
- `routes.approveVisualConcept.test.ts` — Step-2 approve-visual-concept blocks a
  blank concept with **`CONCEPT_MISSING`** (the old `CONCEPT_DISABLED` branch is
  retired).
- `routes.reviews.test.ts` — first-time and refresh production-approval paths
  re-check the resolved concept and **409 `CONCEPT_MISSING`** when it's blank.
- `enrichmentVersioning.refresh.test.ts` — refresh cycles author a concept before
  promoting (the `authorConceptForCycle` helper), proving the promote path is
  concept-gated.

## Schema / DB

- **No migration.** The `enabled` column/field is retired at the type level only;
  stored enrichment blobs that still contain `"enabled": …` parse fine because
  `z.object` strips unknown keys. Confirm nothing in this PR adds a Drizzle
  migration.

## Deliberately NOT in this PR (deferred — "Head 2")

- **System-wide activation guard** — enforcing that a fact cannot be
  `isActive: true` without a non-empty Visual Concept **everywhere** (not just the
  moderation approval paths this PR covers).
- **Ingestion → Stage-1 routing** — guaranteeing every ingestion path (manual
  submit, bulk import, any future API) drops the fact at the front of the
  triage → enrich → activate pipeline.

Both are a recorded pre-launch fast-follow (see `docs/ai-context/decisions.md`),
not part of this PR.

## Delete me

Transient — delete once Replit has run the checklist. The
[`PR234_VSO_PRESENCE_BASED_UAT.md`](./PR234_VSO_PRESENCE_BASED_UAT.md)
sibling is the durable half.
