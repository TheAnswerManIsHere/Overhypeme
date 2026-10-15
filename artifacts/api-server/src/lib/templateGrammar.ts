/**
 * @purpose Server-side re-export of the shared template grammar from the api-zod package, so server modules import it from one local path.
 * @subsystem token-rendering
 */

export {
  validateTemplate,
  autoConjugatePersonSubjectVerbs,
  collapseIdenticalConjugationBranches,
  collapseNameSubjectConjugationPairs,
  expandSubjectContractions,
  applyDeterministicGrammar,
  HAS_ONLY_FOLLOWING_WORDS,
  ALLOWED_SIMPLE_TOKENS,
  type GrammarValidationResult,
} from "@workspace/api-zod";
