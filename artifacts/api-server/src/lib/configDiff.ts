/**
 * @purpose The config diff's comparison: sorts each difference between an existing database's configuration rows and a freshly built one's by who owns the value — missing (code), operator-set (admin), new in code — ignoring runtime columns.
 * @subsystem data-lifecycle
 *
 * Launch Phase 3, increment 3 (#770; plan §3). Pure; scripts/config-diff.ts
 * reads the two databases and calls it.
 */

import type { ConfigOwnership } from "@workspace/db/table-classification";

export type Row = Record<string, unknown>;
export interface ConfigDifference {
  table: string;
  key: string;
  kind: "missing" | "operator-set" | "new-in-code";
  /** The columns that differ; empty when the whole row is missing or new. */
  columns: Array<{ column: string; target: unknown; fresh: unknown }>;
}

/** Normalises a value as node-postgres and json_agg both deliver it. */
function norm(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(v)) {
    return JSON.stringify(new Date(v).toISOString());
  }
  if (typeof v === "number") return JSON.stringify(String(v));
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return JSON.stringify(String(Number(v)));
  return JSON.stringify(v ?? null);
}

/** Which owner a column has on this row, honouring adminOnlyWhere's evaluated flags. */
function ownerOf(owners: ConfigOwnership, col: string, row: Row): "code" | "admin" | "runtime" | "key" {
  if (owners.key.includes(col)) return "key";
  if (owners.runtime.includes(col)) return "runtime";
  if (owners.admin.includes(col)) {
    if (owners.adminOnlyWhere?.[col] && row[`__admin_${col}`] !== true) return "code";
    return "admin";
  }
  return "code";
}

export function diffTable(table: string, owners: ConfigOwnership, target: Row[], fresh: Row[]): ConfigDifference[] {
  const keyOf = (r: Row) => owners.key.map((k) => String(r[k])).join("/");
  const freshByKey = new Map(fresh.map((r) => [keyOf(r), r]));
  const targetKeys = new Set(target.map(keyOf));
  const out: ConfigDifference[] = [];
  for (const t of target) {
    const key = keyOf(t);
    const f = freshByKey.get(key);
    if (!f) {
      out.push({ table, key, kind: owners.adminMayAddRows ? "operator-set" : "missing", columns: [] });
      continue;
    }
    const code: ConfigDifference["columns"] = [];
    const admin: ConfigDifference["columns"] = [];
    for (const col of [...owners.code, ...owners.admin]) {
      if (norm(t[col]) === norm(f[col])) continue;
      (ownerOf(owners, col, f) === "admin" ? admin : code).push({ column: col, target: t[col], fresh: f[col] });
    }
    if (code.length) out.push({ table, key, kind: "missing", columns: code });
    if (admin.length) out.push({ table, key, kind: "operator-set", columns: admin });
  }
  for (const f of fresh) if (!targetKeys.has(keyOf(f))) out.push({ table, key: keyOf(f), kind: "new-in-code", columns: [] });
  return out;
}
