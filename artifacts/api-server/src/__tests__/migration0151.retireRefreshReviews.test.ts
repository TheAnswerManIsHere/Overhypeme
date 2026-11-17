/**
 * Migration 0151 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1H and "Data
 * Model and Migration Impact"): refresh reviews and resubmission reviews are
 * retired, and the facts they touched are left as they were.
 *
 * The row-state matrix, each planted and checked:
 * - an open refresh of a live fact: closed (deleted); a gag it created and
 *   never approved is removed, a gag it changed keeps its approved version
 *   and loses the change and the pick, its removal mark is cleared, a gag it
 *   never touched is unchanged; the ideas and prep mark it owned are cleared;
 *   its candidate version and its queued work are deleted; the fact stays live
 *   and still offers every gag it offered;
 * - every other stored set of gag ideas loses its candidateVersionId key, and
 *   keeps its input hash;
 * - a promoted refresh: deleted; its promoted and superseded versions are kept
 *   as history, their review pointer nulled;
 * - a declined refresh: deleted with its rejected version;
 * - an open resubmission of a deactivated fact: deleted; the fact stays
 *   inactive and its gags are unchanged;
 * - an approved resubmission: kept (a record of the fact's approval);
 * - an open first-time submission: untouched;
 * - a second run changes nothing.
 *
 * Migration 0153 dropped the three columns 0151 reads, so this file first puts
 * them back as they stood before it (the schema 0151 ran against), and ends by
 * running 0153 itself: its closing pass closes a refresh written after 0151 ran,
 * and it drops the columns again.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, imagePromptAttemptsTable } from "@workspace/db";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0151_retire_refresh_reviews.sql"), "utf8");
const CONTRACT_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0153_drop_refresh_review_columns.sql"), "utf8");
const P = `t_0151_${randomUUID().slice(0, 8)}`;

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await rows(q))[0] as T | undefined;
const content = (scene: string) => JSON.stringify({ ...buildPlaceholderGag(), coreSceneOverride: scene });

async function review(stagingFactId: number | null, status: string, stage: string, opts: { candidateVersionId?: number; createdAt?: string } = {}): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO pending_reviews (submitted_text, status, workflow_stage, staging_fact_id, candidate_version_id, created_at)
    VALUES (${`{NAME} ${P} review`}, ${status}::review_status, ${stage}::review_workflow_stage, ${stagingFactId}, ${opts.candidateVersionId ?? null},
            ${opts.createdAt ?? new Date().toISOString()}::timestamptz)
    RETURNING id`);
  return r!.id;
}
async function version(factId: number, status: string, sourceReviewId: number | null): Promise<number> {
  const v = await one<{ id: number }>(sql`
    INSERT INTO fact_enrichment_versions (fact_id, version_no, status, source, source_review_id)
    VALUES (${factId}, (SELECT coalesce(max(version_no), 0) + 1 FROM fact_enrichment_versions WHERE fact_id = ${factId}),
            ${status}, ${status === "superseded" ? "prior_active_snapshot" : "refresh_candidate"}, ${sourceReviewId})
    RETURNING id`);
  return v!.id;
}
async function attempt(factId: number, gagId: number): Promise<number> {
  const [a] = await db.insert(imagePromptAttemptsTable).values({
    factId, gagId, reviewRenderScenarioKey: "i2i_male_default", renderJobId: randomUUID(),
    generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
    sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
    factEnrichmentSnapshot: {} as never, archetypeStrategyVersion: "v2", generatedImageObjectPath: `/objects/${P}/${randomUUID()}.png`,
  }).returning({ id: imagePromptAttemptsTable.id });
  return a!.id;
}
const gag = (id: number) => one<Row>(sql`SELECT * FROM fact_gags WHERE id = ${id}`);
const exists = async (table: string, id: number) => (await rows(sql.raw(`SELECT 1 FROM ${table} WHERE id = ${id}`))).length > 0;

interface Seed {
  live: number; liveUntouched: number; liveChanged: number; liveMarked: number; liveAdded: number;
  openRefresh: number; openCandidate: number; jobs: number[];
  promoted: number; promotedVersion: number; supersededVersion: number;
  declined: number; rejectedVersion: number;
  deactivated: number; deactivatedGag: number; openResubmit: number; approvedResubmit: number;
  firstTime: number; staging: number;
}

async function seed(): Promise<Seed> {
  const enrichment = buildPlaceholderFactEnrichment();
  // A live fact with three approved gags, under an open refresh.
  const f = await insertLiveFact({ text: `{NAME} ${P} live`, enrichment }, { ...buildPlaceholderGag(), coreSceneOverride: "{NAME} one." });
  const live = f.id;
  const liveUntouched = f.gags[0]!.id;
  const more = await rows(sql`
    INSERT INTO fact_gags (fact_id, slot, approved_content, approved_carried_over)
    VALUES (${live}, 2, ${content("{NAME} two.")}::jsonb, true), (${live}, 3, ${content("{NAME} three.")}::jsonb, true)
    RETURNING id`);
  const liveChanged = Number(more[0]!.id);
  const liveMarked = Number(more[1]!.id);
  const openRefresh = await review(live, "pending", "production_review");
  const openCandidate = await version(live, "candidate", openRefresh);
  await db.execute(sql`UPDATE pending_reviews SET candidate_version_id = ${openCandidate} WHERE id = ${openRefresh}`);
  // Gag 2: a change with a pick, owned by the refresh. Gag 3: marked for removal.
  await db.execute(sql`UPDATE fact_gags SET pending_content = ${content("{NAME} two, changed.")}::jsonb, pending_review_id = ${openRefresh} WHERE id = ${liveChanged}`);
  await db.execute(sql`INSERT INTO fact_gag_examples (gag_id, subject_kind, stage, attempt_id) VALUES (${liveChanged}, 'male', 'pending', ${await attempt(live, liveChanged)})`);
  await db.execute(sql`UPDATE fact_gags SET pending_remove = true, pending_review_id = ${openRefresh} WHERE id = ${liveMarked}`);
  // The live fact has three gags already; a gag added in the refresh needs a free slot, so it goes on the
  // promoted refresh's fact below. Ideas and prep mark held by the open refresh:
  await db.execute(sql`UPDATE facts SET visual_concept_owner = ${`review:${openRefresh}`}, visual_concept_status = 'pending', enrichment_status = 'pending' WHERE id = ${live}`);
  const jobs = (await rows(sql`
    INSERT INTO async_jobs (queue, payload, status) VALUES
      ('fact_send_back', ${JSON.stringify({ factId: live })}::jsonb, 'done'),
      ('enrichment', ${JSON.stringify({ versionId: openCandidate })}::jsonb, 'pending'),
      ('fact_visual_concepts', ${JSON.stringify({ reviewId: openRefresh, factId: live })}::jsonb, 'pending')
    RETURNING id`)).map((r) => Number(r.id));

  // A second live fact: a promoted refresh in its history, and a gag a refresh added and never approved.
  const g = await insertLiveFact({ text: `{NAME} ${P} promoted`, enrichment }, { ...buildPlaceholderGag(), coreSceneOverride: "{NAME} kept." });
  const promoted = await review(g.id, "approved", "production_approved");
  const promotedVersion = await version(g.id, "promoted", promoted);
  const supersededVersion = await version(g.id, "superseded", promoted);
  await db.execute(sql`UPDATE pending_reviews SET candidate_version_id = ${promotedVersion} WHERE id = ${promoted}`);
  const declined = await review(g.id, "rejected", "production_rejected");
  const rejectedVersion = await version(g.id, "rejected", declined);
  await db.execute(sql`UPDATE pending_reviews SET candidate_version_id = ${rejectedVersion} WHERE id = ${declined}`);
  const liveAdded = Number((await one<{ id: number }>(sql`
    INSERT INTO fact_gags (fact_id, slot, pending_content, pending_review_id)
    VALUES (${g.id}, 2, ${content("{NAME} added in a refresh.")}::jsonb, ${declined}) RETURNING id`))!.id);

  // A deactivated fact, resubmitted (the review is newer than the fact) and approved once before.
  const d = await insertLiveFact({ text: `{NAME} ${P} deactivated`, enrichment }, { ...buildPlaceholderGag(), coreSceneOverride: "{NAME} old." });
  await db.execute(sql`UPDATE facts SET is_active = false, created_at = now() - interval '2 days' WHERE id = ${d.id}`);
  const approvedResubmit = await review(d.id, "approved", "production_approved", { createdAt: new Date(Date.now() - 86_400_000).toISOString() });
  const openResubmit = await review(d.id, "pending", "concept_review");

  // A first-time submission whose staging fact was created after it, holding ideas drafted for it.
  const firstTime = await review(null, "pending", "concept_review", { createdAt: new Date(Date.now() - 60_000).toISOString() });
  const staging = Number((await one<{ id: number }>(sql`INSERT INTO facts (text, is_active) VALUES (${`{NAME} ${P} staging`}, false) RETURNING id`))!.id);
  await db.execute(sql`UPDATE pending_reviews SET staging_fact_id = ${staging} WHERE id = ${firstTime}`);
  const blob = { candidates: [], generatedAt: "2026-11-17T00:00:00Z", reviewId: firstTime, candidateVersionId: null, source: "staging_fact", inputHash: "h0151",
    provenance: { engineId: "e", model: null, reasoningEffort: null, timeoutMs: 1, promptVersion: 3 } };
  await db.execute(sql`UPDATE facts SET visual_concept_candidates = ${JSON.stringify(blob)}::jsonb, visual_concept_status = 'ok', visual_concept_owner = ${`review:${firstTime}`} WHERE id = ${staging}`);

  return {
    live, liveUntouched, liveChanged, liveMarked, liveAdded, openRefresh, openCandidate, jobs,
    promoted, promotedVersion, supersededVersion, declined, rejectedVersion,
    deactivated: d.id, deactivatedGag: d.gags[0]!.id, openResubmit, approvedResubmit, firstTime, staging,
  };
}

// The schema 0151 ran against: the columns 0153 drops, as 0139 and 0143 left them.
before(async () => {
  await db.execute(sql.raw(`
    ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS candidate_version_id bigint;
    ALTER TABLE fact_gags ADD COLUMN IF NOT EXISTS pending_review_id integer REFERENCES pending_reviews(id) ON DELETE SET NULL;
    ALTER TABLE fact_gags ADD COLUMN IF NOT EXISTS pending_remove boolean NOT NULL DEFAULT false;
    ALTER TABLE fact_gags DROP CONSTRAINT IF EXISTS fact_gags_pending_ops_owned;
    ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_pending_ops_owned CHECK (NOT pending_remove OR pending_review_id IS NOT NULL);
  `));
});
// Whatever happens above, leave the schema as the migrations build it.
after(async () => { await db.execute(sql.raw(CONTRACT_SQL)); });

describe("migration 0151: refresh and resubmission reviews are retired", () => {
  let s: Seed;
  let untouchedBefore: Row | undefined;
  before(async () => {
    s = await seed();
    untouchedBefore = await gag(s.liveUntouched);
    await db.execute(sql.raw(MIGRATION_SQL));
  });

  it("closes an open refresh and leaves its live fact as it was", async () => {
    assert.equal(await exists("pending_reviews", s.openRefresh), false);
    assert.equal(await exists("fact_enrichment_versions", s.openCandidate), false);
    const fact = await one<{ is_active: boolean; visual_concept_owner: string | null; visual_concept_status: string | null; enrichment_status: string | null }>(
      sql`SELECT is_active, visual_concept_owner, visual_concept_status, enrichment_status FROM facts WHERE id = ${s.live}`);
    assert.equal(fact!.is_active, true);
    assert.equal(fact!.visual_concept_owner, null, "the ideas the refresh owned are cleared");
    assert.equal(fact!.visual_concept_status, null);
    assert.equal(fact!.enrichment_status, "ok", "the prep mark is cleared");

    assert.deepEqual(await gag(s.liveUntouched), untouchedBefore, "a gag the refresh never touched is unchanged");
    const changed = await gag(s.liveChanged);
    assert.equal((changed!.approved_content as { coreSceneOverride: string }).coreSceneOverride, "{NAME} two.", "the approved version stands");
    assert.equal(changed!.pending_content, null, "the refresh's change is discarded");
    assert.equal(changed!.pending_review_id, null);
    assert.equal((await rows(sql`SELECT 1 FROM fact_gag_examples WHERE gag_id = ${s.liveChanged} AND stage = 'pending'`)).length, 0, "and its pick");
    const marked = await gag(s.liveMarked);
    assert.equal(marked!.removed_at, null, "a removal mark is not applied");
    assert.equal(marked!.pending_remove, false);
    const offered = await rows(sql`SELECT id FROM fact_gags WHERE fact_id = ${s.live} AND removed_at IS NULL AND approved_content IS NOT NULL`);
    assert.equal(offered.length, 3, "the fact still offers every gag it offered");

    const jobs = await rows(sql`SELECT id FROM async_jobs WHERE id = ANY(${`{${s.jobs.join(",")}}`}::int[])`);
    assert.deepEqual(jobs, [], "send-back, candidate enrichment and the refresh's idea jobs are deleted");
  });

  it("deletes finished refreshes, keeping promoted and superseded versions as history", async () => {
    assert.equal(await exists("pending_reviews", s.promoted), false);
    assert.equal(await exists("pending_reviews", s.declined), false);
    assert.equal(await exists("fact_enrichment_versions", s.rejectedVersion), false);
    for (const id of [s.promotedVersion, s.supersededVersion]) {
      const v = await one<{ source_review_id: number | null }>(sql`SELECT source_review_id FROM fact_enrichment_versions WHERE id = ${id}`);
      assert.ok(v, `version ${id} is kept`);
      assert.equal(v!.source_review_id, null);
    }
    const added = await gag(s.liveAdded);
    assert.ok(added!.removed_at, "a gag a refresh added and never approved is removed");
  });

  it("closes an open resubmission, keeps the approved one, and leaves the deactivated fact as it was", async () => {
    assert.equal(await exists("pending_reviews", s.openResubmit), false);
    assert.equal(await exists("pending_reviews", s.approvedResubmit), true);
    const fact = await one<{ is_active: boolean }>(sql`SELECT is_active FROM facts WHERE id = ${s.deactivated}`);
    assert.equal(fact!.is_active, false);
    assert.equal((await gag(s.deactivatedGag))!.removed_at, null);
  });

  it("leaves a first-time submission untouched", async () => {
    const r = await one<{ status: string; workflow_stage: string; staging_fact_id: number }>(
      sql`SELECT status, workflow_stage, staging_fact_id FROM pending_reviews WHERE id = ${s.firstTime}`);
    assert.deepEqual(r, { status: "pending", workflow_stage: "concept_review", staging_fact_id: s.staging });
    const f = await one<{ b: Record<string, unknown>; status: string; owner: string }>(
      sql`SELECT visual_concept_candidates AS b, visual_concept_status AS status, visual_concept_owner AS owner FROM facts WHERE id = ${s.staging}`);
    assert.equal("candidateVersionId" in f!.b, false, "the retired key leaves its ideas");
    assert.equal(f!.b.inputHash, "h0151", "and its ideas keep their hash");
    assert.equal(f!.status, "ok");
    assert.equal(f!.owner, `review:${s.firstTime}`);
  });

  it("a second run changes nothing", async () => {
    const snap = async () => ({
      reviews: await rows(sql`SELECT id, status FROM pending_reviews ORDER BY id`),
      gags: await rows(sql`SELECT id, pending_content, removed_at FROM fact_gags ORDER BY id`),
      versions: await rows(sql`SELECT id FROM fact_enrichment_versions ORDER BY id`),
    });
    const first = await snap();
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await snap(), first);
  });
});

describe("migration 0153: a late refresh is closed, then the columns are dropped", () => {
  let lateRefresh: number;
  let lateGag: number;
  let live: number;
  before(async () => {
    const f = await insertLiveFact({ text: `{NAME} ${P} late`, enrichment: buildPlaceholderFactEnrichment() }, { ...buildPlaceholderGag(), coreSceneOverride: "{NAME} late." });
    live = f.id;
    lateGag = f.gags[0]!.id;
    const candidate = await version(live, "candidate", null);
    lateRefresh = await review(live, "pending", "concept_review", { candidateVersionId: candidate });
    await db.execute(sql`UPDATE fact_gags SET pending_content = ${content("{NAME} changed late.")}::jsonb, pending_review_id = ${lateRefresh} WHERE id = ${lateGag}`);
    await db.execute(sql.raw(CONTRACT_SQL));
  });

  it("closes the refresh as 0151 did, leaving the live fact's gag as approved", async () => {
    assert.equal(await exists("pending_reviews", lateRefresh), false);
    const g = await gag(lateGag);
    assert.equal(g!.pending_content, null, "the late change is discarded");
    assert.notEqual(g!.approved_content, null, "the approved version stays");
    assert.equal(g!.removed_at, null);
    const fact = await one<{ is_active: boolean }>(sql`SELECT is_active FROM facts WHERE id = ${live}`);
    assert.equal(fact!.is_active, true);
  });

  it("drops the three columns and their constraint", async () => {
    const cols = await rows(sql`
      SELECT table_name || '.' || column_name AS c FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name = 'pending_reviews' AND column_name = 'candidate_version_id')
           OR (table_name = 'fact_gags' AND column_name IN ('pending_review_id', 'pending_remove')))`);
    assert.deepEqual(cols, []);
    const con = await rows(sql`SELECT 1 FROM pg_constraint WHERE conname = 'fact_gags_pending_ops_owned' AND connamespace = current_schema()::regnamespace`);
    assert.deepEqual(con, []);
  });

  it("a re-run changes nothing", async () => {
    await db.execute(sql.raw(CONTRACT_SQL));
    assert.equal(await exists("pending_reviews", lateRefresh), false);
  });
});
