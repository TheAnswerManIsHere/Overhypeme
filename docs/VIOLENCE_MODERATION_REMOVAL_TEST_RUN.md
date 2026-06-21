# Remove automatic violence/gore self-censoring — automated test run

Paired with **`docs/VIOLENCE_MODERATION_REMOVAL_UAT.md`**. Engineering safety net
for Replit. **Replit owns the database connection** — apply migrations against your
own DB; don't copy any connection string from here.

## TL;DR

```
pnpm typecheck                                                # clean (libs + artifacts; cycles + no-console)
pnpm --filter @workspace/db check-snapshots                  # passes (0071/0072/0073 exempt)
pnpm --filter @workspace/db migrate                          # applies 0073 idempotently

# api-server suites (from artifacts/api-server) — DB suites need the env
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/imagePromptUserMessage.test.ts          # 13 pass (generation-layer incl. RENDER POLICY block)
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/imagePromptSystemPrompt.test.ts         # 3 pass (admin-config-proof hard-rule append)
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/nanoBanana2Compiler.test.ts             # 59 pass (compiler allow/soften/suppress)
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/redundantMechanism.test.ts              # 16 pass (classifier prompt + repair)
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/modifierDirectives.test.ts              # 7 pass (retired modifiers inert)
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/migration.stripRetiredViolenceModifiers.test.ts  # 1 pass (data cleanup fixture)
```

## Invariant

> No automatic modifier, strategy prose, classifier prompt, or stored enrichment
> value may suppress required violence / bodies / casualties. Only an explicit
> moderator render-policy mode `soften` or `suppress` may do that.

## What changed (source-of-truth sweep)

The Grenade CORE SCENE self-censored ("…but no bodies or gore are depicted…")
because PR #112 only cleaned the deterministic compiler; the generation layer
still steered the LLM. This removes the self-censoring at every source:

1. **Strategy prose** (`lib/api-zod/src/visualPromptStrategies.ts`): the
   superhuman_physical_feat weapon-facts line + the grenade example
   `visualApproach`/`avoid` no longer forbid bodies/blood/gore/casualties or say
   "non-graphic" (the non-violence redundant-mechanism guidance is kept).
2. **Image-prompt generator** (`generator.ts` + `imagePromptConfig.ts`): a
   non-configurable `IMAGE_PROMPT_PLATFORM_HARD_RULES` block is appended to the
   system prompt via `composeImagePromptSystemPrompt()` (admin-config is seeded
   `ON CONFLICT DO NOTHING`, so editing the default alone wouldn't reach an
   existing env; the append is idempotent via a marker constant). A **RENDER
   POLICY** block is added to the user message next to the strategy context so the
   LLM knows the active `allow`/`soften`/`suppress` mode before writing the scene.
3. **Classifier prompt + vocabulary**: `avoid_gore` / `non_graphic_action`
   removed from `FACT_ENRICHMENT_SYSTEM_DEFAULT`'s catalog and from
   `KNOWN_FACT_MODIFIERS`; `CLASSIFICATION_PROMPT_VERSION` bumped `v4` → `v5`.
4. **Compiler** (`nanoBanana2.ts`, Choice B): all four softening modifiers removed
   from the violence sets and the vestigial softening-modifier machinery
   (`VIOLENCE_SOFTENING_MODIFIERS`, `hasSofteningModifier`, `dropSoftening`)
   deleted — an explicit moderator `soften`/`suppress` override is now the only
   suppressor. `avoid_weapons_focus` / `avoid_gross_literalization` survive as
   ordinary composition/taste modifiers (no longer violence-relevant). The
   redundant-mechanism repair (`factEnrichment.ts`) no longer force-injects the
   retired modifiers.
5. **Data cleanup** — migration `0073_strip_retired_violence_modifiers.sql`
   (DML-only) strips the retired modifiers from `facts.enrichment`,
   `facts.enrichment_ai_derived`, `pending_reviews.enrichment`, and the
   `/modifiers` override `value`/`overriddenFrom`; drops a `/modifiers` override
   that, once cleaned, equals the AI baseline; and scrubs the two catalog lines
   from `admin_config` `value`/`debug_value` for `fact_enrichment_system`
   (preserving `NULL` and other admin edits). Order-preserving; idempotent.

Snapshot exemptions: `0073` is DML-only (no snapshot expected); `0071`/`0072` are
an **exceptional** repo-health unblock for already-merged hand-authored DDL that
shipped (via PR #120) without snapshots — **not** a precedent for future DDL.

## Migration before/after counts (run against your DB)

```sql
-- BEFORE (run prior to applying 0073):
SELECT count(*) AS facts_with_retired FROM facts
 WHERE enrichment::text LIKE '%avoid_gore%' OR enrichment::text LIKE '%non_graphic_action%'
    OR coalesce(enrichment_ai_derived::text,'') LIKE '%avoid_gore%' OR coalesce(enrichment_ai_derived::text,'') LIKE '%non_graphic_action%'
    OR enrichment_overrides::text LIKE '%avoid_gore%' OR enrichment_overrides::text LIKE '%non_graphic_action%';
SELECT count(*) AS reviews_with_retired FROM pending_reviews
 WHERE enrichment::text LIKE '%avoid_gore%' OR enrichment::text LIKE '%non_graphic_action%';
SELECT count(*) AS modifier_overrides_touched FROM facts
 WHERE enrichment_overrides ? '/modifiers'
   AND enrichment_overrides::text LIKE ANY (ARRAY['%avoid_gore%','%non_graphic_action%']);

-- AFTER 0073 — every one of these MUST return zero rows:
SELECT 'facts.enrichment' src, id FROM facts WHERE enrichment::text LIKE '%avoid_gore%' OR enrichment::text LIKE '%non_graphic_action%'
UNION ALL SELECT 'facts.enrichment_ai_derived', id FROM facts WHERE enrichment_ai_derived::text LIKE '%avoid_gore%' OR enrichment_ai_derived::text LIKE '%non_graphic_action%'
UNION ALL SELECT 'facts.enrichment_overrides', id FROM facts WHERE enrichment_overrides::text LIKE '%avoid_gore%' OR enrichment_overrides::text LIKE '%non_graphic_action%'
UNION ALL SELECT 'pending_reviews.enrichment', id FROM pending_reviews WHERE enrichment::text LIKE '%avoid_gore%' OR enrichment::text LIKE '%non_graphic_action%';
```

## grep triage (operational path must be clean)

- **Operational prompt path** (`lib/api-zod/src/visualPromptStrategies.ts`,
  `imagePromptConfig.ts`, `generator.ts`, `nanoBanana2.ts`, `factEnrichmentConfig.ts`,
  `factEnrichment.ts`, `modifierDirectives.ts`, `taxonomy.ts`): zero
  `avoid_gore`/`non_graphic_action` except explanatory comments noting the
  retirement.
- **Tests / migration**: intentional references (assertions + the cleanup SQL).
- **Historical comments**: removed where they would mislead.

## Not changed
- Moderator `soften` / `suppress` render-policy overrides (deliberate per-fact
  control) are untouched. No new moderator controls / admin UI / NSFW tiers.
- No down migration restores the retired auto-sanitizers (their removal is
  intentional product behavior).
