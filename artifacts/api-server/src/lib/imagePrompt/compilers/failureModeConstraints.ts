/**
 * Reusable failure-mode NEGATIVE constraints for the Nano Banana 2 compiler.
 *
 * These complement the POSITIVE `modifierDirectives` ("do X") with conservative
 * "do not / keep" guards that block the predictable rendering mistakes for a
 * fact's role/action shape. Everything is keyed off normalized data we already
 * store — the selected frame, fact modifiers, and the presence of secondary
 * characters — NEVER off raw fact text. The compiler folds the result into
 * STRICT CONSTRAINTS and de-dupes it against the rest of the prompt, so a line
 * the prose already covers is harmless.
 *
 * Emission is deliberately conservative (per the role/action hardening plan):
 *  - the soft role-preservation line whenever secondary characters exist;
 *  - the STRONG sole-agent line only on a reliable active/direct-action frame;
 *  - the active-action line only on a reliable active/direct-action frame;
 *  - soft focus/relationship packs for crowd / causal / object-reversal facts.
 *
 * It never emits a global duplicate ban or a sole-agent claim that would fight
 * an intended co-action, crowd-reaction, symbolic, or multi-instance scene.
 * Illustrative packs that need a signal we do NOT store yet (e.g. detecting
 * "the subject is operating a vehicle") are intentionally omitted — we do not
 * infer them from arbitrary prose. They are documented follow-up.
 */

export interface FailureModeConstraintInput {
  /** Free-text frame name from the visual plan (e.g. "direct_action"). */
  selectedFrame?: string;
  /** Fact enrichment modifiers (the catalog we already store). */
  modifiers?: readonly string[];
  /** Whether the plan listed any secondary characters. */
  hasSecondaryCharacters: boolean;
  /** Rendered subject name, already resolved ("" when unknown). */
  subjectName: string;
}

/**
 * Frame names that reliably mean "the subject is actively performing the central
 * action" (as opposed to an aftermath / symbolic / reaction frame). Kept tight
 * and conservative: only `direct_action`-style frames count, so ambiguous
 * everyday-legend frames ("social_ceremony", "domestic_command") do NOT trip the
 * active-action emphasis and risk over-constraining a subject-as-object scene.
 */
const ACTIVE_ACTION_FRAME_RE = /\b(?:direct|in|mid)[_\s-]?action\b|\baction[_\s-]?shot\b/i;

/** True when the selected frame reliably signals an active subject performing. */
export function isActiveActionFrame(selectedFrame?: string): boolean {
  const f = (selectedFrame ?? "").trim();
  return f ? ACTIVE_ACTION_FRAME_RE.test(f) : false;
}

/**
 * Build the reusable failure-mode negative constraints for this render. Returns
 * sentence-terminated lines in a stable order; the compiler de-dupes them
 * against the assembled prompt.
 */
export function failureModeConstraints(input: FailureModeConstraintInput): string[] {
  const subject = input.subjectName.trim() || "the subject";
  const modifiers = new Set(input.modifiers ?? []);
  const activeAction = isActiveActionFrame(input.selectedFrame);
  const lines: string[] = [];

  // ── Role binding for multi-character scenes ──────────────────────────────
  if (input.hasSecondaryCharacters) {
    // Soft, always-safe: everyone keeps their stated role.
    lines.push(
      `Keep each named character in their stated visual role; do not swap ${subject}'s role with a secondary character.`,
    );
    // Strong sole-agent — only when the frame reliably says the subject is the
    // active agent. Skipped for aftermath / symbolic / reaction frames so it
    // never fights an intended co-action or reaction scene.
    if (activeAction) {
      lines.push(`Only ${subject} performs the central action; secondary characters do not take it over.`);
    }
  }

  // ── Active-action emphasis (covers solo active facts too) ────────────────
  // Show the subject doing it, not posing afterward. Reliable-signal-gated.
  if (activeAction) {
    lines.push(`Show ${subject} actively performing the central action, not posing or passively present afterward.`);
  }

  // ── Soft, reusable packs keyed off modifiers we already store ─────────────
  // These prevent the common "focus drifts / link is unclear / subject becomes
  // a bystander" mistakes WITHOUT asserting sole-agent behavior.
  if (modifiers.has("crowd_reaction")) {
    lines.push(
      `Keep ${subject} the visual focal point; the crowd reacts to and supports ${subject} rather than replacing ${subject} as the subject of the image.`,
    );
  }
  if (modifiers.has("clear_causal_relationship")) {
    lines.push(
      `Show the cause and its effect together in the frame so the causal link is legible, not an unrelated aftermath.`,
    );
  }
  if (modifiers.has("subject_object_reversal")) {
    lines.push(
      `Realize ${subject} through the reversed role the scene requires; do not render ${subject} as a separate, uninvolved bystander beside the object.`,
    );
  }

  return lines;
}
