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
  RenderPolicy,
} from "@workspace/api-zod";
import { DEFAULT_RENDER_POLICY, MANDATORY_FORBIDDEN_TEXT_TYPES } from "@workspace/api-zod";
import type {
  CompiledImagePrompt,
  PromptSection,
  RemovedProseReason,
  RemovedProseSentence,
  PromptWarning,
} from "../types";
import { modifierDirectives } from "../modifierDirectives";
import { failureModeConstraints, isActiveActionFrame } from "./failureModeConstraints";
import { renderPersonalized, hasUnresolvedFactTokens } from "../../renderCanonical";

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
  "Image-to-image edit using the reference image as the person's identity source. Preserve the reference person's recognizable identity and likeness — facial features and distinctive characteristics. Allow apparent age, body proportions, hair, clothing, and life stage to transform when the scene requires it, while keeping the same recognizable person.";
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

/**
 * The narrow OVERLAY-text exclusion, derived from MANDATORY_FORBIDDEN_TEXT_TYPES.
 * Always emitted: overlay/caption text (the meme caption, fact text, hashtags,
 * watermarks, logos, brand marks) is composited separately and must never be
 * baked into the image. This is NOT a blanket "no readable text" ban — in-world
 * scene text is governed by the render policy below and is fully compatible with
 * this line.
 */
const OVERLAY_TEXT_EXCLUSION = `Do not bake overlay or caption text into the image: no ${MANDATORY_FORBIDDEN_TEXT_TYPES.join(", ")}.`;

/**
 * The supporting-text directive. Always emits the narrow overlay-text exclusion;
 * then, depending on the render policy and the planner-selected scene text,
 * governs whether IN-WORLD readable text (signs, TV titles, scoreboards,
 * documents, labels) is rendered, required, or avoided.
 *
 * Phase 1 (R1): in "allow" mode the compiler stays SILENT about in-world text
 * unless the planner picked explicit `supportingTextElements` or the policy
 * carries intentional `guidance` — the absence of a ban is enough, and we do not
 * encourage unnecessary text. "require"/"forbid" always emit their line.
 */
function composeSupportingTextDirective(vp: VisualPlan, policy: RenderPolicy["supportingText"]): string {
  const lines: string[] = [OVERLAY_TEXT_EXCLUSION];
  const pol = vp.supportingTextPolicy;
  const guidance = policy.guidance?.trim() ?? "";

  // Planner picked concrete in-world strings for this render → render them
  // (regardless of mode; the planner's scene content is the strongest signal).
  if (pol.allowSupportingText && pol.supportingTextElements.length > 0) {
    const items = pol.supportingTextElements
      .map((e) => `"${e.content.trim()}"${e.placement.trim() ? ` (${e.placement.trim()})` : ""}`)
      .join("; ");
    lines.push(`Render this in-scene text clearly: ${items}.`);
    return lines.join(" ");
  }

  if (policy.mode === "require") {
    lines.push(
      guidance
        ? `SUPPORTING TEXT: Readable in-scene text is required in this scene. Show it clearly: ${guidance}.`
        : "SUPPORTING TEXT: Readable in-scene text is required in this scene; show it clearly.",
    );
  } else if (policy.mode === "forbid") {
    lines.push("Avoid readable in-scene text unless required by a higher-priority instruction.");
  } else if (guidance) {
    // "allow" with intentional guidance → emit it; otherwise stay silent (R1).
    lines.push(guidance);
  }

  return lines.join(" ");
}

// ─── Violence policy ────────────────────────────────────────────────────────

/** Taxonomy modifiers whose presence implies the fact is violence-relevant. */
const VIOLENCE_RELEVANT_MODIFIERS = new Set([
  "cinematic_aftermath",
  "projectile_impact_power",
  "action_comedy",
  // The softening flags themselves imply a violent fact (a moderator only adds
  // them when there is violence to soften).
  "avoid_gore",
  "non_graphic_action",
  "avoid_weapons_focus",
  "avoid_gross_literalization",
]);

/** Per-fact softening modifiers that, under "allow", let the modifier directive
 *  govern instead of the permission line (so output never contradicts itself). */
const VIOLENCE_SOFTENING_MODIFIERS = new Set([
  "avoid_gore",
  "non_graphic_action",
  "avoid_weapons_focus",
  "avoid_gross_literalization",
]);

const VIOLENCE_LEXICON_RE =
  /\b(?:kill\w*|murder\w*|slay\w*|grenade|bomb\w*|explod\w*|explosion|detonat\w*|weapon\w*|gun\w*|rifle|pistol|knife|knives|sword|blade|blood\w*|bloody|gore|combat|battle|war|fight\w*|punch\w*|stab\w*|shoot\w*|shot|corpse\w*|bodies|dead\b|death\w*|die[ds]?\b|destroy\w*|destruction|wreckage|injur\w*|wound\w*|carnage|massacre|behead\w*|decapitat\w*)\b/i;

/** Does the fact/plan indicate violence/death/weapons/combat/destruction so the
 *  "allow" permission line is warranted? Scans modifiers + violent lexicon over
 *  the fact text and the concrete visual fields. */
function isViolenceRelevant(input: ImagePromptGenerationInput, vp: VisualPlan): boolean {
  const modifiers = input.enrichment.modifiers ?? [];
  if (modifiers.some((m) => VIOLENCE_RELEVANT_MODIFIERS.has(m))) return true;
  const haystack = [
    input.factText,
    vp.coreScene,
    ...(vp.keyVisualElements ?? []),
    ...(vp.subjectDetails ?? []),
    ...(vp.environment ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  return VIOLENCE_LEXICON_RE.test(haystack);
}

const VIOLENCE_ALLOW_LINE =
  "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore.";

/**
 * The violence directive. Precedence (R5): an explicit "soften"/"suppress" mode
 * wins; otherwise, under the default "allow", a per-fact softening modifier wins
 * over the permission line (the modifier's own softening directive governs); and
 * the permission line is only emitted when the fact is violence-relevant or the
 * policy carries intentional guidance. Never emits "graphic"-flavored language.
 */
function composeViolenceDirective(
  policy: RenderPolicy["violence"],
  opts: { relevant: boolean; hasSofteningModifier: boolean },
): string {
  const guidance = policy.guidance?.trim() ?? "";
  if (policy.mode === "suppress") {
    return "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage.";
  }
  if (policy.mode === "soften") {
    return "Soften violent consequences; avoid graphic injury and visible death unless explicitly required by a higher-priority instruction.";
  }
  // mode === "allow"
  if (guidance) return guidance;
  // A per-fact softening modifier already emits its own softening directive — do
  // not also assert the permission line (avoids "show bodies" + "non-graphic").
  if (opts.hasSofteningModifier) return "";
  return opts.relevant ? VIOLENCE_ALLOW_LINE : "";
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

// ─── Reference interpretation (positive role binding) ───────────────────────

/**
 * Build the deterministic REFERENCE INTERPRETATION block: a concise, POSITIVE
 * statement of who each entity is in the scene — the subject's active role plus
 * one short clause per secondary character — so the engine binds roles before
 * the visual prose begins (and a secondary character can't drift into the
 * subject's central action). Negatives live in STRICT CONSTRAINTS, not here.
 *
 * Kept terse on purpose: one short subject clause + one short clause per
 * secondary character. The subject clause is included only when it is
 * meaningful — there are secondary characters to contrast against, or the frame
 * is an active-action frame where asserting "the subject is the one doing it"
 * matters. Returns "" when there is nothing meaningful to bind.
 */
function composeReferenceInterpretation(opts: {
  subjectName: string;
  roleInScene: string;
  secondaryCharacters: ReadonlyArray<{ label: string; visualRole: string }>;
  includeSubjectRole: boolean;
  haystack: string;
}): string {
  const subject = opts.subjectName.trim() || "the reference subject";
  const clauses: string[] = [];

  const role = opts.roleInScene.trim().replace(/[.!?]+$/, "");
  if (opts.includeSubjectRole && role && !containsMeaningfulPhrase(opts.haystack, role)) {
    clauses.push(`${subject} is ${role}`);
  }

  for (const c of opts.secondaryCharacters) {
    const label = c.label.trim().replace(/[.!?]+$/, "");
    const visualRole = c.visualRole.trim().replace(/[.!?]+$/, "");
    if (!label || !visualRole) continue;
    // Skip a secondary clause the prose already states in full.
    if (containsMeaningfulPhrase(opts.haystack, visualRole)) continue;
    clauses.push(`${label} is ${visualRole}`);
  }

  if (!clauses.length) return "";
  return clauses.map((c) => `${c}.`).join(" ");
}

// ─── Subject binding (identity ⊗ transformed life stage) ────────────────────

/** Taxonomy modifiers that mean "render the subject at a transformed age". */
const AGE_TRANSFORM_MODIFIERS = new Set([
  "baby_child_version",
  "infant_version",
  "child_version",
  "older_self_version",
  "age_transform",
]);

/** A default transformed-state noun when the LLM didn't supply one but an age
 *  modifier is present. Kept generic; the LLM's `targetState` is preferred. */
function ageModifierTargetState(modifiers: Set<string>): string | null {
  if (modifiers.has("infant_version")) return "a baby/infant";
  if (modifiers.has("baby_child_version")) return "a baby/young child";
  if (modifiers.has("child_version")) return "a young child";
  if (modifiers.has("older_self_version")) return "a much older version of themselves";
  if (modifiers.has("age_transform")) return "the age and life stage the fact implies";
  return null;
}

/** Strip a leading article so a noun reads cleanly inside a "do not add a
 *  separate, generic <noun>" clause. "a baby/infant" → "baby/infant". */
function bareNoun(s: string): string {
  return s.trim().replace(/^(?:an?|the)\s+/i, "").trim();
}

/**
 * Build the deterministic SUBJECT BINDING block. This is the fix for the core
 * failure: it fuses the reference identity, the transformed life stage, and the
 * single-instance constraint into ONE entity, so the engine de-ages/ages the
 * SAME person instead of pairing an adult with a separate baby (or cloning the
 * subject). Emitted when an age transform applies OR a duplicate-subject guard
 * is requested. Returns "" when neither applies.
 */
function composeSubjectBinding(opts: {
  name: string;
  applies: boolean;
  targetState: string;
  avoidDuplicate: boolean;
  humanIdentity: boolean;
}): string {
  const subject = opts.name || "the reference person";
  const lines: string[] = [];
  // The person/adult de-aging language only makes sense for a human identity
  // subject. Non-human subjects get their age handling from the modifier
  // directives + the non-human identity preamble instead.
  if (opts.humanIdentity && opts.applies && opts.targetState.trim()) {
    const ts = opts.targetState.trim();
    const bare = bareNoun(ts);
    lines.push(
      `The reference person is ${subject}.`,
      `${subject} is ${ts} in this scene.`,
      `Render exactly one ${subject}.`,
      `The transformed ${bare} IS ${subject} — the same person de-aged or aged, not a second person.`,
    );
  } else if (opts.avoidDuplicate) {
    lines.push(
      `The reference person is ${subject}.`,
      `Render exactly one ${subject} — a single instance.`,
    );
  }
  return lines.join(" ");
}

/**
 * The negative anti-entity-split guards that pair with SUBJECT BINDING. Kept in
 * STRICT CONSTRAINTS so the positive binding and the "do not" guards don't
 * duplicate each other. Returns "" when no transform/dup case applies.
 */
function composeAntiSplitConstraints(opts: {
  name: string;
  applies: boolean;
  targetState: string;
  avoidDuplicate: boolean;
  humanIdentity: boolean;
}): string {
  const subject = opts.name || "the reference person";
  const lines: string[] = [];
  if (opts.humanIdentity && opts.applies && opts.targetState.trim()) {
    const bare = bareNoun(opts.targetState);
    lines.push(
      `Do not render the adult reference person separately.`,
      `Do not add a second, generic ${bare}.`,
      `Do not show both an adult ${subject} and a ${bare} in the same frame.`,
    );
  } else if (opts.avoidDuplicate) {
    lines.push(`Do not duplicate, clone, or mirror ${subject} anywhere in the frame.`);
  }
  return lines.join(" ");
}

// ─── Intent-language scrub ──────────────────────────────────────────────────

/**
 * Phrases that EXPLAIN the joke rather than DESCRIBE the picture. Image-edit
 * models render concrete nouns, not authorial intent, so this commentary just
 * dilutes the visual spec. We strip it deterministically from every visual
 * field before it reaches the engine prompt.
 */
const INTENT_LANGUAGE_RE =
  /\b(?:show(?:cas|ing|s|case)?|highlight\w*|emphasiz\w*|underscor\w*|conveys?|conveying|capturing|creat\w*|enhanc\w*|reinforc\w*|playing up|leaning into)\b[^,;.]*\b(?:absurd\w*|humor\w*|comed\w*|hilar\w*|funny|iron(?:y|ic)|ridiculous\w*|whimsy|whimsical|unexpected\b|role[\s-]?reversal|contrast)\b|\b(?:humorous|comedic|comic)\s+(?:contrast|effect|tone|juxtaposition)\b|\bthe\s+(?:absurdity|humor|irony|comedy)\s+of\b|\bsense\s+of\s+(?:absurdity|humor|irony)\b/i;

/**
 * Remove authorial-intent clauses/sentences from a visual text. Operates
 * clause-by-clause (splitting on commas/semicolons) so a sentence like "David
 * grips the wheel, showcasing the absurdity of the situation" keeps the
 * concrete clause and drops only the commentary. A sentence that is entirely
 * commentary is dropped whole.
 */
function scrubIntentLanguage(text: string): string {
  if (!text.trim()) return "";
  const keptSentences: string[] = [];
  for (const sentence of splitSentences(text)) {
    const term = sentence.match(/[.!?]+$/)?.[0] ?? "";
    const core = term ? sentence.slice(0, -term.length) : sentence;
    const clauses = core.split(/\s*[,;]\s*/).filter(Boolean);
    const keptClauses = clauses.filter((c) => !INTENT_LANGUAGE_RE.test(c));
    if (!keptClauses.length) continue; // whole sentence was commentary
    const rebuilt = keptClauses.join(", ") + (term || ".");
    keptSentences.push(rebuilt.trim());
  }
  return keptSentences.join(" ").trim();
}

// ─── Labeled-section formatting ─────────────────────────────────────────────

/** Prefix a non-empty body with its contract header; "" stays "". */
function labeled(header: string, body: string): string {
  const b = body.trim();
  return b ? `${header}: ${b}` : "";
}

/**
 * Join a list of concrete visual entries into one sentence-terminated body,
 * dropping entries already named in `haystack` (so SUBJECT DETAILS / ENVIRONMENT
 * don't repeat what CORE SCENE already said). Each entry becomes its own clause.
 */
function composeListBody(entries: readonly string[], haystack: string): string {
  const kept = entries
    .map((e) => scrubIntentLanguage(e).trim().replace(/[.!?]+$/, ""))
    .filter(Boolean)
    .filter((e) => !containsMeaningfulPhrase(haystack, e));
  if (!kept.length) return "";
  return `${kept.join("; ")}.`;
}

// ─── Planner-prose sanitation ───────────────────────────────────────────────

/**
 * Decide whether a single planner-prose sentence must be dropped because it
 * authors a clause the compiler OWNS deterministically (identity preservation,
 * reference-image operation, token interpretation, or text/logo policy). Narrow
 * and conservative on purpose: it does NOT try to remove all overlapping
 * meaning — only these four compiler-owned categories — so it never strips a
 * concrete scene description. Returns the removal reason, or null to keep.
 */
function getPlannerProseRemovalReason(sentence: string): RemovedProseReason | null {
  const s = normalizeSentence(sentence);
  if (!s) return "empty-or-duplicate";

  // Unresolved template tokens / explicit interpretation clauses.
  if (hasUnresolvedFactTokens(sentence) || /\binterpret these terms exactly\b/.test(s)) {
    return "token-interpretation-owned-by-compiler";
  }
  // Reference-image / mode operational language.
  if (
    /\b(?:reference|uploaded|source)\s+(?:image|photo|picture|person)\b/.test(s) ||
    /\bimage-to-image\b|\bi2i\b|\btext-to-image\b|\bt2i\b/.test(s)
  ) {
    return "reference-image-owned-by-compiler";
  }
  // Identity / face / likeness preservation.
  if (
    /\b(?:preserv\w*|maintain|keep|retain)\b.*\b(?:face|facial|identity|likeness|recognizable|same person)\b/.test(s) ||
    /\b(?:face|facial|identity|likeness|recognizable)\b.*\b(?:preserv\w*|maintain|keep|retain)\b/.test(s) ||
    /\brecognizable face\b/.test(s) ||
    /\bfacial identity\b/.test(s)
  ) {
    return "identity-preservation-owned-by-compiler";
  }
  // Readable-text / logo / watermark policy.
  if (
    /\b(?:readable text|captions?|watermarks?|logos?|brand marks?)\b/.test(s) ||
    /\bfree of\b.*\b(?:text|captions?|watermarks?|logos?|brand marks?)\b/.test(s)
  ) {
    return "text-policy-owned-by-compiler";
  }
  return null;
}

/** Split the planner prose into sentences and drop the compiler-owned ones. */
function sanitizePlannerProse(raw: string): { text: string; removed: RemovedProseSentence[] } {
  const removed: RemovedProseSentence[] = [];
  const kept: string[] = [];
  for (const sentence of splitSentences(raw)) {
    const reason = getPlannerProseRemovalReason(sentence);
    if (reason) {
      removed.push({ sentence: sentence.trim(), reason });
      continue;
    }
    kept.push(sentence.trim());
  }
  return { text: kept.join(" ").trim(), removed };
}

/**
 * Flag a likely tone split between the staging approach and the prose (e.g.
 * "grounded/heroic" vs "playful/humorous") WITHOUT mutating the prompt — those
 * words can be correct if the intended hierarchy is clear. Advisory only.
 */
function detectToneWarnings(args: { visualApproach?: string | null; prose?: string | null }): PromptWarning[] {
  const approach = normalizeSentence(args.visualApproach ?? "");
  const prose = normalizeSentence(args.prose ?? "");
  const seriousTone = /\b(grounded|realistic|cinematic|serious|heroic|dramatic|epic)\b/;
  const comicTone = /\b(playful|goofy|silly|slapstick|cartoonish|humorous|funny|comedic)\b/;
  if (seriousTone.test(approach) && comicTone.test(prose)) {
    return [
      {
        code: "possible-tone-split-between-approach-and-prose",
        severity: "warning",
        message:
          "Visual approach uses a serious/cinematic tone while the prose uses a comic/playful tone. This may be intentional — confirm the final prompt states the intended tone hierarchy (e.g. serious staging, humor from the visual contrast).",
      },
    ];
  }
  return [];
}

/**
 * Advisory visual-density diagnostics. These NEVER block compilation — they
 * surface in the admin prompt preview so a thin or abstract plan is visible.
 * Conservative on purpose (no brittle word-count thresholds): they flag a scene
 * that is obviously too thin to render well, an abstract/empty subject role on
 * an active-action frame, and secondary characters with an empty label/role.
 */
const ACTION_VERB_RE =
  /\b(?:driv\w*|hold\w*|grip\w*|lift\w*|throw\w*|push\w*|pull\w*|run\w*|jump\w*|leap\w*|fly\w*|carr\w*|swing\w*|smash\w*|crush\w*|punch\w*|kick\w*|catch\w*|launch\w*|ride\w*|climb\w*|reach\w*|point\w*|raise\w*|press\w*|deadlift\w*|bench\w*|operat\w*|steer\w*|command\w*|perform\w*|wield\w*|balanc\w*|hurl\w*|toss\w*|dunk\w*|sprint\w*)\b/i;
const ABSTRACT_ROLE_RE = /^(?:the\s+)?(?:protagonist|subject|hero|main\s+character|focal\s+(?:point|subject)|central\s+figure)$/i;

function detectDensityWarnings(args: {
  coreScene: string;
  subjectDetails: readonly string[];
  environment: readonly string[];
  roleInScene: string;
  activeActionFrame: boolean;
  secondaryCharacters: ReadonlyArray<{ label: string; visualRole: string }>;
}): PromptWarning[] {
  const warnings: PromptWarning[] = [];
  const scene = args.coreScene.trim();

  if (scene.length < 40) {
    warnings.push({
      code: "thin-core-scene",
      severity: "warning",
      message: "Core scene may be thin: it is very short and likely under-describes what is happening.",
    });
  } else if (args.activeActionFrame && !ACTION_VERB_RE.test(scene)) {
    warnings.push({
      code: "core-scene-missing-action",
      severity: "warning",
      message:
        "Core scene may be thin for an active-action frame: it does not clearly describe the subject performing an action.",
    });
  }

  if (args.subjectDetails.filter((d) => d.trim()).length === 0) {
    warnings.push({
      code: "thin-subject-details",
      severity: "warning",
      message: "Subject details are empty: add visible pose, expression, body/age presentation, or wardrobe.",
    });
  }
  if (args.environment.filter((e) => e.trim()).length === 0) {
    warnings.push({
      code: "thin-environment",
      severity: "warning",
      message: "Environment is empty: add concrete setting, background, props, or scale.",
    });
  }

  const role = args.roleInScene.trim();
  if (args.activeActionFrame && (!role || ABSTRACT_ROLE_RE.test(role))) {
    warnings.push({
      code: "abstract-subject-role",
      severity: "warning",
      message:
        "subjectTreatment.roleInScene is empty or abstract on an active-action frame: describe what the subject visibly is and does.",
    });
  }

  if (args.secondaryCharacters.some((c) => !c.label.trim() || !c.visualRole.trim())) {
    warnings.push({
      code: "incomplete-secondary-character",
      severity: "warning",
      message: "A secondary character is missing a concrete label or visualRole and was skipped in role binding.",
    });
  }

  return warnings;
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

  const modifierSet = new Set(input.enrichment.modifiers ?? []);
  const subjectName = args.renderedSubject?.name?.trim() ?? "";
  const visualGoal = vp.visualGoal?.trim() ?? "";
  const visualApproach = vp.visualApproach?.trim() ?? "";

  // ── SUBJECT BINDING inputs: fuse reference identity with the transformed life
  // stage. An age transform applies when the LLM flagged it OR an age modifier
  // is present (belt-and-suspenders); the LLM's targetState wins, else a default
  // derived from the modifier. avoid_duplicate_subject triggers a single-instance
  // binding even without an age transform.
  const lifeStage = vp.subjectTreatment?.ageLifeStageTransform;
  const modifierTargetState = ageModifierTargetState(modifierSet);
  const ageApplies = Boolean(lifeStage?.applies) || modifierTargetState !== null;
  const targetState = (lifeStage?.targetState?.trim() || modifierTargetState || "").trim();
  const avoidDuplicate = modifierSet.has("avoid_duplicate_subject");
  const humanIdentity = input.subjectRenderMode === "human_identity_i2i";
  const bindingArgs = { name: subjectName, applies: ageApplies, targetState, avoidDuplicate, humanIdentity };

  // 1. IMAGE-TO-IMAGE TASK (operational lead + required mode clauses).
  const clauses = mode.requiredClauses.filter(Boolean).join(" ");
  const taskBody = [mode.preamble, clauses].filter(Boolean).join(" ");

  // 2. SUBJECT BINDING (deterministic; positive identity↔life-stage fusion).
  const binding = composeSubjectBinding(bindingArgs);

  // Role/action inputs (v4). secondaryCharacters defaults to [] for back-compat
  // with pre-v4 plans replayed from storage. activeActionFrame is the reliable
  // signal that gates the strong sole-agent + active-action constraints.
  const secondaryCharacters = vp.secondaryCharacters ?? [];
  const hasSecondaryCharacters = secondaryCharacters.some((c) => c.label.trim() && c.visualRole.trim());
  const selectedFrame = vp.archetypeApplication?.selectedFrame ?? "";
  const activeActionFrame = isActiveActionFrame(selectedFrame);
  const roleInScene = vp.subjectTreatment?.roleInScene ?? "";

  // Running haystack so each later section only adds what earlier ones didn't
  // already say. Seeded with task + binding + the (internal, non-emitted) goal/
  // approach so concrete fields don't echo the abstract reasoning.
  let haystack = [taskBody, binding, visualGoal, visualApproach].filter(Boolean).join(" ");

  // 2b. REFERENCE INTERPRETATION (positive role binding). Bind the subject's
  // active role + each secondary character's role BEFORE the visual prose, so a
  // secondary character can't drift into the subject's central action. Seed the
  // haystack with it so CORE SCENE doesn't repeat the bound roles. The subject
  // clause is meaningful only when there are others to contrast against or the
  // frame asserts the subject is the one acting.
  const referenceInterpretation = composeReferenceInterpretation({
    subjectName,
    roleInScene,
    secondaryCharacters,
    includeSubjectRole: hasSecondaryCharacters || activeActionFrame,
    haystack,
  });
  haystack = [haystack, referenceInterpretation].filter(Boolean).join(" ");

  // 3. CORE SCENE — the concrete scene. Prefer the structured coreScene; fall
  // back to the LLM prose. Strip compiler-owned clauses (identity/text/ref/
  // token) and scrub authorial intent so only pixels-mapping language remains.
  const rawCore = vp.coreScene?.trim() ? vp.coreScene : args.compiledPrompt.prompt;
  const sanitized = sanitizePlannerProse(rawCore);
  const coreScene = scrubIntentLanguage(sanitized.text);
  haystack = `${haystack} ${coreScene}`;

  // 4. SUBJECT DETAILS — subject-specific visible details, plus expression/pose,
  // age-transform + other modifier directives, and any key element gap-fill.
  const subjectListBody = composeListBody(vp.subjectDetails ?? [], haystack);
  const expressionPose = scrubIntentLanguage(vp.subjectTreatment?.expressionAndPose ?? "");
  const modifierBody = composeModifierDirective(input, `${haystack} ${subjectListBody}`);
  const keyElements = composeKeyElementsDirective(vp, `${haystack} ${subjectListBody} ${modifierBody}`);
  const subjectDetails = [
    subjectListBody,
    expressionPose && !containsMeaningfulPhrase(haystack, expressionPose) ? `${expressionPose.replace(/[.!?]+$/, "")}.` : "",
    keyElements,
    modifierBody,
  ].filter(Boolean).join(" ");
  haystack = `${haystack} ${subjectDetails}`;

  // 5. ENVIRONMENT — setting, background, props, scale.
  const environment = composeListBody(vp.environment ?? [], haystack);
  haystack = `${haystack} ${environment}`;

  // 6. COMPOSITION — framing + camera + caption negative space.
  const composition = composeCompositionDirective(vp, haystack);

  // 7. LIGHTING AND STYLE — the plan's light/mood plus the resolved style suffix.
  // Each clause is terminated so the assembler's sentence-aware de-dupe keeps it
  // (an unpunctuated trailing fragment would be silently dropped).
  const lightingParts = [
    scrubIntentLanguage(vp.lightingAndStyle ?? ""),
    input.stylePrompt?.trim() ?? "",
  ].map((s) => s.trim().replace(/[.!?]+$/, "")).filter(Boolean);
  const lightingAndStyle = lightingParts.length ? `${lightingParts.join(". ")}.` : "";

  // 8. STRICT CONSTRAINTS — semantic referents, cultural refs, supporting-text
  // rule, violence policy, and the negative anti-entity-split guards.
  const renderPolicy: RenderPolicy = input.renderPolicy ?? DEFAULT_RENDER_POLICY;
  const constraintHaystack = `${haystack} ${composition} ${lightingAndStyle}`;
  const semantic = composeSemanticDirective(vp, constraintHaystack);
  const cultural = composeCulturalDirective(vp, `${constraintHaystack} ${semantic}`);
  const supportingText = composeSupportingTextDirective(vp, renderPolicy.supportingText);
  const violence = composeViolenceDirective(renderPolicy.violence, {
    relevant: isViolenceRelevant(input, vp),
    hasSofteningModifier: (input.enrichment.modifiers ?? []).some((m) => VIOLENCE_SOFTENING_MODIFIERS.has(m)),
  });
  const antiSplit = composeAntiSplitConstraints(bindingArgs);
  // Reusable failure-mode role/action constraints, keyed off normalized data
  // (frame + modifiers + whether secondary characters exist). Conservative:
  // strong sole-agent / active-action only on a reliable active-action frame.
  const failureModes = failureModeConstraints({
    selectedFrame,
    modifiers: input.enrichment.modifiers ?? [],
    hasSecondaryCharacters,
    subjectName,
  }).join(" ");
  const strictConstraints = [semantic, cultural, supportingText, violence, antiSplit, failureModes].filter(Boolean).join(" ");

  const rawSections: Section[] = [
    { id: "image_to_image_task", label: "IMAGE-TO-IMAGE TASK", text: labeled("IMAGE-TO-IMAGE TASK", taskBody), priority: "required" },
    { id: "subject_binding", label: "SUBJECT BINDING", text: labeled("SUBJECT BINDING", binding), priority: "required" },
    { id: "reference_interpretation", label: "REFERENCE INTERPRETATION", text: labeled("REFERENCE INTERPRETATION", referenceInterpretation), priority: "required" },
    { id: "core_scene", label: "CORE SCENE", text: labeled("CORE SCENE", coreScene), priority: "high", compressible: true },
    { id: "subject_details", label: "SUBJECT DETAILS", text: labeled("SUBJECT DETAILS", subjectDetails), priority: "high", compressible: true },
    { id: "environment", label: "ENVIRONMENT", text: labeled("ENVIRONMENT", environment), priority: "high", compressible: true },
    { id: "composition", label: "COMPOSITION", text: labeled("COMPOSITION", composition), priority: "high" },
    { id: "lighting_and_style", label: "LIGHTING AND STYLE", text: labeled("LIGHTING AND STYLE", lightingAndStyle), priority: "medium", compressible: true },
    { id: "strict_constraints", label: "STRICT CONSTRAINTS", text: labeled("STRICT CONSTRAINTS", strictConstraints), priority: "required" },
  ];

  // Final identity gate: resolve any residual {NAME}/{SUBJ}/… tokens the LLM
  // echoed (e.g. from a semantic entity whose surfaceText is "{NAME}") BEFORE
  // assembly, so neither the engine prompt nor the debug breakdown ever carries
  // a raw template token.
  const sections = rawSections.map((s) => ({ ...s, text: renderIdentityTokens(s.text, args.renderedSubject) }));

  const { prompt: finalPrompt, breakdown } = assembleSections(sections, notes);

  const warnings = [
    ...detectToneWarnings({ visualApproach, prose: coreScene }),
    ...detectDensityWarnings({
      coreScene,
      subjectDetails: vp.subjectDetails ?? [],
      environment: vp.environment ?? [],
      roleInScene,
      activeActionFrame,
      secondaryCharacters,
    }),
  ];

  const out: CompiledImagePrompt = {
    prompt: finalPrompt,
    imagePrompt: finalPrompt,
    promptBreakdown: breakdown,
    diagnostics: { removedPlannerProseSentences: sanitized.removed, warnings },
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
