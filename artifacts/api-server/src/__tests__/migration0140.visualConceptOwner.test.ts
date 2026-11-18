/**
 * Migration 0140 (plan docs/plans/PLAN_THREE_GAGS.md, increment 2): the
 * generation-owner column and its backfill. A fact with an open review is
 * owned by its latest open review, so a generation in flight at deploy still
 * lands; a fact with no open review stays unowned; an owner already recorded
 * is kept; a second run changes nothing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, factsTable, usersTable } from "@workspace/db";
import { pendingReviewsTable } from "@workspace/db/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0140_visual_concept_owner.sql"), "utf8");

const RUN = randomUUID().slice(0, 8);
const factIds: number[] = [];
let adminId = "";

async function fact(owner: string | null = null): Promise<number> {
  const [row] = await db.insert(factsTable).values({ text: `{NAME} owner ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, visualConceptOwner: owner }).returning({ id: factsTable.id });
  factIds.push(row!.id);
  return row!.id;
}

async function review(factId: number, status: "pending" | "approved"): Promise<number> {
  const [row] = await db.insert(pendingReviewsTable).values({
    submittedText: "t", submittedById: adminId, status, workflowStage: status === "pending" ? "gags" : "approved", stagingFactId: factId,
  } as never).returning({ id: pendingReviewsTable.id });
  return row!.id;
}

const ownerOf = async (factId: number) => (await db.select({ o: factsTable.visualConceptOwner }).from(factsTable).where(eq(factsTable.id, factId)))[0]!.o;

before(async () => {
  adminId = `t-m0140-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
});

after(async () => {
  if (factIds.length) {
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("migration 0140: the gag writer's generation owner", () => {
  it("backfills each fact with an open review to its latest one, leaves the rest, and is idempotent", async () => {
    const withOpen = await fact();
    await review(withOpen, "approved");
    await review(withOpen, "pending");
    const latest = await review(withOpen, "pending");
    const closedOnly = await fact();
    await review(closedOnly, "approved");
    const alreadyOwned = await fact("live:already");
    await review(alreadyOwned, "pending");

    await db.execute(sql.raw(MIGRATION_SQL));
    assert.equal(await ownerOf(withOpen), `review:${latest}`);
    assert.equal(await ownerOf(closedOnly), null);
    assert.equal(await ownerOf(alreadyOwned), "live:already", "an owner already recorded is kept");

    await db.execute(sql.raw(MIGRATION_SQL));
    assert.equal(await ownerOf(withOpen), `review:${latest}`, "a second run changes nothing");
  });
});
