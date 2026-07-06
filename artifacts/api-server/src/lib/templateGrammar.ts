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
