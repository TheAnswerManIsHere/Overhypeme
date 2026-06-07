# Tokenizer: don't conjugate verbs whose subject isn't the person — automated test run

Engineering-side checklist for Replit (the technical safety net). The in-app
walkthrough for David is in
[`TOKENIZER_NONPERSON_VERB_UAT.md`](./TOKENIZER_NONPERSON_VERB_UAT.md).

Companion to the a/an render fix on the same branch
([`AAN_ARTICLE_AGREEMENT_TEST_RUN.md`](./AAN_ARTICLE_AGREEMENT_TEST_RUN.md)) —
together they make "Sharks have a David Week" tokenize and render correctly
end-to-end. They are distinct fixes: a/an is a **render-time** change; this is a
**tokenizer prompt** change.

## What was wrong

The OpenAI fact tokenizer (`/ai/tokenize-fact`,
`artifacts/api-server/src/routes/ai.ts`) wrapped verbs in a
`{singular|plural}` conjugation token **even when the verb's subject was not the
personalized person**. For "Sharks have a David Week" it emitted a
`{have|has}`-style pair, so the they/them render became the ungrammatical
"Sharks **has** an Alex Jordan Week". "Sharks" is always plural; "have" must
stay plain text.

Root cause was the prompt itself:

1. **Rule 7** told the model to conjugate "ANY verb… that conjugates differently
   for they vs he/she" with no subject restriction, reinforced by the IMPORTANT
   bullet "Identify EVERY third-person singular verb".
2. **Both worked examples taught the bug** — they conjugated verbs governed by
   non-person subjects:
   - `When {NAME} {laughs|laugh}, the earth {cries|cry}.` → they/them: "the earth cry"
   - `… time {fears|fear} {Obj}.` → they/them: "time fear them"

## What changed (prompt-only + determinism)

`artifacts/api-server/src/routes/ai.ts` (`TOKENIZE_SYSTEM_PROMPT`):

- **Rule 7 rewritten** to scope conjugation pairs to verbs whose grammatical
  subject is the person ({NAME}/{SUBJ}/{Subj}); any verb governed by a different
  noun ("Sharks", "time", "the earth", "death", "people", …) stays plain text,
  even when third-person singular.
- **IMPORTANT bullets** narrowed: the "EVERY third-person singular verb" bullet
  is replaced by a subject-test ("is the person the subject of THIS verb?"), and
  the "they triggers plural" bullet is gated on the person being the subject.
- **Examples corrected + one added:**
  - `When {NAME} {laughs|laugh}, the earth cries.` (person verb conjugated; "the
    earth cries" plain — a mixed example)
  - `{NAME} {doesn't|don't} age because time fears {Obj}.` ("time fears" plain)
  - new: `Sharks have a David Week.` → `Sharks have a {NAME} Week.`
- **`temperature: 0`** added to the tokenize `callUtilityLLM` call (the request
  type already supports a per-call override; it's safely ignored for reasoning
  models). Tokenization is a structural transform with one right answer.

`scripts/src/retokenize-facts.ts` carries its own copy of the prompt and its own
OpenAI call — synced with the same Rule 7 / bullet rewrite and `temperature: 0`
so a future re-run can't reintroduce the bug.

**No renderer changes. No schema/migration. No new template token.** The
renderers were already correct.

---

## TL;DR

```bash
# Build workspace libs first, then typecheck the touched package.
pnpm run typecheck:libs
( cd artifacts/api-server && tsc -p tsconfig.json --noEmit )   # ai.ts: 0 errors
( cd scripts && tsc -p tsconfig.json --noEmit )                # retokenize-facts.ts: 0 errors

# Renderer regression (must stay green — renderers untouched).
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/renderCanonical.test.ts   # 33 pass
cd artifacts/overhype-me && pnpm exec vitest run src/__tests__/renderFact.test.ts  # 66 pass
```

The actual tokenizer output is produced by OpenAI and is **not** asserted in CI
(the LLM isn't mocked; `routes.ai.test.ts` only covers auth/captcha/validation
gates). Confirm output behavior via the manual checks below.

---

## A — Typecheck

```bash
pnpm run typecheck:libs
( cd artifacts/api-server && tsc -p tsconfig.json --noEmit )   # exits 0; no ai.ts errors
( cd scripts && tsc -p tsconfig.json --noEmit )                # exits 0; no retokenize-facts errors
```

(Without `typecheck:libs` first you'll see unrelated `TS6305 … has not been
built` errors — build the libs and they disappear.)

## B — Renderer regression (already green, must stay green)

The renderers are not modified; these encode the **intended** end state for the
fixed templates and must keep passing:

```bash
node --import tsx/esm --test artifacts/api-server/src/__tests__/renderCanonical.test.ts
cd artifacts/overhype-me && pnpm exec vitest run src/__tests__/renderFact.test.ts
```

Pass criteria: **33 pass** (api) and **66 pass** (web). Note especially
`renderCanonical.test.ts` already asserts `"Sharks have a {NAME} Week"` keeps
"have" for he/him, she/her, and they/them — i.e. once the tokenizer emits the
correct template, the renderers do the right thing.

## C — Tokenizer output (manual / live — no CI assertion)

Run the app (or hit `/api/ai/tokenize-fact` directly with a valid session) and
confirm the produced **templates** for these inputs:

| Input | Expected template |
| --- | --- |
| `Sharks have a David Week.` | `Sharks have a {NAME} Week.` (no `{have\|has}`) |
| `When David laughs, the earth cries.` | `When {NAME} {laughs\|laugh}, the earth cries.` |
| `Sarah doesn't age because time fears her.` | `{NAME} {doesn't\|don't} age because time fears {Obj}.` |
| `David counts to infinity.` (control — person subject) | `{NAME} {counts\|count} to infinity.` (still conjugated) |

The last row is the guard against over-correction: verbs whose subject **is** the
person must still be conjugated.

Because output comes from a live model it can vary across model versions;
`temperature: 0` makes it stable for a fixed model. The deterministic safety net
remains the SubmitFact 3-name preview + the Advanced template editor +
`validateTemplate`'s 422 on structurally-invalid output.

---

## Deliberately NOT shipped

- **No deterministic subject-detection guard.** Reliably identifying a verb's
  grammatical subject needs real dependency parsing (relative clauses, conjoined
  subjects, fronted adverbials). A regex heuristic would mis-strip legitimate
  person-verb conjugations or trip on "Sharks, which {NAME} {fears|fear}, …".
  The corrected prompt + preview + editor + validator is the layered net.
- **No bulk re-tokenization of existing facts.** Remediation for an already-stored
  bad fact is the admin `PATCH /admin/facts/:id` editor or the (now-fixed)
  `retokenize-facts.ts` script.
- **No renderer / grammar-validator change.** The validator stays purely
  syntactic by design.
