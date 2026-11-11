/**
 * @purpose The 100-bit payload the invisible watermark carries: a provenance record id, protected by the same BCH code Adobe's TrustMark uses, so a picture that has been recompressed, resized or cropped still yields its id (plan docs/plans/PLAN_IMAGE_TRACING.md, increment 2).
 *
 * Layout, identical to TrustMark's BCH_5 schema so the reference Python decoder reads our marks too:
 *   61 data bits | 35 BCH parity bits | 4 version bits ("0001" = BCH_5)
 * The 61 data bits are a fixed 9-bit tag followed by the 52-bit record id, most significant bit first. The tag is
 * ours, not TrustMark's: a picture that never carried our mark decodes to a random word, and BCH accepts about one
 * random word in 500 as a codeword; the tag turns that into about one in 250,000 before any database lookup.
 *
 * The code is BCH over GF(2^7) with primitive polynomial x^7 + x^3 + 1 (TrustMark's BCH_POLYNOMIAL = 137),
 * correcting up to 5 flipped bits, shortened from length 127 to the 99 bits TrustMark codes: the 61 data bits
 * padded to 8 bytes with 3 zero bits, then the 35 parity bits. Written from the algebra rather than transliterated
 * from TrustMark's port of the Linux kernel's table-driven coder; watermarkPayload.test.ts holds vectors produced
 * by the reference Python implementation, bit for bit.
 */

const M = 7;
const N = (1 << M) - 1; // 127
const T = 5;
const PRIM = 137; // x^7 + x^3 + 1
export const PAYLOAD_BITS = 100;
const DATA_BITS = 61;
const ECC_BITS = M * T; // 35
const PADDED_DATA_BITS = 64;
const CODE_BITS = PADDED_DATA_BITS + ECC_BITS; // 99
const VERSION = [0, 0, 0, 1];
const TAG = 0b101100101;
const TAG_BITS = 9;
const ID_BITS = 52;

const EXP = new Int32Array(2 * N);
const LOG = new Int32Array(N + 1);
{
  let x = 1;
  for (let i = 0; i < N; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & (1 << M)) x ^= PRIM;
  }
  for (let i = N; i < 2 * N; i++) EXP[i] = EXP[i - N];
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const alphaPow = (e: number) => EXP[((e % N) + N) % N];

/** The generator polynomial, coefficients over GF(2) lowest degree first: the product of the distinct minimal polynomials of alpha^1..alpha^2t. */
const GENERATOR: number[] = (() => {
  const seen = new Set<number>();
  let g: number[] = [1]; // coefficients in GF(2^7) while building; they collapse to 0/1
  for (let i = 1; i <= 2 * T; i++) {
    let r = i % N;
    if (seen.has(r)) continue;
    // multiply in every conjugate root alpha^(i * 2^k)
    do {
      seen.add(r);
      const root = EXP[r];
      const next = new Array<number>(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j + 1] ^= g[j];
        next[j] ^= mul(g[j], root);
      }
      g = next;
      r = (r * 2) % N;
    } while (!seen.has(r));
  }
  if (g.length - 1 !== ECC_BITS || g.some((c) => c > 1)) throw new Error("BCH generator construction failed");
  return g;
})();

/** Parity bits for a 64-bit padded message, highest degree first: the remainder of M(x)·x^35 divided by g(x). */
function parity(message: number[]): number[] {
  const reg = message.concat(new Array<number>(ECC_BITS).fill(0)); // index 0 = highest degree
  for (let i = 0; i < message.length; i++) {
    if (!reg[i]) continue;
    for (let j = 0; j <= ECC_BITS; j++) reg[i + j] ^= GENERATOR[ECC_BITS - j];
  }
  return reg.slice(message.length);
}

/** The 100 bits to watermark into a picture for record `id` (a positive integer below 2^52). */
export function encodeWatermarkPayload(id: number): number[] {
  if (!Number.isSafeInteger(id) || id <= 0 || id >= 2 ** ID_BITS) throw new RangeError(`watermark id out of range: ${id}`);
  const data: number[] = [];
  for (let b = TAG_BITS - 1; b >= 0; b--) data.push((TAG >> b) & 1);
  const big = BigInt(id);
  for (let b = ID_BITS - 1; b >= 0; b--) data.push(Number((big >> BigInt(b)) & 1n));
  const padded = data.concat([0, 0, 0]);
  return data.concat(parity(padded), VERSION);
}

/**
 * Read a record id from 100 decoded bits (1 = the decoder's logit was above 0), correcting up to 5 flipped bits.
 * null when the bits are not one of our marks: wrong version, uncorrectable, or the tag does not match.
 */
export function decodeWatermarkPayload(bits: ArrayLike<number>): { id: number; corrected: number } | null {
  if (bits.length !== PAYLOAD_BITS) return null;
  for (let i = 0; i < 4; i++) if ((bits[96 + i] ? 1 : 0) !== VERSION[i]) return null;
  const word: number[] = [];
  for (let i = 0; i < DATA_BITS; i++) word.push(bits[i] ? 1 : 0);
  word.push(0, 0, 0);
  for (let i = 0; i < ECC_BITS; i++) word.push(bits[DATA_BITS + i] ? 1 : 0);
  // word[k] is the coefficient of x^(98-k)

  const syn = new Array<number>(2 * T + 1).fill(0);
  let any = false;
  for (let j = 1; j <= 2 * T; j++) {
    let s = 0;
    for (let k = 0; k < CODE_BITS; k++) if (word[k]) s ^= alphaPow(j * (CODE_BITS - 1 - k));
    syn[j] = s;
    if (s) any = true;
  }

  let corrected = 0;
  if (any) {
    // Berlekamp-Massey over GF(2^7)
    let C = [1], B = [1];
    let L = 0, m = 1, b = 1;
    for (let n = 0; n < 2 * T; n++) {
      let d = syn[n + 1];
      for (let i = 1; i <= L; i++) d ^= mul(C[i] ?? 0, syn[n + 1 - i]);
      if (d === 0) { m++; continue; }
      const coef = mul(d, EXP[N - LOG[b]]);
      const Tpoly = C.slice();
      const len = Math.max(C.length, B.length + m);
      const next = new Array<number>(len).fill(0);
      for (let i = 0; i < C.length; i++) next[i] = C[i];
      for (let i = 0; i < B.length; i++) next[i + m] ^= mul(coef, B[i]);
      C = next;
      if (2 * L <= n) { L = n + 1 - L; B = Tpoly; b = d; m = 1; } else m++;
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop();
    if (C.length - 1 !== L || L > T) return null;
    // Chien search over the 99 positions the shortened code uses: an error at degree e makes alpha^-e a root
    const errorsAt: number[] = [];
    for (let e = 0; e < CODE_BITS; e++) {
      let v = 0;
      for (let i = 0; i < C.length; i++) if (C[i]) v ^= mul(C[i], alphaPow(-e * i));
      if (v === 0) errorsAt.push(e);
    }
    if (errorsAt.length !== L) return null;
    for (const e of errorsAt) word[CODE_BITS - 1 - e] ^= 1;
    corrected = L;
  }

  let tag = 0;
  for (let i = 0; i < TAG_BITS; i++) tag = (tag << 1) | word[i];
  if (tag !== TAG) return null;
  let id = 0n;
  for (let i = TAG_BITS; i < DATA_BITS; i++) id = (id << 1n) | BigInt(word[i]);
  const n = Number(id);
  return n > 0 ? { id: n, corrected } : null;
}
