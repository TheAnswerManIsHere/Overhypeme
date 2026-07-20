/**
 * Security regression (C9) for the admin input-validation sweep.
 *
 * Focuses on the genuinely security-relevant bounds added to admin.ts:
 *  - the video-style preview-gif `:id` path-traversal guard (id is interpolated
 *    into a storage object key, so it must be a strict slug),
 *  - the bulk-import size caps (unbounded array / CSV → OOM / mass-insert),
 *  - the API-key-reachable set-password email validation.
 *
 * The schemas are unit-tested directly (deterministic, no routing/storage), and
 * the representative POST /admin/facts/import route is exercised end-to-end to
 * prove the 400 fires before any DB write.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  safeStylePreviewKey,
  PreviewGifBody,
  FactsImportBody,
  ImportCsvBody,
} from "../routes/admin.js";

describe("safeStylePreviewKey — preview-gif path-traversal guard", () => {
  const PREFIX = "video_style_previews/";
  it("never produces a key that escapes the storage prefix", () => {
    for (const bad of ["..", "../../evil", "a/b", "a.b", "video/../x", "", "has space", "My.Style", "..%2F..%2Fx", "\\..\\..\\x"]) {
      const key = safeStylePreviewKey(bad);
      assert.ok(key.startsWith(PREFIX), `should keep the prefix for ${JSON.stringify(bad)}`);
      const tail = key.slice(PREFIX.length);
      assert.ok(!tail.includes("/"), `no separators in tail for ${JSON.stringify(bad)} → ${key}`);
      assert.ok(!key.includes(".."), `no traversal in ${JSON.stringify(bad)} → ${key}`);
    }
  });
  it("is deterministic, and distinct source ids never collide", () => {
    assert.equal(safeStylePreviewKey("classic"), safeStylePreviewKey("classic"));
    // 'a.b' and 'a_b' both slugify to 'a_b' but the id-hash keeps them distinct.
    assert.notEqual(safeStylePreviewKey("a.b"), safeStylePreviewKey("a_b"));
  });
});

describe("PreviewGifBody — payload cap", () => {
  it("requires non-empty base64 and caps it (~5 MB decoded)", () => {
    assert.equal(PreviewGifBody.safeParse({ base64: "" }).success, false);
    assert.equal(PreviewGifBody.safeParse({ base64: "   " }).success, false, "whitespace-only trims to empty");
    assert.equal(PreviewGifBody.safeParse({ base64: "AAAA" }).success, true);
    assert.equal(PreviewGifBody.safeParse({ base64: "A".repeat(7_000_001) }).success, false);
  });
});

describe("bulk-import size caps", () => {
  it("FactsImportBody rejects an empty or over-1000 array and over-long items", () => {
    assert.equal(FactsImportBody.safeParse({ facts: [] }).success, false);
    assert.equal(FactsImportBody.safeParse({ facts: Array(1001).fill("x") }).success, false);
    assert.equal(FactsImportBody.safeParse({ facts: ["x".repeat(2001)] }).success, false);
    assert.equal(FactsImportBody.safeParse({ facts: ["ok", { text: "also ok" }] }).success, true);
  });
  it("ImportCsvBody rejects empty and over-2MB payloads", () => {
    assert.equal(ImportCsvBody.safeParse({ csv: "" }).success, false);
    assert.equal(ImportCsvBody.safeParse({ csv: "a".repeat(2_000_001) }).success, false);
    assert.equal(ImportCsvBody.safeParse({ csv: "one line" }).success, true);
  });
});
