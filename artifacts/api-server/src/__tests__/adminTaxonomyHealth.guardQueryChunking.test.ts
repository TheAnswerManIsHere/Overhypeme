/**
 * Guard-query chunking (Codex P2 on PR205).
 *
 * `factsWithInFlightRefresh` / `factsWithActiveVariants` back the bulk
 * send-back picker, which can pass EVERY stale-for-reprocess fact id — on a
 * legacy corpus (or right after a "Mark major update" bump) that can be
 * thousands of ids, well past a safe single `inArray(...)` parameter list.
 * These tests prove chunking preserves correctness across a chunk boundary
 * (not just under it), padding with synthetic nonexistent ids rather than
 * seeding thousands of real rows.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, factEnrichmentVersionsTable } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";

import {
  chunkIds,
  GUARD_QUERY_CHUNK_SIZE,
  factsWithInFlightRefresh,
  factsWithActiveVariants,
} from "../routes/adminTaxonomyHealth.js";

describe("chunkIds", () => {
  it("splits evenly, handles a remainder chunk, and passes through small/empty arrays unchanged", () => {
    assert.deepEqual(chunkIds([], 500), []);
    assert.deepEqual(chunkIds([1, 2, 3], 500), [[1, 2, 3]]);
    const evenly = Array.from({ length: 1000 }, (_, i) => i);
    const chunked = chunkIds(evenly, 500);
    assert.equal(chunked.length, 2);
    assert.equal(chunked[0]!.length, 500);
    assert.equal(chunked[1]!.length, 500);
    const withRemainder = Array.from({ length: 1100 }, (_, i) => i);
    const chunkedRemainder = chunkIds(withRemainder, 500);
    assert.equal(chunkedRemainder.length, 3);
    assert.equal(chunkedRemainder[2]!.length, 100);
    // No ids lost or reordered across the split.
    assert.deepEqual(chunkedRemainder.flat(), withRemainder);
  });
});

const USER_PREFIX = "t_gqc_";
const insertedFactIds: number[] = [];
let adminId: string;

async function seedFact(overrides: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: `{NAME} does something #${randomUUID().slice(0, 8)}.`,
      submittedById: adminId,
      isActive: true,
      ...overrides,
    } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  return fact!.id;
}

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, insertedFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@example.test`, isAdmin: true });
});

after(cleanup);

// Synthetic nonexistent ids well clear of any real serial id in a fresh test DB.
function syntheticIds(count: number, offset: number): number[] {
  return Array.from({ length: count }, (_, i) => 900_000_000 + offset + i);
}

describe("factsWithInFlightRefresh — cross-chunk correctness", () => {
  it("detects an in-flight fact whether it lands in the first or a later chunk, across a >1-chunk id list", async () => {
    const firstChunkFact = await seedFact();
    const laterChunkFact = await seedFact();
    await db.insert(factEnrichmentVersionsTable).values([
      { factId: firstChunkFact, versionNo: 1, status: "candidate", source: "refresh_candidate" },
      { factId: laterChunkFact, versionNo: 1, status: "candidate", source: "refresh_candidate" },
    ]);

    // Real ids sit at position 0 (first chunk) and past GUARD_QUERY_CHUNK_SIZE
    // (a later chunk) in a >1-chunk-sized array — proving chunking doesn't
    // drop or misattribute matches across the boundary.
    const ids = [
      firstChunkFact,
      ...syntheticIds(GUARD_QUERY_CHUNK_SIZE, 0),
      laterChunkFact,
      ...syntheticIds(200, GUARD_QUERY_CHUNK_SIZE + 1000),
    ];
    assert.ok(ids.length > GUARD_QUERY_CHUNK_SIZE, "the id list must actually span more than one chunk");

    const result = await factsWithInFlightRefresh(ids);
    assert.ok(result.has(firstChunkFact), "match in the first chunk must be detected");
    assert.ok(result.has(laterChunkFact), "match in a later chunk must be detected");
    assert.equal(result.size, 2, "no false positives from the synthetic padding");
  });
});

describe("factsWithActiveVariants — cross-chunk correctness", () => {
  it("detects a root's active variant whether the root lands in the first or a later chunk", async () => {
    const firstChunkRoot = await seedFact();
    await seedFact({ parentId: firstChunkRoot });
    const laterChunkRoot = await seedFact();
    await seedFact({ parentId: laterChunkRoot });

    const ids = [
      firstChunkRoot,
      ...syntheticIds(GUARD_QUERY_CHUNK_SIZE, 0),
      laterChunkRoot,
      ...syntheticIds(200, GUARD_QUERY_CHUNK_SIZE + 1000),
    ];
    assert.ok(ids.length > GUARD_QUERY_CHUNK_SIZE, "the id list must actually span more than one chunk");

    const result = await factsWithActiveVariants(ids);
    assert.ok(result.has(firstChunkRoot), "a root in the first chunk must be detected");
    assert.ok(result.has(laterChunkRoot), "a root in a later chunk must be detected");
    assert.equal(result.size, 2, "no false positives from the synthetic padding");
  });
});
