/**
 * The rows a retiring migration will delete from a database, counted per table
 * BEFORE it runs, so the upgrade rehearsal can tell the authorised deletion from
 * an accidental loss: 0142 (variants retired; plan
 * docs/plans/PLAN_RETIRE_VARIANTS.md) and 0151 (refresh and resubmission reviews
 * retired; plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1H), and 0160 (the
 * taxonomy drops; the same plan, 2A/2B: its three tables are declared whole in
 * RETIRED_TABLES, its deleted jobs counted by taxonomyDropLosses), and 0167
 * and 0169 (fact administration's drops, 3.2e: the edit history declared in
 * RETIRED_TABLES, the backfill queue's jobs counted by aiMemeBackfillDropLosses),
 * and 0170 (the eval harness's data, launch Phase 8 part 4: eval_runs declared in
 * RETIRED_TABLES; it deletes no rows), and 0171 (the automatic-render queue's
 * jobs, plan PLAN_RENDERS_MANUAL.md D2, counted by reviewRenderPrepareDropLosses).
 *
 * For 0142:
 * Read on the restored snapshot while `facts.parent_id` still exists, using
 * 0142's own ownership rules: the variant facts (V); every row a cascading
 * foreign key removes with them, followed through the catalogue to any depth;
 * reactions on V's facts, memes and comments; activity entries recording a fact
 * in V or a review that staged or approved one (R); R itself, and whatever
 * cascades from it. Each row is counted once (by ctid). A database without the
 * column, or without a variant, gets an empty map: no allowance at all. Tables
 * resolve in the connection's own schema, as 0142's do.
 *
 * @purpose Count, per table, the rows a retiring migration (0142, 0151, 0160, 0167, 0169, 0170) will delete, before it runs, for the upgrade rehearsal's expected counts.
 * @subsystem upgrade-rehearsal
 */
import type pg from "pg";

/** table → number of rows a migration will delete. */
export type RetirementLosses = Map<string, number>;

interface CascadeFk { child: string; childCols: string[]; parent: string; parentCols: string[] }

async function hasColumn(c: pg.ClientBase, table: string, column: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

/** Whether a table exists in the connection's schema. A losses step reads only tables the counted database has: the frozen snapshot predates later tables (Issue #1294). */
async function hasTable(c: pg.ClientBase, table: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
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

/** Deletion bookkeeping: each row counted once (by ctid), cascades followed through the catalogue. */
async function deletionCounter(c: pg.ClientBase) {
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
  const losses = (): RetirementLosses => {
    const out: RetirementLosses = new Map();
    for (const [table, set] of gone) if (set.size > 0) out.set(table, set.size);
    return out;
  };
  return { cascade, ctidsWhere, losses };
}

export async function variantRetirementLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  const out: RetirementLosses = new Map();
  if (!(await hasColumn(c, "facts", "parent_id"))) return out;
  const { cascade, ctidsWhere, losses } = await deletionCounter(c);

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

  return losses();
}

/**
 * The rows migration 0151 will delete, by its own rules: every refresh review
 * (candidate_version_id set) and every open resubmission review (an open review
 * of a fact created before it), with what cascades from them; the pending picks
 * of gags a refresh owned; enrichment versions that never became the fact's
 * (candidate, rejected); and the queued work that only served those reviews.
 * A database without the column gets an empty map: no allowance at all.
 */
export async function refreshRetirementLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  if (!(await hasColumn(c, "pending_reviews", "candidate_version_id"))) return new Map();
  const { cascade, ctidsWhere, losses } = await deletionCounter(c);

  const refreshIds = (await c.query<{ id: number }>(
    `SELECT id FROM pending_reviews WHERE candidate_version_id IS NOT NULL`,
  )).rows.map((r) => r.id);
  const resubmitIds = (await c.query<{ id: number }>(
    `SELECT r.id FROM pending_reviews r JOIN facts f ON f.id = r.staging_fact_id
      WHERE r.candidate_version_id IS NULL AND r.status = 'pending' AND f.created_at < r.created_at`,
  )).rows.map((r) => r.id);
  const reviewIds = [...refreshIds, ...resubmitIds];

  // 0151's order: pending picks, jobs, versions, then the reviews (with their cascades).
  // A database older than 0139/0143 (the frozen snapshot) has no gags, so no picks to count.
  if (await hasTable(c, "fact_gag_examples") && await hasTable(c, "fact_gags")) {
    await cascade("fact_gag_examples", await ctidsWhere("fact_gag_examples",
      `stage = 'pending' AND gag_id IN (SELECT id FROM fact_gags WHERE removed_at IS NULL AND pending_review_id = ANY($1))`,
      [refreshIds]));
  }
  await cascade("async_jobs", await ctidsWhere("async_jobs",
    `queue = 'fact_send_back'
      OR (status IN ('pending', 'recovering', 'processing') AND (
            (queue = 'enrichment' AND payload ? 'versionId')
         OR (queue = 'fact_visual_concepts' AND (payload ->> 'reviewId') = ANY($1::text[]))))`,
    [reviewIds.map(String)]));
  await cascade("fact_enrichment_versions", await ctidsWhere("fact_enrichment_versions", `status IN ('candidate', 'rejected')`, []));
  await cascade("pending_reviews", await ctidsWhere("pending_reviews", `id = ANY($1)`, [reviewIds]));
  return losses();
}

/**
 * Settings retired by a migration, by admin_config key: each such row is deleted
 * on upgrade, so the rehearsal expects it gone rather than kept. Declared by
 * name; every other setting stays protected.
 *   - review_duplicate_threshold: 0149 (plan docs/plans/PLAN_DUPLICATE_VERDICT.md),
 *     the duplicate verdict replaced the similarity cut-off.
 *   - engine_revision: 0160 (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 2A), the
 *     engine revision went with Taxonomy Health.
 */
export const RETIRED_ADMIN_CONFIG_KEYS: readonly string[] = ["review_duplicate_threshold", "engine_revision"];

/**
 * Tables a migration drops whole, by name: the rehearsal expects each one gone
 * and reports its rows under intendedTableDrops, never as a loss.
 *   - 0160 (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 2A/2B; Issue #1018, 2.1c): the
 *     legacy enrichment versions (converted to fact_taxonomy_runs by 0159), the
 *     manual-override history, and the engine-revision record.
 *   - 0167 (the same plan, item 23; Issue #1018, 3.2e): the approved-text edit
 *     history, whose route went in 3.2c.
 *   - 0170 (plan PLAN_PROMPT_TUNER.md, *E. Retirements*; Issue #887, launch
 *     Phase 8 part 4): the old eval harness's runs, whose readers went in
 *     PR #1290.
 */
export const RETIRED_TABLES: readonly string[] = [
  "fact_enrichment_versions", "enrichment_override_history", "engine_revision_bumps", "fact_text_edit_history",
  "eval_runs",
];

/**
 * The async jobs migration 0160 will delete, by its own rule: every job on the
 * three queues 2.1a removed (taxonomy backfill, character fill, projection
 * repair), and any review-keyed taxonomy job (nothing queues one since 1.2c-ii).
 */
export async function taxonomyDropLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM async_jobs
      WHERE queue IN ('fact_enrichment_backfill', 'fact_character_fill', 'projection_repair')
         OR (queue = 'enrichment' AND payload ? 'reviewId' AND NOT (payload ? 'factId'))`,
  );
  const n = Number(rows[0]?.n ?? 0);
  return n > 0 ? new Map([["async_jobs", n]]) : new Map();
}

/**
 * The async jobs migration 0169 will delete: every job on the retired
 * AI-background backfill queue, whose handler 3.2d removed (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, item 23; Issue #1018, 3.2e).
 */
export async function aiMemeBackfillDropLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM async_jobs WHERE queue = 'fact_ai_meme_backfill'`,
  );
  const n = Number(rows[0]?.n ?? 0);
  return n > 0 ? new Map([["async_jobs", n]]) : new Map();
}

/**
 * The async jobs migration 0171 will delete: every job on the retired
 * automatic-render queue, whose producers and handler were removed when every
 * render became a request (plan PLAN_RENDERS_MANUAL.md, D2; Issue #1282).
 */
export async function reviewRenderPrepareDropLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM async_jobs WHERE queue = 'review_render_scenarios_prepare'`,
  );
  const n = Number(rows[0]?.n ?? 0);
  return n > 0 ? new Map([["async_jobs", n]]) : new Map();
}

/** The admin_config rows the retired-settings deletions will remove, counted before they run. */
export async function retiredSettingLosses(c: pg.ClientBase): Promise<RetirementLosses> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM admin_config WHERE key = ANY($1::text[])`,
    [RETIRED_ADMIN_CONFIG_KEYS],
  );
  const n = Number(rows[0]?.n ?? 0);
  return n > 0 ? new Map([["admin_config", n]]) : new Map();
}

/** Whether an adminValues key ("admin_config/<key>/<column>") belongs to a retired setting. */
export function isRetiredSettingValue(valueKey: string): boolean {
  return RETIRED_ADMIN_CONFIG_KEYS.some((k) => valueKey.startsWith(`admin_config/${k}/`));
}

/** Merge per-table loss maps by summing. */
export function mergeLosses(...maps: RetirementLosses[]): RetirementLosses {
  const out: RetirementLosses = new Map();
  for (const m of maps) for (const [t, n] of m) out.set(t, (out.get(t) ?? 0) + n);
  return out;
}
