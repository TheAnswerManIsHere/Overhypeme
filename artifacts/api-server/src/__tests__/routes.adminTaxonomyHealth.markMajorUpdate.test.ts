/**
 * Atomic engine-revision bump via
 * POST /admin/taxonomy-health/actions/mark-major-update.
 *
 * Proves:
 *   • a bump increments engine_revision by one, records an audit row with the
 *     admin who performed it, and refreshes the config row's own metadata;
 *   • the note is trimmed and empty → null; an overlong note is a 400;
 *   • two CONCURRENT bumps never lose an update — they produce two distinct,
 *     consecutive revisions with a chained pair of audit rows (never two copies
 *     of the same N+1). This is the whole point of the advisory-locked txn.
 *
 * The shared `admin_config.engine_revision` row is global, so every assertion
 * is RELATIONAL (against the response's own previous→next transition and this
 * run's unique `performedBy`/note tag), never against an absolute value — that
 * keeps it robust when other shards touch the same row concurrently.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db, usersTable } from "@workspace/db";
import { adminConfigTable, engineRevisionBumpsTable } from "@workspace/db/schema";
import { and, eq, like } from "drizzle-orm";

import adminTaxonomyHealthRouter from "../routes/adminTaxonomyHealth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "ttha-mmu-";
const RUN = randomUUID().slice(0, 8);
const PATH = "/api/admin/taxonomy-health/actions/mark-major-update";

describe("/admin/taxonomy-health — mark-major-update", () => {
  let adminUserId: string;
  let app: ReturnType<typeof buildTestApp>;

  before(async () => {
    adminUserId = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id: adminUserId,
      email: `${adminUserId}@example.test`,
      profileImageUrl: null,
      isAdmin: true,
    });
    app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminTaxonomyHealthRouter);
  });

  after(async () => {
    // Audit rows reference performed_by ON DELETE SET NULL, so clear them first.
    await db.delete(engineRevisionBumpsTable).where(eq(engineRevisionBumpsTable.performedBy, adminUserId));
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  it("bumps by one, records an audit row + config metadata, and returns the transition", async () => {
    const note = `${RUN}-switched-enricher`;
    const res = await request(app).post(PATH).send({ note: `   ${note}   ` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.engineRevision, res.body.previousRevision + 1, "increments by exactly one");

    // admin_config carries the new value + refreshed metadata (updated_by_id).
    const [cfg] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, "engine_revision"));
    assert.ok(cfg, "engine_revision config row exists");
    assert.equal(cfg.value, String(res.body.engineRevision));
    assert.equal(cfg.updatedById, adminUserId, "config metadata reflects the bumping admin");

    // The audit row for THIS transition, trimmed note, correct performer.
    const [bump] = await db
      .select()
      .from(engineRevisionBumpsTable)
      .where(
        and(
          eq(engineRevisionBumpsTable.performedBy, adminUserId),
          eq(engineRevisionBumpsTable.newRevision, res.body.engineRevision),
        ),
      );
    assert.ok(bump, "audit row written");
    assert.equal(bump.oldRevision, res.body.previousRevision);
    assert.equal(bump.note, note, "note trimmed");
  });

  it("normalizes an empty/whitespace note to null", async () => {
    const res = await request(app).post(PATH).send({ note: "   " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [bump] = await db
      .select()
      .from(engineRevisionBumpsTable)
      .where(
        and(
          eq(engineRevisionBumpsTable.performedBy, adminUserId),
          eq(engineRevisionBumpsTable.newRevision, res.body.engineRevision),
        ),
      );
    assert.ok(bump);
    assert.equal(bump.note, null, "blank note stored as null");
  });

  it("treats a missing note the same as null (no body)", async () => {
    const res = await request(app).post(PATH).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [bump] = await db
      .select()
      .from(engineRevisionBumpsTable)
      .where(
        and(
          eq(engineRevisionBumpsTable.performedBy, adminUserId),
          eq(engineRevisionBumpsTable.newRevision, res.body.engineRevision),
        ),
      );
    assert.equal(bump?.note, null);
  });

  it("rejects a note longer than 2000 chars with 400 and does not bump", async () => {
    const [before] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable)
      .where(eq(adminConfigTable.key, "engine_revision"));
    const res = await request(app).post(PATH).send({ note: "x".repeat(2001) });
    assert.equal(res.status, 400);
    const [after] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable)
      .where(eq(adminConfigTable.key, "engine_revision"));
    assert.equal(after?.value, before?.value, "a rejected bump leaves the revision untouched");
  });

  it("two CONCURRENT bumps produce distinct consecutive revisions with chained audit rows (no lost update)", async () => {
    const note = `${RUN}-concurrent`;
    const [r1, r2] = await Promise.all([
      request(app).post(PATH).send({ note }),
      request(app).post(PATH).send({ note }),
    ]);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));

    const revs = [r1.body.engineRevision as number, r2.body.engineRevision as number].sort((a, b) => a - b);
    assert.equal(revs[1], revs[0]! + 1, "two DISTINCT consecutive revisions — never two copies of N+1");

    const bumps = (
      await db
        .select()
        .from(engineRevisionBumpsTable)
        .where(and(eq(engineRevisionBumpsTable.performedBy, adminUserId), eq(engineRevisionBumpsTable.note, note)))
    ).sort((a, b) => a.newRevision - b.newRevision);
    assert.equal(bumps.length, 2, "exactly two audit rows for the concurrent pair");
    assert.equal(bumps[0]!.newRevision, bumps[0]!.oldRevision + 1);
    assert.equal(bumps[1]!.newRevision, bumps[1]!.oldRevision + 1);
    assert.equal(bumps[1]!.oldRevision, bumps[0]!.newRevision, "audit rows chain: N→N+1 then N+1→N+2");
  });
});
