/**
 * Nano Banana 2 prompt compilers (Phase 2).
 *
 * Three engine-specific compilers, one per SubjectRenderMode. Strategy: use
 * OpenAI's `compiledPrompt.prompt` directly + targeted post-processing to
 * inject the mode-appropriate preamble if the LLM omitted it (the validator
 * already enforced must-include language; the preamble is belt-and-suspenders).
 *
 * Output `imagePrompt` mirrors `prompt` and is what `buildEngineInput` reads.
 * For i2i variants, `referenceImageUrl` is also returned so the caller can
 * pass it into the engine's `image_urls` slot.
 */

import type {
  VisualPlan,
  CompiledPrompt,
  ImagePromptGenerationInput,
} from "@workspace/api-zod";
import type { CompiledImagePrompt } from "../types";

const MAX_PROMPT_CHARS = 4000;

interface CompileArgs {
  visualPlan: VisualPlan;
  compiledPrompt: CompiledPrompt;
  input: ImagePromptGenerationInput;
}

const HUMAN_I2I_PREAMBLE =
  "Image-to-image edit using the reference image as the person's facial identity source. Preserve the reference person's recognizable face. ";
const NONHUMAN_I2I_PREAMBLE =
  "Image-to-image edit using the reference image as the visual identity source for the uploaded subject. The uploaded subject visually represents the named subject in the fact. Preserve the uploaded subject's recognizable visual identity. Do not replace the subject with a human. ";
const T2I_PREAMBLE =
  "Text-to-image generation. No reference identity is being preserved. Generate a protagonist matching fallback subject gender/profile guidance. ";

function appendIfMissing(prompt: string, suffix: string): string {
  if (!suffix.trim()) return prompt;
  const haystack = prompt.toLowerCase();
  const needle = suffix.trim().toLowerCase();
  if (haystack.includes(needle)) return prompt;
  return `${prompt.trim()} ${suffix.trim()}`;
}

/** Split a prompt blob into trimmed sentences, keeping terminal punctuation. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (matches) return matches.map((s) => s.trim()).filter(Boolean);
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeSentence(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Prepend the preamble, but drop any preamble sentence already present
 * (verbatim) in the prompt. The preambles are multi-sentence belt-and-suspenders
 * blocks; the generator frequently emits some of the same required sentences
 * (e.g. the non-human "Do not replace the subject with a human." guard the
 * validator enforces). Prepending the preamble as one unit duplicated those
 * sentences — this de-dupes at sentence granularity so each clause appears once.
 */
function prependMissingSentences(prompt: string, preamble: string): string {
  const present = new Set(splitSentences(prompt).map(normalizeSentence));
  const missing = splitSentences(preamble).filter((s) => !present.has(normalizeSentence(s)));
  if (missing.length === 0) return prompt.trim();
  return `${missing.join(" ")} ${prompt.trim()}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function finalize(prompt: string, args: CompileArgs, withReferenceUrl: boolean): CompiledImagePrompt {
  const styleAdded = appendIfMissing(prompt, args.input.stylePrompt);
  const final = truncate(styleAdded, MAX_PROMPT_CHARS);
  const out: CompiledImagePrompt = {
    prompt: final,
    imagePrompt: final,
  };
  if (args.compiledPrompt.negativePrompt && args.compiledPrompt.negativePrompt.trim().length > 0) {
    out.negativePrompt = args.compiledPrompt.negativePrompt.trim();
  }
  if (args.compiledPrompt.engineNotes && args.compiledPrompt.engineNotes.trim().length > 0) {
    out.engineNotes = args.compiledPrompt.engineNotes.trim();
  }
  if (withReferenceUrl && args.input.referenceImageUrl) {
    out.referenceImageUrl = args.input.referenceImageUrl;
  }
  return out;
}

export function compileNanoBanana2HumanI2I(args: CompileArgs): CompiledImagePrompt {
  const prompt = prependMissingSentences(args.compiledPrompt.prompt, HUMAN_I2I_PREAMBLE);
  return finalize(prompt, args, /* withReferenceUrl */ true);
}

export function compileNanoBanana2NonhumanI2I(args: CompileArgs): CompiledImagePrompt {
  let prompt = prependMissingSentences(args.compiledPrompt.prompt, NONHUMAN_I2I_PREAMBLE);
  // Defensive: ensure the "do not replace with a human" clause appears even
  // if the LLM picked a paraphrase that fooled the validator regex.
  if (!/do\s+not\s+replace.*human|never\s+replace.*human/i.test(prompt)) {
    prompt = `${prompt.trim()} Do not replace the uploaded subject with a human.`;
  }
  return finalize(prompt, args, /* withReferenceUrl */ true);
}

export function compileNanoBanana2T2I(args: CompileArgs): CompiledImagePrompt {
  let prompt = prependMissingSentences(args.compiledPrompt.prompt, T2I_PREAMBLE);
  // If the caller provided a fallbackSubjectGender, make sure it appears.
  const gender = args.input.renderControls.fallbackSubjectGender;
  if (gender) {
    const re = new RegExp(`\\b${gender}\\b`, "i");
    if (!re.test(prompt)) {
      prompt = `${prompt.trim()} Generate a ${gender} protagonist.`;
    }
  }
  return finalize(prompt, args, /* withReferenceUrl */ false);
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
