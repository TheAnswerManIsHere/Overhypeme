// Image tracing, increment 2 (plan docs/plans/PLAN_IMAGE_TRACING.md; #912):
// the watermark payload is TrustMark's BCH_5 packet bit for bit, so a 52-bit
// record id fits and the reference decoder agrees with ours on which damaged
// payloads are still readable.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWatermarkPayload, decodeWatermarkPayload, PAYLOAD_BITS } from "../lib/provenance/watermarkPayload";

const { vectors } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "trustmark-bch5-vectors.json"), "utf8")) as {
  vectors: { id: number; bits: string; corrupt: string; flipped: number; pythonDecodes: boolean }[];
};
const bits = (s: string) => [...s].map(Number);

describe("watermark payload", () => {
  it("encodes exactly what the reference implementation encodes, for ids up to 2^52 - 1", () => {
    assert.ok(vectors.some((v) => v.id === 2 ** 52 - 1));
    for (const v of vectors) assert.equal(encodeWatermarkPayload(v.id).join(""), v.bits, `id ${v.id}`);
  });

  it("accepts and rejects the same damaged payloads the reference decoder does", () => {
    assert.ok(vectors.some((v) => !v.pythonDecodes) && vectors.some((v) => v.pythonDecodes && v.flipped > 0));
    for (const v of vectors) {
      const got = decodeWatermarkPayload(bits(v.corrupt));
      assert.equal(got?.id ?? null, v.pythonDecodes ? v.id : null, `id ${v.id}, ${v.flipped} flipped`);
    }
  });

  it("corrects every pattern of up to five flipped bits", () => {
    const id = 3141592653589793;
    const clean = encodeWatermarkPayload(id);
    assert.equal(clean.length, PAYLOAD_BITS);
    let seed = 912;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
    for (let trial = 0; trial < 300; trial++) {
      const k = trial % 6;
      const w = clean.slice();
      const flipped = new Set<number>();
      while (flipped.size < k) flipped.add(Math.floor(rand() * 96));
      for (const p of flipped) w[p] ^= 1;
      assert.deepEqual(decodeWatermarkPayload(w), { id, corrected: k });
    }
  });

  it("rejects random words almost always, so an unmarked picture does not name a record", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      const w = Array.from({ length: 100 }, () => (rand() < 0.5 ? 1 : 0));
      w.splice(96, 4, 0, 0, 0, 1); // even with the version bits right
      if (decodeWatermarkPayload(w)) accepted++;
    }
    assert.ok(accepted <= 2, `accepted ${accepted} of 20000 random words`);
  });

  it("refuses ids it cannot carry", () => {
    for (const bad of [0, -1, 2 ** 52, 1.5]) assert.throws(() => encodeWatermarkPayload(bad), RangeError);
  });
});
