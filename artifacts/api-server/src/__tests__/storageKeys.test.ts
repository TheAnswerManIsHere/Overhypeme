import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashPrefix,
  aiBackgroundKey,
  memeKey,
  uploadKey,
  filenameFromKey,
} from "../lib/storageKeys.js";

describe("hashPrefix", () => {
  it("returns a 2-character lowercase hex string", () => {
    const p = hashPrefix("foo");
    assert.equal(p.length, 2);
    assert.match(p, /^[0-9a-f]{2}$/);
  });

  it("is deterministic for the same input", () => {
    assert.equal(hashPrefix("anything"), hashPrefix("anything"));
  });

  it("returns the known SHA-256 prefix for 'foo' and 'bar'", () => {
    // Computed via crypto.createHash("sha256").update(s).digest("hex").substring(0,2)
    assert.equal(hashPrefix("foo"), "2c");
    assert.equal(hashPrefix("bar"), "fc");
  });
});

describe("aiBackgroundKey", () => {
  it("formats ai-backgrounds/<hash2>/<factId>-<gender>-<key>.png by default", () => {
    const key = aiBackgroundKey(42, "male", "key1");
    assert.equal(key, "ai-backgrounds/57/42-male-key1.png");
  });

  it("respects a custom extension", () => {
    const key = aiBackgroundKey(42, "male", "key1", "jpg");
    assert.equal(key, "ai-backgrounds/86/42-male-key1.jpg");
  });

  it("includes -ref- in the filename when isRef=true", () => {
    const key = aiBackgroundKey(42, "male", "key1", "png", true);
    assert.equal(key, "ai-backgrounds/5c/42-male-ref-key1.png");
  });

  it("hash prefix is derived from the filename portion only", () => {
    const key = aiBackgroundKey(42, "male", "key1");
    const filename = "42-male-key1.png";
    assert.equal(key, `ai-backgrounds/${hashPrefix(filename)}/${filename}`);
  });
});

describe("memeKey", () => {
  it("formats memes/<hash2>/<slug>.jpg by default", () => {
    assert.equal(memeKey("my-slug"), "memes/5f/my-slug.jpg");
  });

  it("respects a custom extension", () => {
    assert.equal(memeKey("my-slug", "png"), "memes/67/my-slug.png");
  });
});

describe("uploadKey", () => {
  it("includes the extension when provided", () => {
    assert.equal(uploadKey("upload123", "webp"), "uploads/cd/upload123.webp");
  });

  it("omits the extension (and trailing dot) when not provided", () => {
    assert.equal(uploadKey("upload123"), "uploads/f3/upload123");
  });
});

describe("filenameFromKey", () => {
  it("extracts the last segment from a multi-segment key", () => {
    assert.equal(filenameFromKey("ai-backgrounds/57/42-male-key1.png"), "42-male-key1.png");
  });

  it("returns the input when there are no slashes", () => {
    assert.equal(filenameFromKey("plain.jpg"), "plain.jpg");
  });

  it("returns empty string for an empty key (split+pop yields '')", () => {
    assert.equal(filenameFromKey(""), "");
  });
});
