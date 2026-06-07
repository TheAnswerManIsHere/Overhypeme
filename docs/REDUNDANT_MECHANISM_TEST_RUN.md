# Redundant-mechanism taxonomy fix — automated test run

Engineering-side checklist for Replit. The in-app walkthrough is in
[`REDUNDANT_MECHANISM_UAT.md`](./REDUNDANT_MECHANISM_UAT.md).

Fixes the taxonomy engine misreading "result, *then* the normal mechanism"
jokes as **temporal causality inversion**. Canonical case:

> {NAME} once threw a grenade and killed 50 people — then it exploded.

The joke is not time travel — it's that the throw is so impossibly powerful the
grenade's explosion is redundant. Correct read:

- `primaryArchetype: superhuman_physical_feat`
- `subtype: force_scaled_action`
- modifier: `normal_function_rendered_unnecessary` (new), and usually
  `projectile_impact_power` (new) + `avoid_gore`
- explicitly **NOT** `temporal_causality_inversion`

## What changed

- **New known modifiers** in `@workspace/api-zod` taxonomy:
  `normal_function_rendered_unnecessary`, `projectile_impact_power`. They flow
  automatically into the admin enrichment editor's known-modifier datalist
  (no UI code change — `KNOWN_FACT_MODIFIERS` is the single source).
- **Classifier prompt** (`factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT`):
  added a `"then" does not automatically mean temporal inversion` decision rule
  + checklist, the grenade + bullet canonical examples, and the new modifiers in
  the known-modifier catalog. The old misleading line ("a grenade causing
  effects before exploding is temporal/causality inversion") is removed.
- **Visual strategy map** (`visualPromptStrategies.ts`):
  - `superhuman_physical_feat` strategy block gained a redundant-mechanism
    section (stage the action as the force; keep the mechanism intact / unused /
    delayed / secondary; non-graphic environmental impact for weapon facts) plus
    a fully-authored grenade visualization example.
  - `temporal_causality_inversion` strategy block gained anti-guidance so the
    grenade-then-exploded pattern is not staged as an explosion-before-throw.
- **Modifier directives** (`imagePrompt/modifierDirectives.ts`): mapped both new
  modifiers to compiler directives so the render-time prompt stages the throw as
  the force and keeps the grenade redundant.
- **Classification prompt version bump** `v3 → v4`
  (`CLASSIFICATION_PROMPT_VERSION`). This marks every previously-enriched fact as
  *stale* on the Taxonomy Health page so the grenade fact (and any other
  redundant-mechanism fact misclassified under v3) can be re-enriched. The bump
  surfaces badges only — there is **no** automatic re-enrichment/backfill.

No schema or migration changes. `modifiers` already accepts arbitrary strings;
the new entries are added to the *known* catalog so they render as recognized
(non-warning) chips.

---

## TL;DR

```bash
pnpm run typecheck:libs                                   # builds @workspace/* libs, exits 0
( cd artifacts/api-server  && tsc -p tsconfig.json --noEmit )   # exits 0
( cd artifacts/overhype-me && tsc -p tsconfig.json --noEmit )   # exits 0

# New regression suite (pure, no LLM/DB).
( cd artifacts/api-server && node --import tsx/esm --test \
  src/__tests__/redundantMechanism.test.ts )              # 15 tests pass

# Non-regression of the surrounding taxonomy/prompt machinery.
( cd artifacts/api-server && node --import tsx/esm --test \
  src/__tests__/visualPromptStrategies.test.ts \
  src/__tests__/taxonomyRegressionFixtures.test.ts \
  src/__tests__/modifierDirectives.test.ts \
  src/__tests__/enrichmentVersionStatus.test.ts )         # all pass
```

---

## A — New regression suite

```bash
cd artifacts/api-server && node --import tsx/esm --test \
  src/__tests__/redundantMechanism.test.ts
```

Pass criterion: **15 tests pass, 0 fail.** Covers:

- The new modifiers are recognized by `isKnownModifier` / `KNOWN_FACT_MODIFIERS`.
- **Test A** — a hand-authored grenade enrichment (`superhuman_physical_feat` /
  `force_scaled_action` / `normal_function_rendered_unnecessary`) validates, is
  `healthy`, and is **not** temporal.
- **Test C** — the bullet/gun redundant-mechanism fact validates the same way.
- **Test B** — a genuine timeline-inversion fact ("finished tomorrow's workout
  yesterday") still validates as `temporal_causality_inversion` (no
  over-correction).
- **Test D** — the authored `superhuman_physical_feat` strategy + grenade example
  describe a powerful throw with an *intact / unexploded* grenade and
  shockwave/force/trajectory language, and never request an
  explosion-before-throw or a time-paradox; the
  `normal_function_rendered_unnecessary` modifier directive keeps the mechanism
  intact/unused/delayed/secondary/redundant.
- **Test E** — the grenade example's affirmative scene text requests no
  gore/bodies; `avoid_gore` still yields a non-graphic directive.
- Temporal strategy carries the redundant-mechanism anti-guidance.
- The classifier system prompt encodes the `then` rule + grenade example and no
  longer claims the grenade fact is temporal.

## B — Strategy-map + fixtures non-regression

```bash
cd artifacts/api-server && node --import tsx/esm --test \
  src/__tests__/visualPromptStrategies.test.ts \
  src/__tests__/taxonomyRegressionFixtures.test.ts \
  src/__tests__/modifierDirectives.test.ts
```

Pass criterion: all pass. The new superhuman example keeps that archetype's
`examplesAuthoringStatus: "complete"` honest (every example has authored
`visualApproach` / `whyItWorks` / `avoid`), no content-moderation terms leaked
into archetype blocks, and the existing 12 taxonomy fixtures + modifier-directive
ordering are unaffected.

## C — Version-staleness non-regression

```bash
cd artifacts/api-server && node --import tsx/esm --test \
  src/__tests__/enrichmentVersionStatus.test.ts
```

Pass criterion: all pass. These helpers pin their own `CURRENT` versions, so the
`v3 → v4` bump doesn't move them; this confirms the staleness comparison still
behaves.

## D — DB / re-enrichment spot-check (Replit owns the DB)

After applying the branch and pointing the app at the DB:

1. The grenade seed fact (`{NAME} once threw a grenade and killed 50 people …`)
   should appear on the **Taxonomy Health** page as **stale enrichment**
   (`enrich v3→v4`) — along with every other previously-enriched fact, by design.
2. **Re-enrich just the grenade fact** (single-fact re-enrich, not a global
   backfill). Confirm the new enrichment comes back as
   `primaryArchetype: superhuman_physical_feat`, includes
   `normal_function_rendered_unnecessary`, and is **not**
   `temporal_causality_inversion`.
3. Regenerate its visual plan and read the **Runtime Compiled Prompt Preview**:
   it should describe David's throw as the impossible force with an intact
   grenade, and must not mention "explosion before the throw", "impossible
   timing", "time and causality", or a time paradox.

Do **not** run a global re-enrich backfill as part of this validation — the fix
is surgical; broad re-enrichment is a separate, deliberate admin action.

## What this explicitly does NOT ship

- **No new archetype.** Redundant mechanism is a *modifier* under the existing
  `superhuman_physical_feat`, not a new primary archetype.
- **No hardcoding of the grenade fact.** The classifier rule + modifier are
  general; the grenade is the canonical example, not a special case.
- **No safety policy baked into the taxonomy category.** The taxonomy identifies
  the joke; non-graphic rendering stays in the visual-strategy / render layer
  (`avoid_gore` + the strategy's non-graphic guidance).
- **No auto re-enrich / backfill.** The version bump only surfaces staleness;
  re-enrichment is the existing manual / bulk admin action.
