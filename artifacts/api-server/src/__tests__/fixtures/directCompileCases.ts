/**
 * The inputs of the direct compile's captured-prompt pin (plan
 * docs/plans/PLAN_GAG_DIRECT_RENDER.md, *Testing Plan*: "The direct compile
 * is pinned by a captured corpus"). Each case is one gag drawn one way; the
 * prompts it compiled to when the switch landed are in
 * `directCompileBaseline.json`, one per engine family's baseline wording.
 * The cases cover each section the direct compile can emit: a person's and a
 * pet's photo, no balloons, a subject balloon, two speakers bound from the
 * cast, an unbound speaker, a quoted balloon, caption space on each side, a
 * chosen look, tokens in the scene and the balloons, and a long scene.
 *
 * Regenerate the JSON only for a deliberate wording change, and say so in
 * the pull request: `node --import tsx src/__tests__/fixtures/captureDirectCompileBaseline.ts`.
 */
import type { DirectCompileArgs } from "../../lib/imagePrompt/compilers/nanoBanana2.js";

type Case = { name: string; args: Omit<DirectCompileArgs, "recipe"> };

const person = { name: "David Franklin", pronouns: "he/him" } as const;
const pet = { name: "Whiskers", pronouns: "they/them" } as const;
const ref = "https://example.test/reference.jpg";

export const DIRECT_COMPILE_CASES: readonly Case[] = [
  {
    name: "person, plain scene",
    args: { gag: { scene: "{NAME} bench-presses a city bus in a crowded gym.", bubbles: [] }, cast: [], subjectRenderMode: "human_identity_i2i", renderedSubject: person, referenceImageUrl: ref },
  },
  {
    name: "pet, plain scene",
    args: { gag: { scene: "{NAME} sits on a throne of chew toys while three dogs bow.", bubbles: [] }, cast: [], subjectRenderMode: "nonhuman_subject_i2i", renderedSubject: pet, referenceImageUrl: ref },
  },
  {
    name: "person, subject balloon, caption at the bottom",
    args: {
      gag: { scene: "{NAME} catches a falling piano with one hand, coffee in the other.", bubbles: [{ type: "speech", entity: "subject", text: "Morning, {NAME_POSSESSIVE} neighbours." }] },
      cast: [], subjectRenderMode: "human_identity_i2i", renderedSubject: person, referenceImageUrl: ref,
      renderControls: { negativeSpacePreference: "bottom" },
    },
  },
  {
    name: "person, two speakers bound from the cast",
    args: {
      gag: {
        scene: "{NAME} drives {POSS} mom home from the hospital as a newborn, tiny hands on the wheel; a nurse waves from the doorway.",
        bubbles: [
          { type: "speech", entity: "mom", text: "Slow down, {NAME}!" },
          { type: "thought", entity: "nurse", text: "Fastest discharge ever." },
          { type: "thought", entity: "subject", text: "Nailed it." },
        ],
      },
      cast: [
        { label: "mom", description: "the woman in the passenger seat gripping the dashboard" },
        { label: "nurse", description: "the nurse in blue scrubs waving from the doorway" },
      ],
      subjectRenderMode: "human_identity_i2i", renderedSubject: person, referenceImageUrl: ref,
    },
  },
  {
    name: "person, a speaker the cast does not hold",
    args: {
      gag: { scene: "{NAME} wins a staring contest against the sun.", bubbles: [{ type: "speech", entity: "referee", text: "Unbelievable." }] },
      cast: [], subjectRenderMode: "human_identity_i2i", renderedSubject: person, referenceImageUrl: ref,
    },
  },
  {
    name: "pet, quoted balloon and a chosen look, caption on top",
    args: {
      gag: { scene: "{NAME} files the household taxes at a tiny desk.", bubbles: [{ type: "speech", entity: "subject", text: "Who wrote \"miscellaneous\" here?" }] },
      cast: [], subjectRenderMode: "nonhuman_subject_i2i", renderedSubject: pet, referenceImageUrl: ref,
      stylePrompt: "Rendered as a 1950s comic book panel with halftone shading.",
      renderControls: { negativeSpacePreference: "top" },
    },
  },
  {
    name: "person, caption on the left, an incomplete balloon row skipped",
    args: {
      gag: { scene: "{NAME} teaches a black belt class to a room of grizzly bears.", bubbles: [{ type: "speech", entity: "subject", text: "Again." }, { type: "speech", entity: "", text: "" }] },
      cast: [], subjectRenderMode: "human_identity_i2i", renderedSubject: person, referenceImageUrl: ref,
      renderControls: { negativeSpacePreference: "left" },
    },
  },
  {
    name: "person, long scene, caption on the right",
    args: {
      gag: {
        scene: Array.from({ length: 12 }, (_, i) => `Beat ${i + 1}: {NAME} out-negotiates a different world leader over a game of chess played on a moving train.`).join(" "),
        bubbles: [],
      },
      cast: [], subjectRenderMode: "human_identity_i2i", renderedSubject: person, referenceImageUrl: ref,
      renderControls: { negativeSpacePreference: "right" },
    },
  },
];

/** The engine families whose baseline wording the pin compiles each case with. */
export const DIRECT_COMPILE_FAMILIES = ["nano-banana-2", "gpt-image-2-6", "nano-banana-2-1"] as const;
