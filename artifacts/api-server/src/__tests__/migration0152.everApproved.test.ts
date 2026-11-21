/**
 * Migration 0152 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, "Data Model
 * and Migration Impact", step 1): which facts were ever approved, established
 * from legacy evidence and recorded as legacy, with no approver invented.
 *
 * The row-state matrix, each planted and checked:
 * - a fact a review approved for production (now deactivated): legacy, at that
 *   review's reviewed_at;
 * - a live fact with no review on record: legacy, at its created_at;
 * - a fact in moderation (an open review stages it): not approved;
 * - a fact whose review was rejected: not approved;
 * - an inactive fact with no review at all: not approved, reported by id;
 * - a fact whose approval a moderator already recorded: untouched;
 * - a second run changes nothing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { sqlAsOf0155 } from "../testing/stageLabelsAsOf0155.js";
import { publishedGagRuleOff, publishedGagRuleOn } from "./helpers/publishedGagRule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = sqlAsOf0155(readFileSync(path.join(ROOT, "lib/db/migrations/0152_admin_actions_and_ever_approved.sql"), "utf8")); // its stage labels as 0155 renamed them
const P = `t_0152_${randomUUID().slice(0, 8)}`;
const ADMIN = `${P}_admin`;

type Row = Record<string, unknown>;
const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await db.execute(q)).rows[0] as T | undefined;
const approval = (id: number) => one<{ at: string | null; by: string | null; source: string | null }>(
  sql`SELECT approved_at::text AS at, approved_by_id AS by, approval_source AS source FROM facts WHERE id = ${id}`);

async function inactiveFact(label: string, createdAt = "2026-01-01T00:00:00Z"): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO facts (text, is_active, created_at) VALUES (${`{NAME} ${P} ${label}`}, false, ${createdAt}::timestamptz) RETURNING id`);
  return r!.id;
}
async function review(stagingFactId: number, status: string, stage: string, reviewedAt: string | null = null): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO pending_reviews (submitted_text, status, workflow_stage, staging_fact_id, reviewed_at)
    VALUES (${`{NAME} ${P} review`}, ${status}::review_status, ${stage}::review_workflow_stage, ${stagingFactId}, ${reviewedAt}::timestamptz)
    RETURNING id`);
  return r!.id;
}

describe("migration 0152: facts that were ever approved", () => {
  const f: Record<string, number> = {};
  let liveCreated: string;
  let notice = "";
  before(async () => {
    // Data in its own era's shape: no approval record yet, no 0157 rule.
    await publishedGagRuleOff();
    await db.insert(usersTable).values({ id: ADMIN }).onConflictDoNothing();
    f.approvedThenDeactivated = await inactiveFact("approved-then-deactivated");
    await review(f.approvedThenDeactivated, "approved", "approved", "2026-03-04T05:06:07Z");
    const live = await insertLiveFact({ text: `{NAME} ${P} live`, enrichment: buildPlaceholderFactEnrichment(), approvedAt: null }, { ...buildPlaceholderGag(), coreSceneOverride: "{NAME} live." });
    f.liveNoReview = live.id;
    liveCreated = (await one<{ c: string }>(sql`SELECT created_at::text AS c FROM facts WHERE id = ${live.id}`))!.c;
    f.inModeration = await inactiveFact("in-moderation");
    await review(f.inModeration, "pending", "gags");
    f.rejected = await inactiveFact("rejected");
    await review(f.rejected, "rejected", "rejected");
    f.unestablished = await inactiveFact("unestablished");
    f.moderatorRecorded = await inactiveFact("moderator-recorded");
    await db.execute(sql`UPDATE facts SET approved_at = '2026-05-05T00:00:00Z', approved_by_id = ${ADMIN}, approval_source = 'moderator' WHERE id = ${f.moderatorRecorded}`);
    // The notice carries the unestablished ids; catch it from the same connection.
    const client = await pool.connect();
    client.on("notice", (m) => { if (m.message?.startsWith("0152_")) notice = m.message; });
    try { await client.query(MIGRATION_SQL); } finally { client.release(); }
  });
  after(async () => {
    await db.execute(sql`DELETE FROM pending_reviews WHERE submitted_text LIKE ${`%${P}%`}`);
    await db.execute(sql`DELETE FROM facts WHERE text LIKE ${`%${P}%`}`);
    await db.delete(usersTable).where(eq(usersTable.id, ADMIN));
    // Back on last, once this file's era-shaped rows are gone.
    await publishedGagRuleOn();
  });

  it("records a production approval on record as legacy, at the review's time, with no approver", async () => {
    const a = await approval(f.approvedThenDeactivated);
    assert.equal(a!.source, "legacy");
    assert.equal(a!.by, null);
    assert.equal(new Date(a!.at!).toISOString(), "2026-03-04T05:06:07.000Z");
  });

  it("records a live fact with no review as legacy, at its creation", async () => {
    const a = await approval(f.liveNoReview);
    assert.equal(a!.source, "legacy");
    assert.equal(a!.by, null);
    assert.equal(new Date(a!.at!).toISOString(), new Date(liveCreated).toISOString());
  });

  it("leaves a fact in moderation, a rejected fact and an unestablished fact unapproved", async () => {
    for (const k of ["inModeration", "rejected", "unestablished"]) {
      assert.deepEqual(await approval(f[k]!), { at: null, by: null, source: null }, k);
    }
  });

  it("reports an unestablished fact by id", () => {
    assert.match(notice, new RegExp(`unestablished \\d+ \\(ids: [^)]*\\b${f.unestablished}\\b`));
  });

  it("leaves an approval a moderator recorded untouched", async () => {
    const a = await approval(f.moderatorRecorded);
    assert.equal(a!.source, "moderator");
    assert.equal(a!.by, ADMIN);
  });

  it("a second run changes nothing", async () => {
    const snap = async () => (await db.execute(sql`SELECT id, approved_at, approved_by_id, approval_source FROM facts WHERE text LIKE ${`%${P}%`} ORDER BY id`)).rows as Row[];
    const first = await snap();
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await snap(), first);
  });
});
