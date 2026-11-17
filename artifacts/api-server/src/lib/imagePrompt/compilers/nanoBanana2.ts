/**
 * The Nano Banana 2 / GPT Image prompt compiler: the direct path.
 *
 * A picture is drawn from ONE selected gag's content (its scene, bubbles and
 * cast) and wording that is the same for every fact (the recipe; plan
 * `docs/plans/PLAN_GAG_DIRECT_RENDER.md`). The gag's scene leads the prompt
 * verbatim as CORE SCENE; identity and reference, the fill instruction, the
 * bubbles with their speaker bindings, caption space, the look and the
 * STRICT CONSTRAINTS follow. No planner runs and no classification is read:
 * the render planner and the compiler code that read a fact's enrichment were
 * removed at the switch (plan, D).
 *
 * Output `imagePrompt` mirrors `prompt` and is what `buildEngineInput` reads;
 * `referenceImageUrl` is returned with it.
 */

import type { SubjectRenderMode } from "@workspace/api-zod";
import {
  MANDATORY_FORBIDDEN_TEXT_TYPES,
  detectOwnedLanguage,
  serializeLiteralPromptString,
  BUBBLE_DIRECTIVE_LANGUAGE_RE,
  SPEAKER_BINDING_ROLE_MAX_CHARS,
  activeBubbleSpeakers,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import type { CompiledImagePrompt, PromptSection, PromptWarning } from "../types";
import { renderPersonalized, hasUnresolvedFactTokens } from "../../renderCanonical";
import { BASELINE_PIECES, BASELINE_RECIPE, fillPiece, type ResolvedRecipe } from "../recipe";
import { VIOLENCE_RULE } from "../violenceRule";


// Mirrors PROMPT_TOTAL_BUDGET (api-zod promptBudget.ts) — an editorial forcing
// function against bloated/redundant authoring, NOT an engine capacity
// constraint (NB2's context window is ~131K tokens). Raised from 4000 to 6000
// (David, 2026-07-21) to give the moderator authoring pools real headroom, and
// 6000 → 6900 (David, 2026-07-22) to fund the dedicated SPEECH & THOUGHT
// BUBBLES reserve (BUBBLE_DIRECTIVES_RENDERED_MAX), and 6900 → 10150 (David,
// 2026-11-12) for the prompt tuner's editable wording. GPT Image 2.6 accepts
// 32,000 characters and Nano Banana 2.1 50,000.
const MAX_PROMPT_CHARS = 10150;

/**
 * Resolve the identity tokens ({NAME}/{SUBJ}/…) in a section's text with the
 * identity this render draws — a template token must NEVER reach the image
 * engine. No-op when no subject is supplied.
 */
function renderIdentityTokens(text: string, subject?: { name: string; pronouns: string | null }): string {
  if (!subject || !text) return text;
  return renderPersonalized(text, subject.name, subject.pronouns);
}

// The identity preambles are recipe pieces (`identity.person`, `identity.pet`;
// `../recipe.ts`).

// The compiler-owned RENDER STYLE default when no visual style is selected
// (styleId absent or "none"). Medium-only, no lighting instruction — so it can
// never override a scene's deliberate lighting (David's decision, plan §11.4).
// Exported so the shared style resolver (styleResolution.ts) freezes the SAME
// line into a snapshot rather than redefining it.
export const DEFAULT_PHOTOREALISTIC_STYLE = BASELINE_PIECES["style.photoreal"];

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

/**
 * The narrow OVERLAY-text exclusion, derived from MANDATORY_FORBIDDEN_TEXT_TYPES.
 * Always emitted: overlay/caption text (the meme caption, fact text, hashtags,
 * watermarks, logos, brand marks) is composited separately and must never be
 * baked into the image. This is NOT a blanket "no readable text" ban: in-world
 * scene text a gag describes is fully compatible with this line.
 */
const overlayTextExclusion = (r: ResolvedRecipe) => fillPiece(r, "text.overlay", { forbidden: MANDATORY_FORBIDDEN_TEXT_TYPES.join(", ") });

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
const incidentalTextGuard = (r: ResolvedRecipe) => fillPiece(r, "text.incidental");

// ─── Speech & thought bubbles (moderator-authored, compiler-owned language) ──

/**
 * The one deterministic directive per bubble. `who` must already be the
 * RENDERED attribution target (subject name / mode noun / role label as
 * written) and `text` must already be token-RENDERED — serialization runs last
 * (token-before-escape contract, `serializeLiteralPromptString`).
 */
export function composeBubbleDirective(
  bubble: Pick<VisualStrategyBubble, "type" | "text">,
  who: string,
  r: ResolvedRecipe = BASELINE_RECIPE,
): string {
  // Wording is deliberately COMPACT: each directive is billed to the finite
  // BUBBLE_DIRECTIVES_RENDERED_MAX pool, so every fixed word here directly
  // shrinks how many bubbles fit. Keep the four load-bearing parts — balloon
  // shape, tail/trail attribution to <who>, the exact-literal contract, and
  // legibility — and nothing else (in-scene-ness is stated once by the
  // carveout line).
  const literal = serializeLiteralPromptString(bubble.text);
  return fillPiece(r, bubble.type === "speech" ? "bubbles.speech" : "bubbles.thought", { who, text: literal });
}

/** Trailing carveout emitted once after the directives: makes the precedence
 *  over the overlay-caption exclusion and any forbid-mode text policy explicit
 *  IN the compiled language (a balloon is in-scene graphic text, not an
 *  overlay caption). */

/** Shorten a visual role to an identifying tag of at most `max` chars, cut at a word boundary. */
export function shortSpeakerRole(visualRole: string, max: number = SPEAKER_BINDING_ROLE_MAX_CHARS): string {
  const role = visualRole.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (role.length <= max) return role;
  const cut = role.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : role.slice(0, max)).replace(/[,;:\-–—\s]+$/, "");
}

/**
 * Speaker bindings (PLAN_BUBBLE_SPEAKERS.md, F): for every non-subject bubble
 * speaker that has a source, a short line tying its exact label to a visible
 * character, so the engine knows who "mom" is even when the scene describes
 * her without naming her (ROLE DETAILS drops an entry whose role the scene
 * already covers, and its cap can cut one).
 *
 * Always emitted — never skipped because the label happens to appear in some
 * other role text, which proves nothing about which person it means (Codex,
 * PR #973 round 1). Source per speaker: the effective (post-precedence)
 * character with that label — a moderator's Scene Role Assignment wins — else
 * the planner's own character with that label, so a speaker the gag's roles
 * leave out is still supplemented from the plan. Lines are bounded (label ≤ 60
 * by schema, role ≤ SPEAKER_BINDING_ROLE_MAX_CHARS), so they fit
 * SPEAKER_BINDINGS_RENDERED_MAX.
 */
export function composeSpeakerBindings(opts: {
  speakers: readonly string[];
  effective: ReadonlyArray<{ label: string; visualRole: string }>;
  planned: ReadonlyArray<{ label: string; visualRole: string }>;
}): { text: string; boundLabels: string[] } {
  const lines: string[] = [];
  const boundLabels: string[] = [];
  const find = (list: ReadonlyArray<{ label: string; visualRole: string }>, key: string) =>
    list.find((c) => c.label.trim().toLowerCase() === key && c.visualRole.trim());
  for (const speaker of opts.speakers) {
    const label = speaker.trim();
    const key = label.toLowerCase();
    if (!key) continue;
    const source = find(opts.effective, key) ?? find(opts.planned, key);
    if (!source) continue; // unbound — the bubble diagnostics warn
    const role = shortSpeakerRole(source.visualRole);
    if (!role) continue;
    lines.push(`${label}: ${role}.`);
    boundLabels.push(label);
  }
  return { text: lines.join(" "), boundLabels };
}

export interface BubbleDirectivesResult {
  text: string;
  warnings: PromptWarning[];
}

/**
 * Compose the SPEECH & THOUGHT BUBBLES section body: one atomic directive per
 * valid bubble, in STORED ORDER (moderator order is intent — never sorted),
 * with incomplete mid-edit rows (empty entity or text) skipped, plus the
 * carveout line. Emits structured entity diagnostics against the EFFECTIVE
 * scene characters (subject + active role bindings + the planner's secondary
 * characters), so a valid secondary-speaker bubble doesn't false-warn:
 *   - `bubble_entity_unresolved`: no effective character matches;
 *   - `bubble_entity_ambiguous`: several effective labels collide with it.
 */
export function composeBubbleDirectives(opts: {
  bubbles: readonly VisualStrategyBubble[];
  /** Rendered attribution noun for entity "subject" (name or mode noun). */
  subjectNoun: string;
  /** Effective non-subject character labels in the scene (post-precedence). */
  effectiveCharacterLabels: readonly string[];
  /**
   * Labels the compiled prompt actually ties to a visible character (a speaker
   * binding, or a required ROLE DETAILS clause). When given, "unresolved" is
   * judged against THESE — what the engine receives — not the planner's array
   * (PLAN_BUBBLE_SPEAKERS.md, F). Ambiguity still reads the effective labels.
   */
  boundLabels?: readonly string[];
  renderText: (text: string) => string;
  /** The global wording; omitted means the baseline. */
  recipe?: ResolvedRecipe;
}): BubbleDirectivesResult {
  const r = opts.recipe ?? BASELINE_RECIPE;
  const warnings: PromptWarning[] = [];
  const directives: string[] = [];
  const normalizedLabels = opts.effectiveCharacterLabels
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const bound = opts.boundLabels ? new Set(opts.boundLabels.map((l) => l.trim().toLowerCase())) : null;

  opts.bubbles.forEach((bubble, i) => {
    const entity = bubble.entity.trim();
    const text = bubble.text.trim();
    if (!entity || !text) return; // incomplete mid-edit row
    const isSubject = entity.toLowerCase() === "subject";
    const who = isSubject ? opts.subjectNoun : entity;
    if (!isSubject) {
      const matches = normalizedLabels.filter((l) => l === entity.toLowerCase()).length;
      const unresolved = bound ? !bound.has(entity.toLowerCase()) : matches === 0;
      if (unresolved) {
        warnings.push({
          code: "bubble_entity_unresolved",
          severity: "warning",
          message: `Bubble ${i + 1} is attributed to "${entity}", which matches no character in the scene (subject, role bindings, or planned secondary characters). The directive still renders; the model may introduce, ignore, or misattribute that character — confirm the render.`,
          context: { bubbleIndex: i, entity },
        });
      } else if (matches > 1) {
        warnings.push({
          code: "bubble_entity_ambiguous",
          severity: "warning",
          message: `Bubble ${i + 1} is attributed to "${entity}", which matches more than one scene character — the balloon's tail attribution may land on the wrong one.`,
          context: { bubbleIndex: i, entity },
        });
      }
    }
    directives.push(composeBubbleDirective({ type: bubble.type, text: opts.renderText(text) }, who, r));
  });

  if (directives.length === 0) return { text: "", warnings: [] };
  return { text: `${directives.join(" ")} ${fillPiece(r, "bubbles.carveout")}`, warnings };
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


// ─── Labeled-section formatting ─────────────────────────────────────────────

/** Write a non-empty body as a section in the recipe's shape (`shape.section`, by default "LABEL: body"); "" stays "". */
function labeled(r: ResolvedRecipe, header: string, body: string): string {
  const b = body.trim();
  return b ? fillPiece(r, "shape.section", { label: header, body: b }) : "";
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
  /** "none" exempts the section from generic sentence de-duplication —
   *  verbatim moderator content (the bubble directives) must never be
   *  suppressed because CORE SCENE or a planner delta used the same words. */
  dedupe?: "normal" | "none";
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
  /** What sits between two sections (the recipe's `shape.join`; a space by default). */
  sep = " ",
): { prompt: string; breakdown: PromptSection[]; overflowBy: number } {
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
    const reserve = sections[i]!.priority === "required" && raw ? raw.length + sep.length : 0;
    requiredLenAfter[i] = requiredLenAfter[i + 1] + reserve;
  }

  for (let idx = 0; idx < sections.length; idx++) {
    const section = sections[idx]!;
    const raw = section.text.trim();
    if (!raw) {
      record(section, "empty", "", "");
      continue;
    }
    const deduped = section.dedupe === "none" ? raw : dedupeSentences(raw, assembled);
    if (!deduped) {
      record(section, "deduped", "", raw);
      continue;
    }
    const candidate = assembled ? `${assembled}${sep}${deduped}` : deduped;
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
      const remaining = MAX_PROMPT_CHARS - reserve - assembled.length - sep.length;
      const fitted = fitSentences(deduped, remaining);
      if (fitted) {
        assembled = assembled ? `${assembled}${sep}${fitted}` : fitted;
        notes.push(`Compressed ${section.id} to fit the engine prompt budget.`);
        record(section, "compressed", fitted, raw);
        continue;
      }
    }
    notes.push(`Dropped ${section.id} (over the engine prompt budget).`);
    record(section, "dropped", "", raw);
  }

  const prompt = assembled.trim();
  // §10.5: do NOT silently hard-truncate required content (that used to lop the
  // STRICT CONSTRAINTS policy guardrails off the end). If required content alone
  // overflows the budget — impossible for save-validated content (§10.1–10.3),
  // reachable only by legacy over-budget rows — surface it so the caller fails
  // loud + terminal rather than shipping a guardrail-truncated prompt.
  const overflowBy = Math.max(0, prompt.length - MAX_PROMPT_CHARS);
  if (overflowBy > 0) {
    notes.push(`Required content exceeds the engine prompt budget by ${overflowBy} characters.`);
  }
  return { prompt, breakdown, overflowBy };
}

type LabelKey = "coreScene" | "identityReference" | "subjectBinding" | "subjectRealization" | "roleDetails" | "subjectDetails" | "requiredVisualDetails" | "environment" | "additionalDetails" | "bubbles" | "composition" | "lighting" | "engineNotes" | "renderStyle" | "strictConstraints";

/**
 * The moderator scene is verbatim (warn, never strip): compiler-owned
 * language in it, and a balloon it describes itself while structured bubbles
 * are configured (which would double-render), are reported here. One copy
 * for the planned and the direct paths.
 */
function moderatorSceneWarnings(scene: string, hasBubbles: boolean): PromptWarning[] {
  const warnings: PromptWarning[] = [];
  const owned = detectOwnedLanguage(scene);
  if (owned) {
    warnings.push({
      code: "moderator_core_scene_owned_language",
      severity: "warning",
      message: `The Visual concept contains ${owned.category} language the compiler owns ("${owned.matchedText}"). It is rendered verbatim as authored; rewrite it as visible scene description only so the compiler's identity/reference/text-policy clauses stay the single source.`,
    });
  }
  if (hasBubbles && BUBBLE_DIRECTIVE_LANGUAGE_RE.test(scene)) {
    warnings.push({
      code: "bubble_language_in_moderator_scene",
      severity: "warning",
      message:
        "The Visual concept describes a speech/thought balloon while structured bubbles are configured. The SPEECH & THOUGHT BUBBLES section owns balloon rendering — describe only the staging (pose, expression, headroom) in the Concept to avoid a doubled balloon.",
    });
  }
  return warnings;
}

// ─── The direct path (no planner) ──────────────────────────────────────────
//
// Plan `docs/plans/PLAN_GAG_DIRECT_RENDER.md`, *Proposed Design* A: a picture
// drawn from ONE selected gag's content and wording that is the same for every
// fact, with no planner call. The input is explicit and holds no
// classification: nothing a fact's enrichment says can reach this prompt, by
// the shape of the arguments. Increment 1 runs it inside the planned-vs-direct
// comparison only; nothing else calls it yet.

/** One cast entry: a character in the gag's scene other than the subject. */
export interface DirectCastEntry {
  label: string;
  description: string;
}

export interface DirectCompileArgs {
  /** The one selected gag's content: its scene and its bubbles. */
  gag: { scene: string; bubbles: readonly VisualStrategyBubble[] };
  /** The gag's cast, from cast extraction (`lib/gags/castExtraction.ts`). */
  cast: readonly DirectCastEntry[];
  subjectRenderMode: SubjectRenderMode;
  /** The resolved look's suffix; empty or the photoreal default means no look. */
  stylePrompt?: string | null;
  renderControls?: { negativeSpacePreference?: string | null } | null;
  referenceImageUrl?: string | null;
  renderedSubject?: { name: string; pronouns: string | null };
  recipe?: ResolvedRecipe;
}

/**
 * The direct path's fixed wording for what the gag leaves unstated (the
 * filler hypothesis, plan A): the engine keeps the scene and fills the rest.
 * Code constants for the comparison; whether they become recipe pieces is
 * settled at the switch.
 */
export const DIRECT_FILL_INSTRUCTION =
  "Draw the scene above exactly as described. Where it leaves the setting, background, lighting, poses or expressions unstated, choose plausible details that serve it, and add nothing that changes what happens.";

/** The direct path's fixed wording for a pet's photo (plan A): one line, no per-picture call. */
export const DIRECT_PET_INSTRUCTION =
  "The subject is the animal in the reference image: stage the scene's action for that animal's own body, keeping the action and its outcome, and keep the animal's recognizable features.";

export function compileDirect(args: DirectCompileArgs): CompiledImagePrompt {
  const r = args.recipe ?? BASELINE_RECIPE;
  const notes: string[] = [];
  const mode = args.subjectRenderMode;
  if (mode === "t2i_fallback") throw new Error("no-photo renders are retired: every picture starts from a photo");
  const bindingMode = bindingModeFromRenderMode(mode);
  const subjectName = args.renderedSubject?.name?.trim() ?? "";
  const render = (t: string) => renderIdentityTokens(t, args.renderedSubject);

  const coreScene = render(args.gag.scene.trim());
  if (!coreScene) throw new Error("the direct path needs the gag's scene");
  const activeBubbles = args.gag.bubbles.filter((b) => b.entity.trim() && b.text.trim());
  const warnings: PromptWarning[] = moderatorSceneWarnings(coreScene, activeBubbles.length > 0);

  const identity = [fillPiece(r, mode === "human_identity_i2i" ? "identity.person" : "identity.pet"), mode === "nonhuman_subject_i2i" ? DIRECT_PET_INSTRUCTION : ""]
    .filter(Boolean).join(" ");

  // Speaker bindings come from the gag's own cast: the cast is the effective
  // character list, and no planned list exists.
  const castCharacters = args.cast
    .map((c) => ({ label: c.label.trim(), visualRole: c.description.trim() }))
    .filter((c) => c.label && c.visualRole);
  const speakerBindings = composeSpeakerBindings({ speakers: activeBubbleSpeakers(activeBubbles), effective: castCharacters, planned: [] });
  const bubbleResult = composeBubbleDirectives({
    bubbles: activeBubbles,
    subjectNoun: bindingSubjectNoun(subjectName, bindingMode),
    effectiveCharacterLabels: castCharacters.map((c) => c.label),
    boundLabels: speakerBindings.boundLabels,
    renderText: render,
    recipe: r,
  });
  const bubbleSectionBody = bubbleResult.text ? [speakerBindings.text, bubbleResult.text].filter(Boolean).join(" ") : "";
  warnings.push(...bubbleResult.warnings);

  const side = args.renderControls?.negativeSpacePreference ?? "";
  const composition = ["top", "bottom", "left", "right"].includes(side) ? fillPiece(r, "composition.captionSpace", { side }) : "";

  const stylePrompt = args.stylePrompt?.trim() ?? "";
  const renderStyle = !stylePrompt || stylePrompt === DEFAULT_PHOTOREALISTIC_STYLE ? fillPiece(r, "style.photoreal") : stylePrompt;
  const engineNotesText = fillPiece(r, "notes.engine").trim();
  const strictConstraints = [overlayTextExclusion(r), incidentalTextGuard(r), VIOLENCE_RULE].join(" ");

  const L = (key: LabelKey) => fillPiece(r, `label.${key}`);
  const rawSections: Section[] = [
    { id: "core_scene", label: L("coreScene"), text: labeled(r, L("coreScene"), coreScene), priority: "required", moderatorAuthored: true },
    { id: "identity_reference", label: L("identityReference"), text: labeled(r, L("identityReference"), identity), priority: "required" },
    { id: "additional_details", label: L("additionalDetails"), text: labeled(r, L("additionalDetails"), DIRECT_FILL_INSTRUCTION), priority: "required" },
    {
      id: "bubbles", label: L("bubbles"), text: labeled(r, L("bubbles"), bubbleSectionBody), priority: "required", dedupe: "none",
      ...(activeBubbles.length ? { moderatorAuthored: true } : {}),
    },
    { id: "composition", label: L("composition"), text: labeled(r, L("composition"), composition), priority: "high" },
    ...(engineNotesText
      ? [{ id: "engine_notes", label: L("engineNotes"), text: labeled(r, L("engineNotes"), engineNotesText), priority: "required" as const }]
      : []),
    { id: "render_style", label: L("renderStyle"), text: labeled(r, L("renderStyle"), renderStyle), priority: "required" },
    { id: "strict_constraints", label: L("strictConstraints"), text: labeled(r, L("strictConstraints"), strictConstraints), priority: "required" },
  ];
  const sections = rawSections.map((s) => ({ ...s, text: render(s.text) }));

  const { prompt, breakdown, overflowBy } = assembleSections(sections, notes, r.pieces["shape.join"] || " ");
  if (hasUnresolvedFactTokens(prompt)) {
    warnings.push({
      code: "unresolved-token-in-final-prompt",
      severity: "warning",
      message: "The compiled prompt still contains an unresolved personalization token; check the gag's scene and bubbles.",
    });
  }
  const out: CompiledImagePrompt = {
    prompt,
    imagePrompt: prompt,
    promptBreakdown: breakdown,
    diagnostics: {
      removedPlannerProseSentences: [],
      warnings,
      ...(overflowBy > 0 ? { requiredBudgetOverflow: { overBy: overflowBy, totalLength: prompt.length, budget: MAX_PROMPT_CHARS } } : {}),
    },
  };
  if (notes.length) out.engineNotes = notes.join(" ");
  if (args.referenceImageUrl) out.referenceImageUrl = args.referenceImageUrl;
  return out;
}

// ─── Per-mode entry points ─────────────────────────────────────────────────
