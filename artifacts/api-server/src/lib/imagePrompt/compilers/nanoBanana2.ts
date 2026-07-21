/**
 * Nano Banana 2 prompt compilers (Phase 2).
 *
 * Strategy: the VISUAL CONCEPT (CORE SCENE) LEADS THE PROMPT and carries the
 * gag; it is the authoritative scene. Every other section earns its place only
 * by (a) operationally instructing the engine — mode + identity/reference (i2i)
 * or the render task (t2i), subject binding, style, and the STRICT-CONSTRAINTS
 * policy guardrails — or (b) ADDING a concrete detail the Concept genuinely
 * omitted. Anything that merely restates the Concept is dropped: additive
 * sections (role details, subject details, environment) de-dupe against the
 * EMITTED text via content-word contiguity, and the key-element gap-fill drops
 * non-visible "crutch" lines. The de-dupe haystack is seeded ONLY from emitted
 * text (never from the internal, non-emitted visualGoal/visualApproach).
 *
 * Sections carry a priority. Required sections (core scene, mode/identity,
 * subject binding, moderator required details, supporting-text/violence/anti-
 * split constraints) always survive; additive prose, gap-fill, composition and
 * style are included while budget allows and compressed/dropped otherwise.
 * Dropped role/key-element candidates are recorded (structured) in
 * `diagnostics.droppedCandidates`; budget drops in `engineNotes`.
 *
 * Output `imagePrompt` mirrors `prompt` and is what `buildEngineInput` reads.
 * For i2i variants, `referenceImageUrl` is also returned.
 */

import type {
  VisualPlan,
  CompiledPrompt,
  ImagePromptGenerationInput,
  RenderPolicy,
  SubjectRenderMode,
  VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { DEFAULT_RENDER_POLICY, MANDATORY_FORBIDDEN_TEXT_TYPES, detectOwnedLanguage } from "@workspace/api-zod";
import type {
  CompiledImagePrompt,
  PromptSection,
  RemovedProseReason,
  RemovedProseSentence,
  PromptWarning,
  DroppedCandidate,
} from "../types";
import { failureModeConstraints, isActiveActionFrame } from "./failureModeConstraints";
import { renderPersonalized, hasUnresolvedFactTokens } from "../../renderCanonical";

const MAX_PROMPT_CHARS = 4000;

// ROLE DETAILS becomes required + non-compressible whenever moderator
// roleBindings are present (so a casting correction can't be silently
// compressed away — see composeAdditiveRoleDetails). Per-field schema caps
// (visualStrategyOverride.ts) bound a SINGLE role, but up to 20 roles can
// still combine into more raw text than the engine budget can safely spend
// on one required section. This caps the section's OWN contribution so it
// can never itself push STRICT CONSTRAINTS (violence/text-policy/anti-split
// guardrails, emitted last) off the end of the final hard-truncate.
const ROLE_DETAILS_MAX_CHARS = 1000;

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
  "Text-to-image generation: render an original protagonist that fits the scene.";

// The compiler-owned RENDER STYLE default when no visual style is selected
// (styleId absent or "none"). Medium-only, no lighting instruction — so it can
// never override a scene's deliberate lighting (David's decision, plan §11.4).
// Exported so the shared style resolver (styleResolution.ts) freezes the SAME
// line into a snapshot rather than redefining it.
export const DEFAULT_PHOTOREALISTIC_STYLE =
  "Photorealistic rendering: true-to-life materials and textures, realistic optical detail, and the clarity of a high-quality photograph.";

// ─── Text utilities ───────────────────────────────────────────────────────

/** Split a prompt blob into trimmed sentences, keeping terminal punctuation.
 *  Splits at a sentence terminator followed by whitespace — but NOT when the
 *  terminator belongs to an initialism ("M.C. Hammer", "J.R.R. Tolkien"), and
 *  never drops the text between boundaries. (The old `match()`-based splitter
 *  discarded any run that didn't fit the sentence pattern, so "M.C." lost its
 *  leading "M." and abbreviations were shattered.) */
function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<!\b[A-Za-z]\.)(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
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

/**
 * Ensure concrete visible elements the prose omitted are explicitly requested.
 * Candidate sources (all CONCRETE — no interpretation meta reaches the engine):
 *   - the planner's `keyVisualElements`;
 *   - each consumed cultural reference's `visualImplicationUsed` — the concrete
 *     visual ONLY, never the canonical reference / brand / "treat X as Y" meta;
 *   - each semantic entity's `visualReferentUsed` — the resolved referent ONLY
 *     (e.g. "the planet Earth seen from orbit"), never the surface term or an
 *     "interpret X means Y" line.
 * Cultural references + semantic entities are inputs that inform the planner; the
 * planner is expected to bake them into the scene, and this gap-fill is the
 * compiler-side guarantee that their concrete visual still reaches the engine
 * when the scene omitted it. De-duped against the running scene + each other.
 */
/** Function words dropped before content-word coverage matching. */
const GAP_FILL_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "and", "or", "with", "for",
  "by", "from", "as", "is", "are", "be", "that", "this", "it", "its", "into",
  "onto", "over", "under", "behind", "near", "around", "my", "his", "her",
  "their", "your", "our",
]);

/** Tokenize to lowercase content words: drop punctuation + stopwords, strip a
 *  naive trailing plural so "fins"↔"fin" match. Word-level (not substring), so
 *  "earth" never matches "earthquake". */
function gapFillContentWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => w.length >= 2 && !GAP_FILL_STOPWORDS.has(w));
}

/** True when the assembled prompt already conveys this element. Exact-phrase
 *  fast path, else content-word coverage: ALL content words present for short
 *  (≤3-word) elements, ≥80% for longer ones. An element with no content words
 *  (e.g. only stopwords) is treated as NOT covered, so it is emitted rather than
 *  silently dropped. */
function elementCovered(haystack: string, element: string): boolean {
  if (containsMeaningfulPhrase(haystack, element)) return true;
  const words = gapFillContentWords(element);
  if (words.length === 0) return false;
  const hay = new Set(gapFillContentWords(haystack));
  const present = words.filter((w) => hay.has(w)).length;
  return words.length <= 3 ? present === words.length : present / words.length >= 0.8;
}

/**
 * Stricter than `elementCovered`: treats an entry as already-conveyed only when
 * its content words appear as a NEAR-CONTIGUOUS in-order run in the haystack —
 * not merely scattered across unrelated phrases. This is the additive-section
 * de-dupe: it drops a reworded restatement of the scene ("leans against the
 * counter" when the scene says "leans against the bar counter") while KEEPING a
 * distinct detail that happens to reuse scene words from separate places ("a red
 * trophy" when the scene mentions "red warning lights" and "a trophy shelf"
 * separately). The discriminator is insertion density: a restatement threads the
 * entry's words with few gaps; a false-positive needs many insertions to line the
 * scattered words up.
 */
function coveredWithContiguity(haystack: string, entry: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm(entry)) return true;
  if (norm(haystack).includes(norm(entry))) return true;
  const e = gapFillContentWords(entry);
  if (e.length === 0) return false;
  const h = gapFillContentWords(haystack);
  if (e.length === 1) return h.includes(e[0]!);
  // Greedy in-order match; record how many matched and the span they occupy.
  let matched = 0;
  let firstHit = -1;
  let lastHit = -1;
  let hi = 0;
  for (const word of e) {
    const at = h.indexOf(word, hi);
    if (at >= 0) {
      matched++;
      if (firstHit < 0) firstHit = at;
      lastHit = at;
      hi = at + 1;
    }
  }
  if (matched < Math.ceil(0.8 * e.length)) return false;
  const insertions = lastHit - firstHit - (matched - 1); // gap words between matches
  return insertions <= Math.floor(0.5 * matched);
}

/**
 * A key-element gap-fill candidate is only worth emitting under "Ensure these
 * elements are clearly visible" when it names a CONCRETE VISIBLE thing. Reject
 * the crutch shapes that used to leak in: negative constraints ("not a severed
 * finger", "no …", "avoid …"), conditional softeners ("if shown…", "when
 * depicted…"), failure-mode commentary ("depict X, not Z"), and interpretive
 * meta ("treat X as", "means", "represents", "symbolizes"). Safety-relevant
 * exclusions belong in STRICT CONSTRAINTS (failure-mode constraints / moderator
 * forbidden details), never in a visible-elements list. Returns the drop reason,
 * or null to keep.
 */
function keyElementDropReason(candidate: string): DroppedCandidate["reason"] | null {
  const s = candidate.trim().toLowerCase();
  if (!s) return "empty-after-normalization";
  if (/\bnot\b/.test(s) && /\b(?:a|an|the)\b/.test(s.split(/\bnot\b/)[1] ?? "")) {
    // "…, not a severed finger" / "depict X, not Z" — a contrastive negative.
    return "failure-mode-commentary-not-visible-element";
  }
  if (/^\s*(?:no|do not|don['’]?t|avoid|never|without)\b/.test(s) || /\bno\s+(?:severed|detached|visible)\b/.test(s)) {
    return "negative-constraint-not-visible-element";
  }
  if (/\b(?:if shown|when shown|when depicted|if depicted|if any|where shown)\b/.test(s)) {
    return "conditional-softener-not-visible-element";
  }
  if (/\b(?:treat\s+\w+\s+as|interpret|means?|represents?|symboli[sz]es?|stands? for|as a metaphor)\b/.test(s)) {
    return "interpretive-meta-not-visible-element";
  }
  return null;
}

/** Result of a composer that may drop candidates: the emitted text + the drops. */
interface DirectiveResult {
  text: string;
  dropped: DroppedCandidate[];
}

function composeKeyElementsDirective(vp: VisualPlan, haystack: string): DirectiveResult {
  const candidates: Array<{ value: string; source: DroppedCandidate["source"] }> = [
    ...vp.keyVisualElements.map((v) => ({ value: v, source: "keyVisualElements" as const })),
    ...(vp.culturalReferencesUsed ?? []).map((r) => ({ value: r.visualImplicationUsed, source: "culturalReferenceVisual" as const })),
    ...(vp.semanticEntitiesUsed ?? []).map((s) => ({ value: s.visualReferentUsed, source: "semanticReferent" as const })),
  ].map((c) => ({ ...c, value: c.value.trim() })).filter((c) => c.value);
  const seen = new Set<string>();
  const missing: string[] = [];
  const dropped: DroppedCandidate[] = [];
  // Fold each emitted element into a local haystack so two near-duplicate
  // candidates don't both surface (the first suppresses the second).
  let localHaystack = haystack;
  for (const { value, source } of candidates) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Crutch filter FIRST: a non-visible candidate never counts as an element.
    const dropReason = keyElementDropReason(value);
    if (dropReason) {
      dropped.push({ source, value, reason: dropReason });
      continue;
    }
    if (elementCovered(localHaystack, value)) {
      dropped.push({ source, value, reason: "already-in-core-scene" });
      continue;
    }
    // Strip trailing sentence punctuation so joining with "; " and the section's
    // own terminal "." can't produce a doubled terminator ("…props..").
    missing.push(value.replace(/[.!?]+$/, ""));
    localHaystack = `${localHaystack} ${value}`;
  }
  const text = missing.length ? `Ensure these elements are clearly visible: ${missing.join("; ")}.` : "";
  return { text, dropped };
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
 * Always-on anti-gibberish guard for INCIDENTAL text. Image models love to
 * splatter garbled lettering onto background signage/labels; this steers those
 * surfaces clean while YIELDING to any intentional in-scene text ("requested by
 * these instructions" — the explicit elements / require / guidance lines above
 * it). This replaces the retired `no_readable_text` modifier's blanket ban,
 * which did not yield and contradicted intentional in-scene text. Phrasing is
 * deliberately clear of the planner-prose scrubber patterns (no "readable text"
 * / "free of … text" bigram).
 */
const INCIDENTAL_TEXT_GUARD =
  "Keep incidental background text non-readable; render only the specific in-scene text requested by these instructions.";

/**
 * The supporting-text directive. Always emits the narrow overlay-text exclusion
 * and the always-on incidental-text guard; between them, depending on the render
 * policy and the planner-selected scene text, governs whether IN-WORLD readable
 * text (signs, TV titles, scoreboards, documents, labels) is rendered, required,
 * or avoided.
 *
 * Phase 1 (R1): in "allow" mode the compiler adds no in-world-text directive of
 * its own unless the planner picked explicit `supportingTextElements` or the
 * policy carries intentional `guidance` — we do not encourage unnecessary text.
 * "require"/"forbid" always emit their line. The incidental-text guard is
 * appended last in every path and yields to whatever text those lines request.
 */
function composeSupportingTextDirective(vp: VisualPlan, policy: RenderPolicy["supportingText"]): string {
  const lines: string[] = [OVERLAY_TEXT_EXCLUSION];
  const pol = vp.supportingTextPolicy;
  const guidance = policy.guidance?.trim() ?? "";

  // Planner picked concrete in-world elements for this render → render them
  // (regardless of mode; the planner's scene content is the strongest signal).
  // Route by kind: LITERAL glyph strings are quoted as exact readable text;
  // VISUAL GRAPHICS are emitted UNQUOTED as "depict as a visual, not written
  // words" so a description ("a flatline trace") is never baked in as the
  // literal words. This is the fix for quoting descriptions as glyphs.
  if (pol.allowSupportingText && pol.supportingTextElements.length > 0) {
    const fmt = (e: (typeof pol.supportingTextElements)[number]) =>
      `${e.content.trim()}${e.placement.trim() ? ` (${e.placement.trim()})` : ""}`;
    const literals = pol.supportingTextElements.filter((e) => e.kind === "literal_text" && e.content.trim());
    const graphics = pol.supportingTextElements.filter((e) => e.kind === "visual_graphic" && e.content.trim());
    if (literals.length > 0) {
      const items = literals
        .map((e) => `"${e.content.trim()}"${e.placement.trim() ? ` (${e.placement.trim()})` : ""}`)
        .join("; ");
      lines.push(`Render this in-scene text clearly: ${items}.`);
    }
    if (graphics.length > 0) {
      lines.push(`Depict these as visuals, not as written words: ${graphics.map(fmt).join("; ")}.`);
    }
    lines.push(INCIDENTAL_TEXT_GUARD);
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

  lines.push(INCIDENTAL_TEXT_GUARD);
  return lines.join(" ");
}

// ─── Violence policy ────────────────────────────────────────────────────────

/** Taxonomy modifiers whose presence implies the fact is violence-relevant. */
const VIOLENCE_RELEVANT_MODIFIERS = new Set([
  "cinematic_aftermath",
  "projectile_impact_power",
  "action_comedy",
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
 * The violence directive. Precedence: an explicit moderator "soften"/"suppress"
 * mode wins — that is now the ONLY thing that suppresses violent depiction (the
 * retired auto-softening modifiers no longer exist). Otherwise, under the default
 * "allow", the permission line is emitted when the fact is violence-relevant or
 * the policy carries intentional guidance. Never emits "graphic"-flavored language.
 */
function composeViolenceDirective(
  policy: RenderPolicy["violence"],
  opts: { relevant: boolean },
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
  return opts.relevant ? VIOLENCE_ALLOW_LINE : "";
}

// ─── Moderator visual-strategy override (Phase 2) ───────────────────────────

/** The active moderator override, or null when absent/disabled. */
function activeOverride(input: ImagePromptGenerationInput): VisualPromptStrategyOverride | null {
  const ov = input.enrichment.visualPromptStrategyOverride;
  return ov?.enabled ? ov : null;
}

/** Join trimmed, sentence-terminated override list entries; "" when none. */
function composeOverrideList(entries: readonly string[]): string {
  const kept = entries.map((e) => e.trim().replace(/[.!?]+$/, "")).filter(Boolean);
  return kept.length ? `${kept.join("; ")}.` : "";
}

/** SUBJECT REALIZATION block from the moderator override. Emitted only when a
 *  realization mode other than `use_ai_plan` is chosen with a description. This
 *  ADDS to (never replaces) the compiler-owned SUBJECT BINDING / anti-split
 *  guards; conflicting realistic-de-age intent is handled by forbiddenVisualDetails. */
function composeSubjectRealization(ov: VisualPromptStrategyOverride): string {
  const r = ov.subjectRealizationOverride;
  if (!r || r.mode === "use_ai_plan") return "";
  const desc = r.description.trim().replace(/[.!?]+$/, "");
  return desc ? `${desc}.` : "";
}

// Recognizes a line already phrased as a negative so we don't double-prefix it.
// The apostrophe class covers straight (') and curly (’ U+2019) so "Don't" /
// "Don’t" both count as already-negative.
const NEGATIVE_LEAD_RE = /^\s*(?:do not\b|don[’']?t\b|avoid\b|never\b|no\b)/i;

/** Normalize a forbidden/negative entry into a "Do not …" constraint, without
 *  double-prefixing entries that already lead with Do not/Avoid/Never/No. */
function asNegativeConstraint(entry: string): string {
  const t = entry.trim().replace(/[.!?]+$/, "");
  if (!t) return "";
  return `${NEGATIVE_LEAD_RE.test(t) ? t : `Do not ${t}`}.`;
}

/** Forbidden visual details + negative-prompt additions → "Do not …" lines. */
function composeOverrideForbidden(ov: VisualPromptStrategyOverride): string {
  return [...ov.forbiddenVisualDetails, ...ov.negativePromptAdditions]
    .map(asNegativeConstraint)
    .filter(Boolean)
    .join(" ");
}

/**
 * Semantic entities (capitalization-aware referents, e.g. "Earth" → the planet
 * vs "earth" → ground) are an INPUT that informs the planner how to read the
 * fact — they are NOT emitted to the engine as an "Interpret X means Y" meta
 * line. The planner resolves the ambiguity into the concrete scene; the resolved
 * `visualReferentUsed` reaches the engine as a CONCRETE visible element via
 * `composeKeyElementsDirective` (de-duped), and the echo-back stays on the visual
 * plan for the validator + admin debug.
 */

/**
 * Cultural references are an INPUT that informs the planner (OpenAI) how to
 * interpret the fact — they are NOT emitted to the image engine. The planner
 * bakes the reference's visual implication into the concrete fields (CORE SCENE /
 * SUBJECT DETAILS / ENVIRONMENT / keyVisualElements); re-emitting the canonical
 * reference + explanation here just leaks meta-instruction (and brand names like
 * "Discovery Channel") into the prompt. The `culturalReferencesUsed` echo-back is
 * kept on the visual plan for the validator + admin debug, but never compiled in.
 */

// ─── Additive role details (post-Visual-Concept) ────────────────────────────

/** True when `text` opens with `name` — matching either the rendered name OR a
 *  leading personalization name-token ({NAME}/{Name}/{NAME_POSSESSIVE}), because
 *  role text reaches this composer BEFORE tokens are rendered. This is what
 *  prevents "David Franklin is David Franklin as the driver": the moderator wrote
 *  "{NAME} as the driver", which renders to a self-contained subject clause. */
function leadsWithName(text: string, name: string): boolean {
  if (/^\s*\{name(_possessive)?\}/i.test(text)) return true;
  return !!name.trim() && new RegExp(`^\\s*${escapeRegExp(name.trim())}\\b`, "i").test(text);
}

/**
 * Emit ADDITIVE role details — the subject's action and each secondary
 * character's concrete role — but only when the Visual Concept (CORE SCENE)
 * doesn't already state them, and NEVER as a doubled "X is X" clause.
 *
 * This replaces the old REFERENCE INTERPRETATION section, whose bug was that it
 * ALWAYS prepended "${subject} is ${role}" — so when the role already led with
 * the subject's own name (a full authored clause like "Alex Franklin leans
 * against the bar…"), it produced "Alex Franklin is Alex Franklin leans…". The
 * fix: a role/visualRole that already opens with the subject/label name is a
 * self-contained clause and is emitted as-is; a bare predicate ("the newborn
 * baby gripping the wheel") still gets the "${subject} is …" binding. Entries the
 * scene already conveys are dropped (recorded in diagnostics) — since the Visual
 * Concept now leads and carries the gag, this section only surfaces roles the
 * scene omitted. Moderator roleBindings-vs-AI precedence is decided upstream in
 * compile(); this composer is precedence-agnostic.
 */
function composeAdditiveRoleDetails(opts: {
  subjectName: string;
  roleInScene: string;
  secondaryCharacters: ReadonlyArray<{ label: string; visualRole: string }>;
  includeSubjectRole: boolean;
  haystack: string;
}): DirectiveResult {
  const subject = opts.subjectName.trim();
  const clauses: string[] = [];
  const dropped: DroppedCandidate[] = [];

  if (opts.includeSubjectRole) {
    const role = opts.roleInScene.trim().replace(/[.!?]+$/, "");
    if (role) {
      if (coveredWithContiguity(opts.haystack, role)) {
        dropped.push({ source: "subjectRole", value: role, reason: "already-in-core-scene" });
      } else {
        clauses.push(leadsWithName(role, subject) || !subject ? role : `${subject} is ${role}`);
      }
    }
  }

  for (const c of opts.secondaryCharacters) {
    const label = c.label.trim().replace(/[.!?]+$/, "");
    const visualRole = c.visualRole.trim().replace(/[.!?]+$/, "");
    if (!label || !visualRole) continue;
    if (coveredWithContiguity(opts.haystack, visualRole)) {
      dropped.push({ source: "secondaryCharacter", value: `${label}: ${visualRole}`, reason: "already-in-core-scene" });
      continue;
    }
    // Label-colon form ("king cobra: Large venomous snake…") rather than
    // "<label> is <visualRole>": the latter mangled casing ("king cobra is Large
    // venomous snake") and could produce ungrammatical joins with proper-noun /
    // initialism labels ("NASA astronaut", "Dr. Smith"). A visualRole that
    // already opens with the label stays a self-contained clause (no doubling).
    clauses.push(leadsWithName(visualRole, label) ? visualRole : `${label}: ${visualRole}`);
  }

  const text = clauses.length ? clauses.map((c) => `${c}.`).join(" ") : "";
  return { text, dropped };
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
 * How the subject is being realized, which fixes the subject vocabulary so the
 * binding copy can't import human/i2i language into a non-human or t2i render:
 *   - `human_i2i`   → "the reference person"; de-aging a real person.
 *   - `nonhuman_i2i`→ "the uploaded subject"; life-stage transform of that subject.
 *   - `t2i`         → "the subject"; generated protagonist, no reference photo.
 */
type BindingMode = "human_i2i" | "nonhuman_i2i" | "t2i";

function bindingModeFromRenderMode(mode: SubjectRenderMode): BindingMode {
  switch (mode) {
    case "human_identity_i2i": return "human_i2i";
    case "nonhuman_subject_i2i": return "nonhuman_i2i";
    case "t2i_fallback": return "t2i";
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown subjectRenderMode: ${exhaustive}`);
    }
  }
}

/** The subject noun used throughout the binding copy for this mode. */
function bindingSubjectNoun(name: string, mode: BindingMode): string {
  if (name) return name;
  switch (mode) {
    case "human_i2i": return "the reference person";
    case "nonhuman_i2i": return "the uploaded subject";
    case "t2i": return "the subject";
  }
}

interface BindingArgs {
  name: string;
  applies: boolean;
  targetState: string;
  avoidDuplicate: boolean;
  bindingMode: BindingMode;
}

/**
 * Build the deterministic SUBJECT BINDING block. This is the fix for the core
 * failure: it fuses the subject identity, the transformed life stage, and the
 * single-instance constraint into ONE entity, so the engine de-ages/ages the
 * SAME subject instead of pairing it with a separate younger/older copy (or
 * cloning it). Emitted when an age transform applies OR a duplicate-subject
 * guard is requested. Returns "" when neither applies.
 *
 * Age handling covers ALL render modes: human i2i keeps the "reference person"
 * de-aging language; non-human i2i and t2i get mode-appropriate single-entity
 * life-stage wording (no "reference person"/"adult" vocabulary). This is the
 * sole compiled owner of age transforms now that the modifier prose channel is
 * gone.
 */
function composeSubjectBinding(opts: BindingArgs): string {
  const subject = bindingSubjectNoun(opts.name, opts.bindingMode);
  const lines: string[] = [];
  if (opts.applies && opts.targetState.trim()) {
    const ts = opts.targetState.trim();
    const bare = bareNoun(ts);
    if (opts.bindingMode === "human_i2i") {
      lines.push(
        `The reference person is ${subject}.`,
        `${subject} is ${ts} in this scene.`,
        `Render exactly one ${subject}.`,
        `The transformed ${bare} IS ${subject} — the same person de-aged or aged, not a second person.`,
      );
    } else {
      lines.push(
        `${subject} is ${ts} in this scene — the same subject rendered at that life stage, not a different individual.`,
        `Render exactly one ${subject}.`,
      );
    }
  } else if (opts.avoidDuplicate) {
    if (opts.bindingMode === "human_i2i") {
      lines.push(
        `The reference person is ${subject}.`,
        `Render exactly one ${subject} — a single instance.`,
      );
    } else {
      lines.push(`Render exactly one ${subject} — a single instance.`);
    }
  }
  return lines.join(" ");
}

/**
 * The negative anti-entity-split guards that pair with SUBJECT BINDING. Kept in
 * STRICT CONSTRAINTS so the positive binding and the "do not" guards don't
 * duplicate each other. Returns "" when no transform/dup case applies.
 */
function composeAntiSplitConstraints(opts: BindingArgs): string {
  const subject = bindingSubjectNoun(opts.name, opts.bindingMode);
  const lines: string[] = [];
  if (opts.applies && opts.targetState.trim()) {
    const bare = bareNoun(opts.targetState);
    if (opts.bindingMode === "human_i2i") {
      lines.push(
        `Do not render the adult reference person separately.`,
        `Do not add a second, generic ${bare}.`,
        `Do not show both an adult ${subject} and a ${bare} in the same frame.`,
      );
    } else {
      lines.push(
        `Do not add a separate, generic ${bare}.`,
        `Do not show the subject at two ages or life stages in the same frame.`,
      );
    }
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
 * dropping entries the `haystack` already conveys (so SUBJECT DETAILS /
 * ENVIRONMENT don't repeat what CORE SCENE already said) — using CONTENT-WORD
 * CONTIGUITY (`coveredWithContiguity`), not bare substring, so a REWORDED
 * restatement of the scene is dropped while a genuinely distinct detail that
 * merely reuses scattered scene words survives. Entries are also de-duped
 * against each other (a local haystack), so two near-identical entries don't
 * both surface. Each kept entry becomes its own clause.
 */
function composeListBody(entries: readonly string[], haystack: string): string {
  const kept: string[] = [];
  let local = haystack;
  for (const raw of entries) {
    const e = scrubIntentLanguage(raw).trim().replace(/[.!?]+$/, "");
    if (!e) continue;
    if (coveredWithContiguity(local, e)) continue;
    kept.push(e);
    local = `${local} ${e}`;
  }
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
  /** Content authored by a human moderator (core scene, role bindings). */
  moderatorAuthored?: boolean;
}

/**
 * Assemble sections (already in reading order) into a single prompt under the
 * char budget. Required sections always survive (a final hard-truncate handles
 * the pathological case where they alone overflow). Optional sections are
 * included while budget allows; compressible ones are trimmed to fit before
 * being dropped. Drops/compressions are appended to `notes`.
 *
 * BUDGET RESERVATION (matters now that CORE SCENE leads): a compressible section
 * may not consume budget that a REQUIRED section appearing LATER in reading order
 * will need. Without this, a huge (AI-fallback) CORE SCENE at the front would
 * fill the budget and force the final hard-truncate to lop off the required
 * identity/binding/STRICT-CONSTRAINTS sections that follow it — silently dropping
 * the policy guardrails. We precompute the raw length required-and-later sections
 * need and hold it back when fitting each compressible section.
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
    breakdown.push({
      id: s.id,
      label: s.label,
      priority: s.priority,
      status,
      text,
      rawText,
      ...(s.moderatorAuthored ? { moderatorAuthored: true } : {}),
    });

  // For each index, the budget required sections at a LATER index will consume
  // (their trimmed length + a separator each). Reserved when fitting compressibles.
  const requiredLenAfter: number[] = new Array(sections.length + 1).fill(0);
  for (let i = sections.length - 1; i >= 0; i--) {
    const raw = sections[i]!.text.trim();
    const reserve = sections[i]!.priority === "required" && raw ? raw.length + 1 : 0;
    requiredLenAfter[i] = requiredLenAfter[i + 1] + reserve;
  }

  for (let idx = 0; idx < sections.length; idx++) {
    const section = sections[idx]!;
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
    if (section.priority === "required") {
      // Required always survives; the final truncate clamps the pathological
      // (required alone > budget) case. This section's own length was already
      // reserved out of earlier compressibles via requiredLenAfter.
      assembled = candidate;
      record(section, "included", deduped, raw);
      continue;
    }
    // Optional section: it may only use budget NOT reserved for later required
    // sections (requiredLenAfter[idx+1], since this section isn't required).
    const reserve = requiredLenAfter[idx + 1];
    if (candidate.length <= MAX_PROMPT_CHARS - reserve) {
      assembled = candidate;
      record(section, "included", deduped, raw);
      continue;
    }
    if (section.compressible) {
      const remaining = MAX_PROMPT_CHARS - reserve - assembled.length - 1;
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
  /** Operational mode/identity clause. Emitted right AFTER CORE SCENE — the
   *  Visual Concept leads; identity/reference (i2i) or the render task (t2i)
   *  follows it prominently. */
  preamble: string;
  /** Section label + id for that clause. Mode-aware because "IMAGE-TO-IMAGE
   *  TASK" is wrong for the t2i (text-to-image) path. */
  sectionLabel: string;
  sectionId: string;
  /** Extra required clauses for this mode (fallback gender). */
  requiredClauses: string[];
  withReferenceUrl: boolean;
}

function compile(args: CompileArgs, mode: ModeContext): CompiledImagePrompt {
  const { visualPlan: vp, input } = args;
  const notes: string[] = [];

  const modifierSet = new Set(input.enrichment.modifiers ?? []);
  const subjectName = args.renderedSubject?.name?.trim() ?? "";
  // visualGoal/visualApproach are INTERNAL reasoning (never emitted). They are
  // deliberately NOT used to seed the de-dupe haystack (that used to suppress
  // concrete details that only appear in the reasoning); visualApproach is still
  // read for the advisory tone-split warning.
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
  const bindingMode = bindingModeFromRenderMode(input.subjectRenderMode);
  const bindingArgs: BindingArgs = { name: subjectName, applies: ageApplies, targetState, avoidDuplicate, bindingMode };

  // Moderator visual-strategy override (Phase 2). null when absent/disabled.
  const ov = activeOverride(input);

  // ── CORE SCENE FIRST. The Visual Concept leads the prompt AND seeds the
  // additive de-dupe haystack. A moderator-authored coreSceneOverride is
  // AUTHORITATIVE and wins over the AI plan; otherwise prefer the structured
  // coreScene, falling back to the LLM prose. Moderator text is token-rendered
  // BEFORE sanitation (sanitizePlannerProse drops any sentence carrying an
  // unresolved token; the shared section render at assembly time runs too late)
  // and then passes the SAME compiler-owned stripping + intent scrub — the
  // override cannot smuggle identity/reference/text-policy language. A scene
  // left empty by sanitation falls back to the AI scene with a loud warning.
  const removedProse: RemovedProseSentence[] = [];
  const moderatorCoreWarnings: PromptWarning[] = [];
  const moderatorCoreRaw = renderIdentityTokens(ov?.coreSceneOverride?.trim() ?? "", args.renderedSubject);
  const aiCore = vp.coreScene?.trim() ? vp.coreScene : args.compiledPrompt.prompt;
  let coreScene = "";
  let coreSceneModeratorAuthored = false;
  if (moderatorCoreRaw) {
    // VERBATIM: the moderator Concept is the AUTHORITATIVE scene. It reaches the
    // engine token-rendered but otherwise UNMODIFIED — it is NOT run through
    // sanitizePlannerProse / scrubIntentLanguage (those apply only to AI-authored
    // prose, below). Compiler-owned language is DETECTED and warned about
    // (non-mutating), never silently stripped: a human authored this on purpose,
    // and the fix belongs at authoring time, not a surprise rewrite at compile.
    // A non-empty Concept therefore never falls back to AI content.
    coreScene = moderatorCoreRaw;
    coreSceneModeratorAuthored = true;
    const owned = detectOwnedLanguage(moderatorCoreRaw);
    if (owned) {
      moderatorCoreWarnings.push({
        code: "moderator_core_scene_owned_language",
        severity: "warning",
        message: `The Visual concept contains ${owned.category} language the compiler owns ("${owned.matchedText}"). It is rendered verbatim as authored; rewrite it as visible scene description only so the compiler's identity/reference/text-policy clauses stay the single source.`,
      });
    }
  }
  if (!coreSceneModeratorAuthored) {
    const sanitized = sanitizePlannerProse(aiCore);
    removedProse.push(...sanitized.removed);
    coreScene = scrubIntentLanguage(sanitized.text);
  }

  // The de-dupe haystack is seeded ONLY from EMITTED text — starting with the
  // core scene — and grows as each section is actually emitted. It is NEVER
  // seeded with the internal, non-emitted visualGoal/visualApproach reasoning:
  // doing so used to wrongly suppress a concrete detail that appears only in that
  // reasoning (and never in the final prompt). Additive sections dedupe against
  // what the engine will actually read, nothing else.
  let haystack = coreScene;

  // Identity / render-task clause — emitted right AFTER the scene. Operational:
  // mode + identity/reference (i2i) or fallback-gender (t2i). Mode-aware label.
  const clauses = mode.requiredClauses.filter(Boolean).join(" ");
  const taskBody = [mode.preamble, clauses].filter(Boolean).join(" ");
  if (taskBody) haystack = `${haystack} ${taskBody}`;

  // SUBJECT BINDING (deterministic identity↔life-stage fusion; when applicable).
  const binding = composeSubjectBinding(bindingArgs);
  if (binding) haystack = `${haystack} ${binding}`;

  // Role/action inputs. secondaryCharacters defaults to [] for back-compat with
  // pre-v4 plans replayed from storage. Moderator roleBindings (when present)
  // take PRECEDENCE over the AI's secondaryCharacters: the "subject" row becomes
  // the subject's role and every other entity becomes a secondary character.
  const overrideRoleBindings = ov?.roleBindings?.filter((b) => b.entity.trim() && b.visualRole.trim()) ?? [];
  const hasOverrideRoles = overrideRoleBindings.length > 0;
  const overrideSubjectRole = overrideRoleBindings.find((b) => b.entity.trim().toLowerCase() === "subject")?.visualRole.trim() ?? "";
  const overrideSecondary = overrideRoleBindings
    .filter((b) => b.entity.trim().toLowerCase() !== "subject")
    .map((b) => ({ label: b.entity.trim(), visualRole: b.visualRole.trim() }));

  const aiSecondaryCharacters = vp.secondaryCharacters ?? [];
  const secondaryCharacters = hasOverrideRoles ? overrideSecondary : aiSecondaryCharacters;
  const hasSecondaryCharacters = secondaryCharacters.some((c) => c.label.trim() && c.visualRole.trim());
  const selectedFrame = vp.archetypeApplication?.selectedFrame ?? "";
  const activeActionFrame = isActiveActionFrame(selectedFrame);
  const roleInScene = (hasOverrideRoles && overrideSubjectRole) || vp.subjectTreatment?.roleInScene || "";

  // Moderator SUBJECT REALIZATION (authoritative) — emitted right after binding.
  const subjectRealization = ov ? composeSubjectRealization(ov) : "";
  if (subjectRealization) haystack = `${haystack} ${subjectRealization}`;

  // ADDITIVE ROLE DETAILS — replaces the old REFERENCE INTERPRETATION. Now that
  // the Visual Concept leads and carries the gag, this only surfaces roles the
  // scene OMITTED, and never doubles a name ("Alex is Alex leans…"). Drops are
  // recorded for admin diagnostics.
  const roleDetailsRaw = composeAdditiveRoleDetails({
    subjectName,
    roleInScene,
    secondaryCharacters,
    includeSubjectRole: hasSecondaryCharacters || activeActionFrame || Boolean(overrideSubjectRole),
    haystack,
  });
  // When moderator roleBindings make this section required + non-compressible
  // (below), cap its own contribution — up to 20 bindings can combine into
  // more text than the section-level schema caps alone would suggest (see
  // ROLE_DETAILS_MAX_CHARS). Purely AI-authored role details stay
  // high/compressible, so the normal budget fit already protects them.
  const roleDetailsText = hasOverrideRoles
    ? fitSentences(roleDetailsRaw.text, ROLE_DETAILS_MAX_CHARS)
    : roleDetailsRaw.text;
  if (roleDetailsText.length < roleDetailsRaw.text.length) {
    notes.push("Capped role_details to its safety budget (moderator roleBindings).");
  }
  const roleDetails = { text: roleDetailsText, dropped: roleDetailsRaw.dropped };
  if (roleDetails.text) haystack = `${haystack} ${roleDetails.text}`;

  // SUBJECT DETAILS — subject-specific visible details (strictly additive), plus
  // expression/pose and key-element gap-fill. Modifiers are NOT re-injected as
  // prose (their structural effects have dedicated owners).
  const subjectListBody = composeListBody(vp.subjectDetails ?? [], haystack);
  const expressionPose = scrubIntentLanguage(vp.subjectTreatment?.expressionAndPose ?? "");
  const keyElements = composeKeyElementsDirective(vp, `${haystack} ${subjectListBody}`);
  const subjectDetails = [
    subjectListBody,
    expressionPose && !coveredWithContiguity(haystack, expressionPose) ? `${expressionPose.replace(/[.!?]+$/, "")}.` : "",
    keyElements.text,
  ].filter(Boolean).join(" ");
  if (subjectDetails) haystack = `${haystack} ${subjectDetails}`;

  // REQUIRED VISUAL DETAILS (moderator, authoritative).
  const requiredVisualDetails = ov ? composeOverrideList(ov.requiredVisualDetails) : "";
  if (requiredVisualDetails) haystack = `${haystack} ${requiredVisualDetails}`;

  // ENVIRONMENT — setting, background, props, scale (strictly additive).
  const environment = composeListBody(vp.environment ?? [], haystack);
  if (environment) haystack = `${haystack} ${environment}`;

  // ADDITIONAL DETAILS (moderator style-agnostic additions).
  const additionalDetails = ov ? composeOverrideList(ov.styleAgnosticPromptAdditions) : "";
  if (additionalDetails) haystack = `${haystack} ${additionalDetails}`;

  // COMPOSITION — framing + camera + caption negative space, plus moderator
  // composition guidance.
  const composition = [
    composeCompositionDirective(vp, haystack),
    ov ? composeOverrideList(ov.compositionGuidance) : "",
  ].filter(Boolean).join(" ");
  if (composition) haystack = `${haystack} ${composition}`;

  // 7. LIGHTING — physical light/mood/palette ONLY (medium-neutral). The selected
  // visual style is emitted separately as RENDER STYLE (single channel), so a
  // style can never overlap or fight the scene's own lighting. Terminated so the
  // assembler's sentence-aware de-dupe keeps it.
  const lightingCore = scrubIntentLanguage(vp.lightingAndStyle ?? "").trim().replace(/[.!?]+$/, "");
  const lighting = lightingCore ? `${lightingCore}.` : "";

  // 7b. RENDER STYLE — the compiler-owned SINGLE style channel: the resolved
  // style suffix (input.stylePrompt), or the photorealistic default when no
  // style is selected. Required so a chosen style always survives the budget.
  const renderStyle = input.stylePrompt?.trim() || DEFAULT_PHOTOREALISTIC_STYLE;

  // 8. STRICT CONSTRAINTS — supporting-text rule, violence policy, and the
  // negative anti-entity-split guards. Cultural references AND semantic entities
  // are NOT emitted as interpretation meta; they inform the planner, and their
  // concrete visual reaches the engine via the visible-elements gap-fill above.
  const renderPolicy: RenderPolicy = input.renderPolicy ?? DEFAULT_RENDER_POLICY;
  const supportingText = composeSupportingTextDirective(vp, renderPolicy.supportingText);
  const violence = composeViolenceDirective(renderPolicy.violence, {
    relevant: isViolenceRelevant(input, vp),
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
  // Moderator forbidden visual details + negative-prompt additions, as "Do not …"
  // lines, appended after the compiler's own constraints.
  const overrideForbidden = ov ? composeOverrideForbidden(ov) : "";
  const strictConstraints = [supportingText, violence, antiSplit, failureModes, overrideForbidden].filter(Boolean).join(" ");

  // Emitted order (CORE SCENE first — the Visual Concept leads). The override
  // sections sit at required/high priority so moderator intent survives the char
  // budget. A moderator-authored core scene is required + non-compressible: the
  // joke must never be compressed out. AI-authored keeps high/compressible.
  // Same rule for ROLE DETAILS: when a moderator supplies roleBindings, this
  // section is the only compiled place those bindings reach the engine (unless
  // the core scene already restates them), so it must survive the char budget
  // like any other moderator override — required + non-compressible. Purely
  // AI-authored role details keep high/compressible.
  const rawSections: Section[] = [
    {
      id: "core_scene",
      label: "CORE SCENE",
      text: labeled("CORE SCENE", coreScene),
      priority: coreSceneModeratorAuthored ? "required" : "high",
      compressible: !coreSceneModeratorAuthored,
      ...(coreSceneModeratorAuthored ? { moderatorAuthored: true } : {}),
    },
    { id: mode.sectionId, label: mode.sectionLabel, text: labeled(mode.sectionLabel, taskBody), priority: "required" },
    { id: "subject_binding", label: "SUBJECT BINDING", text: labeled("SUBJECT BINDING", binding), priority: "required" },
    { id: "subject_realization", label: "SUBJECT REALIZATION", text: labeled("SUBJECT REALIZATION", subjectRealization), priority: "required" },
    {
      id: "role_details",
      label: "ROLE DETAILS",
      text: labeled("ROLE DETAILS", roleDetails.text),
      priority: hasOverrideRoles ? "required" : "high",
      compressible: !hasOverrideRoles,
      ...(hasOverrideRoles ? { moderatorAuthored: true } : {}),
    },
    { id: "subject_details", label: "SUBJECT DETAILS", text: labeled("SUBJECT DETAILS", subjectDetails), priority: "high", compressible: true },
    { id: "required_visual_details", label: "REQUIRED VISUAL DETAILS", text: labeled("REQUIRED VISUAL DETAILS", requiredVisualDetails), priority: "required" },
    { id: "environment", label: "ENVIRONMENT", text: labeled("ENVIRONMENT", environment), priority: "high", compressible: true },
    { id: "additional_details", label: "ADDITIONAL DETAILS", text: labeled("ADDITIONAL DETAILS", additionalDetails), priority: "high", compressible: true },
    { id: "composition", label: "COMPOSITION", text: labeled("COMPOSITION", composition), priority: "high" },
    { id: "lighting", label: "LIGHTING", text: labeled("LIGHTING", lighting), priority: "medium", compressible: true },
    { id: "render_style", label: "RENDER STYLE", text: labeled("RENDER STYLE", renderStyle), priority: "required" },
    { id: "strict_constraints", label: "STRICT CONSTRAINTS", text: labeled("STRICT CONSTRAINTS", strictConstraints), priority: "required" },
  ];

  // Final identity gate: resolve any residual {NAME}/{SUBJ}/… tokens the LLM
  // echoed (e.g. from a semantic entity whose surfaceText is "{NAME}") BEFORE
  // assembly, so neither the engine prompt nor the debug breakdown ever carries
  // a raw template token.
  const sections = rawSections.map((s) => ({ ...s, text: renderIdentityTokens(s.text, args.renderedSubject) }));

  const { prompt: finalPrompt, breakdown } = assembleSections(sections, notes);

  const warnings = [
    ...moderatorCoreWarnings,
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

  // Defensive: every section was token-rendered above, so the final prompt must
  // carry no unresolved {NAME}/{SUBJ}/… tokens (a moderator override field or an
  // LLM echo could otherwise leak one). Surface it as a warning rather than ship
  // a token to the engine.
  if (hasUnresolvedFactTokens(finalPrompt)) {
    warnings.push({
      code: "unresolved-token-in-final-prompt",
      severity: "warning",
      message: "The compiled prompt still contains an unresolved personalization token; check the moderator override and fact text.",
    });
  }

  // Structured record of concrete role/key-element candidates the compiler chose
  // NOT to emit (redundant-with-scene, or a non-visible "crutch" line), so admins
  // can see WHY an expected detail didn't reach the prompt.
  const droppedCandidates = [...roleDetails.dropped, ...keyElements.dropped];

  const out: CompiledImagePrompt = {
    prompt: finalPrompt,
    imagePrompt: finalPrompt,
    promptBreakdown: breakdown,
    diagnostics: {
      removedPlannerProseSentences: removedProse,
      warnings,
      ...(droppedCandidates.length ? { droppedCandidates } : {}),
    },
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
    sectionLabel: "IDENTITY & REFERENCE",
    sectionId: "identity_reference",
    requiredClauses: [],
    withReferenceUrl: true,
  });
}

export function compileNanoBanana2NonhumanI2I(args: CompileArgs): CompiledImagePrompt {
  // The preamble already carries the required "Do not replace the subject with a
  // human." guard, so no extra clause is needed — and adding a paraphrase would
  // duplicate the instruction.
  return compile(args, {
    preamble: NONHUMAN_I2I_PREAMBLE,
    sectionLabel: "IDENTITY & REFERENCE",
    sectionId: "identity_reference",
    requiredClauses: [],
    withReferenceUrl: true,
  });
}

export function compileNanoBanana2T2I(args: CompileArgs): CompiledImagePrompt {
  const gender = args.input.renderControls.fallbackSubjectGender;
  return compile(args, {
    preamble: T2I_PREAMBLE,
    sectionLabel: "RENDER TASK",
    sectionId: "render_task",
    requiredClauses: gender ? [`Render a ${gender} protagonist.`] : [],
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
