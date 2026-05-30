# Semantic entities (capitalization-aware visual referents) — Test Run

Engineering-side checklist for the work shipped on
`claude/semantic-entities-capitalization-cb8up` (built on top of PR #80).
Covers:

1. **Schema** — new `SemanticEntity` type + enums + Zod schemas
   in `@workspace/api-zod`.
2. **Enrichment prompt** — system + user prompts updated to preserve
   meaningful capitalization and emit `semanticEntities`.
3. **Visual preview prompt** — system prompt updated to treat
   semantic entities as hard context.
4. **Phase 2 image-prompt generator** — user message includes semantic
   entities; system prompt requires `semanticEntitiesUsed` echo-back.
5. **Phase 2 wire schema + validator** — `semanticEntitiesUsed` is now a
   structured field in the visual plan with mandatory echo-back of every
   material entity.
6. **Admin enrichment editor** — new section "Semantic Entities / Visual
   Referents" with full CRUD; warning banners on the existing alerts row.
7. **Version bump** — `CLASSIFICATION_PROMPT_VERSION` v2 → v3.
8. **Tests** — 8 new enrichment cases + 6 new validator cases (25 total
   validator tests, 25 total enrichment tests).

UAT for David: [`SEMANTIC_ENTITIES_UAT.md`](./SEMANTIC_ENTITIES_UAT.md).

---

## TL;DR

```bash
export DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test"
pnpm --filter @workspace/db migrate          # no new migrations in this PR
pnpm -w typecheck                            # all clean
cd artifacts/api-server
DATABASE_URL=$DATABASE_URL TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/imagePromptGeneration.validate.test.ts \
    src/__tests__/factEnrichment.test.ts \
    src/__tests__/visualPromptStrategies.test.ts \
    src/__tests__/asyncJobs.test.ts
# Expected: 72/72 pass (25 validator + 25 enrichment + 11 strategy + 11 asyncJobs).
```

No new DB migrations — `FactEnrichment` is stored as JSONB and the new
`semanticEntities` field defaults to `[]`, so existing rows validate unchanged.

---

## 1. Schema (`lib/api-zod/src/taxonomy.ts`)

Verify these exports:

- `SEMANTIC_ENTITY_KIND_VALUES` — 11 values.
- `CAPITALIZATION_SIGNAL_VALUES` — 6 values.
- `SemanticEntity` type with 9 fields.
- `semanticEntitySchema` (business) + a strict wire mirror baked into
  `factEnrichmentWireSchema`.
- `factEnrichmentSchema` now has `semanticEntities: z.array(...).max(20).default([])`.
- `CLASSIFICATION_PROMPT_VERSION === "v3"`.

```bash
node --import tsx/esm --test src/__tests__/factEnrichment.test.ts
# Expected: # tests 25 # pass 25
```

Cases covered:
- empty array accepted
- single valid entity accepted (Earth → planet)
- two distinct case-variants accepted (Earth + earth in the same fact)
- confidence outside [0,1] rejected
- unknown entityKind rejected
- unknown capitalizationSignal rejected
- empty surfaceText / visualReferent rejected
- sentence-initial ambiguous case accepted with `requiresAdminReview=true`
- brand entity accepted with `requiresAdminReview=true`
- missing field normalizes to `[]`

## 2. Wire schema + validator (`lib/api-zod/src/imagePromptGeneration.ts`)

- `visualPlanWireSchema` now requires `semanticEntitiesUsed:
  Array<{surfaceText, visualReferentUsed, effectOnVisualPlan}>` (strict; never
  omitted in OpenAI Structured Outputs).
- `PlanExpectations` gains optional `materialSemanticEntities: string[]`.
- New validator **rule 14**: for every entry in `materialSemanticEntities`,
  there MUST be a matching `semanticEntitiesUsed` entry (case-insensitive on
  surfaceText) with non-empty `visualReferentUsed` and `effectOnVisualPlan`.

```bash
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts
# Expected: # tests 25 # pass 25 (19 from PR #80 + 6 new echo-back cases)
```

New cases:
- empty `materialSemanticEntities` + empty `semanticEntitiesUsed` → ok
- missing required entry → rejected
- echo with different case → accepted (case-insensitive match)
- empty `visualReferentUsed` → rejected
- empty `effectOnVisualPlan` → rejected
- partial coverage when 2 required → rejected (names the missing entity)

## 3. Enrichment prompts (`lib/factEnrichmentConfig.ts` + `lib/factEnrichment.ts`)

- System prompt extended with the "Semantic entity and capitalization-aware
  interpretation" block + the verbatim examples (Earth, earth, apple, Apple,
  sun, Sun, law, Law).
- JSON return contract names `semanticEntities` and its sub-fields.
- User message now labels the fact as `factTextExact:` and explicitly tells
  the model NOT to lowercase / title-case before interpretation.
- `CLASSIFICATION_PROMPT_VERSION = "v3"` stamps every new enrichment.

Existing facts are NOT auto-re-enriched. Admin can re-enrich per fact via
the existing `/admin/reviews/:id/enrich` flow.

## 4. Phase 2 prompt generator (`lib/imagePrompt/generator.ts`)

- `buildImagePromptUserMessage` now emits a `SEMANTIC ENTITY INTERPRETATION`
  block with every entity from `input.enrichment.semanticEntities`, marking
  the must-echo-back requirement when any material entity is present.
- The user message labels the fact text `factTextExact:` and includes the
  explicit instruction to inspect spelling + capitalization.
- `expectationsFromInput` populates `materialSemanticEntities` from the
  enrichment, so the validator enforces echo-back at render time.

System prompt (`lib/imagePromptConfig.ts`) gains rule #16: capitalization-
aware referents must be reflected in `keyVisualElements` and
`compiledPrompt`, with every material entity echoed in `semanticEntitiesUsed`.

## 5. Admin enrichment editor (`components/admin/EnrichmentEditor.tsx`)

- New `SemanticEntitiesEditor` section beneath the existing Cultural
  References editor with full CRUD (add / remove / edit every field).
- Existing `Warnings` banner row now flags:
  - sentence-initial ambiguity
  - ambiguous entity kind
  - brand / cultural reference entities
  - generic `requiresAdminReview=true` entries
  - low-confidence entries (<0.75)
- `EnrichmentSummary` (read-only view) now lists semantic entities below
  cultural references, mirroring the existing summary style.
- `EMPTY_ENRICHMENT` initialises `semanticEntities: []` so manual-fill
  workflows start clean.

## 6. Admin visual-preview prompt (`lib/factVisualPreviewConfig.ts`)

System prompt gains:
- Input field documentation: "Semantic entities (...). Treat them as hard
  context — if an entity says \"Earth\" means \"the planet Earth\", do not
  reinterpret as dirt or soil."
- Output instruction: reflect material entities in the scene + reference the
  resolved `visualReferent` in concrete terms; mention disambiguation in
  the debug note or `interpretationWarnings`.

## 7. What's NOT in this PR

- No DB migration (JSONB field — defaults to `[]`).
- No bulk backfill or auto-re-enrich of existing facts — admin can re-run
  enrichment per fact via the existing endpoint when a capitalization-
  sensitive miss is spotted.
- No semantic-entity-driven UI badges on the public-facing fact pages.
- No automatic merging of variants based on semantic entities (the doc
  explicitly excludes this).
- No live OpenAI smoke test against the new system prompt in CI — verified
  manually via admin endpoints (`POST /admin/reviews/:id/enrich`).
