# Token Rendering and Grammar

> How a fact template personalizes correctly across pronoun sets. **The
> grammar/token contract lives in `lib/api-zod/src/templateGrammar.ts`** (shared
> with the frontend); **model + prompt policy is server-owned** in
> `artifacts/api-server/src/lib/factTokenizer.ts`; substitution happens in
> `artifacts/overhype-me/src/lib/render-fact.ts`. This separation is deliberate.

## Personalization tokens

The **closed set** an approved template may use (`ALLOWED_SIMPLE_TOKENS` in
`templateGrammar.ts`), each pronoun token having a lowercase base + a
capitalized sentence-start variant:

- `{NAME}`, `{NAME_POSSESSIVE}`
- `{SUBJ}`/`{Subj}`, `{OBJ}`/`{Obj}`, `{POSS}`/`{Poss}`, `{POSS_PRO}`/`{Poss_Pro}`,
  `{REFL}`/`{Refl}`
- Conjugation pairs matching `^[^|]+\|[^|]+$` — exactly two non-empty alternatives,
  e.g. `{laughs|laugh}`, `{doesn't|don't}`.

`validateTemplate()` rejects nested/unmatched braces and any token outside this
set. **Caveat:** the renderer *also* still substitutes some **legacy** tokens
(`{He}`, `{Him}`, `{His}`, `{Himself}`, `{He's}`/`{he's}`, …) for backward compat,
but those are NOT in the allowed set — new tokenization/validation must use the
closed set above.

## Pronoun sets

The renderer resolves a pronoun map from `KNOWN_MAPS` (he/she/they/ze/xe/ey/fae/it,
plus pipe-delimited custom and slash presets). **Plurality** is the branch that
flips verb conjugation: among the `KNOWN_MAPS` presets only they/them is plural,
**but plurality is not hardcoded to they/them** — a pipe-delimited custom pronoun
set carries its own plural flag (`parseCustom(...).plural`, the trailing `|p`/`|s`
field), and `resolveMap()` uses `custom.plural ? "plural" : "singular"`. So a custom
set can render plural too — don't assume only they/them conjugates plural.

## Verb conjugation pairs

A pair `{singular|plural}` renders its **left** branch for singular pronoun sets
(he/she) and its **right** branch for plural (they). Example: `{keeps|keep}` →
"He keeps" / "They keep". The renderer just picks a branch; it does no grammar
reasoning.

## Name tokens

`{NAME}` is the person; `{NAME_POSSESSIVE}` its possessive. Both the server
canonical renderer (`renderCanonical.ts`, via `possessive()`) and the
user-facing renderer (`render-fact.ts`, via `possessiveName()`) substitute
`{NAME_POSSESSIVE}` by **always appending `'s`** — including for names already
ending in `s` (`James` → `James's`, `Chris` → `Chris's`) — so the rule is
unambiguous and viewer-independent (product decision). In the segmented
renderer (`renderFactSegments`) `{NAME}` and `{NAME_POSSESSIVE}` use **two
distinct placeholder sentinels** so each becomes the right text (name vs.
possessive), both still flagged `isName: true`. The renderer also fixes
**indefinite-article agreement at render time** (`a {NAME}` → "an Alex")
because it depends on the viewer's actual name and can't be tokenized ahead of
time. Rare phonetic exceptions ("a Uma"/"an Hugo") are not special-cased.

## Tokenizer responsibilities

`factTokenizer.ts` turns **free English → a template**. It is server-owned policy:
model `gpt-5.4-mini` (low reasoning effort), code-owned allowlist
`{gpt-5.4-mini, gpt-5.5}` (deliberately NOT admin-editable). The LLM proposes the
template, then **deterministic post-processing is the correctness guarantee**
(`postProcessTokenizedTemplate`): `stripUnknownTokens` (hallucinated non-tokens
like `{When}`/`{The}` get their braces removed rather than 422-ing), then the
shared **`applyDeterministicGrammar`** sequence below.

Each rewrite pass returns its own scoped flag
(`nameCollapsed`/`contractionExpanded`/`conjugated`/`collapsed`) and the tokenize
route logs each one, so a silent prompt regression shows up in the logs. **The
deterministic net, not the model, guarantees grammar.** Don't move correctness
into the prompt.

### Shared core: fact submission AND admin Visual-Concept authoring (PR #206)

`tokenizePlainTextToTemplate()` is the **one** exported core both ingresses
call — extracted verbatim from what used to be `/ai/tokenize-fact`'s inline
logic. `/ai/tokenize-fact` (public, captcha-gated, fact submission) is now a
thin wrapper around it; the admin-only batch route `POST
/ai/tokenize-enrichment` (`requireAdmin`, no captcha, path/kind-validated
before any LLM call, bounded concurrency) calls the same core to auto-tokenize
a moderator's plain-English **Visual Strategy Override** fields on Save — see
[`visual-pipeline.md`](./visual-pipeline.md#visual-strategy-override-authoring-auto-tokenize-on-save)
for the authoring-side behavior. One core means the tokenizer prompt, the
deterministic net, and the grammar guarantee can never drift between the two
call sites.

For the admin route, `opts.purpose: "visual_strategy"` + `opts.subjectNames`
prepends a JSON-encoded (never raw-interpolated) hint to the user message —
*"The personalized subject may be referred to by these names: […]. Only
replace those names and their pronouns…"* — since VSO prose may also name
non-personalized secondary characters (a fact template never does). This is a
soft disambiguation hint, not a hard guarantee: a second *named* character can
still be left literal (mitigated by the authoring rule below, not enforced).

Two cost-skip predicates (`isAlreadyTokenizedNoPlainName`,
`hasNoLikelySubjectReference`) let the admin batch route run the deterministic
net only, skipping the LLM call, when nothing personalizable is left to find.
**Both mask every `{…}` brace span before matching** so a token like `{NAME}`
is never mistaken for a plain occurrence of a subject literally named "Name."
**Both must check every personalization signal, not just the most obvious
one** — see the "cost-skip heuristic" entry in
[`known-failure-patterns.md`](./known-failure-patterns.md) for the real bug
this produced (a plain-name check alone let a mixed, partially-tokenized field
with a leftover plain pronoun skip re-tokenization forever).

### The single deterministic sequence: `applyDeterministicGrammar`

`applyDeterministicGrammar(template)` (in `templateGrammar.ts`) is the one
canonical grammar-only cleanup, run in this exact order:

1. `collapseNameSubjectConjugationPairs` — `{NAME} {gives|give}` → `{NAME} gives`
   (a name is a singular literal for every pronoun set, so a pair after `{NAME}`
   is wrong by construction). Covers adjacent coordinated verbs AND a pair
   separated from `{NAME}` by an object when it sits directly after a
   coordinating conjunction (`{NAME} eats cake and {drinks|drink} soda` → `…
   and drinks soda`); the object-separated reach stops at any brace or
   clause-boundary punctuation (`. , ; : ? ! newline "`), so it can't cross a
   different subject token or into a new clause.
2. `expandSubjectContractions` — `{Subj}'s`/`{SUBJ}'s` → `{Subj} {is|are}` (see
   "Retiring `They's`" below).
3. `autoConjugatePersonSubjectVerbs` — wraps pronoun-subject verbs into pairs.
   **Adjacency-only**: fires on the verb immediately after `{SUBJ}`/`{Subj}`
   (through skippable adverbs). It does NOT walk a coordination chain to wrap a
   later verb, because a regex can't tell a shared-subject verb from a new
   lowercase noun subject — `{Subj} runs and dogs bark` correctly becomes
   `{Subj} {runs|run} and dogs bark` (first verb wrapped, `dogs bark` left
   alone). Coordinated `{Subj}` verbs are the AI prompt's job (it has an example
   for them); the net doesn't retro-repair the tail.
4. `collapseIdenticalConjugationBranches` — `{can|can}` → `can`.

`applyDeterministicGrammar` deliberately **excludes** `stripUnknownTokens` — that
is model-hallucination cleanup owned by the AI route; the other write routes
should validate-and-reject unknown tokens, not silently strip them.

### Every ingress runs the same sequence

Because `validateTemplate` accepts any well-formed pair position-independently,
an already-tokenized submission (`{Subj} keeps it`, `{Subj}'s fast`) could
otherwise validate and store unrepaired. So **every** template-writing route runs
the full `applyDeterministicGrammar` sequence through the shared server helper
**`normalizeFactTemplateForStorage(text)`** (in
`artifacts/api-server/src/lib/`), which returns a discriminated union on `valid`
and — on success — the derived storage columns (`canonicalText`,
`splitTokenIndex`, `hasPronouns`) computed from the FINAL normalized text.
Callers: `POST /facts`, `PATCH /admin/facts/:id`, `POST /admin/facts/:id/variants`
(422 on invalid), and the bulk paths `POST /admin/facts/import`,
`POST /admin/facts/import-csv`, and the API-key `POST /admin/import/facts` (which
keep their existing response shapes and add a `failed` array — invalid rows are
reported and skipped, valid rows written: partial success). `POST
/facts/submit-review` uses `normalizeFactTemplateForPendingReview` (normalize +
validate, no fact-only metadata). Normalization runs BEFORE dedupe/canonical/
embedding so stored text and derived metadata never drift.

The authoritative server-side `hasPronouns` detector for storage is
`hasFactPronounMarkersForStorage` (same module) — it must NOT treat `{NAME}` or
`{NAME_POSSESSIVE}` alone as pronoun-bearing. Do not import the frontend
`hasPronouns` from `render-fact.ts` (that one is client-oriented).

Stored rows created under the old contract are repaired by targeted, idempotent,
dry-run-default backfills:
`artifacts/api-server/scripts/backfill-collapse-name-subject-pairs.ts` (name
pairs) and `artifacts/api-server/scripts/backfill-expand-subject-contractions.ts`
(subject contractions — including the legacy `{He's}`/`{he's}` token; pure
transform in `artifacts/api-server/src/lib/expandSubjectContractionBackfill.ts`).

## Retiring `They's`

`{Subj}'s`/`{SUBJ}'s` is valid template *syntax* (`{Subj}` is a valid token, `'s`
is plain text) but renders the never-valid **"They's"** for they/them. `'s` is
also ambiguous (is/has) — but NOT always: a small, fixed set of following words
can only ever mean "has" (`HAS_ONLY_FOLLOWING_WORDS` = `got`, `gotten`, `been`,
`had`), because "is got"/"is been"/"is had" are not grammatical English. The fix
is deterministic at ingress: `expandSubjectContractions` peeks at the word
immediately after the contraction and rewrites to `{Subj} {has|have}` when it's
one of those, otherwise to `{Subj} {is|are}` — genuinely ambiguous cases like
`'s done` ("is done" [finished] vs. "has done" [completed]) deliberately default
to the copula, since a valid-but-possibly-wrong-reading sentence beats a
guaranteed-ungrammatical one. This runs before validation/storage, so a stored
template should never contain the bare contraction. As defense-in-depth for
legacy/stale text, the renderer (`subjectContraction` in `render-fact.ts`, with
its own copy of the same word set — keep them in sync) renders `{Subj}'s`/
`{SUBJ}'s` and the legacy `{He's}`/`{he's}` tokens plurality- and has/is-safely:
singular sets keep the bare contraction (`He's` — valid English either way,
no lookup needed), plural sets expand to `They have` when the following word
signals "has", otherwise the copula (`They are`) — never a bare `'s`.
`tokenizeFact` (the non-AI path) and the `They's` backfill
(`expandSubjectContractionBackfill.ts`) apply the identical has/is check when
producing a stored pair; the AI prompt is instructed to make the same call
itself for `he's`/`she's`.

## Renderer responsibilities

`render-fact.ts` is pure **substitution** for a given viewer: resolve the pronoun
map, pick singular/plural branch by plurality, fix article agreement, substitute
all tokens (and legacy tokens). It never reasons about grammar and never sees the
tokenizer's logic. **Boundary:** tokenizer decides *which* verbs are wrapped and
*where* tokens go (structure); renderer decides *what* each token/branch becomes
(content).

## The core conjugation invariant

> **Only wrap a verb when the personalized PERSON is the grammatical subject AND
> the verb form changes across pronoun sets.**

Enforced by `autoConjugatePersonSubjectVerbs()` + `PERSON_SUBJECT_VERB_RE`, which
fires **only** immediately after `{SUBJ}`/`{Subj}` (through skippable adverbs) —
so it can never mis-pluralize a verb whose subject is a different noun. This is
the **adjacency-only** rule above: the net wraps the immediate verb even inside a
coordination (`{Subj} runs and dogs bark` → `{Subj} {runs|run} and dogs bark`)
but never walks into the coordinated tail, because "and `<word>`" can't be
distinguished from "and `<new subject>` `<verb>`" by regex. A verb whose subject
is `{NAME}` is NOT wrapped: the name renders as a singular literal for every
pronoun set, so those verbs stay plain singular text, and
`collapseNameSubjectConjugationPairs()` collapses any pair the model emits there
anyway (including one separated from `{NAME}` by an object — see the sequence
above). The two passes share one exported adverb pattern
(`SKIPPABLE_ADVERB_RE_SRC`) so their reach can't drift apart.
`thirdPersonToBase()` handles irregulars (is→are, has→have, does→do, goes→go, +
contractions), the sibilant `-sses` rule (passes→pass, misses→miss, kisses→kiss),
and has guards (`NOUN_STOPLIST`, `-ss/-us/-is`, uppercase-initial for proper
nouns).

## Known failure modes

- LLM leaves a person-subject verb unwrapped → would render "They keeps"; the net
  repairs it.
- LLM wraps a **non-person** subject's verb ("Sharks has…") → prevented by prompt
  rule + the narrow anchor.
- LLM wraps a verb whose subject is `{NAME}` (`{NAME} {gives|give}`) → would
  render "David give" for they/them; collapsed to the singular branch.
- LLM wraps a non-conjugating modal (`{can|can}`) → collapsed.
- LLM hallucinates non-token braces → stripped.
- Noun after `{NAME}` ending in `-s` (news, fitness, virus) → false-positive
  pluralization risk, handled by the stoplist/suffix/case guards.
- Sibilant 3rd-person verb after `{Subj}` (passes/misses/kisses) → the `-sses`
  rule yields the correct base (pass/miss/kiss), not `passe`/`misse`.
- Subject-pronoun `'s` (`{Subj}'s`) → would render "They's"; expanded to
  `{Subj} {is|are}` at ingress, rendered plurality-safe as a fallback.
- A skip-LLM heuristic checks only "is there a plain subject name left" and not
  "is there a plain subject pronoun left" → a mixed/partially-tokenized field
  (chip-inserted `{NAME}` but a bare "his"/"her"/"their" left over) reports
  "nothing left to do" and permanently skips the only pass that would fix the
  pronoun. See `isAlreadyTokenizedNoPlainName` above and
  [`known-failure-patterns.md`](./known-failure-patterns.md).

## Regression examples (must stay green)

| Input intent | Wrong | Right | Why |
| --- | --- | --- | --- |
| `{Subj} keeps …` for they/them | "They keeps" | **"They keep"** | person is subject, form changes → wrap `{keeps|keep}` |
| `Sharks have a {NAME} Week` | "Sharks has an Alex Week" | **"Sharks have a … Week"** | *Sharks* is the subject, not the person → leave plain |
| `{NAME} can …` | `{can|can}` | **`can`** | modal doesn't change form → collapse |
| `{NAME} gives …` | `{gives|give}` | **`gives`** | name is a singular literal for every pronoun set → collapse to singular |
| `a {NAME}` where NAME="Alex" | "a Alex" | **"an Alex"** | article agreement fixed at render time |
| `{NAME}'s …` possessive | (mis-wrap) | left plain | possessive of the name, not a verb |
| `{NAME_POSSESSIVE}` where NAME="James" | raw token / "James'" | **"James's"** | always append `'s`; renderer substitutes the token |
| `{Subj} passes` for they/them | "They pass**e**" / "They passes" | **"They pass"** | sibilant `-sses` → strip `es` |
| `{Subj}'s unstoppable` for they/them | "They's unstoppable" | **"They are unstoppable"** | expand contraction to `{is|are}` |
| `{Subj} eats cake and {drinks|drink} soda` (subj={NAME}) | "David drink soda" | **collapse to `drinks`** | object-separated `{NAME}` pair collapse |
| `{Subj} runs and dogs bark` | "They run and dog bark" | **"They run and dogs bark"** | adjacency-only: never wrap the coordinated tail's new subject |

**Prove the general invariant, not just the reported example** — a fix that only
patches the one bad sentence is a known failure pattern (see
[`known-failure-patterns.md`](./known-failure-patterns.md#one-example-bug-fixes)).

## Files to inspect before grammar/token work

- `lib/api-zod/src/templateGrammar.ts` — closed token set, `validateTemplate`,
  `autoConjugatePersonSubjectVerbs`, `collapseIdenticalConjugationBranches`,
  `collapseNameSubjectConjugationPairs`, `expandSubjectContractions`,
  `applyDeterministicGrammar` (single source of truth).
- `artifacts/api-server/src/lib/factTokenizer.ts` — model policy, system prompt,
  post-processing (`postProcessTokenizedTemplate` = strip + `applyDeterministicGrammar`),
  the shared `tokenizePlainTextToTemplate()` core, and the cost-skip predicates
  `isAlreadyTokenizedNoPlainName` / `hasNoLikelySubjectReference`.
- `artifacts/api-server/src/routes/ai.ts` — `/ai/tokenize-fact` (thin wrapper)
  and the admin-only batch route `/ai/tokenize-enrichment`.
- `artifacts/api-server/src/lib/normalizeFactTemplateForStorage.ts` — the shared
  normalize → validate → derive contract every write route uses, plus
  `hasFactPronounMarkersForStorage`.
- `artifacts/overhype-me/src/lib/render-fact.ts` (+ `@/lib/pronouns`) — the
  renderer, pronoun maps, article agreement, `{NAME_POSSESSIVE}` +
  subject-contraction fallback.
- `artifacts/api-server/src/lib/expandSubjectContractionBackfill.ts` +
  `artifacts/api-server/scripts/backfill-expand-subject-contractions.ts` — the
  `They's` backfill.

## Testing expectations

- `artifacts/api-server/src/__tests__/factTokenizer.test.ts` — model policy,
  `stripUnknownTokens`, post-process flags (incl. `contractionExpanded`),
  `{can|can}` collapse, and the parity check
  (`postProcess(raw).template === applyDeterministicGrammar(stripUnknownTokens(raw))`).
- `artifacts/api-server/src/__tests__/autoConjugatePersonSubjectVerbs.test.ts` —
  positive wraps, irregulars, sibilant `-sses`, adverb-between, coordinated-tail
  boundary (`… and dogs bark` stays), the reported failures, and negatives
  (past tense, "Sharks have …", possessives, noun stoplist), plus idempotency.
- `artifacts/api-server/src/__tests__/templateGrammar.test.ts` — object-separated
  `{NAME}` collapse (positive + punctuation/token-boundary negatives),
  `expandSubjectContractions`, `applyDeterministicGrammar` ordering.
- `artifacts/api-server/src/__tests__/expandSubjectContractionBackfill.test.ts` —
  the pure backfill transform (both contraction forms, idempotency, validity).
- `artifacts/overhype-me/src/__tests__/renderFact.test.ts` — `{NAME_POSSESSIVE}`
  (incl. `James's`, blank, segments), and "never renders they's" across he/she/they
  + a custom plural set.
- Route tests (`routes.{facts,reviews,admin,import}.test.ts`) — already-tokenized
  input is repaired before storage; invalid templates are rejected/reported.

Any change to tokenizer/renderer must add cases that assert the **invariant** —
include `They keep`, `Sharks have`, name possessives, and the pronoun sets that
exercise the changed branch.
