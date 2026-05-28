/**
 * Prompt-strategy guardrails — the rules that are constant across every
 * archetype and that the Phase 2 render-time generator will inherit verbatim
 * (subject-label rule + supporting-text policy).
 */

import type { PromptStrategyInput, GuardrailContext } from "./types";

/**
 * Per David's directive (Phase 2A addendum): images should NOT render meme
 * captions, full fact text, hashtags, watermarks, real logos, brand marks, or
 * long explanatory paragraphs — but MAY render concise supporting text,
 * numbers, symbols, equations, UI fragments, scoreboards, documents, keypad
 * digits, short labels, and signs WHEN they directly support the joke. The
 * preview generator carries this policy into its example prompts; the
 * frontend warning heuristic flags only the forbidden side.
 */
export const SUPPORTING_TEXT_POLICY = {
  forbidden: [
    "full meme captions",
    "full fact text",
    "hashtags",
    "watermarks",
    "real logos",
    "brand marks",
    "long explanatory paragraphs",
  ],
  allowed: [
    "concise supporting text",
    "numbers",
    "symbols",
    "equations",
    "UI fragments",
    "scoreboards",
    "documents",
    "keypad digits",
    "short labels",
    "signs",
  ],
  notes:
    "Only include readable text when it directly supports the joke; otherwise keep the scene text-free.",
} as const;

/**
 * The literal "David" subject label is reserved for previews whose sample
 * name is, literally, "David" (the brand's canonical example). Every other
 * sample name renders as the generic "the named subject" — so the model never
 * leans on a real person's name and Phase 2 render-time can substitute the
 * actual user.
 */
const CANONICAL_DAVID_NAME = "david";

export function buildGuardrailContext(input: PromptStrategyInput): GuardrailContext {
  const rawName = (input.sampleName ?? "David").trim();
  const useLiteral = rawName.toLowerCase() === CANONICAL_DAVID_NAME;
  return {
    useLiteralSubjectName: useLiteral,
    subjectLabel: useLiteral ? "David" : "the named subject",
    allowedSupportingText: SUPPORTING_TEXT_POLICY.allowed,
    forbiddenText: SUPPORTING_TEXT_POLICY.forbidden,
  };
}

/**
 * Text block appended to the visual-preview system prompt to enforce the
 * cross-cutting rules (subject label, supporting-text policy, face-preserve
 * for i2i). Phase 2 render-time will inject a similar block.
 */
export function guardrailSystemAddendum(ctx: GuardrailContext): string {
  return [
    "Subject naming:",
    `- Refer to the subject as "${ctx.subjectLabel}" in the example prompt text.`,
    ctx.useLiteralSubjectName
      ? "- The sample name is David, so the literal name may appear."
      : "- Do NOT use any real person's name; keep the subject label generic.",
    "",
    "Identity preservation:",
    "- The example i2i prompt MUST preserve the subject's face strongly.",
    "- Do NOT preserve physique — body type may change to fit the scene.",
    "",
    "Supporting-text policy (the image model may render text only when it directly supports the joke):",
    `- FORBIDDEN: ${ctx.forbiddenText.join(", ")}.`,
    `- ALLOWED when joke-relevant: ${ctx.allowedSupportingText.join(", ")}.`,
    `- ${SUPPORTING_TEXT_POLICY.notes}`,
  ].join("\n");
}

/**
 * Default guardrail-summary string used to populate
 * `visualPromptPreview.promptGuardrailsPreview` when the model omits it.
 */
export function defaultPromptGuardrailsPreview(ctx: GuardrailContext): string {
  return [
    `Subject: ${ctx.subjectLabel}. Preserve face; physique may change.`,
    `Forbidden readable text: ${ctx.forbiddenText.join(", ")}.`,
    `Allowed when joke-relevant: ${ctx.allowedSupportingText.join(", ")}.`,
  ].join(" ");
}
