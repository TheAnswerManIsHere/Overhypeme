# PR229 — Speech &amp; Thought Bubble Controls — TEST_RUN

Engineering/automated checklist for Replit (the technical safety net). Transient —
delete once it has run green. The durable half of the pair is
[`PR229_BUBBLE_CONTROLS_UAT.md`](./PR229_BUBBLE_CONTROLS_UAT.md).

## Scope

Moderator-authored speech/thought bubbles on the Visual Strategy Override, plus
AI-proposed bubbles from the candidate Visual-concept generator. Touches:

- `lib/api-zod`: `visualStrategyOverride.ts` (bubble schema + token plumbing),
  `literalPromptString.ts` (new shared serializer), `promptBudget.ts` (6900
  ceiling + 900 bubble pool + validator), `visualConcepts.ts` (candidate wire +
  sanitize + pick helper), `promptContentDetectors.ts` (shared bubble detector).
- `artifacts/api-server`: `imagePrompt/compilers/nanoBanana2.ts` (bubble
  section + dedupe exemption + typed diagnostics), `imagePrompt/promptBudget.ts`
  (bubble emission measurement + `validateVisualStrategyOverridePersistence`),
  `imagePrompt/generator.ts` (`includeModeratorBubbles` context gate),
  `visualConcepts/generator.ts` (deterministic validate/retry matrix),
  `visualConceptsConfig.ts` (system-prompt default), routes `admin.ts` +
  `reviews.ts` (persistence preflight).
- `artifacts/overhype-me`: `BubbleEditor.tsx` (new shared component),
  `VisualConceptCandidates.tsx` (proposal display + atomic pick),
  `EnrichmentEditor.tsx` (panel embed + renamed helper), `moderation.tsx`
  (first-class placement + unsaved-edit gate), field docs.
- `lib/db/migrations/0090_visual_concepts_bubble_contract.sql` — admin-config
  DML prompt migration.

## Migrations (Replit owns the DB connection)

- Apply migrations. **0090** is a DML-only prompt-content migration (no schema
  change): it rewrites the `fact_visual_concepts_system` admin-config row
  (`value` + `debug_value`) from the old three-field output shape to the v2
  bubble contract, idempotently and preserving unrelated admin edits.
- After applying, confirm the deployed prompt actually changed — the resolved
  `fact_visual_concepts_system` should contain the string `"bubbles" is
  REQUIRED on every concept`. (If the row was never seeded, the TS default
  already carries it.)
- No schema columns or data backfill — the VSO `bubbles` field and the
  stored-candidate `bubbles` field are additive defaulted JSONB shapes; old
  blobs parse to `[]`.

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. `0090` is
  a DML-only migration (no schema change, per above) and correctly has no
  snapshot file — confirm `0090_visual_concepts_bubble_contract` is in
  `SNAPSHOT_EXEMPT_TAGS` (added by a later follow-up commit, not this PR's
  own diff).
- `node scripts/check-docs-accuracy.mjs` — expected: clean.

## Full sharded suite — shared infra touched: yes

`literalPromptString.ts` is a new shared serializer registered in the codegen
allowlist (`lib/api-spec/patch-generated.mjs`) — the codegen pipeline is
touched, so the full suite stays required.

## Commands (`artifacts/api-server`)

```bash
# typecheck (tsc -b + cycle check + no-console gate) — pre-merge gate, assumed
# green; spot-check only if something below fails
pnpm --filter @workspace/api-server run typecheck

# the bubble-core suites
bash artifacts/api-server/scripts/run-test.sh \
  src/__tests__/visualStrategyOverride.test.ts \
  src/__tests__/promptBudget.test.ts \
  src/__tests__/nanoBanana2Compiler.test.ts \
  src/__tests__/imagePromptUserMessage.test.ts \
  src/__tests__/visualConcepts.test.ts

# version pin
bash artifacts/api-server/scripts/run-test.sh src/__tests__/imagePromptGeneration.validate.test.ts

# full suite (shared infra touched — see above)
# Stop the `artifacts/api-server: API Server` workflow first to free test-DB
# connections, or the pretest chain (push-force -> migrate -> codegen) can
# stall against the test database.
pnpm --filter @workspace/api-server test
```

Frontend (`artifacts/overhype-me`):

```bash
pnpm --filter @workspace/overhype-me run typecheck
pnpm --filter @workspace/overhype-me exec vitest run \
  src/components/admin/BubbleEditor.test.tsx \
  src/components/admin/VisualConceptCandidates.test.tsx \
  src/components/admin/EnrichmentEditor.test.tsx \
  src/components/admin/useFactEnrichmentEditing.test.tsx
# field-reference sync gate (regenerate if it drifts)
pnpm --filter @workspace/overhype-me exec vitest run src/components/admin/fieldDocs/fieldDocs.test.ts
```

## Expected results

- api-server typecheck: clean.
- The five bubble-core suites: **236 pass, 0 fail**.
- Version pin: asserts `IMAGE_PROMPT_GENERATION_VERSION === "v8"`.
- Full sharded suite: all shards green (~2318 tests).
- Frontend typecheck: clean; the four admin suites + BubbleEditor: all pass;
  fieldDocs sync: pass (regenerated `ADMIN_FIELD_REFERENCE.md` committed).

## Key invariants the tests pin

- **Budget:** the pool equation and the live-compiler maximum-shape proof both
  fit 6900; the additions measurement excludes bubbles and the bubble
  measurement carries only bubbles (no double-count); a bubble payload over the
  900 pool fails save with `bubble_directives_rendered_too_long`; token-heavy
  bubble text measures at worst-case expansion, not raw length. Pinned shape:
  2–3 maximum-length bubbles fit, 4 realistic bubbles fit, 4 maximal + maximal
  entities fail loud.
- **Compiler:** exact speech/thought directives, subject → rendered name,
  stored order, the shared serializer escapes embedded quotes, the section
  survives sentence de-dup when CORE SCENE reuses its words, renders under
  `forbid`, full-fact-text collision renders, planner restatement stripped with
  the `bubble-directive-owned-by-compiler` reason, `bubble_entity_unresolved` /
  `bubble_entity_ambiguous` diagnostics with typed `{bubbleIndex, entity}`
  context resolving against effective planner characters, zero bubbles → no
  section / no carveout / no bubble diagnostics, all three render modes.
- **Candidate matrix:** required `bubbles` wire ([] normal; missing → retry),
  count/cap/single-channel violations retry, over-cap text never truncated,
  atomic pickability, `withCandidateConceptDraft` preserves unrelated VSO
  fields, all-unpickable response fails (never stored `ok`), the shared
  persistence preflight makes pickable ⇒ saveable.
- **Schema/tokens:** old blob → `bubbles: []`; the path→kind map routes bubble
  entity/text correctly; superRefine rejects a token in a bubble entity with
  the exact machine-recognizable message; whitespace + token canonicalization
  on save.

## Gotchas / notes

- **`literalPromptString` must stay registered in
  `lib/api-spec/patch-generated.mjs`** — the codegen patcher rewrites
  `lib/api-zod/src/index.ts` wholesale on every `pretest`; an unregistered
  module's export silently vanishes and every downstream import breaks with
  "does not provide an export named 'serializeLiteralPromptString'". This is
  registered; do not remove it.
- Compact bubble directive wording is deliberate — every fixed word bills
  against the finite 900 pool. Don't expand the template without re-running the
  budget proof.

## Deliberately NOT shipped

- End-user wizard exposure (moderator-only, per David).
- Runtime-planner-proposed bubbles (planner stages only; proposals come from
  the candidate generator).
- `thinking_level: high` wiring (a separate follow-up experiment).
- Post-composited/SVG bubbles, per-bubble styling/coordinates, drag reorder,
  OCR exactness scoring, a "Use scene only" partial pick.

## Delete me

Transient — delete once Replit has run the checklist. The
[`PR229_BUBBLE_CONTROLS_UAT.md`](./PR229_BUBBLE_CONTROLS_UAT.md) sibling is
the durable half.
