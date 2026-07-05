# PR188 — Tokenizer grammar correctness (NAME_POSSESSIVE, sibilant verbs, subject contractions, universal ingress) · TEST_RUN (engineering checklist)

> **For Replit (the technical safety net).** Automated verification for five
> grammar-correctness fixes: `{NAME_POSSESSIVE}` rendering, the sibilant `-sses`
> verb base, the `{NAME}` object-separated pair collapse, retiring the
> never-valid "They's" render, and running the full deterministic grammar
> cleanup at every template-writing ingress — plus the subject-contraction
> corpus backfill. Companion click-through:
> `docs/PR188_TOKENIZER_GRAMMAR_CORRECTNESS_UAT.md`.
>
> Replit owns the database connection — do **not** set `DATABASE_URL` from this
> doc. "Run the backfill" / "run these tests" against Replit's own DB.

---

## 1. Codegen + build + typecheck

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm typecheck
pnpm run check:docs
```

Expect: codegen leaves no diff, all projects report **Done**, no TS errors, and
docs-accuracy passes (`token-rendering-and-grammar.md` was updated in this PR and
cites the new helper/backfill by full path).

## 2. Grammar unit tests (the core of this PR)

```bash
cd artifacts/api-server
bash scripts/run-test.sh \
  src/__tests__/templateGrammar.test.ts \
  src/__tests__/autoConjugatePersonSubjectVerbs.test.ts \
  src/__tests__/factTokenizer.test.ts \
  src/__tests__/expandSubjectContractionBackfill.test.ts
```

Expect **0 fail**. The cases that must be green:

- **Sibilant `-sses`** (`autoConjugatePersonSubjectVerbs`): `{Subj} passes` →
  `{Subj} {passes|pass}`; same for `misses`/`kisses`. Existing noun negatives
  (`{NAME} news`, `{Subj} focus`, `-ss/-us/-is`) stay unchanged.
- **Coordinated-tail boundary** (adjacency-only): `{Subj} runs and dogs bark` →
  `{Subj} {runs|run} and dogs bark` (first verb wrapped, `dogs bark` untouched);
  same for `… and alarms sound`, `… but robots revolt`.
- **`{NAME}` object-separated collapse** (`collapseNameSubjectConjugationPairs`
  / `templateGrammar.test.ts`): `{NAME} eats cake and {drinks|drink} soda` →
  `… and drinks soda`. Negatives that must stay unchanged: a noun between the
  conjunction and the pair (`{NAME} eats and dogs {barks|bark}`), an intervening
  token (`{NAME} eats cake or {SUBJ} {drinks|drink} soda`), and punctuation stops
  (`… cake, and …`, `… cake; and …`, `… cake. And …`). Idempotent.
- **`expandSubjectContractions`**: `{Subj}'s`/`{SUBJ}'s` (straight or curly
  apostrophe) → `{Subj} {is|are}`; idempotent; leaves already-expanded pairs
  and non-contraction text alone.
- **`applyDeterministicGrammar`**: one call collapses a `{NAME}` pair, expands a
  contraction, conjugates a missed verb, and collapses `{can|can}` — in that
  order; idempotent; no-op on already-correct text.
- **`postProcessTokenizedTemplate`**: returns the new `contractionExpanded` flag
  (scoped — not overloading `conjugated`/`collapsed`), and the **parity** test
  proves `postProcess(raw).template === applyDeterministicGrammar(stripUnknownTokens(raw))`.
- **Prompt policy**: `TOKENIZE_SYSTEM_PROMPT` contains the `he's` → `{is|are}`/
  `{has|have}` expansion rule and the coordinated `{runs|run} and {hides|hide}`
  example plus the `… and dogs bark` contrast.
- **Backfill transform** (`expandSubjectContractionBackfill.test.ts`): expands
  both `{He's}`/`{he's}` (legacy token) and `{Subj}'s`/`{SUBJ}'s` (contraction),
  mixed multi-contraction rows, idempotent, transformed output passes
  `validateTemplate`.

## 3. Renderer unit tests

```bash
pnpm --filter @workspace/overhype-me test -- src/__tests__/renderFact.test.ts
```

Expect **0 fail** (85 at time of writing). Must be green:

- `{NAME_POSSESSIVE}` renders `Alice's`, always-`'s` for `James` → `James's`,
  blank → `___'s`, and in `renderFactSegments` the possessive is a single
  `isName: true` segment distinct from a plain `{NAME}` segment.
- **Never renders "they's"**: `{Subj}'s`/`{SUBJ}'s`/`{He's}`/`{he's}` across
  he/she/they and a custom plural set — singular keeps `He's`, plural becomes
  `They are`.
- `tokenizeFact` emits `{Subj} {is|are}` for `He's`/`he's` (never `{Subj}'s`).

## 4. Ingress route tests (already-tokenized input is repaired before storage)

```bash
cd artifacts/api-server
bash scripts/run-test.sh \
  src/__tests__/routes.facts.test.ts \
  src/__tests__/routes.reviews.test.ts \
  src/__tests__/routes.admin.test.ts \
  src/__tests__/routes.import.test.ts
```

Expect **0 fail**. Notable coverage:

- `POST /facts/submit-review` repairs an already-tokenized submission with the
  FULL cleanup (`{Subj}'s keeping` → `{Subj} {is|are} keeping`), not just
  name-collapse.
- `PATCH /admin/facts/:id` validates before update, recomputes
  `canonicalText`/`splitTokenIndex`/`hasPronouns` from normalized text, and 422s
  grammar-invalid text without writing.
- `POST /admin/facts/:id/variants` computes derived metadata; 422s an invalid
  variant (single-item path, not a bulk skip).
- `POST /admin/facts/import`, `import-csv`, and API-key `POST /admin/import/facts`
  write valid rows (with derived metadata) and report grammar-invalid rows in a
  `failed` array — partial success, existing response keys preserved.

## 5. Full backend + frontend suites

```bash
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/overhype-me test
```

Expect **all shards / all files pass**.

## 6. Backfill (the data half — run against Replit's DB)

Script: `artifacts/api-server/scripts/backfill-expand-subject-contractions.ts`
(pure transform in `src/lib/expandSubjectContractionBackfill.ts`).

```bash
# 1. Dry-run first — prints a was/now pair per affected row, writes nothing:
pnpm --filter @workspace/api-server exec tsx scripts/backfill-expand-subject-contractions.ts --dry-run

# 2. Review: every "now" should differ from "was" ONLY by a subject-pronoun 's
#    contraction ({Subj}'s / {SUBJ}'s) or legacy {He's}/{he's} becoming
#    "{Subj} {is|are}" / "{SUBJ} {is|are}". Nothing else changes.

# 3. Apply:
pnpm --filter @workspace/api-server exec tsx scripts/backfill-expand-subject-contractions.ts --apply

# 4. Idempotency: re-run --dry-run (or --apply); expect "changed=0".
```

**Sample dry-run** (from the local test DB, two seeded rows):

```
[backfill] mode=DRY-RUN (no writes) (all facts + all pending reviews)
[backfill] scanning 2 fact(s)...
[facts #1]
  was: {NAME} caught the virus. {He's} keeping it locked up in {POSS} back yard.
  now: {NAME} caught the virus. {Subj} {is|are} keeping it locked up in {POSS} back yard.
[facts #2]
  was: {Subj}'s unstoppable and always will be.
  now: {Subj} {is|are} unstoppable and always will be.
[backfill] scanning 0 pending review(s)...

[backfill] done. changed=2 invalid_skipped=0 (dry-run — re-run with --apply to write)
```

After `--apply`, both rows had `text` rewritten and `canonical_text`
(`They are …`), `has_pronouns=true`, and `split_token_index` recomputed; a second
`--dry-run` reported `changed=0`.

Checks after apply:

- No fact text or `pending_reviews.submitted_text` contains a subject-pronoun
  contraction: a SQL probe like
  `SELECT id, text FROM facts WHERE text ~ '\{(SUBJ|Subj)\}['''']s' OR text ~ '\{[Hh]e''s\}'`
  returns **0 rows**.
- Changed facts got derived columns recomputed (`canonical_text` shows
  `They are …`, `has_pronouns` reflects the added `{is|are}` pair).
- Rows with no contraction are byte-identical to before (no-op rows never
  written).
- Any transformed row that would fail `validateTemplate` is SKIPPED and logged
  as `invalid_skipped` (should be 0 in practice — the legacy `{He's}` token is
  exactly what the transform removes).
- If a changed fact had an in-flight refresh candidate
  (`fact_enrichment_versions.status = 'candidate'`), the script printed a
  "re-stamped fact_text_hash" line and the candidate's hash now equals the
  sha256 of the NEW `facts.text` — approving that refresh must NOT fail with
  `REFRESH_STALE_TEXT`.

## 7. What's deliberately NOT shipped

- **No coordinated `{SUBJ}` auto-wrapping** across a coordination (e.g.
  auto-wrapping `drinks` in `{Subj} eats cake and drinks soda`). A regex can't
  distinguish `and drinks soda` (shared verb) from `and dogs bark` (new subject),
  so per "prefer no rewrite over rewriting the wrong subject" the net stays
  adjacency-only. The AI prompt is instructed to wrap coordinated verbs; the net
  wraps only the immediate one. (The `{NAME}` object-separated *collapse* is safe
  because it only collapses an EXISTING pair, never creates one.)
- **No tokenizer runtime-model change** — `TOKENIZER_MODEL` stays `gpt-5.4-mini`.
- **No re-embedding** of backfilled facts: `canonicalText` only gains an explicit
  auxiliary a viewer already infers from "'s" — negligible for duplicate search.
- `validateTemplate` still *accepts* `{Subj}'s` as well-formed syntax — the
  ingress expansion is the enforcement point (making the validator reject it
  would 422 historical inputs instead of repairing them).
- The live LLM tokenize call is not exercised by tests (needs `OPENAI_API_KEY`);
  the deterministic post-process around it is the guarantee and is fully covered.
