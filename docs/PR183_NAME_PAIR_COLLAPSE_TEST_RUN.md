# PR183 — {NAME}-subject pair collapse at every ingress + backfill · TEST_RUN (engineering checklist)

> **For Replit (the technical safety net).** Automated verification for the
> name-subject conjugation-pair collapse (grammar contract: pairs only after
> `{SUBJ}/{Subj}`; verbs after `{NAME}` stay plain singular), its wiring into
> every template-writing ingress, and the corpus backfill. Companion
> click-through: `docs/PR183_NAME_PAIR_COLLAPSE_UAT.md`.
>
> Replit owns the database connection — do **not** set `DATABASE_URL` from this
> doc. "Run the backfill" / "run these tests" against Replit's own DB.

---

## 1. Build + typecheck

```bash
pnpm run typecheck:libs
pnpm typecheck
pnpm run check:docs
```

Expect: all projects report **Done**, no TS errors, and docs-accuracy passes
(`token-rendering-and-grammar.md` was updated in this PR and cites the new
backfill script by full path).

## 2. Grammar unit tests (the core of this PR)

```bash
cd artifacts/api-server
bash scripts/run-test.sh src/__tests__/factTokenizer.test.ts src/__tests__/autoConjugatePersonSubjectVerbs.test.ts
```

Expect **55 tests, 0 fail**. The cases that must be green:

- `collapseNameSubjectConjugationPairs`:
  - `"When {NAME} {gives|give} you the finger"` → `"When {NAME} gives you the finger"`.
  - Adverb between: `"{NAME} always {runs|run} …"` → collapsed.
  - **Coordination** (new vs. #181): `"{NAME} {runs|run} and {hides|hide}"` →
    `"{NAME} runs and hides"`; `"{NAME} runs and {hides|hide}"` (plain first
    verb) also collapses; `"{NAME} never {sleeps|sleep} and never {eats|eat}"` →
    both collapsed.
  - **Chain stops at a pronoun subject**: `"{NAME} {runs|run} or {SUBJ} {hides|hide}"`
    collapses only the first pair — the `{SUBJ}` pair MUST survive.
  - Negatives: `{Subj}`-subject pairs untouched; `{NAME_POSSESSIVE} dog {barks|bark}`
    and `{NAME}'s dog {barks|bark}` untouched; `"Sharks have a {NAME} Week."`
    untouched; documented limitation `"{NAME} eats cake and {drinks|drink} soda"`
    unchanged (object ends the chain).
  - Idempotency: running the pass twice equals once, for all shapes above.
- `postProcessTokenizedTemplate` returns the new third flag:
  `nameCollapsed=true, conjugated=false, collapsed=false` when only the name
  pass fired; `nameCollapsed=false` when no name pair exists.
- `autoConjugatePersonSubjectVerbs` negatives: all `{NAME} <verb>` inputs stay
  unchanged (the net is `{SUBJ}/{Subj}`-only now).

## 3. Full backend suite

```bash
pnpm --filter @workspace/api-server test
```

Expect **all shards pass** (615 tests at time of writing). Notable coverage:
`routes.ai.test.ts` (tokenize route + post-process flags), `routes.facts.test.ts`
(direct insert now collapses before validation), `routes.reviews.test.ts`
(submission ingress).

## 4. Frontend suite

```bash
pnpm --filter @workspace/overhype-me test
```

Expect **all pass** (737 at time of writing) — includes the #181-carried tests:
`AdminLayout` nav-active helper, `VisualConceptCard` token examples,
`useFactEnrichmentEditing` draft reconciliation, and the moderation page tests.

## 5. Backfill (the data half — run against Replit's DB)

The script is `artifacts/api-server/scripts/backfill-collapse-name-subject-pairs.ts`.

```bash
# 1. Dry-run first — prints a was/now pair per affected row, writes nothing:
pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-name-subject-pairs.ts --dry-run

# 2. Review the printed changes: every "now" line should differ from "was" ONLY
#    by pairs after {NAME} losing their braces and right branch. {Subj} pairs
#    must never change.

# 3. Apply:
pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-name-subject-pairs.ts --apply

# 4. Idempotency: re-run --apply; expect "changed=0".
```

Checks after apply:

- No fact text contains a pair immediately after `{NAME}` (modulo adverbs):
  a SQL sanity probe like `SELECT id, text FROM facts WHERE text ~ '\{NAME\}\s+\{[^|{}]+\|'`
  should return **0 rows**.
- Same probe on `pending_reviews.submitted_text` → 0 rows.
- Changed facts got their derived columns recomputed: `canonical_text` no longer
  shows the plural branch, and `has_pronouns` flipped to `false` only where the
  collapsed pair was the row's sole pronoun-ish token.
- Rows with `{Subj}` pairs and rows with no pairs are byte-identical to before
  (no-op rows are never written).
- If a changed fact had an in-flight refresh candidate
  (`fact_enrichment_versions.status = 'candidate'`), the script printed a
  "re-stamped fact_text_hash" line for it and the candidate's `fact_text_hash`
  now equals the sha256 of the NEW `facts.text` — approving that refresh in
  moderation must NOT fail with `REFRESH_STALE_TEXT`.

## 6. What's deliberately NOT shipped

- No re-embedding of changed facts: `canonicalText` only loses redundant
  verb-agreement noise — negligible for duplicate search (same rationale as
  `backfill-conjugate-verbs.ts`).
- Coordination through an object (`{NAME} eats cake and {drinks|drink} soda`)
  is not collapsed — same adjacency reach as the conjugation net; documented
  in the function docstring and pinned by a test.
- The live LLM tokenize call is not exercised by tests (needs
  `OPENAI_API_KEY`); the deterministic post-process around it is the guarantee
  and is fully covered.
- `validateTemplate` still *accepts* a `{NAME} {x|y}` pair as well-formed — the
  collapse at each ingress is the enforcement point. Making the validator
  position-aware was considered and rejected as scope creep (it would 422
  historical inputs instead of repairing them).
