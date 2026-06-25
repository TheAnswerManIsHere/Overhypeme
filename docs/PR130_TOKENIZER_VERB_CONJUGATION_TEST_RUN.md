# Tokenizer verb conjugation — engineering test run (Replit)

**PR:** #130 · **Companion:** [`PR130_TOKENIZER_VERB_CONJUGATION_UAT.md`](./PR130_TOKENIZER_VERB_CONJUGATION_UAT.md)

The technical safety net for the "They keeps" → "They keep" fix. Replit owns the
database connection — this doc describes **what** to run against the DB, never a
`DATABASE_URL`/env setup.

## What changed (engineering summary)

- **`lib/api-zod/src/templateGrammar.ts`** — new pure `autoConjugatePersonSubjectVerbs(template)`
  (the deterministic guarantee) + exported `ALLOWED_SIMPLE_TOKENS` as the single
  source of truth for valid simple tokens.
- **`artifacts/api-server/src/lib/factTokenizer.ts`** (new) — server-owned
  tokenizer policy: hardened `TOKENIZE_SYSTEM_PROMPT`, `TOKENIZER_MODEL =
  "gpt-5.4-mini"`, `TOKENIZER_REASONING_EFFORT = "low"`, a code-owned
  `TOKENIZER_ALLOWED_MODELS` (`gpt-5.4-mini`, `gpt-5.5`), `stripUnknownTokens`,
  and `postProcessTokenizedTemplate` (strip → conjugate).
- **`artifacts/api-server/src/lib/utilityLLM.ts`** — new per-call `model` /
  `reasoningEffort` overrides; defaults unchanged so only callers that pass them
  are affected.
- **`artifacts/api-server/src/routes/ai.ts`** — `/ai/tokenize-fact` now calls the
  tokenizer model via the overrides, runs `postProcessTokenizedTemplate`, logs
  `[tokenize-fact] auto-conjugated person-subject verb` when the net fires, and
  shares `ALLOWED_SIMPLE_TOKENS` (fixes a latent strip of valid `{NAME_POSSESSIVE}`).
- **`artifacts/api-server/scripts/backfill-conjugate-verbs.ts`** (new) — no-LLM
  backfill, dry-run by default.
- **`artifacts/api-server/scripts/retokenize-facts.ts`** (moved from
  `scripts/src/`) — reasoning-compatible call shape, shared prompt, skips
  unchanged rows, recomputes derived fields.

## Automated checks

From repo root:

```bash
# Typecheck (builds api-zod + db project refs too)
pnpm --filter @workspace/api-server typecheck

# Full api-server suite — expect ALL pass (816 tests / 236 suites at PR time)
pnpm --filter @workspace/api-server test

# Frontend render regression — expect renderFact.test.ts all green (67 tests)
pnpm --filter @workspace/overhype-me exec vitest run src/__tests__/renderFact.test.ts
```

Targeted, fast feedback on just the new logic (run from `artifacts/api-server/`):

```bash
node --import tsx --test \
  src/__tests__/autoConjugatePersonSubjectVerbs.test.ts \
  src/__tests__/factTokenizer.test.ts
# expect: tests 37, fail 0
```

### What the unit tests pin down

- **`autoConjugatePersonSubjectVerbs`** — positive (`{Subj} keeps`→`{Subj} {keeps|keep}`,
  `has`/`is`/`catches`/`flies`, contractions `doesn't/isn't/hasn't/wasn't`,
  adverb gaps), negative (past tense, already-paired, non-person subjects,
  Title-Case **and** lowercase noun stoplist `{NAME} news`, `-ss/-us/-is`
  endings, `the Corona virus`), idempotency, and the **exact reported template**.
- **`factTokenizer`** — `stripUnknownTokens` keeps `{NAME_POSSESSIVE}` (drift
  fix) and pairs while stripping `{When}`; `postProcessTokenizedTemplate`
  conjugates the reported case and reports `conjugated` truthfully; tokenizer
  model/effort constants are pinned (`gpt-5.4-mini` / `low`, both allowlisted).

## Backfill (existing facts) — DB operation

Deterministic, no LLM, **dry-run by default**. Apply against the real facts
table (Replit's DB). Run from repo root:

```bash
# 1. See exactly what would change (writes nothing)
pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --dry-run

# 2. (optional) target one fact first to eyeball it
pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --fact-id <id> --dry-run
pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --fact-id <id> --apply

# 3. Apply to all facts
pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --apply
```

**Expected behavior / checks:**

- `--dry-run` prints `#id / was: / now:` per changed row and **writes nothing**
  (re-select the rows and confirm `text` is unchanged after a dry-run).
- `--apply` updates only changed rows and, for each, recomputes **`text`,
  `canonical_text`, `split_token_index`, `has_pronouns`** (and `updated_at` via
  the schema's `$onUpdate`). Confirm a repaired row's `canonical_text` now reads
  the **plural** form, e.g. `… They keep it locked up in their back yard.`
- **Idempotent:** a second `--apply` reports `changed=0`.
- It only ever wraps a present-tense verb directly after `{NAME}`/`{SUBJ}`/`{Subj}`;
  it never rewrites a verb whose subject is a different noun.

Spot-check SQL (Replit runs against its own DB):

```sql
-- Find facts that still have a bare person-subject verb the net would fix
-- (sanity check before/after): rows whose text contains "{Subj} <word>s"
-- with no pipe should drop to zero for the screenshot-style pattern after apply.
SELECT id, text FROM facts
WHERE text ~ '\{(SUBJ|Subj|NAME)\}\s+[a-z]+s\b' AND text NOT LIKE '%|%';
```

## Gotchas

- **`scripts/` is not in api-server's tsconfig `include` (only `src`)**, so
  `tsc -b` does **not** typecheck the scripts. They were smoke-run via `tsx`
  instead (backfill exercised end-to-end against the test DB; retokenize verified
  to load all imports). If you change a script, run it (or `tsx --noEmit`-style)
  rather than relying on `typecheck`.
- **`gpt-5.4-mini` is a reasoning model.** It rejects bare `temperature`/`max_tokens`;
  both the route (via `callUtilityLLM` → `chatModelTuningParams`) and the
  retokenize script use `max_completion_tokens` + `reasoning_effort`. The route's
  leftover `temperature: 0` is intentionally harmless — `chatModelTuningParams`
  drops it for reasoning models.
- **`retokenize-facts.ts` requires `OPENAI_API_KEY`** and calls the model per
  fact (cost). It is **not** the routine repair path — prefer the no-LLM
  `backfill-conjugate-verbs.ts`. Kept for a deeper re-tokenize only.
- **No DB schema change.** This PR adds no migration; it only updates existing
  text-derived columns on changed rows.

## Deliberately NOT shipped

- **No embedding re-index in the backfill.** `canonical_text` is recomputed, but
  the pgvector embedding is not refreshed (one-word agreement shift; negligible
  for dedup). An opt-in `--reembed` can be added if desired.
- **No global model change.** Only `/ai/tokenize-fact` moves to `gpt-5.4-mini`;
  the default `llm` engine (dedup, suggest-pronouns, enrichment) is untouched.
- **No `gpt-5.5` by default.** It stays in `TOKENIZER_ALLOWED_MODELS` as a
  code-owned escalation to use only if `gpt-5.4-mini` + net + prompt prove
  insufficient in testing.
- **No Responses API migration.** Intentionally kept on the existing Chat
  Completions wrapper; revisit only if `gpt-5.4-mini` fails through it.
- **No full grammar engine.** The net handles the observed failure class (verb
  right after the person subject token), not arbitrary English.
