# PR172 — Prompt-pipeline de-scaffolding · TEST_RUN (engineering checklist)

> **For Replit.** Automated safety net for the change that retires the
> modifier→prompt-prose injection channel and the `no_readable_text` /
> `avoid_readable_ui` / `avoid_real_logos` modifiers. Companion click-through:
> `docs/PR172_PROMPT_DESCAFFOLDING_UAT.md`.
>
> **Replit owns the database connection.** Where this doc says "apply migrations"
> or "confirm a column/row", use your own DB connection — do not add
> `DATABASE_URL` exports or test-DB config.

---

## 1. Static checks

```bash
pnpm run typecheck
```
Expect: all workspace projects **Done**, no errors. (Catches the deleted
`modifierDirectives.ts` import, the `satisfies Record<KnownFactModifier, …>`
fieldDocs contract, and the new `BindingMode` enum.)

```bash
pnpm --filter @workspace/overhype-me generate:field-docs
git diff --exit-code docs/ADMIN_FIELD_REFERENCE.md
```
Expect: **no diff** — the committed reference already reflects the regenerated
docs. A diff means the fieldDocs source and the generated doc drifted.

```bash
node lib/db/scripts/check-migration-snapshots.ts   # or the package's check script
```
Expect: "All journal entries have snapshot files (or are explicitly exempt)" and
a valid snapshot chain. Migration `0080_strip_retired_text_modifiers` is a
DML-only migration and is in `SNAPSHOT_EXEMPT_TAGS`.

## 2. Test suites

```bash
pnpm --filter @workspace/api-server test
```
Expect: **all shards pass, 0 fail** (this run: 527 + 475 across shards, result=pass).
`pretest` applies push-force + migrations first, so migration `0080` and its
fixture test run here.

Key files exercised (all must be green):
- `nanoBanana2Compiler.test.ts` — the compiler. Now asserts: **no** modifier
  prose is injected (inverted the old "injects high-impact modifier directives"
  test, incl. a `promptBreakdown` SUBJECT DETAILS assertion); the retired-family
  regression (three retired modifiers + explicit in-scene text → text renders,
  **zero** "free of readable text"); the always-on incidental-text guard across
  allow / allow+guidance / require / forbid / explicit-elements, and that the
  guard is never counted as stripped planner prose; age-transform SUBJECT BINDING
  for human/non-human/t2i; content-word gap-fill edges.
- `imagePromptUserMessage.test.ts` — the planner TAXONOMY block lists live
  modifiers but **omits** the three retired names, and building context does not
  mutate the stored enrichment.
- `factRenderScenarios.test.ts` — the render-scenario hash is **unchanged** when
  only a retired modifier is added, but **changes** for a non-retired custom
  modifier.
- `redundantMechanism.test.ts` — the classifier prompt no longer advertises the
  retired names; `CLASSIFICATION_PROMPT_VERSION === "v6"`.
- `imagePromptGeneration.validate.test.ts` — `IMAGE_PROMPT_GENERATION_VERSION === "v5"`.
- `migration.stripRetiredTextModifiers.test.ts` — seeds `admin_config`
  `fact_enrichment_system` with crafted values (single retired line ×3, all
  three, admin edits preserved, NULL `debug_value`, independent `debug_value`
  scrub) and asserts each is cleaned and idempotent; restores the original row.

```bash
pnpm --filter @workspace/overhype-me test
```
Expect: **all files pass** (this run: 63 files / 692 tests — includes the merged
#166 picker tests and the fieldDocs ratchet).

## 3. DB / migration checks (Replit's connection)

- Apply migrations. Confirm `0080_strip_retired_text_modifiers` runs cleanly.
- If an `admin_config` row `key = 'fact_enrichment_system'` exists, confirm its
  `value` (and `debug_value` when non-NULL) **no longer contain** the lines
  `- no_readable_text`, `- avoid_real_logos`, `- avoid_readable_ui`. Any other
  admin edits in that prompt must be preserved verbatim.
- Migration is idempotent — re-running it is a no-op.
- No schema/DDL change is expected (this is a DML-only migration).

## 4. Version stamps (expected, intentional)

- `CLASSIFICATION_PROMPT_VERSION`: `v5 → v6` (catalog changed). Existing
  enrichments will read **version-stale** in Taxonomy Health — advisory only, no
  forced re-enrichment.
- `IMAGE_PROMPT_GENERATION_VERSION`: `v4 → v5` (compiled output changes for
  identical inputs). Existing test renders correctly flag **stale** — this is the
  designed staleness mechanism, not a bug. `SCENARIO_CONFIG_VERSION` is
  **unchanged** (it governs hash *shape*).

## 5. What's deliberately NOT shipped / NOT changed

- **No stored-enrichment strip.** Unlike migration 0073, this PR does not rewrite
  `facts.*` / override blobs. Legacy retired modifier strings survive on old rows
  as inert display-only data (filtered from planner context AND the render hash).
- **Taxonomy classification, cultural references, semantic entities, hashtags,
  fit/adult signals, the planner system prompt, violence policy, `failureModeConstraints`,
  and all compiler safety rails are untouched.**
- No new UI. The moderator surface is unchanged; only the field-doc *text*
  changed (two-tier model) plus the generated reference.
