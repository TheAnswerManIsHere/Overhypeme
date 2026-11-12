/**
 * Prompt recipes — every piece of GLOBAL wording the image-prompt compiler
 * owns, as named templates (the prompt tuner, part 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* A).
 *
 * - **Global, never fact-specific.** A recipe holds only the wording that is
 *   the same for every fact (David, 2026-11-12: *"I should be able to modify
 *   any section of the prompt that is compiled into the final prompt … for
 *   this exercise, we're looking only at global elements."*). The approved
 *   gag, the moderator's sections, the planner's scene description and a look
 *   style's own text never come from a recipe.
 * - **The baseline is today's wording, exactly.** `BASELINE_RECIPE` holds the
 *   strings the compiler emitted before recipes existed; compiling with it
 *   reproduces the captured corpus (`__tests__/fixtures/compilerBaseline.json`)
 *   byte for byte.
 * - **Templates with named slots.** `{subject}`, `{side}` and the like are
 *   filled by the compiler; a version that drops a slot its piece requires,
 *   or names one it does not have, is refused (`recipeProblems`).
 * - **When a line appears is the compiler's.** A recipe changes a line's
 *   wording, never the condition under which it is emitted.
 * - **Policy pieces** (the overlay-text and incidental-text rules and the
 *   violence lines) can be reworded but never emptied, and promoting a change
 *   to one asks a second confirmation (David, 2026-11-12).
 * - **Section order is fixed**; the section labels are pieces.
 */

export type RecipeGroup = "labels" | "identity" | "binding" | "constraints" | "composition" | "style" | "text" | "violence" | "bubbles" | "notes";

export interface RecipePieceDef {
  key: string;
  /** What the piece is, in plain words, for the editor. */
  label: string;
  group: RecipeGroup;
  /** When the compiler emits it, in plain words. */
  when: string;
  /** Slots the piece must contain, each exactly as `{slot}`. */
  slots: readonly string[];
  /** Reworded freely but never emptied; a change asks a second confirmation at promotion. */
  policy?: boolean;
  /** Today's wording. */
  text: string;
}

const label = (key: string, text: string, when = "Whenever the section has content."): RecipePieceDef =>
  ({ key: `label.${key}`, label: `Section label: ${text}`, group: "labels", when, slots: [], text });

/** Every global piece, in the order the editor shows them. */
export const RECIPE_PIECES = [
  // ── Section labels (order fixed; the words are editable) ───────────────────
  label("coreScene", "CORE SCENE"),
  label("identityReference", "IDENTITY & REFERENCE", "On a picture made from a supplied photo."),
  label("renderTask", "RENDER TASK", "On a picture made with no photo."),
  label("subjectBinding", "SUBJECT BINDING"),
  label("subjectRealization", "SUBJECT REALIZATION"),
  label("roleDetails", "ROLE DETAILS"),
  label("subjectDetails", "SUBJECT DETAILS"),
  label("requiredVisualDetails", "REQUIRED VISUAL DETAILS"),
  label("environment", "ENVIRONMENT"),
  label("additionalDetails", "ADDITIONAL DETAILS"),
  label("bubbles", "SPEECH & THOUGHT BUBBLES"),
  label("composition", "COMPOSITION"),
  label("lighting", "LIGHTING"),
  label("engineNotes", "ENGINE NOTES", "Whenever this recipe's engine notes are not empty."),
  label("renderStyle", "RENDER STYLE", "Always."),
  label("strictConstraints", "STRICT CONSTRAINTS"),

  // ── Identity ────────────────────────────────────────────────────────────────
  {
    key: "identity.person", label: "Identity: a person's photo", group: "identity",
    when: "On every picture made from a person's photo.", slots: [],
    text: "Image-to-image edit using the reference image as the person's identity source. Preserve the reference person's recognizable identity and likeness — facial features and distinctive characteristics. Allow apparent age, body proportions, hair, clothing, and life stage to transform when the scene requires it, while keeping the same recognizable person.",
  },
  {
    key: "identity.object", label: "Identity: a pet's or object's photo", group: "identity",
    when: "On every picture made from a photo of a pet or an object.", slots: [],
    text: "Image-to-image edit using the reference image as the visual identity source for the uploaded subject. The uploaded subject visually represents the named subject in the fact. Preserve the uploaded subject's recognizable visual identity. Do not replace the subject with a human.",
  },
  {
    key: "identity.none", label: "Render task: no photo", group: "identity",
    when: "On every picture made with no photo.", slots: [],
    text: "Text-to-image generation: render an original protagonist that fits the scene.",
  },
  {
    key: "identity.gender", label: "Render task: the protagonist's gender", group: "identity",
    when: "With no photo, when a gender is set for the protagonist.", slots: ["gender"],
    text: "Render a {gender} protagonist.",
  },

  // ── Subject binding ─────────────────────────────────────────────────────────
  {
    key: "binding.agePerson", label: "Binding: a person shown at another age", group: "binding",
    when: "From a person's photo, on a fact that changes their age.", slots: ["subject", "targetState", "noun"],
    text: "The reference person is {subject}. {subject} is {targetState} in this scene. Render exactly one {subject}. The transformed {noun} IS {subject} — the same person de-aged or aged, not a second person.",
  },
  {
    key: "binding.ageOther", label: "Binding: a subject shown at another age (no person's photo)", group: "binding",
    when: "Without a person's photo, on a fact that changes the subject's age.", slots: ["subject", "targetState"],
    text: "{subject} is {targetState} in this scene — the same subject rendered at that life stage, not a different individual. Render exactly one {subject}.",
  },
  {
    key: "binding.singlePerson", label: "Binding: exactly one of the person", group: "binding",
    when: "From a person's photo, on a fact marked \"avoid a duplicate subject\".", slots: ["subject"],
    text: "The reference person is {subject}. Render exactly one {subject} — a single instance.",
  },
  {
    key: "binding.singleOther", label: "Binding: exactly one of the subject", group: "binding",
    when: "Without a person's photo, on a fact marked \"avoid a duplicate subject\".", slots: ["subject"],
    text: "Render exactly one {subject} — a single instance.",
  },

  // ── Constraints ─────────────────────────────────────────────────────────────
  {
    key: "constraints.agePerson", label: "Do-nots: a person shown at another age", group: "constraints",
    when: "From a person's photo, on a fact that changes their age.", slots: ["subject", "noun"],
    text: "Do not render the adult reference person separately. Do not add a second, generic {noun}. Do not show both an adult {subject} and a {noun} in the same frame.",
  },
  {
    key: "constraints.ageOther", label: "Do-nots: a subject shown at another age", group: "constraints",
    when: "Without a person's photo, on a fact that changes the subject's age.", slots: ["noun"],
    text: "Do not add a separate, generic {noun}. Do not show the subject at two ages or life stages in the same frame.",
  },
  {
    key: "constraints.duplicate", label: "Do-not: duplicates of the subject", group: "constraints",
    when: "On a fact marked \"avoid a duplicate subject\".", slots: ["subject"],
    text: "Do not duplicate, clone, or mirror {subject} anywhere in the frame.",
  },
  {
    key: "constraints.roles", label: "Keep each character's role", group: "constraints",
    when: "When the scene has other characters.", slots: ["subject"],
    text: "Keep each named character in their stated visual role; do not swap {subject}'s role with a secondary character.",
  },
  {
    key: "constraints.soleAgent", label: "Only the subject performs the action", group: "constraints",
    when: "When the scene has other characters and the subject is doing the action.", slots: ["subject"],
    text: "Only {subject} performs the central action; secondary characters do not take it over.",
  },
  {
    key: "constraints.activeAction", label: "Show the subject acting", group: "constraints",
    when: "When the subject is doing the action.", slots: ["subject"],
    text: "Show {subject} actively performing the central action, not posing or passively present afterward.",
  },
  {
    key: "constraints.crowd", label: "The crowd supports the subject", group: "constraints",
    when: "On a fact with a crowd reacting.", slots: ["subject"],
    text: "Keep {subject} the visual focal point; the crowd reacts to and supports {subject} rather than replacing {subject} as the subject of the image.",
  },
  {
    key: "constraints.causal", label: "Show cause and effect together", group: "constraints",
    when: "On a fact whose joke is a cause and its effect.", slots: [],
    text: "Show the cause and its effect together in the frame so the causal link is legible, not an unrelated aftermath.",
  },
  {
    key: "constraints.reversal", label: "The subject plays the reversed role", group: "constraints",
    when: "On a fact where the subject and the object swap roles.", slots: ["subject"],
    text: "Realize {subject} through the reversed role the scene requires; do not render {subject} as a separate, uninvolved bystander beside the object.",
  },

  // ── Composition ─────────────────────────────────────────────────────────────
  {
    key: "composition.framing", label: "Framing and camera", group: "composition",
    when: "When the scene plan names a framing or camera.", slots: ["framing"],
    text: "Composition: {framing}.",
  },
  {
    key: "composition.captionSpace", label: "Room for the caption", group: "composition",
    when: "When the scene plan leaves room for the caption on one side.", slots: ["side"],
    text: "Leave clean negative space at the {side} of the frame for the caption overlay.",
  },
  {
    key: "composition.keyElements", label: "Elements that must be visible", group: "composition",
    when: "When the scene plan names key elements the scene description has not covered.", slots: ["elements"],
    text: "Ensure these elements are clearly visible: {elements}.",
  },

  // ── Style ───────────────────────────────────────────────────────────────────
  {
    key: "style.photoreal", label: "Photoreal style (no look chosen)", group: "style",
    when: "On every picture with no look style.", slots: [],
    text: "Photorealistic rendering: true-to-life materials and textures, realistic optical detail, and the clarity of a high-quality photograph.",
  },

  // ── Text in the picture ─────────────────────────────────────────────────────
  {
    key: "text.overlay", label: "No caption text baked in", group: "text", policy: true,
    when: "Always.", slots: ["forbidden"],
    text: "Do not bake overlay or caption text into the image: no {forbidden}.",
  },
  {
    key: "text.incidental", label: "Background text stays unreadable", group: "text", policy: true,
    when: "Always.", slots: [],
    text: "Keep incidental background text non-readable; render only the specific in-scene text requested by these instructions.",
  },
  {
    key: "text.literal", label: "Words the scene shows", group: "text",
    when: "When the scene plan puts specific words in the picture.", slots: ["items"],
    text: "Render this in-scene text clearly: {items}.",
  },
  {
    key: "text.graphic", label: "Things drawn rather than written", group: "text",
    when: "When the scene plan names graphics that must not become words.", slots: ["items"],
    text: "Depict these as visuals, not as written words: {items}.",
  },
  {
    key: "text.requireGuided", label: "Text required, with guidance", group: "text",
    when: "On a fact whose moderator requires text and says what it is.", slots: ["guidance"],
    text: "SUPPORTING TEXT: Readable in-scene text is required in this scene. Show it clearly: {guidance}.",
  },
  {
    key: "text.require", label: "Text required", group: "text",
    when: "On a fact whose moderator requires text without saying what.", slots: [],
    text: "SUPPORTING TEXT: Readable in-scene text is required in this scene; show it clearly.",
  },
  {
    key: "text.forbid", label: "Text avoided", group: "text",
    when: "On a fact whose moderator forbids in-scene text.", slots: [],
    text: "Avoid readable in-scene text unless required by a higher-priority instruction.",
  },

  // ── Violence ────────────────────────────────────────────────────────────────
  {
    key: "violence.allow", label: "Violence shown, without gore", group: "violence", policy: true,
    when: "On a fact that involves violence, unless its moderator softened or suppressed it.", slots: [],
    text: "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore.",
  },
  {
    key: "violence.soften", label: "Violence softened", group: "violence", policy: true,
    when: "On a fact whose moderator softened violence.", slots: [],
    text: "Soften violent consequences; avoid graphic injury and visible death unless explicitly required by a higher-priority instruction.",
  },
  {
    key: "violence.suppress", label: "Violence not shown", group: "violence", policy: true,
    when: "On a fact whose moderator suppressed violence.", slots: [],
    text: "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage.",
  },

  // ── Speech and thought balloons ─────────────────────────────────────────────
  {
    key: "bubbles.speech", label: "A speech balloon", group: "bubbles",
    when: "Once per speech balloon the moderator added.", slots: ["who", "text"],
    text: "One clean comic-style speech balloon with its tail pointing to {who}, containing exactly the text {text} in clear, legible lettering.",
  },
  {
    key: "bubbles.thought", label: "A thought balloon", group: "bubbles",
    when: "Once per thought balloon the moderator added.", slots: ["who", "text"],
    text: "One cloud-shaped thought balloon with a trail of small circles leading to the head of {who}, containing exactly the text {text} in clear, legible lettering.",
  },
  {
    key: "bubbles.carveout", label: "Balloons are not captions", group: "bubbles",
    when: "After the balloons, whenever there are any.", slots: [],
    text: "These balloons are intentional in-scene graphic elements requested by these instructions, not overlay captions.",
  },

  // ── Engine notes ────────────────────────────────────────────────────────────
  {
    key: "notes.engine", label: "Engine notes", group: "notes",
    when: "Whenever it is not empty, as its own section just before RENDER STYLE.", slots: [],
    text: "",
  },
] as const satisfies readonly RecipePieceDef[];

export type RecipePieceKey = (typeof RECIPE_PIECES)[number]["key"];
export type RecipePieces = Record<RecipePieceKey, string>;

export const RECIPE_PIECE_KEYS = RECIPE_PIECES.map((p) => p.key) as RecipePieceKey[];
const DEF = new Map<string, RecipePieceDef>(RECIPE_PIECES.map((p) => [p.key, p]));

/** A recipe as the compiler uses it: every piece's text, and the version it came from (null for the baseline). */
export interface ResolvedRecipe {
  versionId: number | null;
  pieces: RecipePieces;
}

export const BASELINE_PIECES: RecipePieces = Object.freeze(
  Object.fromEntries(RECIPE_PIECES.map((p) => [p.key, p.text])) as RecipePieces,
);
export const BASELINE_RECIPE: ResolvedRecipe = Object.freeze({ versionId: null, pieces: BASELINE_PIECES });

/** A stored version's pieces over the baseline: a piece added to the code after the version was saved reads its baseline text. */
export function recipeFrom(versionId: number | null, stored: unknown): ResolvedRecipe {
  const pieces = { ...BASELINE_PIECES };
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (DEF.has(k) && typeof v === "string") pieces[k as RecipePieceKey] = v;
    }
  }
  return { versionId, pieces };
}

const SLOT_RE = /\{([A-Za-z]+)\}/g;

/** Slots that carry a fact's own words into the prompt. */
const CONTENT_SLOTS = new Set(["text", "guidance", "items", "elements"]);

/** Slots measured at their longest by the budget check, so repeating them is charged in full. */
const UNBOUNDED_SLOTS = new Set(["subject", "gender"]);

/**
 * A piece's text with its slots filled. A slot's value is inserted once and
 * never re-read, so a value containing braces (a moderator's balloon text, a
 * name) cannot be mistaken for a slot.
 */
export function fillPiece(recipe: ResolvedRecipe, key: RecipePieceKey, vars: Record<string, string> = {}): string {
  return recipe.pieces[key].replace(SLOT_RE, (whole, name: string) => (name in vars ? vars[name]! : whole));
}

/** The most characters one piece may hold. */
export const RECIPE_PIECE_MAX_CHARS = 1500;

/**
 * What is wrong with a recipe's pieces, if anything: an unknown piece, a
 * piece over the length cap, a policy piece emptied, a required slot missing
 * or an unknown slot named. Empty means the pieces are well formed; whether
 * they fit the prompt budget is `recipeBudgetProblems`' question.
 */
export function recipeProblems(pieces: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(pieces)) {
    const def = DEF.get(key);
    if (!def) { out.push(`"${key}" is not a piece of the prompt`); continue; }
    if (typeof value !== "string") { out.push(`${def.label}: must be text`); continue; }
    if (value.length > RECIPE_PIECE_MAX_CHARS) out.push(`${def.label}: ${value.length} characters, over the ${RECIPE_PIECE_MAX_CHARS} allowed`);
    if (def.policy && !value.trim()) out.push(`${def.label}: a policy line can be reworded but not emptied`);
    // A piece that carries the fact's own text (balloon words, required-text
    // guidance, in-scene words) cannot be emptied: that would drop moderator or
    // planner content from the prompt, which a recipe may never do.
    if (!value.trim() && def.slots.some((s) => CONTENT_SLOTS.has(s))) out.push(`${def.label}: carries the fact's own text, so it can be reworded but not emptied`);
    if (def.group === "labels" && !value.trim()) out.push(`${def.label}: a section label cannot be empty`);
    if (def.group === "labels" && /[\r\n:]/.test(value)) out.push(`${def.label}: a section label is one line with no colon`);
    const uses = [...value.matchAll(SLOT_RE)].map((m) => m[1]!);
    const named = new Set(uses);
    for (const slot of def.slots) if (value.trim() && !named.has(slot)) out.push(`${def.label}: must contain {${slot}}`);
    // A slot the compiler fills with a fact's own text (guidance, balloon text,
    // in-scene words…) may not be used more often than today's wording uses it:
    // the budget check measures each use at its shortest, so extra uses would
    // let a fact that fits today overflow (Codex, PR #926 round 2). The name
    // ({subject}) and the gender are measured at their longest, so they may repeat.
    for (const slot of named) {
      if (UNBOUNDED_SLOTS.has(slot)) continue;
      const count = uses.filter((u) => u === slot).length;
      const allowed = Math.max(1, (def.text.match(new RegExp(`\\{${slot}\\}`, "g")) ?? []).length);
      if (count > allowed) out.push(`${def.label}: {${slot}} may appear ${allowed === 1 ? "once" : `${allowed} times`}; it is filled with the fact's own text`);
    }
    for (const slot of named) if (!def.slots.includes(slot)) out.push(`${def.label}: {${slot}} is not something this piece can name${def.slots.length ? ` (it can name ${def.slots.map((s) => `{${s}}`).join(", ")})` : ""}`);
  }
  return out;
}

/** The policy pieces whose text differs between two recipes. */
export function changedPolicyPieces(a: RecipePieces, b: RecipePieces): RecipePieceKey[] {
  return RECIPE_PIECES.filter((p) => "policy" in p && p.policy && a[p.key] !== b[p.key]).map((p) => p.key);
}
