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
