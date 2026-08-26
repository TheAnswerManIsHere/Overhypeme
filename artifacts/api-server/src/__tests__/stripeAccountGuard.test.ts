/**
 * The Stripe account guard — classification, the construction boundary, the
 * memo, and the throttle.
 *
 * Read the assertions carefully before relaxing one. Several of them exist
 * because a *weaker* version of the same test passes against an implementation
 * that has the defect: a test that only checks "the refusal happened" passes
 * against a check placed after the mutation, and a recovery test that only
 * checks client availability passes against a recovery that leaves the managed
 * webhook unregistered until the next restart.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import {
  VERIFY_THROTTLE_MS,
  __resetVerificationStateForTests,
  __strictModeReadsForTests,
  getVerificationStatus,
  isAccountVerified,
  readStripeLiveModeStrict,
  verifyStripeAccount,
} from "../lib/stripeAccountGuard.js";
import { clearStripeEnv, stubAccountRetriever } from "./helpers/stripeGuardHarness.js";
import {
  STRIPE_UNVERIFIED_CODE as SHARED_STRIPE_UNVERIFIED_CODE,
  STRIPE_UNVERIFIED_CLIENT_MESSAGE as SHARED_STRIPE_UNVERIFIED_CLIENT_MESSAGE,
} from "@workspace/api-zod";
import {
  STRIPE_UNVERIFIED_CODE,
  StripeAccountMismatchError,
  StripeExpectedAccountMissingError,
  StripeUnverifiedError,
} from "../lib/stripeVerificationErrors.js";
import {
  __resetStripeInitForTests,
  __setStripeInitDepsForTests,
  hasStripeInitializationStarted,
  runStripeBootVerification,
  runStripeVerificationRetryOnce,
} from "../lib/stripeInit.js";
import { getStripeSync, getUncachableStripeClient, invalidateStripeSync } from "../lib/stripeClient.js";

const restores: Array<() => void> = [];
let restoreEnv: (() => void) | null = null;

async function setStoredMode(live: boolean): Promise<void> {
  const value = live ? "true" : "false";
  const existing = await db
    .select({ key: adminConfigTable.key })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, "stripe_live_mode"))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(adminConfigTable).values({
      key: "stripe_live_mode",
      value,
      dataType: "boolean",
      label: "Stripe live mode",
    });
  } else {
    await db.update(adminConfigTable).set({ value }).where(eq(adminConfigTable.key, "stripe_live_mode"));
  }
}

/** Credentials present and correct for test mode, connected account matching. */
function configureMatchingTestMode(accountId = "acct_expected"): { retrievals: string[] } {
  process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
  process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_correct";
  process.env.STRIPE_ACCOUNT_ID_TEST = accountId;
  const retrievals: string[] = [];
  restores.push(
    stubAccountRetriever((secretKey) => {
      retrievals.push(secretKey);
      return accountId;
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
describe("the Stripe account guard", () => {
beforeEach(async () => {
  restoreEnv = clearStripeEnv();
  __resetVerificationStateForTests();
  __resetStripeInitForTests();
  invalidateStripeSync();
  await setStoredMode(false);
});

afterEach(async () => {
  while (restores.length > 0) restores.pop()!();
  restoreEnv?.();
  restoreEnv = null;
  __resetVerificationStateForTests();
  __resetStripeInitForTests();
  invalidateStripeSync();
  await setStoredMode(false);
});

describe("the guard classifies each outcome into its own class", () => {
  it("test 1 — an absent expected account id with credentials present is a REFUSAL, and asks Stripe nothing", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_x";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    // STRIPE_ACCOUNT_ID_TEST deliberately unset.
    let retrievals = 0;
    restores.push(stubAccountRetriever(() => { retrievals++; return "acct_anything"; }));

    await assert.rejects(
      () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_x" }),
      (err: Error) => {
        assert.ok(err instanceof StripeExpectedAccountMissingError, `got ${err.name}`);
        assert.match(err.message, /STRIPE_ACCOUNT_ID_TEST/);
        return true;
      },
    );
    // There is nothing a retrieval could say that changes a missing declaration,
    // and the old code's `if (expectedAccountId)` made absence a silent SKIP —
    // fail-open in exactly the environment least likely to be configured.
    assert.equal(retrievals, 0, "a missing declaration must not send a request to Stripe");
  });

  it("test 3 — a confirmed mismatch is a REFUSAL, and no client is ever constructed for it", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_wrong_account";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    restores.push(stubAccountRetriever(() => "acct_someone_elses"));

    await assert.rejects(
      () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_wrong_account" }),
      (err: Error) => {
        assert.ok(err instanceof StripeAccountMismatchError, `got ${err.name}`);
        assert.match(err.message, /acct_someone_elses/);
        assert.match(err.message, /acct_expected/);
        return true;
      },
    );

    // The assertion that distinguishes this fix from the status quo: not merely
    // that a refusal happened, but that nothing capable of mutating the wrong
    // account was ever handed out. The old check ran AFTER
    // findOrCreateManagedWebhook() had already registered a webhook on it.
    await assert.rejects(() => getStripeSync(), (err: Error) => err instanceof StripeAccountMismatchError);
    assert.equal(hasStripeInitializationStarted(), false, "no Stripe mutation sequence may have started");
  });

  it("test 3c — an indefinite answer withholds the client and does NOT refuse to boot", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_x";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    restores.push(stubAccountRetriever(() => { throw new Error("ECONNREFUSED stripe.com"); }));

    const outcome = await runStripeBootVerification();
    assert.equal(outcome.kind, "pending", "a Stripe outage must never take the site down");

    // The client being withheld is the assertion that matters; the refusing
    // payment routes are its consequence, not the mechanism.
    await assert.rejects(() => getStripeSync(), (err: Error) => err instanceof StripeUnverifiedError);
    await assert.rejects(() => getUncachableStripeClient(), (err: Error) => err instanceof StripeUnverifiedError);
  });

  it("test 6 — credentials absent still boots, and does NOT terminate", async () => {
    // No STRIPE_SECRET_KEY_* at all. This is the negative test for the guard's
    // own blast radius: the fix must not turn optional Stripe configuration
    // into a fatal boot dependency.
    let retrievals = 0;
    restores.push(stubAccountRetriever(() => { retrievals++; return "acct_x"; }));

    const outcome = await runStripeBootVerification();
    assert.equal(outcome.kind, "unconfigured");
    assert.equal(retrievals, 0, "an unconfigured integration starts no verification");

    const status = getVerificationStatus(false, "instance-a");
    assert.equal(status.state, "unconfigured");
    assert.equal(status.lastAttemptAt, null, "an unconfigured integration is terminal and unpolled");
  });

  it("a matching account verifies, and the boot phase reports it", async () => {
    const { retrievals } = configureMatchingTestMode();
    const outcome = await runStripeBootVerification();
    assert.deepEqual(outcome, { kind: "verified", liveMode: false });
    assert.deepEqual(retrievals, ["sk_test_correct"]);
    assert.equal(isAccountVerified(false, "sk_test_correct"), true);
  });
});

describe("the account read is Stripe's answer, never local state", () => {
  it("test 7 — the guard uses accounts.retrieve() on the raw client and never getAccountId()", async () => {
    const { retrievals } = configureMatchingTestMode();
    await verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct" });
    // The retriever the guard called is the one that maps to GET /v1/account.
    // getAccountId() would have answered from an in-memory cache, or from a
    // LOCAL key-hash lookup, and on a miss would have UPSERT the account row —
    // so a first mismatched boot poisons every later one. A guard built on it
    // grows quieter precisely in the case it exists to catch.
    assert.deepEqual(retrievals, ["sk_test_correct"]);

    // Cache-hit path: the second call is served from the success memo and asks
    // Stripe nothing, so verification is one call per distinct credential.
    await verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct" });
    assert.equal(retrievals.length, 1);

    // The guard's own source must not reference the rejected helper at all.
    const here = dirname(fileURLToPath(import.meta.url));
    const guardSource = readFileSync(resolve(here, "../lib/stripeAccountGuard.ts"), "utf8");
    const normative = guardSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(normative, /getAccountId\s*\(/, "the guard must never call getAccountId()");
  });

  it("test 7b — a mismatched credential is refused through getUncachableStripeClient() too", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_wrong";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    restores.push(stubAccountRetriever(() => "acct_other"));

    // Guarding sync construction alone passes almost every other test in this
    // file and still hands checkout and the admin mutation routes a
    // wrong-account raw client. Both exported constructors are the boundary.
    await assert.rejects(
      () => getUncachableStripeClient(),
      (err: Error) => err instanceof StripeAccountMismatchError,
    );
  });
});

describe("the memo caches successes only", () => {
  it("test 8 / test 12 (memo half) — a transient failure is not memoised and recovers with no restart", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    let calls = 0;
    restores.push(
      stubAccountRetriever(() => {
        calls++;
        if (calls === 1) throw new Error("503 from Stripe");
        return "acct_expected";
      }),
    );

    await assert.rejects(
      () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct", force: true }),
      (err: Error) => err instanceof StripeUnverifiedError,
    );
    assert.equal(isAccountVerified(false, "sk_test_correct"), false);

    // A cached rejection would pin payments off until restart and silently
    // defeat the retry loop — one transient blip becoming a permanent outage.
    await verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct", force: true });
    assert.equal(isAccountVerified(false, "sk_test_correct"), true);
    assert.equal(calls, 2);
  });
});

describe("retrieval is single-flight and interval-bound behind the public webhook", () => {
  it("concurrent callers share ONE retrieval", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    let calls = 0;
    restores.push(
      stubAccountRetriever(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return "acct_expected";
      }),
    );

    await Promise.all(
      Array.from({ length: 8 }, () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct" })),
    );
    assert.equal(calls, 1, "eight concurrent callers must produce one retrieval");
  });

  it("sequential caller-driven attempts inside the throttle window do NOT re-contact Stripe", async () => {
    // getStripeSync() runs BEFORE signature validation in processWebhook, on the
    // one route exempted from the rate limiter because it has a signature gate.
    // With failures deliberately never memoised, forged requests would otherwise
    // drive one accounts.retrieve() each.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    let calls = 0;
    restores.push(stubAccountRetriever(() => { calls++; throw new Error("network down"); }));

    for (let i = 0; i < 25; i++) {
      await assert.rejects(
        () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct" }),
        (err: Error) => err instanceof StripeUnverifiedError,
      );
    }
    assert.equal(calls, 1, "25 sequential unauthenticated attempts must produce one retrieval");

    // And the throttle is a timestamp, not a stored verdict: the retry loop
    // passes force and is never throttled, which is what keeps recovery working.
    assert.ok(VERIFY_THROTTLE_MS > 0);
    await assert.rejects(
      () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_correct", force: true }),
      (err: Error) => err instanceof StripeUnverifiedError,
    );
    assert.equal(calls, 2, "a forced attempt bypasses the throttle");
  });

  it("the throttle preserves a CONFIRMED mismatch instead of flattening it", async () => {
    // Twice now, a throttle written as "refuse without asking Stripe" answered
    // with the indefinite error for a mode whose account is definitely wrong —
    // the same conflation of definite and indefinite this whole guard exists to
    // end, reintroduced inside the mechanism protecting it. Both the internal
    // window and the construction boundary's earlier check answer from one
    // implementation, and this is what pins that.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_wrong";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    restores.push(stubAccountRetriever(() => "acct_someone_elses"));

    await assert.rejects(
      () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_wrong" }),
      (err: Error) => err instanceof StripeAccountMismatchError,
    );
    // Inside the window, through both entry points.
    await assert.rejects(
      () => verifyStripeAccount({ liveMode: false, secretKey: "sk_test_wrong" }),
      (err: Error) => err instanceof StripeAccountMismatchError,
    );
    await assert.rejects(
      () => getStripeSync(),
      (err: Error) => err instanceof StripeAccountMismatchError,
    );
  });

  it("a flood during an unverified window costs no database read per request", async () => {
    // The Stripe call is not the only amplification vector on the one route the
    // rate limiter exempts: the strict mode read is an uncached row select, so a
    // throttle that bites only at the Stripe call still converts forged requests
    // 1:1 into queries against a 2-connection pool for the whole outage.
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    restores.push(stubAccountRetriever(() => { throw new Error("network down"); }));

    await assert.rejects(() => getStripeSync(), (err: Error) => err instanceof StripeUnverifiedError);
    const readsAfterFirst = __strictModeReadsForTests();

    for (let i = 0; i < 25; i++) {
      await assert.rejects(() => getStripeSync(), (err: Error) => err instanceof StripeUnverifiedError);
    }
    assert.equal(
      __strictModeReadsForTests(),
      readsAfterFirst,
      "25 further calls inside the throttle window must issue no direct-row read",
    );
  });
});

describe("the mode read behind the guard", () => {
  it("test 11 — a failed mode read verifies NOTHING, and recovery verifies the stored mode", async () => {
    // Stored mode is LIVE. The credential for TEST mode is present and would
    // verify; the credential for LIVE mode would not. A guard reading the mode
    // through isLiveMode() — which answers "test" for both "stored as test" and
    // "the lookup threw", through two nested catches — would verify the TEST
    // account and then hand out the misplaced LIVE credential, stamped verified.
    await setStoredMode(true);
    process.env.STRIPE_SECRET_KEY_LIVE = "sk_live_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
    process.env.STRIPE_ACCOUNT_ID_LIVE = "acct_live_expected";
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";

    const verifiedModes: boolean[] = [];
    restores.push(
      stubAccountRetriever((secretKey) => {
        verifiedModes.push(secretKey === "sk_live_correct");
        return secretKey === "sk_live_correct" ? "acct_live_expected" : "acct_test_expected";
      }),
    );

    // The strict read really is a direct row read of the stored value.
    assert.equal(await readStripeLiveModeStrict(), true);

    // Now the recovery half: verification runs against LIVE, never TEST.
    const outcome = await runStripeBootVerification();
    assert.deepEqual(outcome, { kind: "verified", liveMode: true });
    assert.deepEqual(verifiedModes, [true], "the guard must never verify a defaulted mode");
    assert.equal(isAccountVerified(false, "sk_test_correct"), false);
  });

  it("an unreadable mode reports pending rather than guessing a mode", async () => {
    const status = getVerificationStatus(null, "instance-a");
    assert.equal(status.state, "pending");
    assert.equal(status.mode, null);
    assert.match(status.reason ?? "", /could not be read/i);
  });
});

describe("recovery resumes the WHOLE initialization, exactly once", () => {
  it("test 12 — a verified retry registers the webhook and starts the backfill, in that order", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    let calls = 0;
    restores.push(
      stubAccountRetriever(() => {
        calls++;
        if (calls === 1) throw new Error("Stripe unreachable");
        return "acct_expected";
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

    const boot = await runStripeBootVerification();
    assert.equal(boot.kind, "pending");
    assert.deepEqual(sequence, [], "an unverified boot must not touch Stripe");

    // Before this was guarded, a recovered retry restored client availability
    // and left the managed webhook unregistered and the mirror tables empty
    // until the next restart: "payments recover automatically" was true only
    // for clients. Client availability alone is NOT the assertion.
    await runStripeVerificationRetryOnce();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sequence, ["migrations", "webhook", "backfill"]);

    // Exactly once, across boot and every later retry.
    await runStripeVerificationRetryOnce();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sequence, ["migrations", "webhook", "backfill"]);
  });

  it("test 13 — a post-boot confirmed mismatch leaves the process up with payments refused", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_expected";
    let calls = 0;
    restores.push(
      stubAccountRetriever(() => {
        calls++;
        if (calls === 1) throw new Error("Stripe unreachable");
        return "acct_someone_elses";
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

    assert.equal((await runStripeBootVerification()).kind, "pending");

    // Fatality is BOOT-ONLY. A retry (or a PATCH) that discovers a definite
    // wrong account must never terminate a healthy server.
    await runStripeVerificationRetryOnce();
    assert.deepEqual(sequence, [], "a refused account must never start the mutation sequence");
    assert.equal(getVerificationStatus(false, "i").state, "refused");

    // And it stops re-asking: the answer cannot change without an environment
    // change, which needs a restart anyway.
    const before = calls;
    await runStripeVerificationRetryOnce();
    assert.equal(calls, before);
  });
});

describe("the wire contract the frontend branches on", () => {
  it("the client-visible code comes from the shared contract, not a copy", () => {
    // This used to be a test that read the frontend file as TEXT and regexed it
    // for the literal — a mechanism maintained in place of an import. Both sides
    // now import `@workspace/api-zod`, so the type-checker enforces it and this
    // only has to pin that the error class did not grow a local literal.
    assert.equal(new StripeUnverifiedError("x", false).code, SHARED_STRIPE_UNVERIFIED_CODE);
    assert.equal(new StripeUnverifiedError("x", false).clientMessage, SHARED_STRIPE_UNVERIFIED_CLIENT_MESSAGE);
  });

  it("a refusal's client-safe message carries no account identifier", () => {
    const err = new StripeAccountMismatchError(
      "STRIPE ACCOUNT MISMATCH — sk belongs to acct_actual but acct_expected was declared.",
      false,
    );
    assert.doesNotMatch(err.clientMessage, /acct_/);
    assert.equal(err.code, STRIPE_UNVERIFIED_CODE);
  });
});
});
