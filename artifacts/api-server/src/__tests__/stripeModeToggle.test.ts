/**
 * The construction boundary's mode-coherence, and the mode toggle that sits on
 * top of it.
 *
 * The boundary had to be made coherent in the same increment as the guard, not
 * after it. `getStripeSync()` read the mode, then `getStripeSecretKey()` read it
 * again, then `getStripeWebhookSecret()` read it a third time — so verification
 * bolted onto that would have been a FOURTH independent read, verifying mode A
 * and handing back a client built for mode B, stamped verified. A guard that
 * certifies the wrong account is worse than no guard, which is what these tests
 * are here to keep true.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { adminConfigTable, usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { runScopedSync, isSyncRunning, _resetSyncRunnerForTests, type SyncRunnerDriver } from "../lib/stripeSyncRunner.js";
import { bustConfigCache, getConfigStringRaw } from "../lib/adminConfig.js";
import {
  __resetVerificationStateForTests,
  __strictModeReadsForTests,
  getVerificationStatus,
  isAccountVerified,
  readStripeLiveModeStrict,
} from "../lib/stripeAccountGuard.js";
import { clearStripeEnv, stubAccountRetriever } from "./helpers/stripeGuardHarness.js";
import {
  __discardedBuildsForTests,
  __endCachedSyncForTests,
  getStripeSync,
  invalidateStripeSync,
  isLiveMode,
} from "../lib/stripeClient.js";
import {
  __resetStripeInitForTests,
  __setStripeInitDepsForTests,
  runStripeVerificationRetryOnce,
} from "../lib/stripeInit.js";

const USER_PREFIX = "tstripetoggle-";

const restores: Array<() => void> = [];
let restoreEnv: (() => void) | null = null;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(adminRouter);
  return app;
}

async function setStoredMode(live: boolean): Promise<void> {
  const value = live ? "true" : "false";
  const existing = await db
    .select({ key: adminConfigTable.key })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, "stripe_live_mode"))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(adminConfigTable).values({
      key: "stripe_live_mode", value, dataType: "boolean", label: "Stripe live mode",
    });
  } else {
    await db.update(adminConfigTable).set({ value }).where(eq(adminConfigTable.key, "stripe_live_mode"));
  }
  bustConfigCache();
}

async function storedMode(): Promise<string | undefined> {
  const [row] = await db
    .select({ value: adminConfigTable.value })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, "stripe_live_mode"))
    .limit(1);
  return row?.value;
}

/** Test mode matches its declared account; live mode's key belongs to someone else. */
function configureTestValidLiveMismatched(): { retrievals: string[] } {
  process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
  process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
  process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
  process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_wrong";
  process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
  process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
  const retrievals: string[] = [];
  restores.push(
    stubAccountRetriever((secretKey) => {
      retrievals.push(secretKey);
      return secretKey === "sk_test_correct" ? "acct_test_expected" : "acct_someone_elses";
    }),
  );
  return { retrievals };
}

// Every hook below is scoped INSIDE this describe deliberately.
// `node --test` runs this suite with `--test-isolation=none`, so a hook
// declared at a file's top level attaches to the ROOT suite — which spans
// every test file in the process. A root-level `beforeEach` here that deletes
// STRIPE_* env vars would therefore run before other files' tests too, and
// break them somewhere far from this file.
describe("the Stripe mode toggle and its construction boundary", () => {
let adminSid: string;

before(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  const adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true });
  const sessionData: SessionData = {
    user: { id: adminId } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
  };
  adminSid = await createSession(sessionData, adminId);
});

after(async () => {
  await __endCachedSyncForTests();
  _resetSyncRunnerForTests();
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await setStoredMode(false);
});

beforeEach(async () => {
  restoreEnv = clearStripeEnv();
  __resetVerificationStateForTests();
  __resetStripeInitForTests();
  _resetSyncRunnerForTests();
  await __endCachedSyncForTests();
  await setStoredMode(false);
});

afterEach(async () => {
  while (restores.length > 0) restores.pop()!();
  restoreEnv?.();
  restoreEnv = null;
  __resetVerificationStateForTests();
  __resetStripeInitForTests();
  _resetSyncRunnerForTests();
  await __endCachedSyncForTests();
  await setStoredMode(false);
});

/** Hold the sync lock so the route's post-write runFullSync short-circuits. */
function holdSyncLock(): void {
  const stalled: SyncRunnerDriver = {
    async getAccountId() { return "acct_lockheld_test"; },
    syncProducts() { return new Promise<{ synced: number }>(() => { /* never settles */ }); },
    async syncPrices() { return { synced: 0 }; },
    async syncPlans() { return { synced: 0 }; },
    async syncCustomers() { return { synced: 0 }; },
    async syncSubscriptions() { return { synced: 0 }; },
    async syncInvoices() { return { synced: 0 }; },
    async syncCharges() { return { synced: 0 }; },
    async syncPaymentMethods() { return { synced: 0 }; },
  };
  runScopedSync(stalled);
  assert.equal(isSyncRunning(), true, "test setup: the sync lock should be held");
}

describe("the mode toggle verifies BEFORE it writes", () => {
  it("test 5 — a refused target leaves the stored mode unchanged and returns a non-success naming the mismatch", async () => {
    configureTestValidLiveMismatched();
    assert.equal(await storedMode(), "false");

    const res = await request(makeApp())
      .patch("/admin/config/stripe_live_mode")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ value: "true" });

    // All three halves. Asserting only the refusal would pass against the
    // behavior this replaced: the route committed the row, then invalidated and
    // rebuilt the sync inside a try/catch that only logged, and answered
    // res.json(updated) regardless — so payments switched to a mode whose every
    // client rejects, and the operator saw a successful toggle.
    assert.ok(res.status >= 400, `expected a non-success, got ${res.status}`);
    assert.match(String(res.body.error), /acct_someone_elses/);
    assert.match(String(res.body.error), /STRIPE_SECRET_KEY_LIVE/);
    assert.equal(await storedMode(), "false", "the stored mode must not have changed");
  });

  it("test 5d — the row NEVER transiently holds an unverified target", async () => {
    // The plan's concurrent-writer form of this test cannot discriminate on a
    // two-valued key: a rollback only loses a write when the other writer's
    // value differs from the rolled-back request's remembered prior, and with
    // {true,false} that value is the refused request's own target.
    //
    // What DOES discriminate — and is the actual reason the write-first shape
    // was struck — is that between the write and the rollback the stored mode
    // names an unverified target, so every payment request reading it in that
    // window is refused. Verify-before-write has no such window, and this
    // asserts its absence directly by sampling the row throughout the request.
    configureTestValidLiveMismatched();

    let sampling = true;
    const samples: Array<string | undefined> = [];
    const sampler = (async () => {
      while (sampling) {
        samples.push(await storedMode());
      }
    })();

    const res = await request(makeApp())
      .patch("/admin/config/stripe_live_mode")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ value: "true" });
    sampling = false;
    await sampler;

    assert.ok(res.status >= 400);
    assert.ok(samples.length > 0, "the sampler must have observed the row at least once");
    assert.ok(
      samples.every((s) => s === "false"),
      `the row held an unverified target at some instant: ${JSON.stringify([...new Set(samples)])}`,
    );
  });

  it("test 5c — a valid toggle still works end to end", async () => {
    // The only test here that fails if the guard simply broke the toggle. Round
    // 3 found the suite covered refusal only, so an implementation rejecting
    // every toggle — or verifying, refusing to persist, and skipping the sync —
    // would have passed.
    const { retrievals } = configureTestValidLiveMismatched();
    await setStoredMode(true);
    invalidateStripeSync();
    holdSyncLock();

    const res = await request(makeApp())
      .patch("/admin/config/stripe_live_mode")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ value: "false" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await storedMode(), "false", "the new mode must be stored");
    assert.ok(retrievals.includes("sk_test_correct"), "the TARGET mode's credential is what gets verified");
    assert.equal(isAccountVerified(false, "sk_test_correct"), true);
    // bustConfigCache() ran, so the lenient read agrees with the row again.
    assert.equal(await getConfigStringRaw("stripe_live_mode", "true"), "false");
  });

  it("a target mode with no credentials is refused rather than switched into", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    // No live credentials at all.
    restores.push(stubAccountRetriever(() => "acct_test_expected"));

    const res = await request(makeApp())
      .patch("/admin/config/stripe_live_mode")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ value: "true" });

    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /STRIPE_SECRET_KEY_LIVE/);
    assert.equal(await storedMode(), "false");
  });

  it("test 17 — a refused inactive-mode probe changes nothing, and recovery stays isolated", async () => {
    // The correction that matters most in the plan. An unqualified recovery hook
    // would let a retry following a refused INACTIVE-mode probe run webhook
    // registration and backfill against the account the guard had just rejected
    // — the design specifying, in its recovery path, the wrong-account mutation
    // it exists to prevent.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_unreachable";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";

    let liveAttempts = 0;
    restores.push(
      stubAccountRetriever((secretKey) => {
        if (secretKey === "sk_test_correct") return "acct_test_expected";
        liveAttempts++;
        if (liveAttempts === 1) throw new Error("Stripe unreachable");
        return "acct_live_expected"; // a later probe WOULD verify
      }),
    );

    const sequence: string[] = [];
    restores.push(
      __setStripeInitDepsForTests({
        runSyncMigrations: async () => { sequence.push("migrations"); },
        getSync: async () => ({
          findOrCreateManagedWebhook: async () => { sequence.push("webhook"); },
          syncBackfill: async () => { sequence.push("backfill"); },
        }),
        getSiteBaseUrl: () => "https://example.test",
      }),
    );

    // The probe returns indefinite, so the mode write never commits.
    const res = await request(makeApp())
      .patch("/admin/config/stripe_live_mode")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ value: "true" });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(await storedMode(), "false", "an indefinite probe must not commit the mode write");

    // Now a retry runs. It attempts the STORED mode only — never the refused
    // inactive target — so nothing initializes against the live account.
    await runStripeVerificationRetryOnce();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sequence, ["migrations", "webhook", "backfill"], "the STORED mode's initialization runs");
    assert.equal(liveAttempts, 1, "the inactive mode is never re-probed by the retry loop");

    // The active mode's payments were never affected by the failed probe.
    assert.equal(isAccountVerified(false, "sk_test_correct"), true);
    assert.equal(getVerificationStatus(false, "i").state, "verified");
  });
});

describe("the construction boundary is mode-coherent", () => {
  it("test 14 — the guard's strict read bypasses the admin-config cache", async () => {
    // loadAll() has no in-flight tracking, so a read crossing bustConfigCache()
    // can repopulate the cache with PRE-WRITE rows for another ~60s. A
    // construction reading the mode through that cache captures the old mode
    // INSIDE the current generation, so the generation check passes and the
    // guard verifies one mode while the sync runs another.
    await setStoredMode(false);
    // Warm the cache with the pre-write value.
    assert.equal(await getConfigStringRaw("stripe_live_mode", "true"), "false");
    assert.equal(await isLiveMode(), false);

    // Change the row WITHOUT busting — this stands in for the stale
    // republication, which is what a delayed loadAll() produces.
    await db.update(adminConfigTable).set({ value: "true" }).where(eq(adminConfigTable.key, "stripe_live_mode"));

    assert.equal(await isLiveMode(), false, "the cached read is stale, as documented");
    assert.equal(await readStripeLiveModeStrict(), true, "the guard's read must see the row, not the cache");
  });

  it("a published sync is reused without a direct-row read per call", async () => {
    // getStripeSync() runs on every webhook, BEFORE signature validation, on the
    // one route the rate limiter exempts because it has a signature gate. A
    // strict (uncached, direct-row) mode read on that path would hand an
    // unauthenticated flood one database round-trip each — the same
    // amplification the verification throttle exists to prevent, one layer down.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    restores.push(stubAccountRetriever(() => "acct_test_expected"));

    const first = await getStripeSync();
    const readsAfterBuild = __strictModeReadsForTests();
    assert.ok(readsAfterBuild >= 1, "the BUILD must read the mode strictly");

    for (let i = 0; i < 20; i++) {
      assert.equal(await getStripeSync(), first, "the published instance is reused");
    }
    assert.equal(
      __strictModeReadsForTests(),
      readsAfterBuild,
      "reusing a published sync must not issue a direct-row read per call",
    );
  });

  it("test 5b / test 9 — a build whose generation is stale is discarded and its pool is ENDED", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";

    let released: (() => void) | null = null;
    const firstRetrievalStarted = new Promise<void>((resolve) => {
      restores.push(
        stubAccountRetriever(async () => {
          if (released === null) {
            resolve();
            await new Promise<void>((r) => { released = r; });
          }
          return "acct_test_expected";
        }),
      );
    });

    const pending = getStripeSync();
    await firstRetrievalStarted;

    // A toggle lands mid-construction. Publishing the in-flight build now would
    // reinstate the mode the invalidation just removed.
    invalidateStripeSync();
    (released as unknown as () => void)();

    const sync = await pending;
    assert.ok(sync, "construction still succeeds — it retries against the current generation");

    const discarded = __discardedBuildsForTests();
    assert.equal(discarded.count, 1, "the superseded build must have been discarded");
    // "Discarded" without this assertion means "leaked once per delayed toggle":
    // PostgresClient's constructor runs new pg.Pool(...) synchronously, so a
    // pool exists before any generation check can reject the build, and the
    // library exposes no teardown of its own beyond this public field.
    assert.equal(discarded.lastPoolEnded, true, "the rejected build's pool must be ended, not dropped");
  });
});
});
