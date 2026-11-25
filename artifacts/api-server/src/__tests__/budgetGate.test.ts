/**
 * Integration tests for budgetGate.ts (checkBudget + recordCost).
 *
 * Talks to the real dev database. Each test creates its own users and ledger
 * rows tagged with the prefix "tbg-" and cleans them up in afterEach.
 *
 * Prefix uses `-` (not `_`) so SQL LIKE wildcards in the cleanup can't
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 *
 * The admin_config row that drives the limit (budget_per_credit_ceiling_usd:
 * dollars per credit ever granted, launch Phase 7) is snapshotted in `before`
 * and restored in `after` so tests can override it safely. A test user's
 * credits go with it (the ledger cascades from the account).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import {
  usersTable,
  adminConfigTable,
  userGenerationCostsTable,
  creditLedgerTable,
} from "@workspace/db/schema";
import { eq, like, sql, inArray } from "drizzle-orm";

import {
  BudgetExceededError,
  BudgetGateError,
  checkBudget,
  noteLedgerWriteFailure,
  recordCost,
} from "../lib/budgetGate.js";
import { bustConfigCache } from "../lib/adminConfig.js";


// ── Helpers ────────────────────────────────────────────────────────────────────

const USER_PREFIX = "tbg-";

function uid(): string {
  return `${USER_PREFIX}${randomUUID()}`;
}

interface CreateUserOpts {
  tier?: "registered" | "legendary" | "unregistered";
  isAdmin?: boolean;
  overrideUsd?: number | null;
  /** Credits granted (one admin lot); default 2, so the default limit is 2 × $0.25 = $0.50. */
  credits?: number;
}

async function createTestUser(opts: CreateUserOpts = {}): Promise<string> {
  const id = uid();
  await db.insert(usersTable).values({
    id,
    membershipTier: opts.tier ?? "registered",
    isAdmin: opts.isAdmin ?? false,
    monthlyGenerationLimitOverrideUsd:
      opts.overrideUsd != null ? String(opts.overrideUsd) : null,
  });
  if ((opts.credits ?? 2) > 0) await grantCredits(id, opts.credits ?? 2);
  return id;
}

async function insertCost(
  userId: string,
  costUsd: number,
  createdAt: Date = new Date(),
): Promise<void> {
  await db.insert(userGenerationCostsTable).values({
    userId,
    jobType: "image",
    endpointId: "fal-ai/test/budgetGate",
    unitPriceAtCreation: "0.01",
    billingUnits: "1",
    computedCostUsd: String(costUsd),
    pricingFetchedAt: new Date(),
    createdAt,
  });
}

async function cleanupTestRows(): Promise<void> {
  // USER_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the file header comment.
  await db
    .delete(userGenerationCostsTable)
    .where(like(userGenerationCostsTable.userId, `${USER_PREFIX}%`));
  await db
    .delete(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
}

interface ConfigSnapshot {
  key: string;
  value: string | null;
  dataType: string | null;
  label: string | null;
}

const SNAPSHOTTED_KEYS = [
  "budget_per_credit_ceiling_usd",
];

const snapshot: Map<string, ConfigSnapshot | null> = new Map();

async function snapshotConfig(): Promise<void> {
  for (const key of SNAPSHOTTED_KEYS) {
    const [row] = await db
      .select()
      .from(adminConfigTable)
      .where(eq(adminConfigTable.key, key))
      .limit(1);
    snapshot.set(
      key,
      row
        ? { key, value: row.value, dataType: row.dataType, label: row.label }
        : null,
    );
  }
}

async function restoreConfig(): Promise<void> {
  for (const key of SNAPSHOTTED_KEYS) {
    const original = snapshot.get(key);
    if (original === null || original === undefined) {
      await db.delete(adminConfigTable).where(eq(adminConfigTable.key, key));
    } else {
      await db
        .insert(adminConfigTable)
        .values({
          key: original.key,
          value: original.value ?? "",
          dataType: original.dataType ?? "string",
          label: original.label ?? key,
        })
        .onConflictDoUpdate({
          target: adminConfigTable.key,
          set: {
            value: original.value ?? "",
            dataType: original.dataType ?? "string",
            label: original.label ?? key,
          },
        });
    }
  }
  bustConfigCache();
}

async function setConfig(
  key: string,
  value: string,
  dataType: string,
): Promise<void> {
  await db
    .insert(adminConfigTable)
    .values({ key, value, dataType, label: key })
    .onConflictDoUpdate({
      target: adminConfigTable.key,
      set: { value, dataType },
    });
  bustConfigCache();
}

/** The backstop's one setting: dollars of engine spend per credit ever granted (launch Phase 7). */
async function setStandardLimits(opts: { perCreditUsd?: number } = {}): Promise<void> {
  await setConfig("budget_per_credit_ceiling_usd", String(opts.perCreditUsd ?? 0.25), "float");
}

/** Grant `n` credits as one admin lot (an unverified test user has no free credit). */
async function grantCredits(userId: string, n: number): Promise<number> {
  const [lot] = await db.insert(creditLedgerTable).values({
    userId, kind: "admin_grant", credits: n, ref: `tbg-grant-${randomUUID()}`, note: "test", actorLabel: "test",
  }).returning({ id: creditLedgerTable.id });
  return lot!.id;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

before(async () => {
  await snapshotConfig();
});

after(async () => {
  await cleanupTestRows();
  await restoreConfig();
});

beforeEach(async () => {
  bustConfigCache();
});

afterEach(async () => {
  await cleanupTestRows();
});

// ── Tests: checkBudget ─────────────────────────────────────────────────────────

describe("checkBudget — admin", () => {
  it("admins are exempt and always allowed with infinite limit", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ isAdmin: true });
    const status = await checkBudget(userId, 99999);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, Infinity);
    assert.equal(status.remainingBudget, Infinity);
  });

  // Round 2 of PR #425's review: this used to check the raw `is_admin`
  // column alone, so an admin granted only via the ADMIN_USER_IDS env
  // allowlist (no stored flag) was silently billed like a regular user.
  it("an env-allowlisted admin (no stored is_admin flag) is exempt too", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ isAdmin: false, tier: "registered" });
    const prevAdminUserIds = process.env["ADMIN_USER_IDS"];
    process.env["ADMIN_USER_IDS"] = userId;
    try {
      const status = await checkBudget(userId, 99999);
      assert.equal(status.allowed, true);
      assert.equal(status.limit, Infinity);
      assert.equal(status.remainingBudget, Infinity);
    } finally {
      if (prevAdminUserIds === undefined) delete process.env["ADMIN_USER_IDS"];
      else process.env["ADMIN_USER_IDS"] = prevAdminUserIds;
    }
  });

  // Round 4 of PR #474's review. The cost of a generation whose fal price is
  // unavailable has to be looked up, and that lookup can fail. Passed eagerly
  // — `checkBudget(userId, await resolveCost())` — its failure preempts the
  // exemption above, because the argument is evaluated before this function is
  // ever entered. An admin was therefore refused a generation by a check they
  // are exempt from. The thunk form defers it past the exemption.
  it("an admin is exempt without the cost thunk ever being invoked", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ isAdmin: true });

    let thunkCalls = 0;
    const status = await checkBudget(userId, async () => {
      thunkCalls++;
      throw new Error("cost lookup failed — must never run for an exempt admin");
    });

    assert.equal(thunkCalls, 0, "the cost thunk must not run for an exempt admin");
    assert.equal(status.allowed, true);
    assert.equal(status.limit, Infinity);
  });

  it("a non-admin still gets a failing cost lookup as BudgetGateError, not as over-limit", async () => {
    // The other half of the same behavior: deferring the lookup must not turn
    // a genuine cost-resolution failure into a silent pass for everyone else.
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ tier: "registered" });

    let thunkCalls = 0;
    await assert.rejects(
      () =>
        checkBudget(userId, async () => {
          thunkCalls++;
          throw new Error("cost lookup failed");
        }),
      (err: unknown) => {
        assert.ok(err instanceof BudgetGateError, `expected BudgetGateError, got ${String(err)}`);
        assert.ok(
          !(err instanceof BudgetExceededError),
          "a cost-resolution failure is not the same as being over limit (#409)",
        );
        return true;
      },
    );
    assert.equal(thunkCalls, 1, "the thunk must run for a non-exempt user");
  });

  it("a thunk returning a number gates identically to passing that number", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ tier: "registered" });

    const viaNumber = await checkBudget(userId, 0.10);
    const viaThunk = await checkBudget(userId, async () => 0.10);
    assert.equal(viaThunk.allowed, viaNumber.allowed);
    assert.equal(viaThunk.limit, viaNumber.limit);
    assert.equal(viaThunk.remainingBudget, viaNumber.remainingBudget);

    const overNumber = await checkBudget(userId, 99999);
    const overThunk = await checkBudget(userId, async () => 99999);
    assert.equal(overThunk.allowed, false);
    assert.equal(overNumber.allowed, false);
  });
});

describe("checkBudget — the backstop follows the credits granted (launch Phase 7)", () => {
  it("allows a request inside credits granted × the per-credit ceiling", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 0.5);
    assert.equal(status.currentSpend, 0);
    assert.equal(status.remainingBudget, 0.5);
  });

  it("denies when current spend + proposed exceeds it", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    await insertCost(userId, 0.45);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, false);
    assert.equal(Math.round(status.currentSpend * 100) / 100, 0.45);
    assert.equal(status.limit, 0.5);
  });

  it("allows a request that lands exactly at the limit", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    await insertCost(userId, 0.40);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, true);
  });

  it("reports remainingBudget = 0 (never negative) when already over", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    await insertCost(userId, 0.75);
    const status = await checkBudget(userId, 0.01);
    assert.equal(status.allowed, false);
    assert.equal(status.remainingBudget, 0);
  });

  it("is the same rule for a member: the tier does not change the limit", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const member = await createTestUser({ tier: "legendary", credits: 2 });
    const registered = await createTestUser({ tier: "registered", credits: 2 });
    assert.equal((await checkBudget(member, 0.01)).limit, (await checkBudget(registered, 0.01)).limit);
  });

  it("grows with every credit granted, however it was granted", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    await grantCredits(userId, 6);
    assert.equal((await checkBudget(userId, 0.01)).limit, 2);
  });

  it("a returned credit adds no allowance; spending one takes none away", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 0 });
    const lot = await grantCredits(userId, 1);
    await db.insert(creditLedgerTable).values([
      { userId, kind: "picture_spend", credits: -1, ref: "picture:990000001", lotId: lot },
      { userId, kind: "picture_return", credits: 1, ref: "picture:990000001", lotId: lot },
    ]);
    assert.equal((await checkBudget(userId, 0.01)).limit, 0.25);
  });

  it("counts all spend on record, not a month: credits never expire, so neither does what they bought", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    await insertCost(userId, 0.45, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000));
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, false);
  });

  it("an account with no credits has no allowance", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 0 });
    const status = await checkBudget(userId, 0.01);
    assert.equal(status.allowed, false);
    assert.equal(status.limit, 0);
  });
});

describe("checkBudget — per-user override", () => {
  it("a per-user override replaces the credit allowance (higher)", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ overrideUsd: 5 });
    const status = await checkBudget(userId, 4);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 5);
  });

  it("a per-user override replaces the credit allowance (lower)", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ overrideUsd: 0.1, credits: 40 });
    const status = await checkBudget(userId, 0.05);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 0.1);
  });

  it("a zero override caps the user at zero", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ overrideUsd: 0 });
    const status = await checkBudget(userId, 0.01);
    assert.equal(status.allowed, false);
    assert.equal(status.limit, 0);
  });
});

describe("checkBudget — unknown user", () => {
  it("a user that doesn't exist has no credits and so no allowance", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const status = await checkBudget(uid(), 0.10);
    assert.equal(status.limit, 0);
    assert.equal(status.allowed, false);
  });
});

// ── Tests: recordCost ──────────────────────────────────────────────────────────

describe("recordCost", () => {
  it("inserts a row with all provided values", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const fetchedAt = new Date("2026-01-01T00:00:00Z");
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/test-endpoint",
      unitPriceAtCreation: 0.05,
      billingUnits: 4,
      computedCostUsd: 0.20,
      pricingFetchedAt: fetchedAt,
      jobReferenceId: "ref_abc",
      isEstimated: false,
    });
    const rows = await db
      .select()
      .from(userGenerationCostsTable)
      .where(eq(userGenerationCostsTable.userId, userId));
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.jobType, "image");
    assert.equal(r.endpointId, "fal-ai/test-endpoint");
    assert.equal(parseFloat(r.unitPriceAtCreation), 0.05);
    assert.equal(parseFloat(r.billingUnits), 4);
    assert.equal(parseFloat(r.computedCostUsd), 0.20);
    assert.equal(r.jobReferenceId, "ref_abc");
  });

  it("stores null jobReferenceId when not provided", async () => {
    const userId = await createTestUser({ tier: "registered" });
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/test-image",
      unitPriceAtCreation: 1.0,
      billingUnits: 100,
      computedCostUsd: 0.50,
      pricingFetchedAt: new Date(),
      isEstimated: false,
    });
    const [row] = await db
      .select()
      .from(userGenerationCostsTable)
      .where(eq(userGenerationCostsTable.userId, userId));
    assert.equal(row?.jobReferenceId, null);
  });

  it("recorded cost shows up in subsequent checkBudget call", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/test",
      unitPriceAtCreation: 0.05,
      billingUnits: 9,
      computedCostUsd: 0.45,
      pricingFetchedAt: new Date(),
      isEstimated: false,
    });
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, false);
    assert.equal(Math.round(status.currentSpend * 100) / 100, 0.45);
  });
});

// ── #409: the gate fails CLOSED ───────────────────────────────────────────────
//
// `checkBudget` used to return `{ allowed: true, limit: Infinity }` from its
// own catch, so any internal error lifted the spend ceiling entirely. These
// tests pin the corrected behaviour under two independent failure injections
// — the spend-ledger read (below) and the admin_config read (further down,
// which round 1 of this PR's own review found was a second, narrower path to
// the same fail-open shape).
//
// The gate has no production caller since launch Phase 4 (video, PuLID and
// the per-user AI background path went in removals 2, 3 and 11); it stays for
// the rebuild. A future caller keeps its pricing lookup and its `checkBudget`
// call in separate `catch` scopes, inline — round 1 found that a *shared*
// helper for this was itself a new-abstraction Tier C trigger, so the
// separation is enforced by code shape at each call site rather than by one
// function this file can unit-test directly.

/**
 * Run `fn` while the spend-ledger table is renamed out from under the gate, so
 * its ledger query raises a real "relation does not exist" error — the closest
 * faithful stand-in for the transient database failure this bug is about.
 *
 * Safe under the sharded runner: each shard owns its own database and runs its
 * files serially (`--test-concurrency=1 --test-isolation=none`), and the
 * rename is always reversed in `finally`.
 */
async function withBrokenLedgerTable<T>(fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`ALTER TABLE user_generation_costs RENAME TO user_generation_costs_409tmp`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`ALTER TABLE user_generation_costs_409tmp RENAME TO user_generation_costs`);
  }
}

describe("checkBudget — fails closed on internal error (#409)", () => {
  it("throws BudgetGateError instead of granting unlimited spend", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });

    await withBrokenLedgerTable(async () => {
      await assert.rejects(
        () => checkBudget(userId, 0.01),
        (err: unknown) => {
          assert.ok(
            err instanceof BudgetGateError,
            `expected BudgetGateError, got ${String(err)}`,
          );
          return true;
        },
      );
    });
  });

  it("does not resolve to an allowed status when the lookup fails", async () => {
    // The precise shape of the old bug: a resolved value whose `allowed` was
    // true and whose `limit` was Infinity. Asserting on rejection alone would
    // still pass if some future change reintroduced a permissive fallback, so
    // this pins that no allowed status is produced at all.
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });

    await withBrokenLedgerTable(async () => {
      const outcome = await checkBudget(userId, 0.01).then(
        (status) => ({ resolved: true as const, status }),
        () => ({ resolved: false as const }),
      );
      assert.equal(outcome.resolved, false, "checkBudget must not resolve when it cannot determine spend");
    });
  });
});

// Round 1 of #409's own review found a second fail-open path: `checkBudget`'s
// outer catch only fires for errors that escape its try block, but
// `getConfigString`/`getConfigFloat` swallow their own read failures and
// return the code default instead of throwing — so a transient failure while
// reading the operator's configured limits never reached the new catch at
// all, and checkBudget would silently price the request against the $0.50/
// $10 code defaults instead of genuinely refusing. Fixed by reading the
// three budget configs via their `WithSource` variants and treating a
// `fallback_default` source (read failed) as a gate failure.
describe("checkBudget — a config-READ failure also fails closed (#409 round 1)", () => {
  it("throws BudgetGateError when admin_config itself is unreadable, not just the ledger", async () => {
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });

    await db.execute(sql`ALTER TABLE admin_config RENAME TO admin_config_409tmp`);
    // Cleared after the rename, not only before it: the settings cache is
    // module-wide, and any test sharing this process can reload it between an
    // earlier clear and the rename, so checkBudget would read the cached
    // settings instead of failing (Build on 4fa6dfb).
    bustConfigCache();
    try {
      await assert.rejects(
        () => checkBudget(userId, 0.01),
        (err: unknown) => {
          assert.ok(
            err instanceof BudgetGateError,
            `expected BudgetGateError, got ${String(err)}`,
          );
          return true;
        },
      );
    } finally {
      await db.execute(sql`ALTER TABLE admin_config_409tmp RENAME TO admin_config`);
      bustConfigCache();
    }
  });

  it("does not silently substitute the code defaults for the operator's real limit", async () => {
    // Same failure, asserted the other way: no allowed/denied answer at all
    // should come out of a config-read failure, computed against the wrong
    // limit or otherwise. A resolved status here — of either polarity —
    // means the failure was silently absorbed rather than denied.
    await setStandardLimits({ perCreditUsd: 0.25 });
    const userId = await createTestUser({ credits: 2 });

    await db.execute(sql`ALTER TABLE admin_config RENAME TO admin_config_409tmp`);
    // Cleared after the rename, not only before it: the settings cache is
    // module-wide, and any test sharing this process can reload it between an
    // earlier clear and the rename, so checkBudget would read the cached
    // settings instead of failing (Build on 4fa6dfb).
    bustConfigCache();
    try {
      const outcome = await checkBudget(userId, 0.01).then(
        (status) => ({ resolved: true as const, status }),
        () => ({ resolved: false as const }),
      );
      assert.equal(outcome.resolved, false, "checkBudget must not resolve when its config read fails");
    } finally {
      await db.execute(sql`ALTER TABLE admin_config_409tmp RENAME TO admin_config`);
      bustConfigCache();
    }
  });

  it("admins stay exempt even when the config read fails — they never need the limit", async () => {
    const userId = await createTestUser({ isAdmin: true });

    await db.execute(sql`ALTER TABLE admin_config RENAME TO admin_config_409tmp`);
    // Cleared after the rename, not only before it: the settings cache is
    // module-wide, and any test sharing this process can reload it between an
    // earlier clear and the rename, so checkBudget would read the cached
    // settings instead of failing (Build on 4fa6dfb).
    bustConfigCache();
    try {
      const status = await checkBudget(userId, 99999);
      assert.equal(status.allowed, true);
      assert.equal(status.limit, Infinity);
    } finally {
      await db.execute(sql`ALTER TABLE admin_config_409tmp RENAME TO admin_config`);
      bustConfigCache();
    }
  });
});

// ── Release B: cost provenance and the accounting-health signal ────────────────
//
// The plan's guarantee is that a generation reaching the recording point leaves
// a row *with its provenance*. These cover the ledger side of that; the
// call-site side (the removed `if (priced)` guards) is exercised by the
// pipeline suites.

describe("recordCost — provenance", () => {
  it("persists is_estimated=false for a provider-resolved rate", async () => {
    const userId = await createTestUser();
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/probe",
      unitPriceAtCreation: 0.04,
      billingUnits: 1,
      computedCostUsd: 0.04,
      pricingFetchedAt: new Date(),
      isEstimated: false,
      jobReferenceId: "probe-priced",
    });
    const [row] = await db
      .select({ isEstimated: userGenerationCostsTable.isEstimated })
      .from(userGenerationCostsTable)
      .where(eq(userGenerationCostsTable.userId, userId));
    assert.equal(row?.isEstimated, false);
  });

  it("persists is_estimated=true for an operator-configured estimate", async () => {
    const userId = await createTestUser();
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/probe-image",
      unitPriceAtCreation: 0.05,
      billingUnits: 6,
      computedCostUsd: 0.3,
      pricingFetchedAt: new Date(),
      isEstimated: true,
      jobReferenceId: "probe-estimated",
    });
    const [row] = await db
      .select({ isEstimated: userGenerationCostsTable.isEstimated })
      .from(userGenerationCostsTable)
      .where(eq(userGenerationCostsTable.userId, userId));
    assert.equal(row?.isEstimated, true);
  });

  it("keeps unit_price * billing_units = computed_cost on an estimated row", async () => {
    // The decomposition invariant from the plan. It is what keeps Release C's
    // classifier meaningful for rows written AFTER this change: R3 keys on
    // billing_units = 1, which must be true because the writer chose it, not
    // by accident.
    const userId = await createTestUser();
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/probe-image",
      unitPriceAtCreation: 0.05,
      billingUnits: 6,
      computedCostUsd: 0.3,
      pricingFetchedAt: new Date(),
      isEstimated: true,
      jobReferenceId: "probe-decomposition",
    });
    const [row] = await db
      .select({
        unitPrice: userGenerationCostsTable.unitPriceAtCreation,
        units: userGenerationCostsTable.billingUnits,
        total: userGenerationCostsTable.computedCostUsd,
      })
      .from(userGenerationCostsTable)
      .where(eq(userGenerationCostsTable.userId, userId));
    assert.ok(row);
    const product = Number(row.unitPrice) * Number(row.units);
    assert.ok(
      Math.abs(product - Number(row.total)) < 1e-6,
      `unit_price * billing_units (${product}) must equal computed_cost (${row.total})`,
    );
  });

  it("counts estimated rows toward the enforcement ceiling", async () => {
    // The Must-Not-Change invariant: excluding estimated rows from the SUM
    // would reopen the fail-open PR #474 closed.
    await setStandardLimits({ perCreditUsd: 0.1 });
    const userId = await createTestUser({ credits: 1 });
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/probe",
      unitPriceAtCreation: 0.09,
      billingUnits: 1,
      computedCostUsd: 0.09,
      pricingFetchedAt: new Date(),
      isEstimated: true,
      jobReferenceId: "probe-ceiling",
    });
    const status = await checkBudget(userId, 0.05);
    assert.equal(status.allowed, false, "an estimated row must consume the ceiling");
    assert.ok(status.currentSpend >= 0.09);
  });
});

describe("noteLedgerWriteFailure", () => {
  // These two keys are OPERATIONAL SIGNALS, not configuration, and this suite
  // is the only thing that creates them in a test database. `ledger_write_failures`
  // describes itself as warranting investigation when non-zero, so leaving a
  // count behind manufactures exactly the alarm it exists to raise — and the
  // per-DB runner caches and reuses its schema, so the residue accumulates
  // while the relative assertions below (`before + 1`) keep passing forever.
  //
  // DELETED rather than snapshot-and-restored, unlike the budget-limit keys.
  // Those are seeded configuration with a legitimate prior value; these exist
  // only because something failed, so restoring a previous count would preserve
  // an earlier run's residue instead of clearing it. Zero rows is the correct
  // state for a database in which nothing was actually lost.
  afterEach(async () => {
    await db
      .delete(adminConfigTable)
      .where(
        inArray(adminConfigTable.key, ["ledger_write_failures", "ledger_write_failure_last_at"]),
      );
  });

  it("increments the counter and stamps the timestamp", async () => {
    const before = await readCounter();
    await noteLedgerWriteFailure();
    const after = await readCounter();
    assert.equal(after, before + 1, "the lost-write counter must advance");

    const [stamp] = await db
      .select({ value: adminConfigTable.value })
      .from(adminConfigTable)
      .where(eq(adminConfigTable.key, "ledger_write_failure_last_at"));
    assert.ok(stamp?.value, "the most-recent-failure timestamp must be set");
  });

  it("is monotonic across repeated failures", async () => {
    const before = await readCounter();
    await noteLedgerWriteFailure();
    await noteLedgerWriteFailure();
    assert.equal(await readCounter(), before + 2);
  });
});

async function readCounter(): Promise<number> {
  const [row] = await db
    .select({ value: adminConfigTable.value })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, "ledger_write_failures"));
  return Number(row?.value ?? "0");
}
