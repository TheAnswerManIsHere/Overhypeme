# Subject-name semantic-entity leak — automated test run

Paired with **`docs/SEMANTIC_ENTITY_SUBJECT_LEAK_UAT.md`** (the click-through
acceptance test). This doc is the engineering safety net for Replit. **Replit
owns the DB** — run the backfill against your own database; this doc sets no
`DATABASE_URL`.

## TL;DR

```
# api-server (from artifacts/api-server)
pnpm run typecheck                                                        # tsc + cycles + no-console, clean
node --import tsx/esm --test src/__tests__/renderCanonical.test.ts            # helper guard — all pass
node --import tsx/esm --test src/__tests__/factEnrichment.test.ts             # fix-forward strip — all pass
node --import tsx/esm --test src/__tests__/imagePromptUserMessage.test.ts     # leak-proof render path — all pass
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # validator rule 14 — all pass
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts         # 12 pass (non-regression)

# Backfill (against Replit's DB)
pnpm --filter @workspace/api-server run cleanup:subject-name-entities                 # DRY RUN — reports, writes nothing
pnpm --filter @workspace/api-server run cleanup:subject-name-entities -- --apply      # APPLY — scrubs facts + pending_reviews
pnpm --filter @workspace/api-server run cleanup:subject-name-entities -- --apply      # re-run = 0 changes (idempotent)
```

## The problem this fixes

Fact enrichment runs on the **canonical-rendered** fact:
`renderCanonical()` (`artifacts/api-server/src/lib/renderCanonical.ts`)
substitutes the `{NAME}` token with the fixed canonical name **"Alex"** before
the text reaches the enrichment LLM. The model then extracts "Alex" as a
`semanticEntities` entry (`entityKind=named_entity`, `visualReferent="a person"`,
`materiallyAffectsVisualPrompt=true`). Nothing filtered it, so it was stored,
shown in the admin enrichment editor, and — worse — at render time the
image-prompt generator forces every material entity to be echoed and
`validateImagePromptPlan` **rule 14** hard-requires it, baking "Alex" → "a
person" into the picture.

**Principle:** the personalized subject is owned by the identity/rendering layer.
Semantic entities are for NON-subject referents (Earth-vs-earth, cultural refs).
The subject must never be a semantic entity.

## What changed (defense in depth, one shared predicate)

`renderCanonical.ts` — new exports:
- `CANONICAL_NAME` + `CANONICAL_SUBJECT_NAMES` (list, so future canonical
  placeholders are added in one place).
- `hasSubjectIdentityToken()` — narrow, identity tokens only
  (`{NAME}/{SUBJ}/{OBJ}/{POSS}/{POSS_PRO}/{REFL}`); deliberately NOT the
  `{singular|plural}` pairs that `hasUnresolvedFactTokens` also matches.
- `isSubjectNameSemanticEntity()` / `stripSubjectNameSemanticEntities()` — exact
  (case-insensitive, trimmed) match on a canonical name, or a residual identity
  token. **Exact equality**, so "Alex Honnold"/"Earth"/"Firearms" are preserved.

1. **Fix-forward** — `factEnrichment.ts` `enrichFactWithModel` strips
   subject-name entities **before** the final `validateEnrichment`, so newly
   enriched facts (facts + pending reviews, both via this path) store clean.
2. **Defensive at render time** — `imagePrompt/generator.ts` strips at **both**
   reads of the enrichment entities (`expectationsFromInput` → the validator's
   required-echo list, and `buildImagePromptUserMessage` → the prompt block), so
   facts enriched before this shipped never leak or trip rule 14.
3. **Soft layer** — `factEnrichmentConfig.ts` system prompt now explicitly tells
   the model not to list the subject ("Alex") as a semantic entity.
4. **Backfill** — `scripts/cleanup-subject-name-semantic-entities.ts` scrubs
   already-stored `enrichment.semanticEntities` on `facts` + `pending_reviews`.

## Backfill behavior to confirm

- **Dry run by default** — prints `fact <id>: removing N subject entit…[Alex]`
  per affected row and a per-table + total summary; writes nothing.
- `-- --apply` performs the surgical update (only the `semanticEntities` array is
  replaced; all other enrichment fields untouched; promoted columns unaffected).
- **Idempotent** — a second `--apply` run reports `0` changes.
- Verified end-to-end locally: seed a fact with `[Earth, Alex]` → dry run detects
  it → `--apply` leaves `[Earth]` → re-run reports 0.

## Schema / SQL checks

- No migration. Surgical JSONB field edit on existing rows.
- After `--apply`: no stored `enrichment.semanticEntities` entry should have
  `lower(normalizedText) = 'alex'` (or a `{NAME}`-style token) across `facts` and
  `pending_reviews`.

## What's deliberately NOT shipped

- No admin-UI/queued job for the backfill — a one-time, LLM-free, idempotent
  scrub matches the repo's one-shot-script convention
  (`scripts/backfill-*.ts`); the async job queue + Taxonomy-Health panel is for
  ongoing admin bulk actions.
- No change to how the subject itself is rendered — only its erroneous presence
  as a semantic entity is removed.
