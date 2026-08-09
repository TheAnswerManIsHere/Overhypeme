# Chapter 1 · Personalization and Grammar

> How one [fact](../ai-context/glossary.md#fact) template becomes a sentence about whoever's reading it — and
> stays grammatically correct no matter which name or pronouns that turns
> out to be.
>
> Deep spec: [`token-rendering-and-grammar.md`](../ai-context/token-rendering-and-grammar.md).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

A fact isn't stored as finished prose — it's stored as a template with
[placeholders](../ai-context/glossary.md#personalization-tokens) for a name and for pronouns, plus verb forms that can go either
way depending on which [pronoun set](../ai-context/glossary.md#pronoun-set) ends up filling them in. The same stored
template renders as a different, grammatically correct sentence for every
reader: their name goes in, their pronouns go in, and every verb that needs
to agree with those pronouns picks the right form automatically. Nobody
writing or approving a fact has to think about grammar across every
possible pronoun set by hand — the system locks that guarantee in when the
fact is written, and simply plays it back correctly for whoever ends up
reading it.

## How it works

### For the reader

A visitor types a name on the home page, and Overhype.me makes its best
guess at pronouns from that name — with presets (she/her, he/him, they/them)
and a custom option always available to correct or replace the guess.
Every fact on the page re-renders instantly for whatever's currently
selected — this is the personalization step the rest of the product's loop
runs on. A registered user can also save default pronouns on their own
profile, so every fact renders that way for *them* while they browse —
signed in, without re-selecting each visit. It has no effect on how anyone
else sees that user's own submitted facts; every reader always personalizes
from their own current selection, never the author's.

### For whoever writes the words

A [submitter](../ai-context/glossary.md#submitter) or moderator doesn't need to hand-type the placeholders — the
normal path is to write in plain English, naming the subject the usual way,
and let the system convert that into a template automatically. An advanced,
optional editor still lets someone view or hand-adjust the converted result
afterward, for the rare case that needs it. That conversion, and what a
submitter sees happen to their own draft, belongs to
[`2-content-lifecycle.md`](./2-content-lifecycle.md#for-the-submitter-writing-a-fact)
(for a fact submission) and
[`5-visual-pipeline.md`](./5-visual-pipeline.md) (for a moderator authoring a
[Visual Concept](../ai-context/glossary.md#visual-concept)) — both routes end up going through the same underlying
conversion, so a fact and a Visual Concept are personalized identically and
never drift apart from each other.

### Underneath: two jobs, kept strictly separate

Turning plain English into a template is one job; turning a stored template
into a sentence for a specific reader is a completely different one, and
Overhype.me keeps them apart on purpose. The **conversion** step decides
which words become placeholders and which verbs need to be able to change
form — that's a one-time decision made when the text is written. The
**[rendering](../ai-context/glossary.md#rendering)** step, run fresh for every reader, only ever fills in what the
conversion step already decided needed filling in — it never makes new
grammatical judgment calls of its own. Splitting the responsibility this
way means a rendering bug can only ever be about substitution (the wrong
word went in) and a conversion bug can only ever be about structure (the
wrong thing was marked personalizable) — the two failure modes can't blend
into each other.

### A deterministic pass backs up the AI, every time

An AI model proposes the initial conversion from plain English to a
template, but the model's proposal is never trusted on its own. A fixed,
code-owned pass runs over every proposal afterward and corrects the
specific grammar mistakes a model proposal can make — a verb that should
change with pronouns but wasn't marked as such, one that was marked as
changeable but shouldn't be, that kind of thing. This same corrective pass
also runs on any template that reaches storage by a path that skipped the
AI step entirely (an API submission, for instance), so a template can never
end up stored half-corrected depending on which door it came through.

## Why it works this way

- **A guaranteed correction pass matters more than a good prompt.** An AI
  model can be instructed carefully and still occasionally get a pronoun
  agreement wrong — that's the nature of asking a model to reason about
  grammar. Rather than trying to make the prompt perfect, Overhype.me
  accepts that the model will sometimes be wrong and runs a fixed,
  deterministic pass afterward that catches the specific mistakes that
  matter, every single time, regardless of how the model phrased its
  answer.
- **Splitting conversion from rendering means a bug can only be in one
  place at a time.** If the same code both decided what was personalizable
  *and* filled in the actual words for a reader, a wrong sentence could
  come from either job tangled together, and every bug report would start
  with "which part is broken?" Keeping them separate means that question
  answers itself: rendering never invents new structure, and conversion
  never resolves an actual reader's pronouns.
- **A fact and a moderator's Visual Concept share the exact same
  conversion, on purpose.** If fact submission and Visual Concept authoring
  each had their own version of "turn plain English into a template," the
  two would eventually diverge — a grammar fix applied to one path and
  forgotten on the other. Routing both through one shared conversion means
  a fix or an improvement is automatically true everywhere it's used.

## Boundaries & known limitations

- **A small set of older placeholder forms still render correctly for
  backward compatibility**, even though new writing never produces them —
  existing facts stored under an earlier version of the system aren't left
  broken by a later change to how new facts get written.
- **Article agreement ("a" vs "an") is fixed for a reader's actual name at
  render time**, since it depends on the specific name and can't be decided
  when the template is written; see the [spec](../ai-context/token-rendering-and-grammar.md)
  for the exact rule and its known edge cases.
- **The system only ever fills in the placeholders a template actually
  has** — it doesn't reason about grammar beyond that; it substitutes and
  picks the correct pre-decided branch, nothing more creative than that.

## Going deeper

- Spec: [`token-rendering-and-grammar.md`](../ai-context/token-rendering-and-grammar.md)
  — the exact token set, the pronoun-map mechanics, the full deterministic
  grammar sequence, and the regression cases that must stay green.
- Related: [`2-content-lifecycle.md`](./2-content-lifecycle.md) (the submission
  path that produces a template), [`5-visual-pipeline.md`](./5-visual-pipeline.md)
  (the Visual Concept authoring path that shares the same conversion).
- Rationale: the [tokenizer](../ai-context/glossary.md#tokenize)/grammar entries in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 2 — [`2-content-lifecycle.md`](./2-content-lifecycle.md), how
a fact gets into Overhype.me in the first place.

*Verified against `03efc05` (2026-08-09) · claim inventory in PR #367.*
