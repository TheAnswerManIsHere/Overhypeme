# PR234 — VSO presence-based activation + required Visual Concept — TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. This PR retires the Visual Strategy Override (VSO) `enabled`
toggle in favor of **presence-based activation** (every field applies when
non-empty), makes the **Visual Concept (`coreSceneOverride`)** required and
blocking at both admin save and production approval, and makes the prominent
`VisualConceptCard` the single scene-editing surface. **Replit owns the DB
connection** — no `DATABASE_URL` / test-DB env is set anywhere in this doc.

Sibling doc: [`PR234_VSO_PRESENCE_BASED_UAT.md`](./PR234_VSO_PRESENCE_BASED_UAT.md).

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails.

**No test suites in this checklist, deliberately.** This PR's behavior is
covered by `nanoBanana2Compiler.test.ts`, `promptBudget.test.ts`,
`imagePromptUserMessage.test.ts`, `visualStrategyOverride.test.ts`,
`visualConcepts.test.ts`, `routes.approveVisualConcept.test.ts`,
`routes.adminFactsEnrichment.test.ts`,
`routes.candidateEnrichmentEditing.test.ts`, `routes.reviews.test.ts`, and
`enrichmentVersioning.refresh.test.ts` on the backend, plus the frontend
Vitest suite — all of which already ran and passed in CI on this exact code.
Re-running any of them here would verify nothing new. Everything below is
what CI genuinely cannot see: the state of the post-merge repo. Nothing
below writes a row.

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes
  (matches CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. No new
  `SNAPSHOT_EXEMPT_TAGS` entries — this PR has no migration (see *Live
  checks* below).
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Other allow-list entries this PR added: none.

## Live checks

This PR has no migration and touches no seeded `admin_config`, catalogue
data, queue behavior, or external service, so there is nothing
live-database- or live-config-specific to check beyond the repo-health gates
above. **No migration.** The `enabled` field is retired at the type level
only; stored enrichment blobs that still carry `"enabled": …` parse cleanly
because `z.object` strips unknown keys — this is why no migration was
needed. The check-snapshots gate above already confirms no new migration
landed unexempted.

Tests already covering this PR's behavior in CI, named here for awareness
(they run in CI, not here):

**Compiler / budget (the keystone invariant):**
- `nanoBanana2Compiler.test.ts` — the **keystone test**: an override whose
  every field is empty compiles **byte-identically** to having no override
  at all (`activeOverride()` now returns the override iff any field is
  present, not iff `enabled`). Populated fields still merge into their
  compiled sections.
- `promptBudget.test.ts` — the budget measurers
  (`measureModeratorAdditionsEmission`, `measureBubbleDirectivesEmission`)
  count emission based on **presence**, not an `enabled` flag; an empty
  override measures 0.
- `imagePromptUserMessage.test.ts` — the assembled user message reflects
  presence-based sections.

**Schema / helpers:**
- `visualStrategyOverride.test.ts` — `EMPTY_VISUAL_STRATEGY_OVERRIDE` has no
  `enabled` key; a stored row that still carries `enabled` parses cleanly
  (Zod strips the unknown key).
- `visualConcepts.test.ts` — `withCandidateConceptDraft` and the
  token-error probes no longer set `enabled: true`.

**Required-concept gates (server-side, blocking):**
- `routes.adminFactsEnrichment.test.ts` — `PATCH
  /admin/facts/:id/enrichment` rejects a blank/absent `coreSceneOverride`
  with **`400 visual_concept_required`**, and the gate sits **after** the
  404 / write-freeze / tracked-field checks so it never shadows them.
- `routes.candidateEnrichmentEditing.test.ts` — `PATCH
  /admin/reviews/:id/candidate-enrichment` rejects a blank concept
  (`400 visual_concept_required`) from **inside** the transaction, after
  the tracked-field check.
- `routes.approveVisualConcept.test.ts` — Step-2 approve-visual-concept
  blocks a blank concept with **`CONCEPT_MISSING`** (the old
  `CONCEPT_DISABLED` branch is retired).
- `routes.reviews.test.ts` — first-time and refresh production-approval
  paths re-check the resolved concept and **409 `CONCEPT_MISSING`** when
  it's blank.
- `enrichmentVersioning.refresh.test.ts` — refresh cycles author a concept
  before promoting (the `authorConceptForCycle` helper), proving the
  promote path is concept-gated.

## What's deliberately NOT shipped

- **System-wide activation guard** — enforcing that a fact cannot be
  `isActive: true` without a non-empty Visual Concept everywhere (not just
  the moderation approval paths this PR covers).
- **Ingestion → Stage-1 routing** — guaranteeing every ingestion path
  (manual submit, bulk import, any future API) drops the fact at the front
  of the triage → enrich → activate pipeline.

Both are a recorded pre-launch fast-follow (see `docs/ai-context/decisions.md`),
not part of this PR.

## Delete me

Transient — delete once Replit has run the checklist. The
[`PR234_VSO_PRESENCE_BASED_UAT.md`](./PR234_VSO_PRESENCE_BASED_UAT.md)
sibling is the durable half.
