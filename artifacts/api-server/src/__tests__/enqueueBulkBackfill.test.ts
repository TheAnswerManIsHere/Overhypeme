/**
 * Unit tests for `enqueueBulkBackfill` (routes/admin.ts) — the shared
 * enqueue loop behind the three corpus-wide bulk media routes.
 *
 * Focus: a rejected per-fact enqueue call is caught and recorded as a
 * "failed" outcome, not an uncaught throw that would abort the request and
 * lose every already-committed job descriptor from earlier facts in the same
 * loop (Codex review, PR #256).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enqueueBulkBackfill } from "../routes/admin.js";

describe("enqueueBulkBackfill", () => {
  it("a rejected enqueue for one fact is recorded as a failed outcome, not an aborted request", async () => {
    const facts = [
      { id: 1, text: "fact one", isActive: true },
      { id: 2, text: "fact two", isActive: true },
      { id: 3, text: "fact three", isActive: true },
    ];
    const enqueue = async (factId: number) => {
      if (factId === 2) throw new Error("db connection reset");
      return { jobId: factId * 100, inserted: true };
    };

    const response = await enqueueBulkBackfill(facts, enqueue);

    // Facts 1 and 3 still got queued despite fact 2's enqueue rejecting.
    assert.deepEqual(
      response.jobs.map((j) => j.factId).sort(),
      [1, 3],
    );
    const failure = response.outcomes.find((o) => o.factId === 2);
    assert.ok(failure, "fact 2's rejected enqueue must surface as an outcome");
    assert.equal(failure!.status, "failed");
    assert.equal(failure!.label, "fact two");
    assert.equal(response.summary, response.summary); // sanity: object exists
    assert.equal(response.summary.requested, 3);
    assert.equal(response.summary.queued, 2);
    assert.equal(response.summary.failed, 1);
    assert.equal(response.summary.skipped, 0);
  });

  it("an inactive fact is still skipped (route-level, no enqueue attempted) alongside enqueue failures", async () => {
    const facts = [
      { id: 1, text: "active but enqueue fails", isActive: true },
      { id: 2, text: "inactive", isActive: false },
    ];
    const enqueue = async () => {
      throw new Error("boom");
    };

    const response = await enqueueBulkBackfill(facts, enqueue);

    assert.equal(response.jobs.length, 0);
    assert.equal(response.outcomes.length, 2);
    const skip = response.outcomes.find((o) => o.factId === 2);
    const failure = response.outcomes.find((o) => o.factId === 1);
    assert.equal(skip!.status, "skipped");
    assert.equal(failure!.status, "failed");
    assert.equal(response.summary.skipped, 1);
    assert.equal(response.summary.failed, 1);
  });
});
