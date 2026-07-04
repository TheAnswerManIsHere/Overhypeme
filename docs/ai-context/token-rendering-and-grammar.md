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
(`{He}`, `{Him}`, `{His}`, `{Himself}`, …) for backward compat, but those are NOT
in the allowed set — new tokenization/validation must use the closed set above.

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

`{NAME}` is the person; `{NAME_POSSESSIVE}` its possessive. The renderer also
fixes **indefinite-article agreement at render time** (`a {NAME}` → "an Alex")
because it depends on the viewer's actual name and can't be tokenized ahead of
time. Rare phonetic exceptions ("a Uma"/"an Hugo") are not special-cased.

## Tokenizer responsibilities

`factTokenizer.ts` turns **free English → a template**. It is server-owned policy:
model `gpt-5.4-mini` (low reasoning effort), code-owned allowlist
`{gpt-5.4-mini, gpt-5.5}` (deliberately NOT admin-editable). The LLM proposes the
template, then **deterministic post-processing is the correctness guarantee**
(`postProcessTokenizedTemplate`), in four passes:

1. `stripUnknownTokens` — hallucinated non-tokens (`{When}`, `{The}`) get their
   braces removed rather than 422-ing.
2. `collapseNameSubjectConjugationPairs` — `{NAME} {gives|give}` → `{NAME} gives`
   (a name is a singular literal for every pronoun set, so a pair after `{NAME}`
   is wrong by construction; covers coordinated verbs too).
3. `autoConjugatePersonSubjectVerbs` — wraps pronoun-subject verbs into pairs.
4. `collapseIdenticalConjugationBranches` — `{can|can}` → `can`.

Each rewrite pass returns its own flag (`nameCollapsed`/`conjugated`/`collapsed`)
and the tokenize route logs each one, so a silent prompt regression shows up in
the logs. **The deterministic net, not the model, guarantees grammar.** Don't
move correctness into the prompt.

The name-subject collapse is also applied at the OTHER template-writing
ingress points (direct fact insert in `facts.ts`, review submission in
`reviews.ts`, the retokenize script), because `validateTemplate` accepts any
well-formed pair position-independently. Stored rows created under the old
contract are repaired by `scripts/backfill-collapse-name-subject-pairs.ts`.

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
so it can never mis-pluralize a verb whose subject is a different noun. A verb
whose subject is `{NAME}` is NOT wrapped: the name renders as a singular literal
for every pronoun set, so those verbs stay plain singular text, and
`collapseNameSubjectConjugationPairs()` collapses any pair the model emits there
anyway. The two passes share one exported adverb pattern
(`SKIPPABLE_ADVERB_RE_SRC`) so their reach can't drift apart.
`thirdPersonToBase()` handles irregulars (is→are, has→have, does→do, goes→go, +
contractions) and has guards (`NOUN_STOPLIST`, `-ss/-us/-is`, uppercase-initial
for proper nouns).

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

## Regression examples (must stay green)

| Input intent | Wrong | Right | Why |
| --- | --- | --- | --- |
| `{Subj} keeps …` for they/them | "They keeps" | **"They keep"** | person is subject, form changes → wrap `{keeps|keep}` |
| `Sharks have a {NAME} Week` | "Sharks has an Alex Week" | **"Sharks have a … Week"** | *Sharks* is the subject, not the person → leave plain |
| `{NAME} can …` | `{can|can}` | **`can`** | modal doesn't change form → collapse |
| `{NAME} gives …` | `{gives|give}` | **`gives`** | name is a singular literal for every pronoun set → collapse to singular |
| `a {NAME}` where NAME="Alex" | "a Alex" | **"an Alex"** | article agreement fixed at render time |
| `{NAME}'s …` possessive | (mis-wrap) | left plain | possessive of the name, not a verb |

**Prove the general invariant, not just the reported example** — a fix that only
patches the one bad sentence is a known failure pattern (see
[`known-failure-patterns.md`](./known-failure-patterns.md#one-example-bug-fixes)).

## Files to inspect before grammar/token work

- `lib/api-zod/src/templateGrammar.ts` — closed token set, `validateTemplate`,
  `autoConjugatePersonSubjectVerbs`, `collapseIdenticalConjugationBranches`,
  `collapseNameSubjectConjugationPairs` (single source of truth).
- `artifacts/api-server/src/lib/factTokenizer.ts` — model policy, system prompt,
  post-processing.
- `artifacts/overhype-me/src/lib/render-fact.ts` (+ `@/lib/pronouns`) — the
  renderer, pronoun maps, article agreement.

## Testing expectations

- `artifacts/api-server/src/__tests__/factTokenizer.test.ts` — model policy,
  `stripUnknownTokens`, post-process flags, `{can|can}` collapse.
- `artifacts/api-server/src/__tests__/autoConjugatePersonSubjectVerbs.test.ts` —
  positive wraps, irregulars, adverb-between, the reported failures, and negatives
  (past tense, "Sharks have …", possessives, noun stoplist), plus idempotency
  (running twice == once).

Any change to tokenizer/renderer must add cases that assert the **invariant** —
include `They keep`, `Sharks have`, name possessives, and the pronoun sets that
exercise the changed branch.
