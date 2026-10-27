/**
 * Launch Phase 3, increment 3 (#770; plan §3): the config diff sorts each
 * difference by who owns the value — a code-owned value or row code does not
 * produce is "missing", an admin-owned value is "operator-set", a runtime value
 * is ignored, and a column admin-owned only on some rows is code-owned on the
 * others. Pure: no database.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ConfigOwnership } from "@workspace/db/table-classification";
import { diffTable } from "../lib/configDiff.js";

const owners: ConfigOwnership = {
  key: ["id"],
  code: ["label"],
  admin: ["enabled", "endpoint"],
  runtime: ["updated_at"],
  adminOnlyWhere: { endpoint: "provider = 'openai'" },
};

const row = (over: Record<string, unknown>) => ({
  id: "a",
  label: "A",
  enabled: true,
  endpoint: "e1",
  updated_at: "2026-10-01T00:00:00Z",
  __admin_endpoint: true,
  ...over,
});

describe("config diff", () => {
  it("reports nothing when only runtime columns differ", () => {
    assert.deepEqual(diffTable("t", owners, [row({ updated_at: "2026-10-27T00:00:00Z" })], [row({})]), []);
  });

  it("calls a row code does not produce missing, and a row only code produces new", () => {
    const d = diffTable("t", owners, [row({ id: "gone" })], [row({ id: "fresh" })]);
    assert.deepEqual(
      d.map((x) => [x.kind, x.key]),
      [
        ["missing", "gone"],
        ["new-in-code", "fresh"],
      ],
    );
  });

  it("sorts a changed code value as missing and a changed admin value as operator-set", () => {
    const d = diffTable("t", owners, [row({ label: "Edited", enabled: false })], [row({})]);
    assert.deepEqual(
      d.map((x) => [x.kind, x.columns.map((c) => c.column)]),
      [
        ["missing", ["label"]],
        ["operator-set", ["enabled"]],
      ],
    );
  });

  it("treats a conditionally admin-owned column as code-owned on rows its predicate excludes", () => {
    const fal = diffTable("t", owners, [row({ endpoint: "e2" })], [row({ __admin_endpoint: false })]);
    assert.deepEqual(fal.map((x) => x.kind), ["missing"]);
    const llm = diffTable("t", owners, [row({ endpoint: "e2" })], [row({})]);
    assert.deepEqual(llm.map((x) => x.kind), ["operator-set"]);
  });

  it("calls a row only the target holds an operator setting where admins may add rows", () => {
    const d = diffTable("t", { ...owners, adminMayAddRows: true }, [row({ id: "toggled" })], []);
    assert.deepEqual(d.map((x) => x.kind), ["operator-set"]);
  });

  it("compares numbers and timestamps by value, not by how they were delivered", () => {
    const d = diffTable(
      "t",
      { ...owners, code: ["label", "price"], admin: ["enabled"] },
      [row({ price: "0.050000", enabled: true })],
      [row({ price: 0.05 })],
    );
    assert.deepEqual(d, []);
  });
});
