/**
 * Prompt recipes — every piece of GLOBAL wording the image-prompt compiler
 * owns, as named templates (the prompt tuner, part 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* A).
 *
 * - **Global, never fact-specific.** A recipe holds only the wording that is
 *   the same for every fact (David, 2026-11-12: *"I should be able to modify
 *   any section of the prompt that is compiled into the final prompt … for
 *   this exercise, we're looking only at global elements."*). The approved
 *   gag (scene, bubbles, cast) and a look style's own text never come from a
 *   recipe.
 * - **Only what the direct compile emits** (plan
 *   `docs/plans/PLAN_GAG_DIRECT_RENDER.md`, D). The pieces only the removed
 *   planned sections used (subject binding, the do-not constraints, framing
 *   and key elements, the in-scene text policies, the violence lines) are no
 *   longer offered; a stored version that holds them keeps them, and they are
 *   ignored (`recipeFrom` reads only known pieces). Violence is the one
 *   sentence `VIOLENCE_RULE`, which no recipe rewords or drops.
 * - **Templates with named slots.** `{subject}`, `{side}` and the like are
 *   filled by the compiler; a version that drops a slot its piece requires,
 *   or names one it does not have, is refused (`recipeProblems`).
 * - **When a line appears is the compiler's.** A recipe changes a line's
 *   wording, never the condition under which it is emitted.
 * - **Policy pieces** (the overlay-text and incidental-text rules) can be
 *   reworded but never emptied, and promoting a change
 *   to one asks a second confirmation (David, 2026-11-12).
 * - **Section order is fixed**; the section labels are pieces, and so is the
 *   shape: how a section is written (`shape.section`) and what sits between
 *   sections (`shape.join`).
 * - **A baseline per engine family** (compiler review, Phase 1, plan
 *   `docs/plans/PLAN_COMPILER_REVIEW.md`). `BASELINE_RECIPE` is Nano Banana 2's
 *   wording and every family's default; a family in `FAMILY_BASELINES`
 *   replaces only the pieces it names, following that vendor's published
 *   prompting guidance. A stored version is laid over its own family's
 *   baseline.
 */

export type RecipeGroup = "labels" | "shape" | "identity" | "composition" | "style" | "text" | "bubbles" | "notes";

export interface RecipePieceDef {
  key: string;
  /** What the piece is, in plain words, for the editor. */
  label: string;
  group: RecipeGroup;
  /** When the compiler emits it, in plain words. */
  when: string;
  /** Slots the piece must contain, each exactly as `{slot}`. */
  slots: readonly string[];
  /** Slots the piece may contain but need not (a section written without its label). */
  optionalSlots?: readonly string[];
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
  label("additionalDetails", "ADDITIONAL DETAILS"),
  label("bubbles", "SPEECH & THOUGHT BUBBLES"),
  label("composition", "COMPOSITION"),
  label("engineNotes", "ENGINE NOTES", "Whenever this recipe's engine notes are not empty."),
  label("renderStyle", "RENDER STYLE", "Always."),
  label("strictConstraints", "STRICT CONSTRAINTS"),

  // ── Shape: how sections are written and joined ──────────────────────────────
  {
    key: "shape.section", label: "How each section is written", group: "shape",
    when: "For every section that has content.", slots: ["body"], optionalSlots: ["label"],
    text: "{label}: {body}",
  },
  {
    key: "shape.join", label: "Between sections", group: "shape",
    when: "Between every two sections. Spaces and line breaks only.", slots: [],
    text: " ",
  },

  // ── Identity ────────────────────────────────────────────────────────────────
  {
    key: "identity.person", label: "Identity: a person's photo", group: "identity",
    when: "On every picture made from a person's photo.", slots: [],
    text: "Image-to-image edit using the reference image as the person's identity source. Preserve the reference person's recognizable identity and likeness — facial features and distinctive characteristics. Allow apparent age, body proportions, hair, clothing, and life stage to transform when the scene requires it, while keeping the same recognizable person.",
  },
  {
    key: "identity.pet", label: "Identity: a pet's photo", group: "identity",
    when: "On every picture made from a photo of a pet.", slots: [],
    text: "Image-to-image edit using the reference image as the visual identity source for the uploaded pet. The uploaded pet visually represents the named subject in the fact. Preserve the pet's recognizable visual identity. Do not replace the pet with a human.",
  },

  // ── Composition ─────────────────────────────────────────────────────────────
  {
    key: "composition.captionSpace", label: "Room for the caption", group: "composition",
    when: "When the render asks for room for the caption on one side.", slots: ["side"],
    text: "Leave clean negative space at the {side} of the frame for the caption overlay.",
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

/**
 * Each engine family's own starting wording, where it differs from Nano Banana
 * 2's (compiler review, Phase 1). Only what differs is named; when a line
 * appears is still the compiler's. Both fix the doubled "COMPOSITION:
 * Composition:" label; Nano Banana 2's baseline keeps it, byte for byte, so
 * its stored renders stay reproducible.
 *
 * - **GPT Image 2.6** follows OpenAI's image prompting guide
 *   (developers.openai.com/api/docs/guides/image-prompting, read 2026-11-14):
 *   "organize the prompt as scene, subject, details, and constraints, using
 *   labeled sections"; "Identify each input by number and purpose"; "State
 *   which facial features and proportions must remain unchanged"; "Put
 *   required wording in quotes"; "Request 'photorealistic' or 'real
 *   photograph' explicitly". Labeled sections, one per paragraph.
 * - **Nano Banana 2.1** follows Google's Gemini image-generation guide
 *   (ai.google.dev/gemini-api/docs/image-generation, and Google Cloud's
 *   "ultimate Nano Banana prompting guide", 2026-03-05, both read
 *   2026-11-14): "describe the scene narratively" rather than as keywords;
 *   "Ensure that the features of [element from image 1] remain completely
 *   unchanged"; "Use positive framing: Describe what you want, not what you
 *   don't want". Unlabeled paragraphs, and the do-nots written as what the
 *   picture is.
 */
const FAMILY_BASELINES: Readonly<Record<string, Partial<RecipePieces>>> = {
  "gpt-image-2-6": {
    "shape.join": "\n\n",
    "identity.person": "Edit image 1. The person in image 1 is the subject of this picture. Keep their identity and likeness exactly: face, facial features, skin tone, hairstyle and distinctive characteristics, so they are unmistakably the same person. Their apparent age, body proportions, clothing, pose and life stage change only where the scene requires it.",
    "identity.pet": "Edit image 1. The pet in image 1 is the named subject of the fact. Keep its recognizable identity exactly: markings, colours, shape and distinctive features. Do not replace the pet with a human.",
    "style.photoreal": "A photorealistic image, like a real photograph: true-to-life materials and textures, natural detail and believable lighting.",
  },
  "nano-banana-2-1": {
    "shape.section": "{body}",
    "shape.join": "\n\n",
    "identity.person": "Create this image using the provided photo as the reference for the person in it. Ensure that their face, facial features, skin tone and distinctive characteristics remain completely unchanged, so they are unmistakably the same person; their apparent age, body proportions, hair, clothing and life stage change only where the scene requires it.",
    "identity.pet": "Create this image using the provided photo as the reference for its subject, a pet that is the named subject of the fact. Ensure that its markings, colours, shape and distinctive features remain completely unchanged, and keep it the animal it is.",
    "style.photoreal": "A photorealistic photograph with true-to-life materials and textures, natural light and realistic optical detail.",
    "text.overlay": "The picture is a clean, uncaptioned scene: captions are added later, so it carries none of these: {forbidden}.",
    "text.incidental": "Background signs and labels stay softly unreadable; the only legible lettering is the in-scene text these instructions ask for.",
  },
};

/** Each family's baseline, built once: Nano Banana 2's wording with the family's differences laid over it. */
const FAMILY_BASELINE_RECIPES: ReadonlyMap<string, ResolvedRecipe> = new Map(
  Object.entries(FAMILY_BASELINES).map(([family, own]) => [
    family,
    Object.freeze({ versionId: null, pieces: Object.freeze({ ...BASELINE_PIECES, ...own }) as RecipePieces }),
  ]),
);

/** The baseline a family compiles with when no version is live. Nano Banana 2 and any family without its own is `BASELINE_RECIPE` itself. */
export function baselineRecipeFor(family: string | null | undefined): ResolvedRecipe {
  return (family && FAMILY_BASELINE_RECIPES.get(family)) || BASELINE_RECIPE;
}

/** A stored version's pieces over its family's baseline: a piece added to the code after the version was saved reads its baseline text. */
export function recipeFrom(versionId: number | null, stored: unknown, family?: string | null): ResolvedRecipe {
  const pieces = { ...baselineRecipeFor(family).pieces };
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (DEF.has(k) && typeof v === "string") pieces[k as RecipePieceKey] = v;
    }
  }
  return { versionId, pieces };
}

export const SLOT_RE = /\{([A-Za-z]+)\}/g;

/** Slots that carry a fact's own words into the prompt. */
const CONTENT_SLOTS = new Set(["text", "guidance", "items", "elements", "body"]);

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
    // guidance, in-scene words) cannot be emptied: that would drop the gag's
    // own content from the prompt, which a recipe may never do.
    if (!value.trim() && def.slots.some((s) => CONTENT_SLOTS.has(s))) out.push(`${def.label}: carries the fact's own text, so it can be reworded but not emptied`);
    if (def.group === "labels" && !value.trim()) out.push(`${def.label}: a section label cannot be empty`);
    if (def.group === "labels" && /[\r\n:]/.test(value)) out.push(`${def.label}: a section label is one line with no colon`);
    if (def.key === "shape.join" && !/^[ \n]+$/.test(value)) out.push(`${def.label}: spaces and line breaks only, at least one`);
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
    const allowedSlots = [...def.slots, ...(def.optionalSlots ?? [])];
    for (const slot of named) if (!allowedSlots.includes(slot)) out.push(`${def.label}: {${slot}} is not something this piece can name${allowedSlots.length ? ` (it can name ${allowedSlots.map((s) => `{${s}}`).join(", ")})` : ""}`);
  }
  return out;
}

/** The policy pieces whose text differs between two recipes. */
export function changedPolicyPieces(a: RecipePieces, b: RecipePieces): RecipePieceKey[] {
  return RECIPE_PIECES.filter((p) => "policy" in p && p.policy && a[p.key] !== b[p.key]).map((p) => p.key);
}
