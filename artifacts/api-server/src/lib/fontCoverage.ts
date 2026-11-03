/**
 * Which characters a font file draws, read from the file's own character map
 * (its `cmap` table), and the name rule's letters derived from them
 * (names-and-fonts plan). The rule admits a letter only when every caption
 * face draws it and every code point of its uppercase, the form an all-caps
 * caption draws; so the admitted set is computed from the shipped files and
 * pinned in `lib/api-zod/src/personalNameLetters.generated.ts`, and a test
 * fails when the two disagree in either direction.
 *
 * @purpose Reads the set of code points a TrueType font maps to a glyph, and derives the name rule's admitted letters (Latin-script letters that every caption face draws in both cases) from the shipped font files.
 * @subsystem accounts-auth
 */

/** Code points the font maps to a real glyph (not glyph 0). */
export function fontCodePoints(file: Buffer): Set<number> {
  const numTables = file.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (file.toString("latin1", rec, rec + 4) === "cmap") cmap = file.readUInt32BE(rec + 8);
  }
  if (cmap < 0) throw new Error("font has no cmap table");
  const subtables: { platform: number; encoding: number; offset: number }[] = [];
  const count = file.readUInt16BE(cmap + 2);
  for (let i = 0; i < count; i++) {
    const rec = cmap + 4 + i * 8;
    subtables.push({ platform: file.readUInt16BE(rec), encoding: file.readUInt16BE(rec + 2), offset: cmap + file.readUInt32BE(rec + 4) });
  }
  const pick = (format: number) => subtables.find((t) => (t.platform === 3 || t.platform === 0) && file.readUInt16BE(t.offset) === format);
  const out = new Set<number>();
  const f12 = pick(12);
  if (f12) {
    const groups = file.readUInt32BE(f12.offset + 12);
    for (let g = 0; g < groups; g++) {
      const at = f12.offset + 16 + g * 12;
      const start = file.readUInt32BE(at);
      const end = file.readUInt32BE(at + 4);
      const glyph = file.readUInt32BE(at + 8);
      for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
    }
    return out;
  }
  const f4 = pick(4);
  if (!f4) throw new Error("font has no Unicode cmap subtable of format 4 or 12");
  const segs = file.readUInt16BE(f4.offset + 6) / 2;
  const ends = f4.offset + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  for (let i = 0; i < segs; i++) {
    const end = file.readUInt16BE(ends + i * 2);
    const start = file.readUInt16BE(starts + i * 2);
    const delta = file.readInt16BE(deltas + i * 2);
    const rangeAt = ranges + i * 2;
    const range = file.readUInt16BE(rangeAt);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (range === 0) glyph = (c + delta) & 0xffff;
      else {
        const g = file.readUInt16BE(rangeAt + range + 2 * (c - start));
        glyph = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(c);
    }
  }
  return out;
}

const LATIN_LETTER = /^\p{L}$/u;
const LATIN_SCRIPT = /^\p{Script=Latin}$/u;

/** The Latin-script letters every font draws, together with their uppercase forms. */
export function deriveNameLetters(fonts: readonly Buffer[]): number[] {
  const maps = fonts.map(fontCodePoints);
  const inAll = (cp: number) => maps.every((m) => m.has(cp));
  const letters: number[] = [];
  for (let cp = 0; cp <= 0x2ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (!LATIN_LETTER.test(ch) || !LATIN_SCRIPT.test(ch)) continue;
    if (!inAll(cp)) continue;
    if (Array.from(ch.toUpperCase()).every((u) => inAll(u.codePointAt(0)!))) letters.push(cp);
  }
  return letters;
}

/** Code points as `[start, end]` runs. */
export function toRanges(cps: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const cp of cps) {
    const last = out[out.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}
