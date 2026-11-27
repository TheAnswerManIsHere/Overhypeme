/**
 * Word-level marking for the prompt tuner's preview (Issue #1341). A piece the
 * draft changed is not amber as a whole: only the words that are not in the
 * wording it was based on are. Splits a compiled segment into runs, each
 * marked `changed` when its words are absent from the base wording's longest
 * common word subsequence.
 *
 * Words and punctuation are separate tokens, so moving a full stop does not
 * colour the word before it; whitespace takes the changed mark only between
 * two changed tokens, so an added word's run does not swallow its neighbours'
 * spacing. A slot placeholder in the base ("{subject}") never matches, which
 * is right: the filled value is its own unmarked segment.
 */
export interface WordRun { text: string; changed: boolean }

const TOKEN = /\{[^{}\s]*\}|[\p{L}\p{N}'’_-]+|\s+|[^\p{L}\p{N}'’_\s-]+/gu;
const isSpace = (t: string) => /^\s+$/.test(t);

/** Runs of `text`, with each run's words marked when `base` does not hold them in order. */
export function wordChanges(text: string, base: string): WordRun[] {
  const tokens = text.match(TOKEN) ?? [];
  const words = tokens.map((t, i) => ({ t, i })).filter((x) => !isSpace(x.t));
  const baseWords = (base.match(TOKEN) ?? []).filter((t) => !isSpace(t));

  // Longest common subsequence of the word tokens; unmatched words are the change.
  const n = words.length, m = baseWords.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let a = n - 1; a >= 0; a--) {
    for (let b = m - 1; b >= 0; b--) {
      lcs[a]![b] = words[a]!.t === baseWords[b] ? lcs[a + 1]![b + 1]! + 1 : Math.max(lcs[a + 1]![b]!, lcs[a]![b + 1]!);
    }
  }
  const changed = new Array<boolean>(tokens.length).fill(false);
  for (let a = 0, b = 0; a < n; ) {
    if (b < m && words[a]!.t === baseWords[b]) { a++; b++; }
    else if (b < m && lcs[a]![b + 1]! >= lcs[a + 1]![b]!) b++;
    else { changed[words[a]!.i] = true; a++; }
  }
  // Whitespace is changed only between two changed tokens.
  for (let i = 0; i < tokens.length; i++) {
    if (isSpace(tokens[i]!)) changed[i] = i > 0 && i < tokens.length - 1 && changed[i - 1]! && changed[i + 1]!;
  }

  const runs: WordRun[] = [];
  tokens.forEach((t, i) => {
    const last = runs[runs.length - 1];
    if (last && last.changed === changed[i]) last.text += t;
    else runs.push({ text: t, changed: changed[i]! });
  });
  return runs;
}

/** A slot as the server cuts a piece at it (`SLOT_RE` in the api-server's `imagePrompt/recipe.ts`). */
const SLOT = /\{[A-Za-z]+\}/g;

/**
 * Marks one changed piece's compiled segments (PR #1342, Codex 4715586277).
 * The server cuts a piece at every slot, so a piece with slots reaches the
 * editor as several segments; comparing each against the whole base would
 * let an added word pair with a base word on the far side of a slot. Instead
 * the draft and base wording are compared once, as whole templates, so each
 * slot anchors the alignment, and each segment takes the marks of the stretch
 * of draft wording it is.
 *
 * Call the returned function on the piece's segments in prompt order: a
 * segment is looked for from the stretch after the last one found, wrapping,
 * so a piece that appears twice (a balloon per balloon) marks each copy. A
 * segment that is not a stretch of the draft (the compiler altered it, or an
 * empty slot value merged two stretches) falls back to comparing it alone
 * against the base.
 */
export function pieceMarker(draft: string, base: string): (segment: string) => WordRun[] {
  const changed = new Array<boolean>(draft.length).fill(false);
  let at = 0;
  for (const r of wordChanges(draft, base)) { if (r.changed) changed.fill(true, at, at + r.text.length); at += r.text.length; }
  const stretches: Array<{ start: number; text: string }> = [];
  let from = 0;
  for (const m of [...draft.matchAll(SLOT), { index: draft.length, 0: "" }]) {
    if (m.index! > from) stretches.push({ start: from, text: draft.slice(from, m.index) });
    from = m.index! + m[0].length;
  }
  let cursor = 0;
  // A whole stretch first; only then a stretch the compiler shortened.
  const find = (segment: string): { k: number; offset: number } | null => {
    for (const whole of [true, false]) {
      for (let j = 0; j < stretches.length; j++) {
        const k = (cursor + j) % stretches.length;
        const offset = whole ? (stretches[k]!.text === segment ? 0 : -1) : stretches[k]!.text.indexOf(segment);
        if (offset >= 0) return { k, offset };
      }
    }
    return null;
  };
  return (segment) => {
    const hit = segment ? find(segment) : null;
    if (hit) {
      const s = stretches[hit.k]!, offset = hit.offset;
      cursor = (hit.k + 1) % stretches.length;
      const runs: WordRun[] = [];
      for (let i = 0; i < segment.length; i++) {
        const c = changed[s.start + offset + i]!;
        const last = runs[runs.length - 1];
        if (last && last.changed === c) last.text += segment[i];
        else runs.push({ text: segment[i]!, changed: c });
      }
      return runs;
    }
    return wordChanges(segment, base);
  };
}
