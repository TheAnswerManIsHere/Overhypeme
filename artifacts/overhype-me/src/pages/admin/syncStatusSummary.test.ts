/** deriveSyncSummary — the sync panel's aggregate state table, as a pure unit test. */

import { describe, it, expect } from "vitest";
import { deriveSyncSummary } from "./syncStatusSummary";

type Row = Parameters<typeof deriveSyncSummary>[0][number];

function row(overrides: Partial<Row> & { resource: string }): Row {
  return { status: "idle", lastSyncedAt: null, errorMessage: null, ...overrides };
}

const TEN_MIN_AGO = new Date(Date.now() - 10 * 60_000).toISOString();
const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

describe("deriveSyncSummary — aggregate state table", () => {
  it("all-idle with no stamps → never synced, not success", () => {
    // Regression: readSyncStatus maps over SYNC_RESOURCES and defaults every
    // absent row to `idle`, so a fresh install returns eight idle resources.
    // A gate keyed on "has a non-idle resource" would hide this entirely.
    const summary = deriveSyncSummary(
      [row({ resource: "products" }), row({ resource: "prices" })],
      false,
    );
    expect(summary).toMatchObject({ tone: "never", latestSyncedAt: null, erroredResources: [] });
    expect(summary.message).toMatch(/never synced/i);
  });

  it("an errored resource → error tone, naming the resource and its message", () => {
    // Regression: the bug that started this. A failed sync's error was
    // persisted, fetched, and then never rendered after a reload.
    const summary = deriveSyncSummary(
      [
        row({ resource: "products", status: "complete", lastSyncedAt: TEN_MIN_AGO }),
        row({ resource: "plans", status: "error", errorMessage: "Simulated failure" }),
      ],
      false,
    );
    expect(summary.tone).toBe("error");
    expect(summary.erroredResources).toEqual(["plans"]);
    expect(summary.message).toContain("plans");
    expect(summary.message).toContain("Simulated failure");
  });

  it("a partial run is reported as failed, never rounded up to success", () => {
    const summary = deriveSyncSummary(
      [
        row({ resource: "products", status: "complete", lastSyncedAt: TEN_MIN_AGO }),
        row({ resource: "prices", status: "complete", lastSyncedAt: TEN_MIN_AGO }),
        row({ resource: "plans", status: "error", errorMessage: "boom" }),
      ],
      false,
    );
    expect(summary.tone).toBe("error");
    // The successful stamp is still surfaced — the operator needs both facts.
    expect(summary.latestSyncedAt).toBe(TEN_MIN_AGO);
  });

  it("counts additional errored resources without listing all of them", () => {
    const summary = deriveSyncSummary(
      [
        row({ resource: "plans", status: "error", errorMessage: "a" }),
        row({ resource: "charges", status: "error", errorMessage: "b" }),
        row({ resource: "invoices", status: "error", errorMessage: "c" }),
      ],
      false,
    );
    expect(summary.erroredResources).toEqual(["plans", "charges", "invoices"]);
    expect(summary.message).toMatch(/2 other resources/);
  });

  it("an error with no message still reads as a failure", () => {
    const summary = deriveSyncSummary(
      [row({ resource: "plans", status: "error", errorMessage: null })],
      false,
    );
    expect(summary.tone).toBe("error");
    expect(summary.message).toMatch(/did not complete/);
    expect(summary.message).not.toContain("null");
  });

  it("all complete → ok, with the most recent stamp", () => {
    const summary = deriveSyncSummary(
      [
        row({ resource: "products", status: "complete", lastSyncedAt: HOUR_AGO }),
        row({ resource: "prices", status: "complete", lastSyncedAt: TEN_MIN_AGO }),
      ],
      false,
    );
    expect(summary.tone).toBe("ok");
    expect(summary.latestSyncedAt).toBe(TEN_MIN_AGO);
  });

  it("inProgress outranks a stale error from the previous run", () => {
    const summary = deriveSyncSummary(
      [row({ resource: "plans", status: "error", errorMessage: "old" })],
      true,
    );
    expect(summary.tone).toBe("running");
  });

  it("a running resource implies in-progress even when the flag is false", () => {
    // The flag comes from the server's in-process lock, which is null after a
    // restart; the per-resource rows outlive it.
    const summary = deriveSyncSummary([row({ resource: "products", status: "running" })], false);
    expect(summary.tone).toBe("running");
  });

  it("ignores unparseable timestamps rather than producing an Invalid Date", () => {
    const summary = deriveSyncSummary(
      [
        row({ resource: "products", status: "complete", lastSyncedAt: "not-a-date" }),
        row({ resource: "prices", status: "complete", lastSyncedAt: TEN_MIN_AGO }),
      ],
      false,
    );
    expect(summary.latestSyncedAt).toBe(TEN_MIN_AGO);
  });

  it("an empty resource list does not claim success", () => {
    const summary = deriveSyncSummary([], false);
    expect(summary.tone).toBe("never");
  });

  it("all complete with NO timestamps → a successful empty-catalog sync, not 'never synced'", () => {
    // Regression (Codex review, PR #276): stripe-replit-sync writes
    // `last_synced_at` only in `updateSyncCursor`, which runs per item.
    // `markSyncComplete` sets status alone. So a Stripe account with no
    // products completes a sync with every stamp still null — and keying
    // "never synced" off the stamp would tell that operator to re-run a sync
    // they just ran, permanently.
    const summary = deriveSyncSummary(
      [
        row({ resource: "products", status: "complete" }),
        row({ resource: "prices", status: "complete" }),
      ],
      false,
    );
    expect(summary.tone).toBe("ok");
    expect(summary.message).toMatch(/nothing to pull/i);
    expect(summary.message).not.toMatch(/never synced/i);
    expect(summary.latestSyncedAt).toBeNull();
  });

  it("a single completed resource among idle ones is not 'never synced'", () => {
    // Scoped syncs touch products/prices/plans and leave the other five
    // idle, so "some non-idle" is the right ever-ran signal, not "all".
    const summary = deriveSyncSummary(
      [
        row({ resource: "products", status: "complete", lastSyncedAt: TEN_MIN_AGO }),
        row({ resource: "customers" }),
        row({ resource: "invoices" }),
      ],
      false,
    );
    expect(summary.tone).toBe("ok");
    expect(summary.message).toMatch(/1 of 3 resources/);
  });
});
