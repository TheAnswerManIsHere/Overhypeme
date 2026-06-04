/**
 * Nano Banana 2 prompt compilers (Phase 2).
 *
 * Strategy: the deterministic compiler ASSEMBLES the final engine prompt from
 * the structured visualPlan + runtime inputs — the LLM's free-text
 * `compiledPrompt.prompt` is one high-value input, not the source of truth.
 * The generator's rich reasoning (key visual elements, composition, supporting-
 * text policy, semantic-entity + cultural-reference resolutions, fact modifiers)
 * is turned into explicit natural-language directives and folded in, de-duped
 * against what the prose already says, then budgeted to the engine char cap.
 *
 * Sections carry a priority. Required sections (mode preamble, identity guards,
 * core mechanic, semantic/cultural resolutions, supporting-text rule) always
 * survive; the prose, key-element gap-fill, composition, modifiers and style are
 * included while budget allows and compressed/dropped otherwise. Anything
 * dropped or compressed is recorded in `engineNotes` for admin visibility.
 *
 * Output `imagePrompt` mirrors `prompt` and is what `buildEngineInput` reads.
 * For i2i variants, `referenceImageUrl` is also returned.
 */

import type {
  VisualPlan,
  CompiledPrompt,
  ImagePromptGenerationInput,
} from "@workspace/api-zod";
import type { CompiledImagePrompt, PromptSection } from "../types";
import { modifierDirectives } from "../modifierDirectives";
import { renderPersonalized } from "../../renderCanonical";

const MAX_PROMPT_CHARS = 4000;

interface CompileArgs {
  visualPlan: VisualPlan;
  compiledPrompt: CompiledPrompt;
  input: ImagePromptGenerationInput;
  /**
   * Identity used to render the fact text for this generation. Used as a final
   * gate to resolve any residual identity tokens ({NAME}/{SUBJ}/…) the LLM
   * echoed from the fact template (e.g. a semantic entity whose surfaceText is
   * literally "{NAME}") — a template token must NEVER reach the image engine.
   * When omitted (some unit tests), no token rendering is applied.
   */
  renderedSubject?: { name: string; pronouns: string | null };
}

/**
 * Resolve any leftover identity tokens in a section's text using the same
 * identity that rendered the fact text. No-op when no subject is supplied.
 */
function renderIdentityTokens(text: string, subject?: CompileArgs["renderedSubject"]): string {
  if (!subject || !text) return text;
  return renderPersonalized(text, subject.name, subject.pronouns);
}

const HUMAN_I2I_PREAMBLE =
  "Image-to-image edit using the reference image as the person's facial identity source. Preserve the reference person's recognizable face.";
const NONHUMAN_I2I_PREAMBLE =
  "Image-to-image edit using the reference image as the visual identity source for the uploaded subject. The uploaded subject visually represents the named subject in the fact. Preserve the uploaded subject's recognizable visual identity. Do not replace the subject with a human.";
const T2I_PREAMBLE =
  "Text-to-image generation. No reference identity is being preserved. Generate a protagonist matching fallback subject gender/profile guidance.";

// ─── Text utilities ───────────────────────────────────────────────────────

/** Split a prompt blob into trimmed sentences, keeping terminal punctuation. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (matches) return matches.map((s) => s.trim()).filter(Boolean);
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeSentence(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Boundary-aware containment check. Short phrases (<8 chars, e.g. "earth")
 * must match on word boundaries so "earth" is not considered present inside
 * "earthquake"; longer phrases use substring matching.
 */
function containsMeaningfulPhrase(haystack: string, phrase: string): boolean {
  const h = haystack.toLowerCase();
  const p = phrase.trim().toLowerCase();
  if (!p) return true;
  if (p.length < 8) {
    return new RegExp(`\\b${escapeRegExp(p)}\\b`).test(h);
  }
  return h.includes(p);
}

/** Drop sentences from `text` already present (normalized) in `assembled`. */
function dedupeSentences(text: string, assembled: string): string {
  const present = new Set(splitSentences(assembled).map(normalizeSentence));
  const kept = splitSentences(text).filter((s) => !present.has(normalizeSentence(s)));
  return kept.join(" ").trim();
}

/** Keep leading whole sentences that fit `budget`; hard-cut as a last resort. */
function fitSentences(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  let out = "";
  for (const s of splitSentences(text)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > budget) break;
    out = next;
  }
  if (!out) {
    const cut = Math.max(0, budget - 1);
    return `${text.slice(0, cut).trimEnd()}…`;
  }
  return out;
}

// ─── visualPlan → directive composers ─────────────────────────────────────

/** Ensure key visual elements the prose omitted are explicitly requested. */
function composeKeyElementsDirective(vp: VisualPlan, haystack: string): string {
  const missing = vp.keyVisualElements
    .map((e) => e.trim())
    .filter(Boolean)
    .filter((e) => !containsMeaningfulPhrase(haystack, e));
  if (!missing.length) return "";
  return `Ensure these elements are clearly visible: ${missing.join("; ")}.`;
}

/** Framing + camera (each if absent) + caption-overlay negative space. */
function composeCompositionDirective(vp: VisualPlan, haystack: string): string {
  const c = vp.composition;
  const parts: string[] = [];
  if (c.subjectFraming && !containsMeaningfulPhrase(haystack, c.subjectFraming)) parts.push(c.subjectFraming.trim());
  if (c.cameraStyle && !containsMeaningfulPhrase(haystack, c.cameraStyle)) parts.push(c.cameraStyle.trim());
  let out = parts.length ? `Composition: ${parts.join("; ")}.` : "";
  if (["top", "bottom", "left", "right"].includes(c.negativeSpace)) {
    const ns = `Leave clean negative space at the ${c.negativeSpace} of the frame for the caption overlay.`;
    if (!containsMeaningfulPhrase(haystack, "negative space")) out = out ? `${out} ${ns}` : ns;
  }
  return out.trim();
}

/** The supporting-text rule. Always emitted (required). */
function composeSupportingTextDirective(vp: VisualPlan): string {
  const pol = vp.supportingTextPolicy;
  if (pol.allowSupportingText && pol.supportingTextElements.length > 0) {
    const items = pol.supportingTextElements
      .map((e) => `"${e.content.trim()}"${e.placement.trim() ? ` (${e.placement.trim()})` : ""}`)
      .join("; ");
    return `Render only this short in-image text: ${items}; keep all other surfaces free of text, captions, watermarks, and logos.`;
  }
  return "Keep all surfaces free of readable text, captions, watermarks, logos, and brand marks.";
}

/** Lock capitalization-aware semantic referents into the scene. */
function composeSemanticDirective(vp: VisualPlan, haystack: string): string {
  const items = (vp.semanticEntitiesUsed ?? [])
    .filter((e) => e.surfaceText.trim() && e.visualReferentUsed.trim())
    .filter((e) => !containsMeaningfulPhrase(haystack, e.visualReferentUsed))
    .map((e) => `"${e.surfaceText.trim()}" means ${e.visualReferentUsed.trim()}`);
  if (!items.length) return "";
  return `Interpret these terms exactly: ${items.join("; ")}.`;
}

/** Turn consumed cultural references into explicit, logo-free directives. */
function composeCulturalDirective(vp: VisualPlan, haystack: string): string {
  const items = (vp.culturalReferencesUsed ?? [])
    .filter((r) => r.sourcePhrase.trim() && r.visualImplicationUsed.trim())
    .filter((r) => !containsMeaningfulPhrase(haystack, r.visualImplicationUsed))
    .map((r) => `treat "${r.sourcePhrase.trim()}" as ${(r.canonicalReferenceUsed.trim() || r.sourcePhrase.trim())}, shown via ${r.visualImplicationUsed.trim()}`);
  if (!items.length) return "";
  return `Cultural references: ${items.join("; ")}. Avoid real logos or brand marks.`;
}

/** High-impact fact modifiers the prose did not already cover. */
function composeModifierDirective(input: ImagePromptGenerationInput, haystack: string): string {
  const directives = modifierDirectives(input.enrichment.modifiers ?? [])
    .filter((d) => {
      // De-dupe on the directive's leading clause (before the first comma/dash).
      const lead = d.split(/[,.—-]/)[0]?.trim() ?? d;
      return lead.length > 6 ? !containsMeaningfulPhrase(haystack, lead) : true;
    });
  return directives.join(" ").trim();
}

// ─── Section assembly ──────────────────────────────────────────────────────

type Priority = PromptSection["priority"];

interface Section {
  id: string;
  label: string;
  text: string;
  priority: Priority;
  compressible?: boolean;
}

/**
 * Assemble sections (already in reading order) into a single prompt under the
 * char budget. Required sections always survive (a final hard-truncate handles
 * the pathological case where they alone overflow). Optional sections are
 * included while budget allows; compressible ones are trimmed to fit before
 * being dropped. Drops/compressions are appended to `notes`.
 *
 * Returns the assembled prompt plus a per-section `breakdown` recording how
 * each component fared (included / compressed / dropped / deduped / empty) so
 * admins can see exactly how the final prompt was computed from its parts.
 */
function assembleSections(
  sections: Section[],
  notes: string[],
): { prompt: string; breakdown: PromptSection[] } {
  let assembled = "";
  const breakdown: PromptSection[] = [];
  const record = (s: Section, status: PromptSection["status"], text: string, rawText: string) =>
    breakdown.push({ id: s.id, label: s.label, priority: s.priority, status, text, rawText });

  for (const section of sections) {
    const raw = section.text.trim();
    if (!raw) {
      record(section, "empty", "", "");
      continue;
    }
    const deduped = dedupeSentences(raw, assembled);
    if (!deduped) {
      record(section, "deduped", "", raw);
      continue;
    }
    const candidate = assembled ? `${assembled} ${deduped}` : deduped;
    if (candidate.length <= MAX_PROMPT_CHARS) {
      assembled = candidate;
      record(section, "included", deduped, raw);
      continue;
    }
    if (section.priority === "required") {
      assembled = candidate; // keep; final truncate will clamp if needed
      record(section, "included", deduped, raw);
      continue;
    }
    if (section.compressible) {
      const remaining = MAX_PROMPT_CHARS - assembled.length - 1;
      const fitted = fitSentences(deduped, remaining);
      if (fitted) {
        assembled = assembled ? `${assembled} ${fitted}` : fitted;
        notes.push(`Compressed ${section.id} to fit the engine prompt budget.`);
        record(section, "compressed", fitted, raw);
        continue;
      }
    }
    notes.push(`Dropped ${section.id} (over the engine prompt budget).`);
    record(section, "dropped", "", raw);
  }

  let prompt = assembled.trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    notes.push("Hard-truncated required content to the engine prompt budget.");
    prompt = fitSentences(prompt, MAX_PROMPT_CHARS);
  }
  return { prompt, breakdown };
}

interface ModeContext {
  /** Mode preamble (required, leads the prompt). */
  preamble: string;
  /** Extra required clauses for this mode (identity guards, fallback gender). */
  requiredClauses: string[];
  withReferenceUrl: boolean;
}

function compile(args: CompileArgs, mode: ModeContext): CompiledImagePrompt {
  const { visualPlan: vp, input } = args;
  const notes: string[] = [];

  // Required core comes first so it always survives and so the prose + directive
  // composers de-dupe against it (not the other way around). The visualGoal and
  // visualApproach are kept as separate sections (rather than one opaque "core
  // mechanic" blob) so the debug breakdown shows each taxonomy-derived part.
  const clauses = mode.requiredClauses.filter(Boolean).join(" ");
  const visualGoal = vp.visualGoal?.trim() ?? "";
  const visualApproach = vp.visualApproach?.trim() ?? "";
  const coreMechanic = [visualGoal, visualApproach].filter(Boolean).join(" ");
  const requiredHead = [mode.preamble, clauses, coreMechanic].filter(Boolean).join(" ");

  const semantic = composeSemanticDirective(vp, requiredHead);
  const cultural = composeCulturalDirective(vp, `${requiredHead} ${semantic}`);
  const supportingText = composeSupportingTextDirective(vp);
  // Haystack for the prose-dependent (high-priority) composers: everything
  // required, so directives only fill what the prose itself doesn't cover.
  const requiredAll = [requiredHead, semantic, cultural, supportingText].filter(Boolean).join(" ");
  const prose = args.compiledPrompt.prompt.trim();
  const proseHaystack = `${requiredAll} ${prose}`;

  const keyElements = composeKeyElementsDirective(vp, proseHaystack);
  const composition = composeCompositionDirective(vp, proseHaystack);
  const modifiers = composeModifierDirective(input, proseHaystack);
  const style = input.stylePrompt?.trim() ?? "";

  const rawSections: Section[] = [
    { id: "mode_preamble", label: "Mode preamble (operational lead)", text: mode.preamble, priority: "required" },
    { id: "required_clauses", label: "Required mode clauses", text: clauses, priority: "required" },
    { id: "visual_goal", label: "Visual goal", text: visualGoal, priority: "required" },
    { id: "visual_approach", label: "Visual approach", text: visualApproach, priority: "required" },
    { id: "semantic_referents", label: "Semantic referents", text: semantic, priority: "required" },
    { id: "cultural_references", label: "Cultural references", text: cultural, priority: "required" },
    { id: "supporting_text_rule", label: "Supporting-text rule", text: supportingText, priority: "required" },
    { id: "prose", label: "LLM prose (compiledPrompt.prompt)", text: prose, priority: "high", compressible: true },
    { id: "key_visual_elements", label: "Key visual elements (gap-fill)", text: keyElements, priority: "high", compressible: true },
    { id: "composition", label: "Composition", text: composition, priority: "high" },
    { id: "modifier_directives", label: "Modifier directives", text: modifiers, priority: "medium", compressible: true },
    { id: "style", label: "Style suffix", text: style, priority: "medium", compressible: true },
  ];

  // Final identity gate: resolve any residual {NAME}/{SUBJ}/… tokens the LLM
  // echoed (e.g. from a semantic entity whose surfaceText is "{NAME}") BEFORE
  // assembly, so neither the engine prompt nor the debug breakdown ever carries
  // a raw template token.
  const sections = rawSections.map((s) => ({ ...s, text: renderIdentityTokens(s.text, args.renderedSubject) }));

  const { prompt: finalPrompt, breakdown } = assembleSections(sections, notes);

  const out: CompiledImagePrompt = {
    prompt: finalPrompt,
    imagePrompt: finalPrompt,
    promptBreakdown: breakdown,
  };

  // Nano Banana 2 has no negative-prompt parameter; the validator already
  // forces negativePrompt empty, but never forward one even if present.
  const engineNotesParts: string[] = [];
  if (args.compiledPrompt.engineNotes && args.compiledPrompt.engineNotes.trim()) {
    engineNotesParts.push(args.compiledPrompt.engineNotes.trim());
  }
  if (notes.length) engineNotesParts.push(notes.join(" "));
  if (engineNotesParts.length) out.engineNotes = engineNotesParts.join(" ");

  if (mode.withReferenceUrl && input.referenceImageUrl) {
    out.referenceImageUrl = input.referenceImageUrl;
  }
  return out;
}

// ─── Per-mode entry points ─────────────────────────────────────────────────

export function compileNanoBanana2HumanI2I(args: CompileArgs): CompiledImagePrompt {
  return compile(args, {
    preamble: HUMAN_I2I_PREAMBLE,
    requiredClauses: [],
    withReferenceUrl: true,
  });
}

export function compileNanoBanana2NonhumanI2I(args: CompileArgs): CompiledImagePrompt {
  // The preamble (added first, always) already carries the required
  // "Do not replace the subject with a human." guard, so no extra clause is
  // needed — and adding a paraphrase would duplicate the instruction.
  return compile(args, {
    preamble: NONHUMAN_I2I_PREAMBLE,
    requiredClauses: [],
    withReferenceUrl: true,
  });
}

export function compileNanoBanana2T2I(args: CompileArgs): CompiledImagePrompt {
  const gender = args.input.renderControls.fallbackSubjectGender;
  return compile(args, {
    preamble: T2I_PREAMBLE,
    requiredClauses: gender ? [`Generate a ${gender} protagonist.`] : [],
    withReferenceUrl: false,
  });
}

/**
 * Dispatch by `input.subjectRenderMode`. Throws on unknown mode (shouldn't
 * happen if the input is validated upstream).
 */
export function compileForSubjectRenderMode(args: CompileArgs): CompiledImagePrompt {
  switch (args.input.subjectRenderMode) {
    case "human_identity_i2i":
      return compileNanoBanana2HumanI2I(args);
    case "nonhuman_subject_i2i":
      return compileNanoBanana2NonhumanI2I(args);
    case "t2i_fallback":
      return compileNanoBanana2T2I(args);
    default: {
      const exhaustive: never = args.input.subjectRenderMode;
      throw new Error(`Unknown subjectRenderMode: ${exhaustive}`);
    }
  }
}
