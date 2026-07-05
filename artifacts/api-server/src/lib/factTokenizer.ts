/**
 * Server-owned tokenizer policy: the system prompt and model choice used to
 * convert a plain-English fact into a `{NAME}/{SUBJ}/…/{verb|verb}` template.
 *
 * This lives here (not in `@workspace/api-zod`) on purpose: the prompt and model
 * are server implementation policy, not schema/grammar contracts, and api-zod is
 * also imported by the frontend. The tokenize route and the retokenize/backfill
 * scripts all import these so the prompt can never drift between copies again.
 * The pure grammar helpers (token validation, the deterministic conjugation net)
 * stay in api-zod.
 */

import {
  ALLOWED_SIMPLE_TOKENS,
  autoConjugatePersonSubjectVerbs,
  collapseIdenticalConjugationBranches,
  collapseNameSubjectConjugationPairs,
} from "./templateGrammar";

// Re-exported for callers/tests that reach the grammar passes through the
// tokenizer module; the implementation lives in api-zod with its siblings.
export { collapseNameSubjectConjugationPairs };

// Deliberately code-owned tokenizer models — NOT governed by adminEngines'
// ALLOWED_LLM_MODELS (that list only gates the admin-editable engine row). Keep
// this set tiny; tokenizer model changes should be reviewed in code.
export const TOKENIZER_ALLOWED_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.4-mini",
  "gpt-5.5",
]);

/**
 * Default tokenizer model: `gpt-5.4-mini` with low reasoning. Tokenization is a
 * short, bounded structural transform, so the mini reasoning model is the right
 * default — and the deterministic `autoConjugatePersonSubjectVerbs` pass, not
 * the model, is the actual correctness guarantee. Escalate this single route to
 * `gpt-5.5` (low reasoning) only if testing shows the mini model still produces
 * too many malformed templates after the prompt hardening + net are in place.
 */
export const TOKENIZER_MODEL = "gpt-5.4-mini";
export const TOKENIZER_REASONING_EFFORT = "low";

export const TOKENIZE_SYSTEM_PROMPT = `You are a fact-template tokenizer for a personalized humor website called Overhype.me.
Users write facts in plain English about a person. You convert them into a template using a closed token set.

TOKEN RULES:
1. Replace the person's name with {NAME}
2. Replace subject pronouns (he, she) with {SUBJ}; capitalize to {Subj} when sentence-starting
3. Replace object pronouns (him, her) with {OBJ}; capitalize to {Obj} when needed
4. Replace possessive adjectives (his, her as adjective) with {POSS}; capitalize to {Poss} when needed
5. Replace possessive pronouns (his, hers as standalone pronoun) with {POSS_PRO}; capitalize to {Poss_Pro} when needed
6. Replace reflexive pronouns (himself, herself) with {REFL}; capitalize to {Refl} when needed
7. Conjugation pairs are ONLY for verbs whose grammatical subject is a
   {SUBJ}/{Subj} pronoun referring to the personalized person. For such a verb
   or auxiliary, use {singular_form|plural_form} syntax.
   The LEFT form is used for he/she; the RIGHT form is used for they.
   Examples (subject IS the person): {doesn't|don't}  {isn't|aren't}  {was|were}  {does|do}  {has|have}  {pushes|push}  {counts|count}  {keeps|keep}  {runs|run}
   If the subject is {NAME}, leave the verb plain in its normal singular-name
   form. "When {NAME} gives..." is correct for every pronoun set; do NOT output
   "When {NAME} {gives|give}..."
   A verb whose subject is ANYTHING ELSE — a literal noun ("Sharks", "time", "the earth", "death", "people") or any noun phrase that is not the person — MUST stay plain text with NO braces, even if it is third-person singular. The person's pronouns never change another subject's number.
8. Keep everything else exactly as written — no braces around any other word.

IMPORTANT:
- Capitalize tokens at the start of sentences: {Subj} not {SUBJ}, etc.
- Verb conjugation is NARROW: only conjugate a verb whose subject is a person pronoun token ({SUBJ}/{Subj}). Before adding a pair, ask "is the subject a {SUBJ}/{Subj} token?" — if the subject is {NAME} or a different noun, leave the verb plain.
- When the person is the subject, "they" triggers plural: "he sleeps" → "{SUBJ} {sleeps|sleep}", "he doesn't" → "{SUBJ} {doesn't|don't}", "he was" → "{SUBJ} {was|were}"
- If the he/she and they forms are IDENTICAL, leave the verb plain — do NOT wrap it. Modal verbs are the common case: can, will, would, should, could, must, might, may. Output "{NAME} can fly" not "{NAME} {can|can} fly".
- SELF-CHECK before returning: re-read every present-tense verb that directly follows {SUBJ}/{Subj}. Each one MUST be a {singular|plural} pair. A bare "-s" verb in that position (keeps, runs, is, has, does) is a bug — wrap it. Re-read every verb that follows {NAME}; each one MUST stay plain singular-name text.
- NEVER put braces around words that are not in the token list above. Conjunctions ("When", "But", "If", "Because"), articles ("The", "A", "An"), prepositions ("In", "On", "At"), and all other non-token words must be written as plain text without braces. Wrapping any such word in braces is ALWAYS wrong.
- Return ONLY valid JSON: {"template": "...the tokenized template..."}
- Do NOT explain, do NOT add any other keys.

EXAMPLES (correct output):
Input: "When David laughs, the earth cries."
Output: {"template": "When {NAME} laughs, the earth cries."}

Input: "Sarah doesn't age because time fears her."
Output: {"template": "{NAME} doesn't age because time fears {Obj}."}

Input: "Sharks have a David Week."
Output: {"template": "Sharks have a {NAME} Week."}

Input: "Alex keeps the virus in his back yard."
Output: {"template": "{NAME} keeps the virus in {POSS} back yard."}`;

/**
 * Remove braces from tokens the grammar validator does not recognise.
 *
 * When the model hallucinates `{When}` or `{The}` it violates rule 8 of the
 * system prompt ("keep everything else exactly as written"). Stripping the
 * braces from those tokens restores the original plain text — what the prompt
 * intended — rather than aborting with a 422. Valid simple tokens and
 * conjugation pairs ({is|are}) are left untouched. The recognised-token set is
 * `ALLOWED_SIMPLE_TOKENS` from api-zod — the same source of truth
 * `validateTemplate` uses — so this cleanup can never drift from the validator
 * (e.g. wrongly strip a valid `{NAME_POSSESSIVE}`).
 */
export function stripUnknownTokens(template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (match, inner: string) => {
    if (ALLOWED_SIMPLE_TOKENS.has(inner)) return match;
    // Conjugation pair: two non-empty alternatives separated by exactly one |
    const pipeIdx = inner.indexOf("|");
    if (pipeIdx > 0 && pipeIdx === inner.lastIndexOf("|") && pipeIdx < inner.length - 1) {
      return match;
    }
    // Unknown token — strip the braces, leave the word as plain text.
    return inner;
  });
}

/**
 * Clean up a raw model-produced template into its final form, in four passes:
 *   1. strip hallucinated tokens ({When} → When),
 *   2. collapse name-subject conjugation pairs ({NAME} {gives|give} → {NAME} gives)
 *      because {NAME} is a singular literal name for every pronoun set,
 *   3. apply the deterministic pronoun-subject verb-conjugation net (the actual
 *      guarantee that "{Subj} keeps" becomes "{Subj} {keeps|keep}"),
 *   4. collapse identical conjugation branches ({can|can} → can) — modals and
 *      other non-conjugating verbs whose he/she and they forms match, which the
 *      model sometimes wraps into a useless duplicate pair.
 *
 * Returns the final template plus one scoped flag per rewrite pass so callers
 * can log each independently: `nameCollapsed` (a {NAME}-subject pair was
 * collapsed to its singular branch), `conjugated` (the net wrapped a missed
 * verb), and `collapsed` (a duplicate pair was dropped). No flag is overloaded
 * to mean "anything changed" — a raw `{can|can}` collapses with
 * `conjugated: false, collapsed: true`.
 */
export function postProcessTokenizedTemplate(
  raw: string,
): { template: string; nameCollapsed: boolean; conjugated: boolean; collapsed: boolean } {
  const stripped = stripUnknownTokens(raw);
  const nameSubjectCollapsed = collapseNameSubjectConjugationPairs(stripped);
  const conjugatedTemplate = autoConjugatePersonSubjectVerbs(nameSubjectCollapsed);
  const collapsedTemplate = collapseIdenticalConjugationBranches(conjugatedTemplate);
  return {
    template: collapsedTemplate,
    nameCollapsed: nameSubjectCollapsed !== stripped,
    conjugated: conjugatedTemplate !== nameSubjectCollapsed,
    collapsed: collapsedTemplate !== conjugatedTemplate,
  };
}
