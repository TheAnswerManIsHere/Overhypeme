/**
 * The rows migration 0142 (variants retired; plan docs/plans/PLAN_RETIRE_VARIANTS.md)
 * will delete from a database, counted per table BEFORE it runs, so the upgrade
 * rehearsal can tell the authorised deletion from an accidental loss.
 *
 * Read on the restored snapshot while `facts.parent_id` still exists, using
 * 0142's own ownership rules: the variant facts (V); every row a cascading
 * foreign key removes with them, followed through the catalogue to any depth;
 * reactions on V's facts, memes and comments; activity entries recording a fact
 * in V or a review that staged or approved one (R); R itself, and whatever
 * cascades from it. Each row is counted once (by ctid). A database without the
 * column, or without a variant, gets an empty map: no allowance at all. Tables
 * resolve in the connection's own schema, as 0142's do.
 *
 * @purpose Count, per table, the rows migration 0142 will delete, before it runs, for the upgrade rehearsal's expected counts.
 * @subsystem upgrade-rehearsal
 */
import type pg from "pg";

/** table → number of rows 0142 will delete. */
export type RetirementLosses = Map<string, number>;

interface CascadeFk { child: string; childCols: string[]; parent: string; parentCols: string[] }

async function hasColumn(c: pg.ClientBase, table: string, column: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function cascadingFks(c: pg.ClientBase): Promise<CascadeFk[]> {
  const { rows } = await c.query<{ child: string; parent: string; child_cols: string[]; parent_cols: string[] }>(`
    SELECT ch.relname AS child, pa.relname AS parent,
           array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS child_cols,
           array(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS parent_cols
      FROM pg_constraint con
      JOIN pg_class ch ON ch.oid = con.conrelid
      JOIN pg_class pa ON pa.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace AND n.nspname = current_schema()
     WHERE con.contype = 'f' AND con.confdeltype = 'c'`);
  return rows.map((r) => ({ child: r.child, parent: r.parent, childCols: r.child_cols, parentCols: r.parent_cols }));
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export async function variantRetirementLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  const out: RetirementLosses = new Map();
  if (!(await hasColumn(c, "facts", "parent_id"))) return out;

  // table → set of ctids that go.
  const gone = new Map<string, Set<string>>();
  const mark = (table: string, ctids: string[]): string[] => {
    const set = gone.get(table) ?? gone.set(table, new Set()).get(table)!;
    const fresh = ctids.filter((t) => !set.has(t));
    fresh.forEach((t) => set.add(t));
    return fresh;
  };
  const fks = await cascadingFks(c);

  // Delete `ctids` from `table` and follow every cascading FK from it.
  const cascade = async (table: string, ctids: string[]): Promise<void> => {
    const fresh = mark(table, ctids);
    if (fresh.length === 0) return;
    for (const fk of fks.filter((f) => f.parent === table)) {
      const parentCols = fk.parentCols.map(q).join(", ");
      const join = fk.childCols.map((col, i) => `ch.${q(col)} = p.${q(fk.parentCols[i]!)}`).join(" AND ");
      const { rows } = await c.query<{ t: string }>(
        `SELECT ch.ctid::text AS t FROM ${q(fk.child)} ch
           JOIN (SELECT ${parentCols} FROM ${q(table)} WHERE ctid::text = ANY($1)) p ON ${join}`,
        [fresh],
      );
      await cascade(fk.child, rows.map((r) => r.t));
    }
  };
  const ctidsWhere = async (table: string, where: string, params: unknown[]): Promise<string[]> =>
    (await c.query<{ t: string }>(`SELECT ctid::text AS t FROM ${q(table)} WHERE ${where}`, params)).rows.map((r) => r.t);

  const variantIds = (await c.query<{ id: number }>(`SELECT id FROM facts WHERE parent_id IS NOT NULL`)).rows.map((r) => r.id);
  if (variantIds.length === 0) return out;
  const memeIds = (await c.query<{ id: number }>(`SELECT id FROM memes WHERE fact_id = ANY($1)`, [variantIds])).rows.map((r) => r.id);
  const commentIds = (await c.query<{ id: number }>(`SELECT id FROM comments WHERE fact_id = ANY($1)`, [variantIds])).rows.map((r) => r.id);
  const reviewIds = (await c.query<{ id: number }>(
    `SELECT id FROM pending_reviews WHERE staging_fact_id = ANY($1) OR approved_fact_id = ANY($1)`, [variantIds],
  )).rows.map((r) => r.id);

  // 0142's order: explicit deletions, the facts (with their cascades), then the reviews.
  if (await hasColumn(c, "reactions", "target_type")) {
    await cascade("reactions", await ctidsWhere("reactions",
      `(target_type = 'fact' AND target_id = ANY($1)) OR (target_type = 'meme' AND target_id = ANY($2)) OR (target_type = 'comment' AND target_id = ANY($3))`,
      [variantIds, memeIds, commentIds]));
  }
  if (await hasColumn(c, "activity_feed", "metadata")) {
    await cascade("activity_feed", await ctidsWhere("activity_feed",
      `(jsonb_typeof(metadata -> 'factId') = 'number' AND (metadata ->> 'factId')::numeric = ANY($1::numeric[]))
        OR (jsonb_typeof(metadata -> 'reviewId') = 'number' AND (metadata ->> 'reviewId')::numeric = ANY($2::numeric[]))`,
      [variantIds, reviewIds]));
  }
  await cascade("facts", await ctidsWhere("facts", `id = ANY($1)`, [variantIds]));
  await cascade("pending_reviews", await ctidsWhere("pending_reviews", `id = ANY($1)`, [reviewIds]));

  for (const [table, set] of gone) if (set.size > 0) out.set(table, set.size);
  return out;
}
