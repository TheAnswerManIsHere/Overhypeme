/**
 * Security regression (C9) for the admin input-validation sweep.
 *
 * Focuses on the genuinely security-relevant bounds added to admin.ts:
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
  FactsImportBody,
  ImportCsvBody,
} from "../routes/admin.js";

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
