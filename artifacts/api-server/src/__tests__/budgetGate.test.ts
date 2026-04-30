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
 * The admin_config rows that drive budget limits (budget_period,
 * budget_limit_registered_usd, budget_limit_legendary_usd) are snapshotted in
 * `before` and restored in `after` so tests can override them safely.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import {
  usersTable,
  adminConfigTable,
  userGenerationCostsTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { checkBudget, recordCost } from "../lib/budgetGate.js";
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
  "budget_period",
  "budget_limit_registered_usd",
  "budget_limit_legendary_usd",
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

async function setStandardLimits(opts: {
  period?: "monthly" | "rolling_30d";
  registeredUsd?: number;
  legendaryUsd?: number;
} = {}): Promise<void> {
  await setConfig("budget_period", opts.period ?? "monthly", "string");
  await setConfig("budget_limit_registered_usd", String(opts.registeredUsd ?? 0.5), "float");
  await setConfig("budget_limit_legendary_usd", String(opts.legendaryUsd ?? 10), "float");
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
    await setStandardLimits({ registeredUsd: 0.5 });
    const userId = await createTestUser({ isAdmin: true });
    const status = await checkBudget(userId, 99999);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, Infinity);
    assert.equal(status.remainingBudget, Infinity);
  });
});

describe("checkBudget — registered tier", () => {
  it("allows a request that fits inside the registered limit", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 0.5);
    assert.equal(status.currentSpend, 0);
    assert.equal(status.remainingBudget, 0.5);
  });

  it("denies when current spend + proposed exceeds the registered limit", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    await insertCost(userId, 0.45);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, false);
    assert.equal(Math.round(status.currentSpend * 100) / 100, 0.45);
    assert.equal(status.limit, 0.5);
  });

  it("allows a request that lands exactly at the limit", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    await insertCost(userId, 0.40);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, true);
  });

  it("reports remainingBudget = 0 (never negative) when already over", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    await insertCost(userId, 0.75);
    const status = await checkBudget(userId, 0.01);
    assert.equal(status.allowed, false);
    assert.equal(status.remainingBudget, 0);
  });
});

describe("checkBudget — legendary tier", () => {
  it("uses the legendary limit, not the registered limit", async () => {
    await setStandardLimits({ registeredUsd: 0.50, legendaryUsd: 10 });
    const userId = await createTestUser({ tier: "legendary" });
    const status = await checkBudget(userId, 5);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 10);
  });

  it("denies a legendary user that exceeds the legendary limit", async () => {
    await setStandardLimits({ registeredUsd: 0.50, legendaryUsd: 10 });
    const userId = await createTestUser({ tier: "legendary" });
    await insertCost(userId, 9.50);
    const status = await checkBudget(userId, 1);
    assert.equal(status.allowed, false);
  });
});

describe("checkBudget — per-user override", () => {
  it("a per-user override beats the tier limit (higher)", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered", overrideUsd: 5 });
    const status = await checkBudget(userId, 4);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 5);
  });

  it("a per-user override beats the tier limit (lower than legendary)", async () => {
    await setStandardLimits({ legendaryUsd: 10 });
    const userId = await createTestUser({ tier: "legendary", overrideUsd: 1 });
    const status = await checkBudget(userId, 0.5);
    assert.equal(status.allowed, true);
    assert.equal(status.limit, 1);
  });

  it("a zero override caps the user at zero", async () => {
    await setStandardLimits({ legendaryUsd: 10 });
    const userId = await createTestUser({ tier: "legendary", overrideUsd: 0 });
    const status = await checkBudget(userId, 0.01);
    assert.equal(status.allowed, false);
    assert.equal(status.limit, 0);
  });
});

describe("checkBudget — period boundaries", () => {
  it("monthly period: a row from a prior month is not counted", async () => {
    await setStandardLimits({ period: "monthly", registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    // Row dated to first day of last month — well before the current monthly window
    const lastMonth = new Date();
    lastMonth.setUTCDate(1);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await insertCost(userId, 999, lastMonth);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, true);
    assert.equal(status.currentSpend, 0);
  });

  it("rolling_30d period: a row from 40 days ago is not counted", async () => {
    await setStandardLimits({ period: "rolling_30d", registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await insertCost(userId, 999, fortyDaysAgo);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, true);
    assert.equal(status.currentSpend, 0);
  });

  it("rolling_30d period: a row from 5 days ago IS counted", async () => {
    await setStandardLimits({ period: "rolling_30d", registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await insertCost(userId, 0.45, fiveDaysAgo);
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, false);
  });
});

describe("checkBudget — unknown user", () => {
  it("treats a user that doesn't exist as 'unregistered' tier (uses registered limit)", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const ghostId = uid();
    const status = await checkBudget(ghostId, 0.10);
    assert.equal(status.limit, 0.5);
    assert.equal(status.allowed, true);
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
      jobType: "video",
      endpointId: "fal-ai/test-video",
      unitPriceAtCreation: 1.0,
      billingUnits: 100,
      computedCostUsd: 0.50,
      pricingFetchedAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(userGenerationCostsTable)
      .where(eq(userGenerationCostsTable.userId, userId));
    assert.equal(row?.jobReferenceId, null);
  });

  it("recorded cost shows up in subsequent checkBudget call", async () => {
    await setStandardLimits({ registeredUsd: 0.50 });
    const userId = await createTestUser({ tier: "registered" });
    await recordCost({
      userId,
      jobType: "image",
      endpointId: "fal-ai/test",
      unitPriceAtCreation: 0.05,
      billingUnits: 9,
      computedCostUsd: 0.45,
      pricingFetchedAt: new Date(),
    });
    const status = await checkBudget(userId, 0.10);
    assert.equal(status.allowed, false);
    assert.equal(Math.round(status.currentSpend * 100) / 100, 0.45);
  });
});
