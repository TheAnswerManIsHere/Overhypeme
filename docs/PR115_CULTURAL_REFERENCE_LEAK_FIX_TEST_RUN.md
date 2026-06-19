# Cultural-reference leak + Do-not normalizer (PR #115) — automated test run

Paired with **`docs/PR115_CULTURAL_REFERENCE_LEAK_FIX_UAT.md`** (the click-through
acceptance test). Engineering safety net for Replit. **Replit owns the database
connection.** No DB migration, no schema change — compiler-only.

## TL;DR

```
# api-server (from artifacts/api-server)
pnpm run typecheck                                                      # clean
node --import tsx/esm --test src/__tests__/nanoBanana2Compiler.test.ts             # 57 pass
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts              # non-regression
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # non-regression
```

## What changed

A follow-up to the Phase 2 override (#114). Two compiler fixes in
`compilers/nanoBanana2.ts`:

1. **Cultural references no longer reach the engine prompt.** They are an INPUT
   that informs the planner (OpenAI) how to interpret the fact; the planner bakes
   the visual implication into `CORE SCENE` / concrete fields. The compiler used
   to also emit `Cultural references: treat "X" as <canonical>, shown via Y. Avoid
   real logos or brand marks.` into `STRICT CONSTRAINTS` — redundant meta that
   leaked brand names (e.g. "Discovery Channel"). That emission is removed. The
   `culturalReferencesUsed` echo-back stays on the visual plan (validator rule 15
   + admin debug) but is never compiled into the prompt.
2. **Do-not normalizer handles curly apostrophes.** A forbidden/negative override
   entry starting with `Don’t` (curly ’) was not recognized as already-negative
   and got double-prefixed (`Do not Don’t …`). The negative-lead regex now matches
   straight (`'`) and curly (`’`) apostrophes.

## Test coverage

- `nanoBanana2Compiler.test.ts`:
  - the cultural-reference test now asserts the prompt does **not** contain
    `treat "shark week" as`, `discovery channel`, or `Cultural references:`, while
    the gag still reaches the engine via the planner's `CORE SCENE`;
  - a new case: a forbidden detail starting with a curly-apostrophe `Don’t` is
    emitted once (no `Do not Don’t`).

## What is intentionally unchanged

- **Semantic-entity** disambiguation (`Interpret these terms exactly: "Earth"
  means the planet Earth…`) is still emitted — it resolves capitalization
  ambiguity that can matter at the engine level, and was not part of this report.
  (Flagged to David as a possible follow-up.)
- The enrichment classifier and the image-prompt planner still receive cultural
  references as input — only the deterministic compiler's emission changed.
