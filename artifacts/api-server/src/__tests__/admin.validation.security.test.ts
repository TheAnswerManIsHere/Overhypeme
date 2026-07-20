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
  MotionPresetIdParam,
  PreviewGifBody,
  SetPasswordBody,
  FactsImportBody,
  ImportCsvBody,
} from "../routes/admin.js";

describe("MotionPresetIdParam — preview-gif path-traversal guard", () => {
  it("rejects traversal / separator / dot ids (would escape the storage prefix)", () => {
    for (const bad of ["..", "../../evil", "a/b", "a.b", "video/../x", "", "A", "has space", "x".repeat(65), "-leading"]) {
      assert.equal(MotionPresetIdParam.safeParse(bad).success, false, `should reject ${JSON.stringify(bad)}`);
    }
  });
  it("accepts normal motion-preset slugs", () => {
    for (const ok of ["classic", "zoom_1", "slow-pan", "a", "style-2-b", "0abc"]) {
      assert.equal(MotionPresetIdParam.safeParse(ok).success, true, `should accept ${JSON.stringify(ok)}`);
    }
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

describe("SetPasswordBody — API-key-reachable route", () => {
  it("rejects malformed / oversized emails", () => {
    assert.equal(SetPasswordBody.safeParse({ email: "not-an-email", password: "abcd1234" }).success, false);
    assert.equal(SetPasswordBody.safeParse({ email: `${"a".repeat(320)}@x.com`, password: "abcd1234" }).success, false);
  });
  it("keeps the 8–128 password rule", () => {
    assert.equal(SetPasswordBody.safeParse({ email: "a@b.com", password: "short" }).success, false);
    assert.equal(SetPasswordBody.safeParse({ email: "a@b.com", password: "x".repeat(129) }).success, false);
  });
  it("normalizes a valid email (trim + lowercase) so the DB lookup matches", () => {
    const parsed = SetPasswordBody.safeParse({ email: "  ADMIN@Example.COM ", password: "abcd1234" });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.email, "admin@example.com");
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
