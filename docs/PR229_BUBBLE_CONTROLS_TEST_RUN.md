# PR229 — Speech &amp; Thought Bubble Controls — TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. **Replit owns the DB connection** — no `DATABASE_URL` /
test-DB env is set anywhere in this doc. The durable half of the pair is
[`PR229_BUBBLE_CONTROLS_UAT.md`](./PR229_BUBBLE_CONTROLS_UAT.md).

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails.

**No test suites in this checklist, deliberately.** This PR's feature is
covered by `visualStrategyOverride.test.ts`, `promptBudget.test.ts`,
`nanoBanana2Compiler.test.ts`, `imagePromptUserMessage.test.ts`,
`visualConcepts.test.ts`, and `imagePromptGeneration.validate.test.ts` (the
version-pin tripwire asserting `IMAGE_PROMPT_GENERATION_VERSION === "v8"`) on
the api-server side, plus `BubbleEditor.test.tsx`,
`VisualConceptCandidates.test.tsx`, `EnrichmentEditor.test.tsx`,
`useFactEnrichmentEditing.test.tsx`, and `fieldDocs.test.ts` on the frontend
— all of which already ran and passed in CI on this exact code, including the
full sharded suite (`literalPromptString.ts`'s new codegen-allowlist
registration is exercised by that same CI run). Everything below is what CI
genuinely cannot see: the state of the live database.

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

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. `0090` is
  a DML-only migration (no schema change, per below) and correctly has no
  snapshot file — confirm `0090_visual_concepts_bubble_contract` is in
  `SNAPSHOT_EXEMPT_TAGS` (added by a later follow-up commit, not this PR's
  own diff).
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Other allow-list entries this PR added: `lib/api-zod/src/literalPromptString.ts`
  registered in the codegen allowlist (`lib/api-spec/patch-generated.mjs`) —
  confirm it's present so a codegen run doesn't silently drop the export (see
  the Gotchas note below on why this matters).

## Live checks (read-only; run always)

1. Migration `0090` applied — confirm the resolved
   `fact_visual_concepts_system` admin-config value contains the string
   `"bubbles" is REQUIRED on every concept`. `0090` is a DML-only
   prompt-content migration (no schema change): it rewrites the
   `fact_visual_concepts_system` admin-config row (`value` + `debug_value`)
   from the old three-field output shape to the v2 bubble contract,
   idempotently and preserving unrelated admin edits. (If the row was never
   seeded, the TS default already carries the string, so the check still
   passes.)
2. No schema columns or data backfill from this PR — the VSO `bubbles` field
   and the stored-candidate `bubbles` field are additive defaulted JSONB
   shapes; old blobs parse to `[]`. Nothing further to verify beyond check 1.

## Invariants covered in CI (named for awareness — not re-run here)

Pinned by the suites listed above, already green in CI on this exact code:

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

## What's deliberately NOT shipped

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
