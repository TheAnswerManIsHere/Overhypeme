# Stop leaking interpretation meta (cultural refs + semantic entities) — keep the resolved visual · PR #115 — automated test run

Paired with **`docs/PR115_CULTURAL_REFERENCE_LEAK_FIX_UAT.md`** (the click-through
acceptance test). Engineering safety net for Replit. **Replit owns the database
connection.** No DB migration, no schema change — compiler-only.

## TL;DR

```
# api-server (from artifacts/api-server)
pnpm run typecheck                                                      # clean
node --import tsx/esm --test src/__tests__/nanoBanana2Compiler.test.ts             # 58 pass
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts              # non-regression
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # non-regression
node --import tsx/esm --test src/__tests__/redundantMechanism.test.ts              # non-regression
```

## What changed (and why this revision)

Found while testing the Phase 2 override (#114). The compiler was emitting
interpretation **meta** into the final Nano Banana prompt:

- `STRICT CONSTRAINTS: Cultural references: treat "Shark Week" as Discovery
  Channel's Shark Week, shown via …` (leaks the canonical name + brand)
- `STRICT CONSTRAINTS: Interpret these terms exactly: "Earth" means the planet
  Earth …`

Cultural references and semantic-entity disambiguation are **inputs that inform
the planner (OpenAI)** how to read the fact — they should not reach the image
engine as meta. The engine wants concrete pixels-language, not the reasoning.

The first cut of this PR simply *removed* the cultural directive. A review caught
that this dropped the **only compiler-side fallback** that guaranteed the
reference's visual reached the engine: `validateImagePromptPlan` rules 14/15 only
check that `culturalReferencesUsed`/`semanticEntitiesUsed` are echoed with
non-empty fields, NOT that the implication was baked into `coreScene`. So a plan
could echo `visualImplicationUsed: "sharks on a TV"` yet compile a generic beach
scene and still validate — losing the gag.

**Final design — separate the meta from the concrete visual:**
- Strip the meta from the prompt (canonical reference, brand, `treat X as Y` /
  `interpret X means Y`, surface term). The `semantic` + `cultural` directives are
  gone from `STRICT CONSTRAINTS`.
- Keep the concrete visual as a **safety net**: `composeKeyElementsDirective` now
  draws its `Ensure these elements are clearly visible: …` set from three concrete
  sources — `keyVisualElements`, each cultural ref's `visualImplicationUsed`, and
  each semantic entity's `visualReferentUsed` — de-duped against each other and the
  scene. So the resolved visual reaches the engine **only when the planner didn't
  already bake it in**, with no meta and no brand.

Echo-backs stay on the visual plan (validator + admin debug); the compiler
gap-fill is the delivery guarantee, so no stricter validation / extra planner
retries are needed.

Also retained from the first cut: the **curly-apostrophe `Do not` normalizer**
fix (`Don’t` is recognized as already-negative; no `Do not Don’t …`).

## Test coverage (`nanoBanana2Compiler.test.ts`)

- **Cultural safety net + no leak (the review's regression case):**
  `visualImplicationUsed = "sharks circling on a TV screen behind David"` with a
  generic beach `coreScene` → the implication appears under `Ensure these elements
  are clearly visible`; the prompt has **no** `treat "shark week" as`, **no**
  `Discovery Channel`, **no** `Cultural references:`.
- **Cultural dedupe:** when `coreScene` already states the implication → it is not
  duplicated.
- **Semantic — concrete, not meta:** `visualReferentUsed = "the planet Earth seen
  from orbit"` omitted from `coreScene` → appears as a visible element; **no**
  `Interpret these terms exactly` / `"Earth" means`.
- **Token gate:** `{NAME}` inside an emitted `keyVisualElement` and an emitted
  semantic referent both resolve to the subject; no raw token leaks.
- Curly-apostrophe `Don’t` forbidden detail → emitted once, no double prefix.

## What is intentionally unchanged

- The enrichment classifier and the image-prompt planner still receive cultural
  references + semantic entities as input — only the deterministic compiler's
  emission changed.
- No DB / schema / validator change.
