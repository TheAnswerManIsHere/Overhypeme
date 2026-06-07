/**
 * Map high-impact fact modifiers (`enrichment.modifiers`) to natural-language
 * compiler directives. Only visually-meaningful modifiers are mapped — pure
 * setting/location flags and taxonomy-only signals are skipped, since the
 * authored strategy + scene already cover them. Policy-adjacent modifiers are
 * phrased strictly as PRESENTATION constraints; content moderation is not the
 * compiler's job.
 *
 * Returns directive sentences in a stable order. The compiler de-dupes them
 * against the assembled prompt and drops/compresses under budget, so it is safe
 * to return a few that the LLM prose may already cover.
 */
export function modifierDirectives(modifiers: readonly string[]): string[] {
  const set = new Set(modifiers);
  const out: string[] = [];
  const add = (modifier: string, text: string): void => {
    if (set.has(modifier)) out.push(text);
  };

  // Subject / framing.
  add("face_prominent", "Frame the subject's face prominently and clearly.");
  add("full_body_needed", "Show the subject's full body within the frame.");
  add("avoid_duplicate_subject", "Show exactly one instance of the subject — no duplicates or clones.");
  add("avoid_extra_faces", "Keep extra background faces to a minimum; the subject stays the clear focal point.");

  // Action / causality / staging.
  add("clear_causal_relationship", "Make the scene's cause-and-effect visually unmistakable.");
  add("subject_object_reversal", "Reverse the expected roles so the object acts on the subject, not the other way around.");
  add("object_transformation", "Show the object mid-transformation so the change reads at a glance.");
  add("crowd_reaction", "Include a visible crowd reacting to the subject.");
  add("environmental_reaction", "Show the surrounding environment visibly reacting to the action.");
  add("technology_reaction", "Show nearby technology visibly reacting to the subject.");
  add("mock_heroic", "Stage the subject in an exaggerated, mock-heroic pose.");
  add("cinematic_aftermath", "Capture the cinematic aftermath of the action.");
  add("action_comedy", "Lean into energetic, slapstick action-comedy staging.");
  add(
    "normal_function_rendered_unnecessary",
    "Stage the subject's own action as the overwhelming force; keep the object's normal mechanism intact, unused, delayed, or secondary so it reads as redundant — do not depict that mechanism happening before the subject's action.",
  );
  add("projectile_impact_power", "Show the thrown or launched object carrying impossible force through a shockwave, motion trail, or impact path.");

  // Scale / abstraction.
  add("astronomical_consequence", "Stage a dramatic astronomical or planetary-scale consequence.");
  add("celestial_object", "Include a clearly rendered celestial object (planet, moon, star, or sky body).");
  add("symbolic_abstraction_required", "Render the idea symbolically rather than literally.");
  add("metaphorical_visualization", "Carry the joke through a clear visual metaphor.");

  // Text / brand presentation constraints.
  add("no_readable_text", "Keep all surfaces free of readable text, captions, and labels.");
  add("avoid_real_logos", "Do not depict any real-world logos or brand marks; use generic stand-ins.");
  add("avoid_readable_ui", "Keep any on-screen UI abstract and non-readable.");

  // Policy-adjacent → presentation only (NOT moderation).
  add("avoid_gore", "Keep the scene clean and non-graphic — no gore or blood.");
  add("non_graphic_action", "Keep any action stylized and non-graphic.");
  add("avoid_weapons_focus", "Do not make weapons the visual focus of the scene.");
  add("avoid_gross_literalization", "Render the idea tastefully rather than grossly literal.");

  return out;
}
