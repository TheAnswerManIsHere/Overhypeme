---
name: overhype-token-rendering
description: Work on Overhype.me grammar, the fact tokenizer, personalization tokens, pronoun handling, and rendering. Use for anything touching factTokenizer, templateGrammar, render-fact, verb conjugation, or pronoun sets. Keeps tokenizer vs renderer responsibilities distinct and requires tests for the general invariant, not just the reported example.
---

# Overhype token rendering

For work on tokenization, grammar, pronouns, and rendering.

## Read first

- [`docs/ai-context/token-rendering-and-grammar.md`](../../../docs/ai-context/token-rendering-and-grammar.md)
- [`docs/ai-context/known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md)

## Respect the boundary

- **Tokenizer** (`factTokenizer.ts`, server-owned, model `gpt-5.4-mini`) turns free
  text → template and decides **which** verbs get wrapped and **where** tokens go.
  The deterministic post-processing net — not the LLM — is the correctness guarantee.
- **Renderer** (`render-fact.ts`) substitutes tokens for a viewer and picks the
  singular/plural branch. It does **no** grammar reasoning.
- The token/grammar contract lives in `lib/api-zod/src/templateGrammar.ts` (shared
  with the frontend). The renderer also still supports some **legacy** tokens not in
  the closed allowed set — "the closed set" governs new tokenization/validation.

## The invariant

**Only wrap a verb when the personalized PERSON is the grammatical subject AND the
form changes across pronoun sets.** Never wrap a verb whose subject is a different
noun; collapse identical branches (`{can|can}` → `can`).

## Tests (required)

Add cases that prove the **general** invariant, not only the reported example, with
negatives. Include regression cases for:

- `They keep` (person subject, form changes → `{keeps|keep}`)
- `Sharks have a {NAME} Week` (Sharks is the subject → leave plain)
- name possessives (`{NAME}'s` not mis-wrapped)
- the pronoun sets that exercise the changed branch
- idempotency (running the net twice == once)

Test files: `factTokenizer.test.ts`, `autoConjugatePersonSubjectVerbs.test.ts`. Run
via the repo runners (never raw `node --test`).
