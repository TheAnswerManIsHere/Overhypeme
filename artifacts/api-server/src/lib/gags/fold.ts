/**
 * @purpose The fold, as a pure function: turns one stored gag version's eleven "More art direction" fields into sentences of its scene, or says why a moderator must do it instead.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, E (David, Q1: 1: the eleven
 * controls leave the screen and the pipeline, live values folded into scene
 * text first). Deterministic on purpose: the text a moderator typed is moved,
 * never reworded by a model, so a converted version says what it said before
 * and the conversion can be read and reversed.
 *
 * - Everything meaningful lands in the scene: required details, composition
 *   guidance, extra prompt details and a subject depiction description become
 *   scene sentences; forbidden details and do-not-render additions become
 *   "No ..." sentences; every role assignment, the subject's own and a silent
 *   character's included, becomes a sentence saying who does what.
 * - Policy overrides: an allow-mode override's guidance becomes a scene
 *   sentence. A violence override of soften or suppress, or one whose
 *   intensity is not the default, and a supporting-text override of forbid or
 *   require, change what the picture shows, so the version is listed.
 * - A subject depiction mode other than "use the AI plan" or "a normal person"
 *   with no description to carry it is listed: the mode alone would be lost.
 * - Moderator intent and notes never reached the engine: they are dropped from
 *   the content and kept in the archived original only.
 * - A version that would not fit the prompt budget after the fold is listed;
 *   nothing is truncated.
 *
 * A listed version is not converted at all: its moderator edits it through
 * the ordinary pending change and render approval.
 */
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, hasExtraArtDirection, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { validateVisualStrategyOverridePersistence } from "../imagePrompt/promptBudget";

/** The default violence intensity: "allow" at it is no override at all (renderPolicyEnums.ts). */
const DEFAULT_VIOLENCE_INTENSITY = "strong";
/** Depiction modes the scene already implies; any other needs its description to survive. */
const PLAIN_DEPICTION_MODES = new Set(["use_ai_plan", "normal_human"]);

export type FoldOutcome =
  | { kind: "nothing" }
  | { kind: "converted"; content: VisualPromptStrategyOverride; moved: string[] }
  | { kind: "listed"; reasons: string[] };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** One sentence: trimmed, ending in a full stop unless it already ends a sentence. */
const sentence = (s: string) => {
  const t = clean(s);
  return /[.!?…]["'’”)]?$/.test(t) ? t : `${t}.`;
};
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
/** "a red hat" → "No a red hat." reads wrongly; an item already phrased as a prohibition keeps its words. */
const negated = (s: string) => {
  const t = clean(s);
  return sentence(/^(no|not|never|don['’]t|do not|avoid|without)\b/i.test(t) ? t : `No ${lowerFirst(t)}`);
};
const nonEmpty = (xs: readonly string[]) => xs.map(clean).filter(Boolean);

/** Fold one version. Pure: the caller stores the result and the original. */
export function foldGagContent(content: VisualPromptStrategyOverride): FoldOutcome {
  if (!hasExtraArtDirection(content)) return { kind: "nothing" };

  const reasons: string[] = [];
  const v = content.violencePolicyOverride;
  if (v && (v.mode !== "allow" || v.intensity !== DEFAULT_VIOLENCE_INTENSITY)) {
    reasons.push(`violence is set to ${v.mode} at ${v.intensity}, which changes what the picture shows`);
  }
  const t = content.supportingTextPolicyOverride;
  if (t && t.mode !== "allow") {
    reasons.push(`supporting text is set to ${t.mode}, which changes what the picture shows`);
  }
  const d = content.subjectRealizationOverride;
  if (d && !PLAIN_DEPICTION_MODES.has(d.mode) && !clean(d.description)) {
    reasons.push(`the subject's depiction is set to ${d.mode.replace(/_/g, " ")} with no description to carry it into the scene`);
  }
  if (reasons.length) return { kind: "listed", reasons };

  const added: string[] = [];
  const moved: string[] = [];
  if (d && clean(d.description)) {
    added.push(sentence(d.description));
    moved.push("subject depiction");
  }
  for (const rb of content.roleBindings) {
    const who = clean(rb.entity);
    const role = clean(rb.visualRole);
    if (!who || !role) continue;
    added.push(sentence(`${who.toLowerCase() === "subject" ? "{NAME}" : who}: ${role}`));
  }
  if (content.roleBindings.length) moved.push("scene role assignments");
  const required = nonEmpty(content.requiredVisualDetails);
  if (required.length) {
    added.push(sentence(`Also in the picture: ${required.join("; ")}`));
    moved.push("required details");
  }
  const composition = nonEmpty(content.compositionGuidance);
  if (composition.length) {
    added.push(sentence(`Composition: ${composition.join("; ")}`));
    moved.push("composition guidance");
  }
  for (const extra of nonEmpty(content.styleAgnosticPromptAdditions)) added.push(sentence(extra));
  if (content.styleAgnosticPromptAdditions.length) moved.push("extra prompt details");
  for (const no of [...nonEmpty(content.forbiddenVisualDetails), ...nonEmpty(content.negativePromptAdditions)]) added.push(negated(no));
  if (content.forbiddenVisualDetails.length) moved.push("forbidden details");
  if (content.negativePromptAdditions.length) moved.push("do-not-render additions");
  if (v?.guidance && clean(v.guidance)) {
    added.push(sentence(v.guidance));
    moved.push("violence guidance");
  }
  if (t?.guidance && clean(t.guidance)) {
    added.push(sentence(t.guidance));
    moved.push("supporting-text guidance");
  }
  if (content.moderatorIntent?.trim() || content.notesForModerator?.trim()) moved.push("moderator intent and notes (archived only)");

  const scene = [clean(content.coreSceneOverride ?? ""), ...added].filter(Boolean).join(" ");
  const folded: VisualPromptStrategyOverride = {
    ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
    version: content.version,
    coreSceneOverride: scene,
    bubbles: content.bubbles,
    ...(content.updatedBy ? { updatedBy: content.updatedBy } : {}),
    ...(content.updatedAt ? { updatedAt: content.updatedAt } : {}),
  };
  // The cast was read from the old scene; the job reads it again from this one.
  const budget = validateVisualStrategyOverridePersistence(folded);
  if (!budget.ok) {
    return { kind: "listed", reasons: [`the scene would be too long once the extra fields join it (${budget.errors.map((e) => e.message).join(" ")})`] };
  }
  return { kind: "converted", content: folded, moved };
}
