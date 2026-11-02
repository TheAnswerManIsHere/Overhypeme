/**
 * Plan 1a tests 6 and 15 — the admin-lockout invariant.
 *
 * The invariant is stated over the POPULATION, not over a list of endpoints:
 * no sequence of PATCH/DELETE operations, including concurrent ones, may
 * reduce the number of accounts that can actually reach the admin console to
 * zero.
 *
 * Every test here isolates its own admin population. The guard counts the whole
 * `users` table, so a test that left a stray active admin behind would make a
 * later test's "last admin" not actually last — the assertions would pass for
 * the wrong reason. Hence the prefix + full cleanup, and hence the deactivation
 * of any pre-existing admin for the duration of each test.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, like, not, sql } from "drizzle-orm";

import { BOOTSTRAP_ADMIN_EMAIL } from "../lib/auth.js";
import { isReachableAdminSql } from "../lib/adminIdentity.js";
import { db as _dbTypeAnchor } from "@workspace/db";
type Tx = Parameters<Parameters<typeof _dbTypeAnchor.transaction>[0]>[0];

import {
  AdminLockoutError,
  SelfDemotionError,
  assertAdminPopulationSurvives,
  assertNotSelfDemotion,
  crossesBootstrapBoundary,
} from "../lib/adminLockoutGuard.js";

const PREFIX = "tlockout-";

async function createUser(opts: {
  isAdmin?: boolean;
  isActive?: boolean;
  email?: string | null;
}): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: opts.email === undefined ? `${id}@example.test` : opts.email,
    isAdmin: opts.isAdmin ?? false,
    isActive: opts.isActive ?? true,
  });
  return id;
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

/**
 * Runs `fn` in a transaction where every admin this file did NOT create is
 * deactivated, then rolls the whole thing back.
 *
 * The guard counts the WHOLE users table by design — that is the invariant —
 * so "the last admin" only means anything if no other file's admins are alive
 * at that moment. An earlier attempt parked them with a plain UPDATE and
 * restored in `after`; that broke OTHER suites, because test files in a shard
 * are not as strictly ordered as it assumed and a foreign admin could be
 * deactivated while its own suite was still using it.
 *
 * A transaction fixes both halves: the guard sees the population it needs
 * (it takes the same `tx`), and nothing outside this file ever observes the
 * deactivation, because the transaction always rolls back.
 */
class Rollback extends Error {}

async function withOnlyOurAdmins(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(usersTable)
        .set({ isActive: false })
        .where(and(isReachableAdminSql(), not(like(usersTable.id, `${PREFIX}%`))));
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** Asserts `fn` rejects with AdminLockoutError, with foreign admins excluded. */
async function assertLockoutRefused(targetId: string): Promise<void> {
  let refused = false;
  await withOnlyOurAdmins(async (tx) => {
    try {
      await assertAdminPopulationSurvives(tx, targetId);
    } catch (err) {
      if (err instanceof AdminLockoutError) { refused = true; return; }
      throw err;
    }
  });
  assert.ok(refused, "removing the last reachable admin must be refused");
}

/** Asserts the guard PASSES, with foreign admins excluded. */
async function assertLockoutAllowed(targetId: string): Promise<void> {
  await withOnlyOurAdmins(async (tx) => {
    await assertAdminPopulationSurvives(tx, targetId);
  });
}

/**
 * Admins reachable right now that this file did NOT create.
 *
 * A test below cannot be isolated with the rollback trick: it needs two
 * genuinely concurrent committed transactions. (Two more exercised the soft
 * delete's reservation until launch Phase 5's Increment 7a retired it.) It
 * asserts a property that is only meaningful when the target really is the
 * last reachable admin —
 * and committing a deactivation of foreign admins to arrange that is what broke
 * other suites the first time.
 *
 * So they state their precondition and skip when it does not hold, rather than
 * failing for a reason unrelated to the guard. In a clean shard database (the
 * canonical runner's normal case) and in isolation, it holds and they run.
 */
async function foreignReachableAdminCount(): Promise<number> {
  const { rows } = await db.execute<{ n: string | number }>(sql`
    SELECT count(*) AS n FROM ${usersTable}
    WHERE ${and(isReachableAdminSql(), not(like(usersTable.id, `${PREFIX}%`)))}
  `);
  return Number(rows[0]!.n);
}

/** Reachable admins created by THIS file. */
async function ourReachableAdminCount(): Promise<number> {
  const { rows } = await db.execute<{ n: string | number }>(sql`
    SELECT count(*) AS n FROM ${usersTable}
    WHERE ${and(isReachableAdminSql(), like(usersTable.id, `${PREFIX}%`))}
  `);
  return Number(rows[0]!.n);
}

before(cleanup);
beforeEach(cleanup);

// ── Who counts as an admin ───────────────────────────────────────────────────

describe("the admin population is counted over all three grant mechanisms", () => {
  it("counts a stored-column admin", async () => {
    await createUser({ isAdmin: true });
    assert.equal(await ourReachableAdminCount(), 1);
  });

  it("counts an ADMIN_USER_IDS admin whose stored flag is false", async () => {
    const id = await createUser({ isAdmin: false });
    const previous = process.env["ADMIN_USER_IDS"];
    process.env["ADMIN_USER_IDS"] = id;
    try {
      assert.equal(
        await ourReachableAdminCount(),
        1,
        "an env-granted admin must be visible to the population count",
      );
    } finally {
      if (previous === undefined) delete process.env["ADMIN_USER_IDS"];
      else process.env["ADMIN_USER_IDS"] = previous;
    }
  });

  it("counts a bootstrap-email admin whose stored flag is false", async () => {
    await createUser({ isAdmin: false, email: BOOTSTRAP_ADMIN_EMAIL });
    assert.equal(
      await ourReachableAdminCount(),
      1,
      "a bootstrap-email admin must be visible to the population count",
    );
  });

  it("does NOT count an inactive admin — authMiddleware would not resolve them", async () => {
    await createUser({ isAdmin: true, isActive: false });
    assert.equal(await ourReachableAdminCount(), 0);
  });
});

// ── Test 6 — the guard, over each grant mechanism ────────────────────────────

describe("the last admin cannot be removed", () => {
  it("rejects removing the last stored-column admin", async () => {
    const id = await createUser({ isAdmin: true });
    await assertLockoutRefused(id);
  });

  it("rejects removing an account that is an admin ONLY by ADMIN_USER_IDS", async () => {
    const id = await createUser({ isAdmin: false });
    const previous = process.env["ADMIN_USER_IDS"];
    process.env["ADMIN_USER_IDS"] = id;
    try {
      await assertLockoutRefused(id);
    } finally {
      if (previous === undefined) delete process.env["ADMIN_USER_IDS"];
      else process.env["ADMIN_USER_IDS"] = previous;
    }
  });

  it("rejects removing an account that is an admin ONLY by bootstrap email", async () => {
    const id = await createUser({ isAdmin: false, email: BOOTSTRAP_ADMIN_EMAIL });
    await assertLockoutRefused(id);
  });

  it("allows removing one admin when another remains", async () => {
    const first = await createUser({ isAdmin: true });
    await createUser({ isAdmin: true });
    await assertLockoutAllowed(first);
  });

  it("does not count an inactive second admin as cover", async () => {
    const active = await createUser({ isAdmin: true });
    await createUser({ isAdmin: true, isActive: false });
    await assertLockoutRefused(active);
  });
});

// ── The email-change mutation kind ───────────────────────────────────────────

describe("an email change is an admin-removing mutation", () => {
  it("detects crossing the bootstrap boundary in the removing direction", () => {
    assert.equal(crossesBootstrapBoundary(BOOTSTRAP_ADMIN_EMAIL, "someone@example.test"), true);
  });

  it("detects crossing it in the granting direction too", () => {
    assert.equal(crossesBootstrapBoundary("someone@example.test", BOOTSTRAP_ADMIN_EMAIL), true);
  });

  it("is case-insensitive, matching isAdminByEmail", () => {
    assert.equal(
      crossesBootstrapBoundary(BOOTSTRAP_ADMIN_EMAIL.toUpperCase(), BOOTSTRAP_ADMIN_EMAIL),
      false,
      "a case-only change does not cross the boundary",
    );
  });

  it("is not triggered by an ordinary email change", () => {
    assert.equal(crossesBootstrapBoundary("a@example.test", "b@example.test"), false);
  });

  it("treats clearing the bootstrap admin's email as a crossing", () => {
    assert.equal(crossesBootstrapBoundary(BOOTSTRAP_ADMIN_EMAIL, null), true);
  });
});

// ── Self-demotion ────────────────────────────────────────────────────────────

describe("self-demotion", () => {
  it("an admin may not remove their own admin flag", () => {
    assert.throws(() => assertNotSelfDemotion("u1", "u1"), SelfDemotionError);
  });

  it("an admin may act on someone else", () => {
    assert.doesNotThrow(() => assertNotSelfDemotion("u1", "u2"));
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("concurrent removals of DIFFERENT admins cannot both succeed", () => {
  it("serializes on the advisory lock rather than on the rows being written", async (t) => {
    if ((await foreignReachableAdminCount()) > 0) {
      t.skip("needs an exclusive admin population; another suite has an active admin");
      return;
    }

    // This is the case a transaction alone does not cover. At READ COMMITTED
    // both transactions read a count of two, both conclude they are safe, and
    // both commit — the rows they write don't overlap, so nothing serializes
    // them. The guard must serialize on something else.
    const a = await createUser({ isAdmin: true });
    const b = await createUser({ isAdmin: true });

    const removeUnderGuard = (target: string) =>
      db.transaction(async (tx) => {
        await assertAdminPopulationSurvives(tx, target);
        await tx.update(usersTable).set({ isAdmin: false }).where(eq(usersTable.id, target));
      });

    const results = await Promise.allSettled([removeUnderGuard(a), removeUnderGuard(b)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;

    assert.equal(fulfilled, 1, "exactly one of two concurrent removals may succeed");
    assert.equal(
      await ourReachableAdminCount(),
      1,
      "the population must never reach zero, whatever the interleaving",
    );
  });
});

// ── The listing an operator reads before demoting someone ────────────────────

describe("the admin listing reflects the real population", () => {
  it("includes an env-granted admin whose stored flag is false", async () => {
    const stored = await createUser({ isAdmin: true });
    const envOnly = await createUser({ isAdmin: false });
    const previous = process.env["ADMIN_USER_IDS"];
    process.env["ADMIN_USER_IDS"] = envOnly;
    try {
      const rows = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(isReachableAdminSql(), like(usersTable.id, `${PREFIX}%`)));
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(stored));
      assert.ok(ids.includes(envOnly), "the listing must not undercount env-granted admins");
    } finally {
      if (previous === undefined) delete process.env["ADMIN_USER_IDS"];
      else process.env["ADMIN_USER_IDS"] = previous;
    }
  });
});
