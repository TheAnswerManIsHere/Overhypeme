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
  __expireModeRecheckForTests,
  __endCachedSyncForTests,
  __setRawClientFactoryForTests,
  getStripeSync,
  getUncachableStripeClient,
  getVerifiedStripeClient,
  getVerifiedStripeMode,
  invalidateStripeSync,
  isLiveMode,
} from "../lib/stripeClient.js";
import {
  __resetStripeInitForTests,
  __setStripeInitDepsForTests,
  ensureVerificationArmedFor,
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

  it("an active mode this process has never verified gets verification STARTED, not just reported", async () => {
    // Round 5's P2, and it only exists because of autoscale. When ANOTHER
    // instance commits a mode toggle, this process has no state for the newly
    // active mode — and a boot that succeeded normally has already stopped its
    // retry timer, or never armed one. Nothing was scheduled to verify the new
    // mode, so the Billing poll read a pure getter, saw "Verification has not
    // run yet", and polled that forever while the UI claimed verification was
    // in progress. The status was transitional with nothing in transit.
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
    restores.push(stubAccountRetriever(() => "acct_live_expected"));

    // Injected so the pass is hermetic: what is under test is that
    // verification RUNS, not the sync library's migrations.
    restores.push(
      __setStripeInitDepsForTests({
        runSyncMigrations: async () => {},
        getSync: async () => ({
          findOrCreateManagedWebhook: async () => {},
          syncBackfill: async () => {},
        }),
        getSiteBaseUrl: () => "https://example.test",
      }),
    );

    await setStoredMode(true);
    bustConfigCache();

    assert.equal(
      getVerificationStatus(true, "inst-1").state,
      "pending",
      "the premise: nothing in this process has attempted the newly active mode",
    );
    assert.equal(isAccountVerified(true, "sk_live_correct"), false);

    ensureVerificationArmedFor(true);
    // The pass is started, not awaited by the caller — the summary endpoint
    // must never block on Stripe. So wait for the OUTCOME, bounded, exiting the
    // moment it lands rather than sleeping a fixed span.
    for (let i = 0; i < 200 && !isAccountVerified(true, "sk_live_correct"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(
      isAccountVerified(true, "sk_live_correct"),
      true,
      "detecting an unseen active mode must START verification",
    );
    assert.equal(getVerificationStatus(true, "inst-1").state, "verified");
  });

  it("a strict recheck shared with the catalog readers cannot make a stale sync look fresh", async () => {
    // Round 5's P1. Round 4 made `lastStrictModeReadAt` a SHARED value so the
    // catalog and the client boundary would stop disagreeing — and the sync's
    // fast path was still testing that shared timestamp for freshness while
    // comparing the sync itself against the LENIENT cached mode. So a public
    // `/stripe/plans` request could learn the new mode, refresh the timestamp,
    // and thereby certify a sync built for the old one as current for another
    // full interval. The fix that removed one divergence had created another.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
    restores.push(
      stubAccountRetriever((secretKey) =>
        secretKey === "sk_live_correct" ? "acct_live_expected" : "acct_test_expected",
      ),
    );

    await setStoredMode(false);
    const testSync = await getStripeSync();

    // A toggle committed by ANOTHER instance: the row moves, this process's
    // config cache does not, and nothing here is invalidated.
    await db.update(adminConfigTable).set({ value: "true" }).where(eq(adminConfigTable.key, "stripe_live_mode"));
    assert.equal(await isLiveMode(), false, "the lenient read is stale, which is the premise");

    // Let the interval lapse, then have a CATALOG reader refresh the shared
    // strict mode — exactly what a public /stripe/plans request does.
    __expireModeRecheckForTests();
    assert.equal(await getVerifiedStripeMode(), true, "the catalog reader learns the new mode");

    // The published sync is now stale and the shared timestamp is fresh. The
    // old fast path returned `testSync` here.
    const after = await getStripeSync();
    assert.notEqual(after, testSync, "a sync built for the superseded mode must not be reused");

    // The superseded instance is replaced, not disposed — production defers
    // that deliberately — so this test owns ending the pool it orphaned. Four
    // shards share one Postgres, and a test that leaks connections fails
    // something else, somewhere hard to trace back to it.
    await (testSync as unknown as { postgresClient?: { pool?: { end?: () => Promise<void> } } })
      .postgresClient?.pool?.end?.();
    await __endCachedSyncForTests();
  });

  it("a flood arriving the moment the recheck expires costs ONE row read, not one each", async () => {
    // Round 5's other P1, and the reason it is a P1 rather than a tidiness
    // note: getStripeSync() runs before signature validation on the
    // rate-limiter-exempt webhook route, so "concurrent callers" there means
    // "as many as an attacker sends". Every one of them observed the recheck as
    // due before any had refreshed the timestamp, so the interval bounded one
    // caller and nothing bounded a burst.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    restores.push(stubAccountRetriever(() => "acct_test_expected"));

    await setStoredMode(false);
    await getStripeSync();

    __expireModeRecheckForTests();
    const before = __strictModeReadsForTests();
    await Promise.all(Array.from({ length: 25 }, () => getVerifiedStripeMode()));
    assert.equal(
      __strictModeReadsForTests() - before,
      1,
      "25 concurrent rechecks must collapse to a single row read",
    );
    await __endCachedSyncForTests();
  });

  it("a failing strict read is not re-queried on every request until it recovers", async () => {
    // The failure half, and the sharper one. captureModeForConstruction()
    // stamps the read time only on SUCCESS — deliberately, so a failure cannot
    // postpone learning the real mode. The consequence nobody had priced: a
    // database refusing reads never refreshes the timestamp at all, so every
    // request keeps querying it for as long as it stays down. The attempt
    // stamp is separate from the read stamp precisely so a failure can be
    // throttled without ever being mistaken for an answer.
    const { __setStrictModeReaderForTests } = await import("../lib/stripeAccountGuard.js");
    let attempts = 0;
    restores.push(
      __setStrictModeReaderForTests(async () => {
        attempts += 1;
        throw new Error("the row is unreadable");
      }),
    );

    __expireModeRecheckForTests();
    for (let i = 0; i < 10; i++) {
      await assert.rejects(getVerifiedStripeMode(), /unreadable/);
    }
    assert.equal(attempts, 1, "a recent failure is replayed, not re-queried once per request");
  });

  it("getUncachableStripeClient() re-derives when a toggle lands mid-verification", async () => {
    // Round 1's P1. The generation check covered getStripeSync() only — so a
    // checkout or admin request that captured test mode and then waited in
    // verifyStripeAccount (a network round-trip, up to the Stripe timeout)
    // would still be handed a TEST-account client after a concurrent admin
    // toggle had committed LIVE, and would mutate the now-inactive account.
    //
    // This is the same defect the plan named for the sync path, in the other
    // constructor — the exact asymmetry round 3 of the plan review caught once
    // already for verification itself.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";

    const retrievals: string[] = [];
    let builtFrom: string | null = null;
    restores.push(
      __setRawClientFactoryForTests((secretKey) => {
        builtFrom = secretKey;
        return {} as never;
      }),
    );
    let released: (() => void) | null = null;
    const firstRetrievalStarted = new Promise<void>((resolve) => {
      restores.push(
        stubAccountRetriever(async (secretKey) => {
          retrievals.push(secretKey);
          if (released === null) {
            resolve();
            await new Promise<void>((r) => { released = r; });
          }
          return secretKey === "sk_live_correct" ? "acct_live_expected" : "acct_test_expected";
        }),
      );
    });

    const pending = getUncachableStripeClient();
    await firstRetrievalStarted;

    // The toggle commits and invalidates, exactly as the admin route does.
    await setStoredMode(true);
    invalidateStripeSync();
    (released as unknown as () => void)();

    const client = await pending;

    assert.deepEqual(
      retrievals,
      ["sk_test_correct", "sk_live_correct"],
      "the constructor must re-derive against the current mode rather than return the superseded one",
    );
    // And the client it actually hands back is built from the NEW mode's
    // credential. Asserting the retrieval sequence alone would pass against a
    // constructor that re-verifies for the new mode and then returns the stale
    // client anyway — stripe@20 keeps the secret in a private field, which is
    // why the factory is indirected rather than read back off the object.
    assert.equal(builtFrom, "sk_live_correct", `client was built from the wrong credential: ${String(builtFrom)}`);
    assert.ok(client, "a client is still returned");
  });

  it("the test-event gate and the client it uses cannot disagree about the mode", async () => {
    // Round 3's P1, and a divergence THIS increment created: the route refused
    // to run in live mode by reading the lenient config-cached mode, while its
    // client was built from the guard's strict row read. On an instance that had
    // not handled a toggle those disagree for the cache's TTL — so the route
    // could pass its "test mode only" gate and then create a real customer on
    // the LIVE account. Before this increment both reads went through the same
    // cached path and always agreed.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
    restores.push(
      stubAccountRetriever((secretKey) =>
        secretKey === "sk_live_correct" ? "acct_live_expected" : "acct_test_expected",
      ),
    );

    // Warm the lenient cache on TEST, then move the row to LIVE *without*
    // busting it — precisely the remote-toggle case.
    await setStoredMode(false);
    assert.equal(await isLiveMode(), false);
    await db.update(adminConfigTable).set({ value: "true" }).where(eq(adminConfigTable.key, "stripe_live_mode"));
    assert.equal(await isLiveMode(), false, "the lenient read is stale, which is the setup for this defect");

    // The gate must see the mode the CLIENT was verified for, not the stale one.
    const { liveMode } = await getVerifiedStripeClient();
    assert.equal(
      liveMode,
      true,
      "the verified mode must be the row's, so a gate reading it cannot authorize test while the client is live",
    );

    // And the convenience wrapper is the same construction, not a second one.
    assert.notEqual(await getUncachableStripeClient(), undefined);
  });

  it("a mode committed by another instance DURING verification is not handed out", async () => {
    // Round 4's P1. The generation counter is process-local, so a toggle
    // committed by another autoscale instance never moves it — and verification
    // is a network round-trip, which is a wide window for one to land in. The
    // constructor would have returned a client for the superseded account, and
    // checkout or an admin mutation would then have operated on it.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
    await setStoredMode(false);

    let builtFrom: string | null = null;
    restores.push(
      __setRawClientFactoryForTests((secretKey) => { builtFrom = secretKey; return {} as never; }),
    );

    // While the FIRST verification is in flight, another instance commits the
    // toggle: the row changes and this process is told nothing — no
    // bustConfigCache, and critically no invalidateStripeSync, so the
    // generation counter does not move.
    let toggled = false;
    restores.push(
      stubAccountRetriever(async (secretKey) => {
        if (!toggled) {
          toggled = true;
          await db.update(adminConfigTable).set({ value: "true" })
            .where(eq(adminConfigTable.key, "stripe_live_mode"));
          __expireModeRecheckForTests();
        }
        return secretKey === "sk_live_correct" ? "acct_live_expected" : "acct_test_expected";
      }),
    );

    const { liveMode } = await getVerifiedStripeClient();

    assert.equal(liveMode, true, "the client must be for the mode the row holds AFTER verification");
    assert.equal(builtFrom, "sk_live_correct", "and built from that mode's credential");
  });

  it("a remote-instance toggle is noticed within the recheck interval, not the cache TTL", async () => {
    // Round 2's P1. A toggle busts the config cache and invalidates the sync
    // only on the instance that handled it. Every other instance of this
    // autoscale deployment kept BOTH for the config cache's full 60s TTL, so an
    // admin sync or a webhook routed there ran against the previous account and
    // mixed its data into the shared database — while the Billing surface
    // already reported the new mode.
    //
    // This simulates the remote case exactly: the row changes, and this process
    // is told nothing (no bustConfigCache, no invalidateStripeSync).
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
    restores.push(
      stubAccountRetriever((secretKey) =>
        secretKey === "sk_live_correct" ? "acct_live_expected" : "acct_test_expected",
      ),
    );

    const first = await getStripeSync();
    const readsAfterBuild = __strictModeReadsForTests();

    // The row moves to live behind this process's back.
    await db.update(adminConfigTable).set({ value: "true" }).where(eq(adminConfigTable.key, "stripe_live_mode"));
    // NOT busting the cache is the point: isLiveMode() still answers "test".
    assert.equal(await isLiveMode(), false, "the lenient read is stale, which is the remote-toggle case");

    // Inside the interval the published sync is still reused, and no row is read
    // — that is the amplification bound, and it is deliberate.
    assert.equal(await getStripeSync(), first);
    assert.equal(__strictModeReadsForTests(), readsAfterBuild);

    // Once the interval elapses the row is consulted, and the stale sync is
    // replaced rather than handed out again. The interval is expired directly
    // rather than slept out: a five-second sleep in a suite that runs in under
    // thirty is waste, and it makes the assertion depend on wall-clock timing
    // rather than on the behaviour under test.
    __expireModeRecheckForTests();
    const second = await getStripeSync();
    assert.notEqual(second, first, "a sync for the superseded mode must not be reused past the interval");
    assert.ok(__strictModeReadsForTests() > readsAfterBuild, "the row must actually have been read");

    // `first` was replaced, not disposed — production defers disposal of
    // previously cached instances — so THIS TEST must end its pool. Leaving it
    // open leaks two connections per run into a suite that runs four shards
    // against one server, and a test that leaks connections is a test that will
    // eventually fail something else.
    await (first as unknown as { postgresClient?: { pool?: { end?: () => Promise<void> } } })
      .postgresClient?.pool?.end?.();
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
