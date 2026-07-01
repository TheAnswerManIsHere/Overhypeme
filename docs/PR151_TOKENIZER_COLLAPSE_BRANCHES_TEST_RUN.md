# Tokenizer collapse `{X|X}` → `X` — engineering test run (Replit)

Engineering/automated checklist for PR #151. Click-through acceptance:
`docs/PR151_TOKENIZER_COLLAPSE_BRANCHES_UAT.md`.

## What changed (engineering summary)

The fact template grammar uses `{singular|plural}` conjugation tokens (LEFT =
he/she, RIGHT = they). Non-conjugating verbs (modals: can/will/should/must/…) have
identical forms, so the LLM tokenizer sometimes emits a useless duplicate like
`{can|can}`. The deterministic net `autoConjugatePersonSubjectVerbs` already guards
against identical branches, so the duplicate comes straight from the model.

- **`lib/api-zod/src/templateGrammar.ts`** — new `collapseIdenticalConjugationBranches`:
  `template.replace(/\{([^|{}]+)\|\1\}/g, "$1")`. The backreference `\1` enforces
  *exact* duplicates, so `{is|are}` / `{has|have}` never match. Pure + idempotent.
  Re-exported via `artifacts/api-server/src/lib/templateGrammar.ts`.
- **`artifacts/api-server/src/lib/factTokenizer.ts`** — `postProcessTokenizedTemplate`
  now runs three passes: strip-unknown → auto-conjugate → **collapse**. Returns a
  new `collapsed` flag; `conjugated` is unchanged (scoped to the auto-conjugation
  net only). `TOKENIZE_SYSTEM_PROMPT` gained a line telling the model not to wrap
  identical-form modals.
- **`artifacts/api-server/src/routes/ai.ts`** — logs a `collapsed` line (mirrors the
  existing `conjugated` log) on `/ai/tokenize-fact`.
- **`artifacts/api-server/scripts/backfill-collapse-identical-branches.ts`** — new
  backfill (dry-run by default).

No schema change / migration. Output-preserving (both branches render identically),
so no re-embed.

## Automated checks

```bash
# Typecheck (builds api-zod + db project refs too) — expect clean
cd artifacts/api-server && npx tsc -b

# Touched suites — expect: tests 64, fail 0
node --import tsx/esm --test src/__tests__/factTokenizer.test.ts src/__tests__/renderCanonical.test.ts
```

### What the tests pin down
- `factTokenizer.test.ts`: `collapseIdenticalConjugationBranches` collapses
  `{can|can}`/`{won't|won't}`, collapses multiple in one template, leaves
  `{is|are}`/`{has|have}`/`{keeps|keep}` untouched, is idempotent, no-ops on
  empty/plain input. `postProcessTokenizedTemplate("{NAME} {can|can} fill …")` →
  `"{NAME} can fill …"` with `conjugated:false, collapsed:true`; a legitimate pair
  survives with `collapsed:false`.
- `renderCanonical.test.ts`: `renderCanonical` and `renderPersonalized` produce
  identical output for `{can|can}` vs `can` (he/him AND they/them) — the safety
  proof that collapsing can't change rendered text.

## Backfill (Replit owns the DB connection)

Collapses existing `{X|X}` already stored before this fix. **Dry-run first, review,
then apply.** It scans **all** `facts` rows — including **inactive staging facts**
(do NOT add an `isActive` filter) — plus `pending_reviews.submittedText`. For each
changed fact it recomputes `canonicalText` / `splitTokenIndex` / `hasPronouns`
(collapsing the only conjugation token can correctly flip `hasPronouns` false).
Idempotent; no re-embed.

```bash
# From repo root. Dry-run reports [facts #id] / [pending_reviews #id] rewrites, writes nothing:
pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-identical-branches.ts --dry-run
# After reviewing the dry-run output, apply:
pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-identical-branches.ts --apply
```
Confirm: every printed rewrite only drops a duplicate pair to its single word
(nothing else changes); re-running `--dry-run` after `--apply` reports `changed=0`
(idempotent).

## Gotchas
- The collapse is **exact-match only** — a whitespace-padded `{can | can}` is left
  alone deliberately (not seen in real data; revisit only if it appears).
- `validateTemplate` is intentionally unchanged: `{X|X}` is still structurally
  valid; it's just cleaned up before persistence, so nothing starts rejecting.

## Deliberately NOT shipped
- No enforcement of "no identical branches" at the grammar/validator layer (keep
  validation permissive, cleanup deterministic).
- No frontend `renderFact` automated parity test (the server render-equivalence
  test covers the safety claim; frontend uses the same split logic).
