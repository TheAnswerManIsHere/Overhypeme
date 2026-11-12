/**
 * @purpose Mark which characters of a compiled prompt came from the prompt tuner's editable wording, so the wording editor's preview can highlight them against the fact's own text.
 * @subsystem visual-pipeline
 *
 * The prompt tuner plan (`docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design*
 * A: the preview shows the whole prompt "with the recipe's pieces
 * highlighted"). The compiler is not told about highlighting: each piece's
 * template is wrapped in private-use marker characters before compiling, the
 * markers travel through the compiler with the text, and `segmentsOf` reads
 * them back out. A slot's filled value (the fact's own words) is closed off
 * from the marking, so only the wording itself is highlighted.
 *
 * The markers never reach an engine: this is used by the preview only, and a
 * test requires the unmarked text to equal the ordinary compile for every
 * captured baseline case.
 */

import { RECIPE_PIECES, SLOT_RE, type RecipePieceKey, type ResolvedRecipe } from "./recipe";

const OPEN = "";
const CLOSE = "";
/** Each piece's index is carried as one private-use character after OPEN. */
const INDEX_BASE = 0xE100;
const KEYS = RECIPE_PIECES.map((p) => p.key);

/** A recipe whose every non-empty piece is wrapped in markers naming it. */
export function markRecipe(recipe: ResolvedRecipe): ResolvedRecipe {
  const pieces = { ...recipe.pieces };
  KEYS.forEach((key, i) => {
    const text = pieces[key];
    if (!text) return;
    const open = OPEN + String.fromCharCode(INDEX_BASE + i);
    pieces[key] = open + text.replace(SLOT_RE, (whole) => `${CLOSE}${whole}${open}`) + CLOSE;
  });
  return { versionId: recipe.versionId, pieces };
}

export interface PromptSegment {
  text: string;
  /** The piece this text is the wording of, or null for the fact's own text and the compiler's joins. */
  piece: RecipePieceKey | null;
}

/** Split a prompt compiled from a marked recipe into wording and everything else, dropping the markers. */
export function segmentsOf(marked: string): PromptSegment[] {
  const out: PromptSegment[] = [];
  let piece: RecipePieceKey | null = null;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const last = out[out.length - 1];
    if (last && last.piece === piece) last.text += buf;
    else out.push({ text: buf, piece });
    buf = "";
  };
  for (let i = 0; i < marked.length; i++) {
    const ch = marked[i]!;
    if (ch === OPEN) {
      flush();
      const idx = marked.charCodeAt(i + 1) - INDEX_BASE;
      piece = KEYS[idx] ?? null;
      i++;
    } else if (ch === CLOSE) {
      flush();
      piece = null;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}
