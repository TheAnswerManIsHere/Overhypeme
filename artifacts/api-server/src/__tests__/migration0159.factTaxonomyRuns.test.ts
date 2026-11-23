/**
 * Migration 0159 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 16 and
 * 2B; Issue #1018, increment 2.1b): the legacy fact_enrichment_versions rows
 * become taxonomy run history.
 *
 * The row-state matrix, each planted and checked:
 * - a promoted version: one `legacy_promoted` row, at its promoted_at, whose
 *   output is the version's AI baseline;
 * - a superseded version with no baseline: one `legacy_superseded` row, at its
 *   archive time, whose output is its stored blob with the gag removed;
 * - a version with no output at all: skipped, counted, no row;
 * - a second run: no new row (already converted, counted);
 * - a candidate row, which 0151 deleted: the migration aborts and names it.
 *
 * Migration 0160 dropped the source table, so the file puts it back first and
 * runs 0160 again at the end (helpers/pre0160Schema.ts).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";
import { restorePre0160Schema, rerun0160 } from "./helpers/pre0160Schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
// 0159 looks for its source table in `public`, where production keeps it; the
// test schema is another, and since 0160 the table exists only where this file
// puts it back, so the test reads 0159's guard against the current schema.
const PUBLIC_GUARD = "to_regclass('public.fact_enrichment_versions')";
const MIGRATION_FILE = readFileSync(path.join(ROOT, "lib/db/migrations/0159_fact_taxonomy_runs.sql"), "utf8");
if (!MIGRATION_FILE.includes(PUBLIC_GUARD)) throw new Error("0159's source-table guard is not the text this test rewrites");
const MIGRATION_SQL = MIGRATION_FILE.replace(PUBLIC_GUARD, "to_regclass('fact_enrichment_versions')");
const P = `t_0159_${randomUUID().slice(0, 8)}`;

type RunRow = { origin: string; outcome: string; output: Record<string, unknown> | null; at: string; legacy: string };
const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await db.execute(q)).rows[0] as T | undefined;

async function fact(label: string): Promise<number> {
  const r = await one<{ id: number }>(sql`INSERT INTO facts (text, is_active) VALUES (${`{NAME} ${P} ${label}`}, false) RETURNING id`);
  return r!.id;
}
async function version(factId: number, v: {
  status: string; enrichment?: unknown; aiDerived?: unknown; createdAt: string; promotedAt?: string;
}): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO fact_enrichment_versions (fact_id, version_no, status, enrichment, enrichment_ai_derived, source, created_at, promoted_at)
    VALUES (${factId}, 1, ${v.status},
            ${v.enrichment === undefined ? null : JSON.stringify(v.enrichment)}::jsonb,
            ${v.aiDerived === undefined ? null : JSON.stringify(v.aiDerived)}::jsonb,
            'prior_active_snapshot', ${v.createdAt}::timestamptz, ${v.promotedAt ?? null}::timestamptz)
    RETURNING id`);
  return r!.id;
}
const runsOf = async (factId: number): Promise<RunRow[]> => (await db.execute(sql`
  SELECT origin, outcome, output, created_at::text AS at, legacy_version_id::text AS legacy
    FROM fact_taxonomy_runs WHERE fact_id = ${factId} ORDER BY id`)).rows as RunRow[];

async function runMigration(): Promise<string> {
  let notice = "";
  const client = await pool.connect();
  client.on("notice", (m) => { if (m.message?.startsWith("[0159]")) notice = m.message; });
  try { await client.query(MIGRATION_SQL); } finally { client.release(); }
  return notice;
}

describe("migration 0159: legacy enrichment versions become taxonomy run history", () => {
  const base = buildPlaceholderFactEnrichment();
  const baseline = { ...base, primaryArchetype: "superhuman_physical_feat", adminReviewNotes: `${P} baseline` };
  const stored = { ...base, adminReviewNotes: `${P} stored`, visualPromptStrategyOverride: { coreSceneOverride: "{NAME} lifts." } };
  const f: Record<string, number> = {};
  const v: Record<string, number> = {};
  let first = "";
  let second = "";
  before(async () => {
    await restorePre0160Schema();
    f.promoted = await fact("promoted");
    v.promoted = await version(f.promoted, {
      status: "promoted", enrichment: stored, aiDerived: baseline,
      createdAt: "2026-02-01T00:00:00Z", promotedAt: "2026-02-03T04:05:06Z",
    });
    f.superseded = await fact("superseded");
    v.superseded = await version(f.superseded, { status: "superseded", enrichment: stored, createdAt: "2026-01-02T03:04:05Z" });
    f.empty = await fact("empty");
    v.empty = await version(f.empty, { status: "superseded", createdAt: "2026-01-01T00:00:00Z" });
    first = await runMigration();
    second = await runMigration();
  });
  after(async () => {
    await db.execute(sql`DELETE FROM facts WHERE text LIKE ${`%${P}%`}`); // cascades to both tables
    await rerun0160();
  });

  it("converts a promoted version at its promotion time, from its AI baseline", async () => {
    const rows = await runsOf(f.promoted!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.origin, "legacy_promoted");
    assert.equal(rows[0]!.outcome, "ok");
    assert.equal(rows[0]!.legacy, String(v.promoted));
    assert.equal(new Date(rows[0]!.at).toISOString(), "2026-02-03T04:05:06.000Z");
    assert.equal(rows[0]!.output!["adminReviewNotes"], `${P} baseline`);
  });

  it("converts a superseded version at its archive time, from its stored blob with the gag removed", async () => {
    const rows = await runsOf(f.superseded!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.origin, "legacy_superseded");
    assert.equal(new Date(rows[0]!.at).toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(rows[0]!.output!["adminReviewNotes"], `${P} stored`);
    assert.equal("visualPromptStrategyOverride" in rows[0]!.output!, false);
  });

  it("skips a version with no output, and counts it", async () => {
    assert.deepEqual(await runsOf(f.empty!), []);
    assert.match(first, /skipped \(no output\) [1-9]\d*/);
  });

  it("a second run converts nothing new, and counts the rows already converted", async () => {
    assert.match(second, /converted 0, already converted \(no-op\) ([2-9]|\d{2,})/);
    for (const k of ["promoted", "superseded"]) assert.equal((await runsOf(f[k]!)).length, 1, k);
  });

  it("aborts on a candidate version, naming it, and converts nothing", async () => {
    const id = await fact("candidate");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fact_enrichment_versions (fact_id, version_no, status, enrichment, source)
         VALUES ($1, 1, 'candidate', $2::jsonb, 'refresh_candidate') RETURNING id`,
        [id, JSON.stringify(base)],
      );
      await assert.rejects(client.query(MIGRATION_SQL), new RegExp(`unexpected fact_enrichment_versions rows, not converted: .*\\b${rows[0]!.id} \\(candidate\\)`));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.deepEqual(await runsOf(id), []);
  });
});
