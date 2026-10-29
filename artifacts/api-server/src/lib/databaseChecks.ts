/**
 * @purpose Read-only checks of a whole database that the Launch Phase 3 rehearsals and the dev rebuild share: row counts, admin-owned values, orphaned foreign keys, and sequences that would collide.
 * @subsystem data-lifecycle
 *
 * Moved out of scripts/upgrade-rehearsal.ts (increment 4, #770) when the dev
 * rebuild (increment 7) needed the same checks. Every function reads the
 * public schema of the database the client is connected to and writes nothing,
 * except that `exhaustedSequences` advances each sequence it probes by one.
 */

import type pg from "pg";

import { configTables } from "@workspace/db/table-classification";

export type Counts = Map<string, number>;

export async function publicTables(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ t: string }>(
    "SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1",
  );
  return rows.map((r) => r.t);
}

export async function rowCounts(c: pg.ClientBase): Promise<Counts> {
  const out: Counts = new Map();
  for (const t of await publicTables(c)) out.set(t, Number((await c.query(`SELECT count(*) AS n FROM public."${t}"`)).rows[0].n));
  return out;
}

/** Every admin-owned value, keyed table/key/column, honouring adminOnlyWhere. */
export async function adminValues(c: pg.ClientBase): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [table, owners] of configTables()) {
    if (owners.admin.length === 0) continue;
    const flags = Object.entries(owners.adminOnlyWhere ?? {}).map(([col, p]) => `, (${p}) AS "__admin_${col}"`);
    const { rows } = await c.query(`SELECT *${flags.join("")} FROM public."${table}"`);
    for (const r of rows) {
      const key = owners.key.map((k) => String(r[k])).join("/");
      for (const col of owners.admin) {
        if (owners.adminOnlyWhere?.[col] && r[`__admin_${col}`] !== true) continue;
        out.set(`${table}/${key}/${col}`, JSON.stringify(r[col] instanceof Date ? r[col].toISOString() : r[col] ?? null));
      }
    }
  }
  return out;
}

/** Foreign keys with at least one row whose referenced row is missing. */
export async function orphans(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ name: string; child: string; parent: string; ccols: string[]; pcols: string[] }>(`
    SELECT con.conname AS name, ch.relname AS child, pa.relname AS parent,
           array_agg(ca.attname::text ORDER BY k.n) AS ccols, array_agg(pa_att.attname::text ORDER BY k.n) AS pcols
    FROM pg_constraint con
    JOIN pg_class ch ON ch.oid = con.conrelid
    JOIN pg_class pa ON pa.oid = con.confrelid
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(c, p, n)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.c
    JOIN pg_attribute pa_att ON pa_att.attrelid = con.confrelid AND pa_att.attnum = k.p
    WHERE con.contype = 'f' AND ch.relnamespace = 'public'::regnamespace
    GROUP BY con.conname, ch.relname, pa.relname`);
  const out: string[] = [];
  for (const fk of rows) {
    const notNull = fk.ccols.map((col) => `c."${col}" IS NOT NULL`).join(" AND ");
    const join = fk.ccols.map((col, i) => `p."${fk.pcols[i]}" = c."${col}"`).join(" AND ");
    const { rows: n } = await c.query(
      `SELECT count(*) AS n FROM public."${fk.child}" c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM public."${fk.parent}" p WHERE ${join})`,
    );
    if (Number(n[0].n) > 0) out.push(`${fk.child}.${fk.name}: ${n[0].n} orphan row(s)`);
  }
  return out;
}

interface SequenceColumn {
  seq: string;
  t: string;
  col: string;
}

async function sequenceColumns(c: pg.ClientBase): Promise<SequenceColumn[]> {
  const { rows } = await c.query<SequenceColumn>(`
    SELECT s.oid::regclass::text AS seq, t.relname AS t, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace`);
  return rows;
}

/** Sequence-backed columns whose next value would collide with an existing row. */
export async function exhaustedSequences(c: pg.ClientBase): Promise<string[]> {
  const out: string[] = [];
  for (const { seq, t, col } of await sequenceColumns(c)) {
    const { rows: r } = await c.query(
      `SELECT nextval($1::regclass) AS next, (SELECT max("${col}") FROM public."${t}") AS max`,
      [seq],
    );
    if (r[0].max !== null && BigInt(r[0].next) <= BigInt(r[0].max)) out.push(`${t}.${col}: next ${r[0].next} ≤ max ${r[0].max}`);
  }
  return out;
}

/** Moves every sequence that is behind its column's largest value past it; returns the columns it moved. */
export async function advanceSequences(c: pg.ClientBase): Promise<string[]> {
  const moved: string[] = [];
  for (const { seq, t, col } of await sequenceColumns(c)) {
    const { rows: r } = await c.query(
      `SELECT last_value, is_called, (SELECT max("${col}") FROM public."${t}") AS max FROM ${seq}`,
    );
    const max = r[0].max;
    if (max === null) continue;
    const next = r[0].is_called ? BigInt(r[0].last_value) + 1n : BigInt(r[0].last_value);
    if (next > BigInt(max)) continue;
    await c.query("SELECT setval($1::regclass, $2::bigint, true)", [seq, String(max)]);
    moved.push(`${t}.${col}`);
  }
  return moved;
}
