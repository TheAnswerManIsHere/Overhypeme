/**
 * A fact's AI-meme gallery is stored as JSON, and the image-prompt worker
 * creates it one gender at a time (`{ ...current, [gender]: [...] }` starting
 * from `{}`), so a gallery can lack a gender key. The response trimmer must
 * treat a missing key as an empty list rather than throw: a throw here turns
 * every fact listing that includes such a fact into a 500.
 *
 * @purpose Proves trimAiMemeImages returns all three gender lists, capped, for a full gallery, a gallery missing gender keys, and a gallery whose entry is not a list, and returns null for no gallery.
 * @subsystem public-site
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { trimAiMemeImages } from "../lib/trimFactImages.js";
import type { AiMemeImages } from "../lib/aiMemePipeline.js";

describe("trimAiMemeImages", () => {
  it("caps each gender list of a full gallery", () => {
    const out = trimAiMemeImages({ male: ["m1", "m2", "m3"], female: ["f1"], neutral: [] }, 2);
    assert.deepEqual(out, { male: ["m1", "m2"], female: ["f1"], neutral: [] });
  });

  it("treats a missing gender key as an empty list, as the image-prompt worker writes", () => {
    const partial = { neutral: ["n1", "n2"] } as unknown as AiMemeImages;
    assert.deepEqual(trimAiMemeImages(partial, 1), { male: [], female: [], neutral: ["n1"] });
  });

  it("treats a non-list entry as an empty list", () => {
    const odd = { male: null, female: "f1", neutral: ["n1"] } as unknown as AiMemeImages;
    assert.deepEqual(trimAiMemeImages(odd, 5), { male: [], female: [], neutral: ["n1"] });
  });

  it("returns null for no gallery", () => {
    assert.equal(trimAiMemeImages(null, 5), null);
    assert.equal(trimAiMemeImages(undefined, 5), null);
  });
});
