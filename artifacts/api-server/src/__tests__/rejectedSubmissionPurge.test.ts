/**
 * Issue #1304, increment A (plan docs/plans/PLAN_RENDER_HISTORY.md D7, D8 and
 * the cleanup list): a rejected submission is purged, and only one that was
 * never approved; the one-time purge's dry run reports what --apply then
 * does, and a re-run finds nothing; the durable cleanup list commits with its
 * delete, removes what it can, and keeps the rest outstanding; an approval's
 * record commits with the pick; the approval-audit boundary is set once.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  adminActionsTable, adminConfigTable, commentsTable, factGagsTable, factHashtagsTable, factsTable, hashtagsTable,
  imagePromptAttemptsTable, imageProvenanceTable, pendingReviewsTable, storedFileDeletionsTable, usersTable,
} from "@workspace/db/schema";
import { giveExampleSet, insertExampleRender } from "./helpers/gagExampleSets.js";
import { assessRejectedFact, purgeRejectedFact, runRejectedSubmissionPurge } from "../lib/rejectedSubmissionPurge.js";
import {
  __setFileRemoverForTest, queueStoredFileDeletions, runStoredFileCleanup, storedFileDeletionHealth,
} from "../lib/storedFileDeletions.js";
import { listMySubmissions } from "../lib/mySubmissions.js";
import { approveGagRender } from "../lib/gags/gagStore.js";
import {
  RENDER_APPROVAL_AUDIT_KEY, RENDER_APPROVAL_AUDIT_MARGIN_MS, markRenderApprovalAuditBoundary, renderApprovalAuditBoundary,
} from "../lib/renderApprovalAudit.js";

const PREFIX = "t_rsp_";
const GAG = { version: 1, coreSceneOverride: "{NAME} lifts the moon.", bubbles: [] };
let submitterId: string;
let adminId: string;
const pathPrefix = `/objects/ai-bg-v2/${PREFIX}${randomUUID()}`;

/** Removes nothing; records which paths it was asked to remove. */
const removed: string[] = [];
const fakeRemover = { async deleteObject(path: string) { removed.push(path); } };

async function user(isAdmin = false): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, isAdmin, membershipTier: "registered", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() });
  return id;
}

/**
 * A submission at Test Renders with a staging fact holding one gag, its three
 * example renders (each with a provenance record naming its file) and a
 * hashtag; rejected unless `pending`.
 */
async function submission(opts: { rejected?: boolean; approvedAt?: Date | null; isActive?: boolean } = {}) {
  const tag = `${PREFIX}${randomUUID().slice(0, 8)}`;
  const [fact] = await db.insert(factsTable).values({
    text: `{NAME} lifts the moon ${randomUUID()}`, submittedById: submitterId,
    isActive: opts.isActive ?? false, approvedAt: opts.approvedAt ?? null, approvalSource: opts.approvedAt ? "legacy" : null,
  }).returning();
  const [gag] = await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, pendingContent: GAG }).returning();
  const set = await giveExampleSet(fact!.id, gag!.id, GAG, "pending");
  const attempts = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, fact!.id));
  for (const a of attempts) {
    await db.insert(imageProvenanceTable).values({
      id: Math.floor(Math.random() * 2 ** 50) + 1, kind: "ai_render", actorKind: "system",
      attemptId: a.id, factId: fact!.id, objectPath: a.generatedImageObjectPath, sha256: "0".repeat(64), mime: "image/png", byteSize: 1,
    });
  }
  // A picture recorded and uploaded but never linked (its worker stopped).
  const unlinked = `${pathPrefix}/${fact!.id}-unlinked.png`;
  await db.insert(imageProvenanceTable).values({
    id: Math.floor(Math.random() * 2 ** 50) + 1, kind: "ai_render", actorKind: "system",
    attemptId: set.male, factId: fact!.id, objectPath: unlinked, sha256: "0".repeat(64), mime: "image/png", byteSize: 1,
  });
  const [ht] = await db.insert(hashtagsTable).values({ name: tag, factCount: 1 }).returning();
  await db.insert(factHashtagsTable).values({ factId: fact!.id, hashtagId: ht!.id });
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: fact!.text, submittedById: submitterId, stagingFactId: fact!.id,
    status: opts.rejected === false ? "pending" : "rejected",
    workflowStage: opts.rejected === false ? "test_renders" : "rejected",
    reason: "visual", adminNote: "no picture lands", reviewedAt: new Date(),
  }).returning();
  const files = [...attempts.map((a) => a.generatedImageObjectPath!), unlinked].sort();
  return { fact: fact!, gag: gag!, review: review!, hashtagId: ht!.id, files };
}

before(async () => {
  submitterId = await user();
  adminId = await user(true);
});

after(async () => {
  __setFileRemoverForTest(null);
  await db.delete(storedFileDeletionsTable).where(like(storedFileDeletionsTable.path, "/objects/ai-bg-v2/%"));
  await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.submittedById, [submitterId]));
  await db.delete(factsTable).where(eq(factsTable.submittedById, submitterId));
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, `${PREFIX}%`));
  await db.delete(adminActionsTable).where(eq(adminActionsTable.actorId, adminId));
  await db.delete(usersTable).where(inArray(usersTable.id, [submitterId, adminId]));
});

describe("a rejected submission is purged (D7)", () => {
  it("the fact goes with its gags, renders, hashtag link and every picture file; the Library keeps the rejection with its reason", async () => {
    __setFileRemoverForTest(fakeRemover);
    const s = await submission();
    const outcome = await db.transaction((tx) => purgeRejectedFact(tx, s.fact.id, { excludeReviewId: s.review.id }));
    assert.equal(outcome.kind, "purged");
    assert.ok(outcome.kind === "purged");
    assert.equal(outcome.renders, 3);
    assert.deepEqual(outcome.files, s.files, "each render's own file and the unlinked one its provenance names");

    assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, s.fact.id))).length, 0);
    assert.equal((await db.select().from(factGagsTable).where(eq(factGagsTable.factId, s.fact.id))).length, 0);
    assert.equal((await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, s.fact.id))).length, 0);
    const [ht] = await db.select().from(hashtagsTable).where(eq(hashtagsTable.id, s.hashtagId));
    assert.equal(ht!.factCount, 0, "the hashtag's count drops through its one writer");
    const prov = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.factId, s.fact.id));
    assert.equal(prov.length, 4, "provenance records stay (the 2026-11-10 tracing decision)");

    const queued = await db.select().from(storedFileDeletionsTable).where(inArray(storedFileDeletionsTable.path, s.files));
    assert.equal(queued.length, 4, "every file is on the cleanup list, committed with the delete");
    assert.ok(queued.every((q) => q.reason === "rejected_submission_purge" && q.doneAt == null));
    await runStoredFileCleanup({ paths: outcome.files });
    assert.deepEqual(removed.filter((p) => s.files.includes(p)).sort(), s.files);
    const done = await db.select().from(storedFileDeletionsTable).where(inArray(storedFileDeletionsTable.path, s.files));
    assert.ok(done.every((q) => q.doneAt != null && q.attempts === 1));

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, s.review.id));
    assert.equal(review!.stagingFactId, null, "the review stays, its fact link nulled");
    const page = await listMySubmissions(submitterId, { type: "facts", status: "declined", limit: 50 } as never);
    const row = page.items.find((i) => i.id === s.review.id) as { reason?: string | null; text?: string } | undefined;
    assert.ok(row, "the submitter's Library still lists the rejection");
    assert.equal(row!.reason, "visual");
  });

  it("skips a fact ever approved (every live fact is), one with another open review, and one with member content; one already gone is a no-op", async () => {
    const approved = await submission({ approvedAt: new Date() });
    const reopened = await submission();
    await db.insert(pendingReviewsTable).values({ submittedText: "again", submittedById: submitterId, stagingFactId: reopened.fact.id, status: "pending", workflowStage: "gags" });
    const commented = await submission();
    await db.insert(commentsTable).values({ factId: commented.fact.id, authorId: submitterId, text: "nice", status: "approved" } as never);
    const cases = [[approved, "approved"], [reopened, "open_review"], [commented, "member_content"]] as const;
    for (const [s, reason] of cases) {
      const outcome = await db.transaction((tx) => purgeRejectedFact(tx, s.fact.id, { excludeReviewId: s.review.id }));
      assert.deepEqual(outcome, { kind: "skipped", factId: s.fact.id, reason });
      assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, s.fact.id))).length, 1, `${reason}: the fact stays`);
      assert.equal((await db.select().from(storedFileDeletionsTable).where(inArray(storedFileDeletionsTable.path, s.files))).length, 0, `${reason}: nothing queued`);
    }
    const gone = await db.transaction((tx) => purgeRejectedFact(tx, 2_000_000_000));
    assert.deepEqual(gone, { kind: "gone", factId: 2_000_000_000 });
  });

  it("purges a fact whose gag examples pick its renders, whichever of the fact's two cascades Postgres fires first (Issue #1326)", async () => {
    // Deleting a fact cascades to its renders and to its gags (and through
    // them to the examples), and an example's render link does not cascade.
    // Postgres fires a table's foreign-key triggers in name order, and those
    // names carry each constraint's OID, so which cascade goes first depends
    // on how the database was built: dev fired the renders' first and the
    // reject failed. Re-adding the renders' constraint and then the gags' gives
    // both triggers fresh, adjacent OIDs of the same width, so their names sort
    // renders first. Re-adding the gags' alone was not enough: a trigger name
    // compares as text, and once the cluster's OID counter passes 99,999 (any
    // file that builds whole databases in the shard) a new six-digit OID sorts
    // before the five-digit ones. The DDL rolls back with the test.
    const s = await submission();
    const fire = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => tx.execute(sql`
      SELECT c.conrelid::regclass::text AS tbl FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
      WHERE t.tgrelid = 'facts'::regclass AND t.tgname LIKE 'RI_ConstraintTrigger_a_%'
        AND c.conrelid IN ('image_prompt_attempts'::regclass, 'fact_gags'::regclass)
      ORDER BY t.tgname`);
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE image_prompt_attempts DROP CONSTRAINT image_prompt_attempts_fact_id_facts_id_fk`);
      await tx.execute(sql`ALTER TABLE image_prompt_attempts ADD CONSTRAINT image_prompt_attempts_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE`);
      await tx.execute(sql`ALTER TABLE fact_gags DROP CONSTRAINT fact_gags_fact_id_fkey`);
      await tx.execute(sql`ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_fact_id_fkey FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE`);
      const order = (await fire(tx)).rows.map((r) => (r as { tbl: string }).tbl);
      assert.equal(order[0], "image_prompt_attempts", "precondition: the renders' cascade fires before the gags'");
      const outcome = await purgeRejectedFact(tx, s.fact.id, { excludeReviewId: s.review.id });
      assert.equal(outcome.kind, "purged");
      assert.equal((await tx.select().from(factsTable).where(eq(factsTable.id, s.fact.id))).length, 0);
      assert.equal((await tx.select().from(factGagsTable).where(eq(factGagsTable.factId, s.fact.id))).length, 0);
      assert.equal((await tx.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, s.fact.id))).length, 0);
      throw new Error("rolled back");
    }), /rolled back/);
  });

  it("a rollback leaves the fact, its renders and the cleanup list unchanged", async () => {
    const s = await submission();
    await assert.rejects(db.transaction(async (tx) => {
      await purgeRejectedFact(tx, s.fact.id, { excludeReviewId: s.review.id });
      throw new Error("rolled back");
    }), /rolled back/);
    assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, s.fact.id))).length, 1);
    assert.equal((await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, s.fact.id))).length, 3);
    assert.equal((await db.select().from(storedFileDeletionsTable).where(inArray(storedFileDeletionsTable.path, s.files))).length, 0);
  });
});

describe("the one-time purge of already-rejected submissions", () => {
  it("the dry run deletes nothing and reports what --apply then purges; a second --apply finds nothing", async () => {
    __setFileRemoverForTest(fakeRemover);
    const a = await submission();
    const b = await submission();
    const kept = await submission({ approvedAt: new Date() });
    const dry = await runRejectedSubmissionPurge({ apply: false });
    assert.equal(dry.mode, "dry-run");
    for (const s of [a, b, kept]) assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, s.fact.id))).length, 1, "the dry run deletes nothing");
    assert.ok(dry.purged >= 2 && dry.skipped.approved >= 1);
    assert.equal((await assessRejectedFact(db, a.fact.id, { excludeReviewId: a.review.id })).files.length, 4);

    const applied = await runRejectedSubmissionPurge({ apply: true });
    assert.deepEqual({ ...applied, mode: "dry-run", filesOutstanding: 0 }, dry, "the dry run's counts are what --apply purged");
    assert.equal(applied.filesOutstanding, 0);
    for (const s of [a, b]) assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, s.fact.id))).length, 0);
    assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, kept.fact.id))).length, 1, "a fact ever approved is never purged");

    const again = await runRejectedSubmissionPurge({ apply: true });
    assert.equal(again.purged, 0, "a re-run finds nothing to purge");
    assert.equal(again.files, 0);
  });
});

describe("the durable cleanup list", () => {
  it("one open row per path; a failed removal stays outstanding with its error, shows on Queue Health, and the sweep's retry removes it", async () => {
    const path = `${pathPrefix}/sweep-${randomUUID()}.png`;
    await db.transaction((tx) => queueStoredFileDeletions(tx, [path, path], "render_delete"));
    await db.transaction((tx) => queueStoredFileDeletions(tx, [path], "render_delete"));
    assert.equal((await db.select().from(storedFileDeletionsTable).where(eq(storedFileDeletionsTable.path, path))).length, 1);

    __setFileRemoverForTest({ async deleteObject() { throw new Error("bucket unreachable"); } });
    assert.deepEqual(await runStoredFileCleanup({ paths: [path] }), { deleted: 0, failed: 1 });
    const [row] = await db.select().from(storedFileDeletionsTable).where(eq(storedFileDeletionsTable.path, path));
    assert.equal(row!.doneAt, null);
    assert.equal(row!.attempts, 1);
    assert.match(row!.lastError ?? "", /bucket unreachable/);
    const health = await storedFileDeletionHealth();
    assert.ok(health.outstanding >= 1 && health.failing >= 1 && health.oldestQueuedAt);

    __setFileRemoverForTest(fakeRemover);
    // An hour on, the hourly sweep: a row tried moments ago is left to the run
    // that claimed it until its lease passes.
    await db.update(storedFileDeletionsTable).set({ lastAttemptAt: new Date(Date.now() - 60 * 60_000) }).where(eq(storedFileDeletionsTable.path, path));
    await runStoredFileCleanup();
    const [after] = await db.select().from(storedFileDeletionsTable).where(eq(storedFileDeletionsTable.path, path));
    assert.ok(after!.doneAt, "the hourly sweep's retry removed it");
    assert.equal(after!.attempts, 2);
    assert.equal(after!.lastError, null);
  });

  it("a file already missing counts as removed (the store's own rule)", async () => {
    __setFileRemoverForTest(null);
    const path = `/objects/ai-bg-v2/${PREFIX}missing-${randomUUID()}.png`;
    await db.transaction((tx) => queueStoredFileDeletions(tx, [path], "render_delete"));
    const prior = { backend: process.env.STORAGE_BACKEND, dir: process.env.STORAGE_DOUBLE_DIR, priv: process.env.PRIVATE_OBJECT_DIR };
    process.env.STORAGE_BACKEND = "local-double";
    process.env.STORAGE_DOUBLE_DIR = `/tmp/${PREFIX}${randomUUID()}`;
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    try {
      assert.deepEqual(await runStoredFileCleanup({ paths: [path] }), { deleted: 1, failed: 0 });
    } finally {
      for (const [k, v] of [["STORAGE_BACKEND", prior.backend], ["STORAGE_DOUBLE_DIR", prior.dir], ["PRIVATE_OBJECT_DIR", prior.priv]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("an approval is recorded with its pick (D8), and the boundary that marks it is set once", () => {
  it("approving a render writes its record in the same transaction, with no route involved", async () => {
    const [fact] = await db.insert(factsTable).values({ text: `{NAME} approves ${randomUUID()}`, submittedById: submitterId, isActive: false, approvedAt: new Date(), approvalSource: "legacy" }).returning();
    const [gag] = await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, pendingContent: GAG }).returning();
    const attemptId = await insertExampleRender(fact!.id, gag!.id, GAG, "male");
    await approveGagRender(fact!.id, gag!.id, attemptId, { adminId, reviewId: null });
    const records = await db.select().from(adminActionsTable)
      .where(and(eq(adminActionsTable.factId, fact!.id), eq(adminActionsTable.action, "gag_render_approval")));
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]!.detail, { gagId: gag!.id, attemptId });
  });

  it("the boundary is this release's first boot plus the margin, and a later boot never moves it", async () => {
    const prior = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY));
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY));
    try {
      assert.equal(await renderApprovalAuditBoundary(), null);
      const boot = new Date("2026-12-01T10:00:00Z");
      await markRenderApprovalAuditBoundary(boot);
      assert.equal((await renderApprovalAuditBoundary())!.getTime(), boot.getTime() + RENDER_APPROVAL_AUDIT_MARGIN_MS);
      await markRenderApprovalAuditBoundary(new Date("2026-12-05T10:00:00Z"));
      assert.equal((await renderApprovalAuditBoundary())!.getTime(), boot.getTime() + RENDER_APPROVAL_AUDIT_MARGIN_MS, "set once");
    } finally {
      await db.delete(adminConfigTable).where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY));
      if (prior.length) await db.insert(adminConfigTable).values(prior);
    }
  });
});
