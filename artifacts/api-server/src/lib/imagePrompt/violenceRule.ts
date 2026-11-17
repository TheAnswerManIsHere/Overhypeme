/**
 * The one violence rule (plan `docs/plans/PLAN_GAG_DIRECT_RENDER.md`, *Proposed
 * Design* B; David, 2026-11-17: "allow violence without creating intense gore
 * (until we enable NSFW mode which might change that policy)").
 *
 * Defined once, here, and sent word for word wherever a picture's violence is
 * governed: on every picture's prompt (`compileDirect`) and in the gag
 * writer's request limits (`visualConcepts/generator.ts`). No recipe version may reword or drop it; a later
 * NSFW mode changes this definition, nothing else.
 *
 * @purpose The single sentence that sets how much violence a picture may show: comedic violence and its consequences shown clearly, without intense gore.
 * @subsystem visual-pipeline
 */
export const VIOLENCE_RULE =
  "When the scene involves violence, show the action and its consequences clearly, as comedy, without intense gore.";
