/**
 * The fake Stripe driver and the database partition (#566,
 * docs/plans/PLAN_STRIPE_FAKE.md).
 *
 * What is proven here, by section:
 *
 *   - **Classification at boot.** Each driver on each kind of database: the
 *     fake only on a fake-owned database, the real driver with credentials only
 *     on one carrying neither setting — and a refusal makes no account read.
 *     That a fatal boot outcome never binds the port is stripeBootPlacement's
 *     claim; the end-to-end refusal of the fake on a non-fake database is
 *     asserted there too.
 *   - **Recovery from an unreadable partition**, on every gated path — request
 *     client, sync, the mode toggle and the background retry: nothing reaches
 *     Stripe until a retry reads a definite answer, and only "allowed" opens.
 *   - **The fake read path**, against the real sync library and the test
 *     database: verification, webhook registration, backfill into the mirror,
 *     the catalog read, a scoped sync, and a reboot after the fake's memory is
 *     gone.
 *   - **Refusals**: payment mutations and unimplemented members refuse by name,
 *     and the payment-error responder answers them with a typed 501.
 *   - **Isolation**: the fake's import closure never reaches the real driver.
 *
 * The partition's catalog read itself — the SQL against real databases with
 * each combination of settings — is tested in lib/db
 * (`stripeFakeDatabase.test.ts`); here it is stubbed, because the test database
 * is not fake-owned and must not be made so.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Express, type Request, type Response } from "express";
import request from "supertest";
import ts from "typescript";
import { db } from "@workspace/db";
import { adminConfigTable, usersTable } from "@workspace/db/schema";
import { like, sql } from "drizzle-orm";
import type { DatabasePartitionSettings } from "@workspace/db/test-database";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { __setStripeDriverForTests } from "../lib/stripeDriver.js";
import { realStripeDriver } from "../lib/stripeRealDriver.js";
import { FAKE_SECRET_KEY, __forgetFakeWebhookEndpointsForTests, fakeStripeDriver } from "../lib/stripeFakeDriver.js";
import { FAKE_ACCOUNT_ID } from "../lib/stripeFakeFixture.js";
import { StripeFakeUnsupportedError } from "../lib/stripeFakeErrors.js";
import { __setPartitionReaderForTests, partitionRefusal } from "../lib/stripeDatabasePartition.js";
import {
  __resetVerificationStateForTests,
  __setAccountRetrieverForTests,
  __setStrictModeReaderForTests,
} from "../lib/stripeAccountGuard.js";
import {
  __endCachedSyncForTests,
  __setRawClientFactoryForTests,
  __stripeSyncBuildsForTests,
  getStripeSync,
  getVerifiedStripeClient,
  invalidateStripeSync,
} from "../lib/stripeClient.js";
import {
  __resetStripeInitForTests,
  __setStripeInitDepsForTests,
  runStripeBootVerification,
  runStripeVerificationRetryOnce,
} from "../lib/stripeInit.js";
import { runScopedSync, isSyncRunning, _resetSyncRunnerForTests } from "../lib/stripeSyncRunner.js";
import { stripeStorage } from "../lib/stripeStorage.js";
import { paymentErrorResponse } from "../lib/paymentErrorResponse.js";
import { StripeDatabasePartitionError, StripeUnverifiedError } from "../lib/stripeVerificationErrors.js";
import { clearStripeEnv } from "./helpers/stripeGuardHarness.js";

const NEITHER: DatabasePartitionSettings = { database: "db_real", testMarked: false, fakeOwned: false };
const TEST_ONLY: DatabasePartitionSettings = { database: "db_test", testMarked: true, fakeOwned: false };
const FAKE_OWNED: DatabasePartitionSettings = { database: "db_fake", testMarked: true, fakeOwned: true };
const FAKE_WITHOUT_TEST: DatabasePartitionSettings = { database: "db_odd", testMarked: false, fakeOwned: true };

const USER_PREFIX = "tstripefake-";

/** Remove every row the fake account wrote to the shared test database. */
async function clearFakeAccountRows(): Promise<void> {
  const byAccount = ["prices", "products", "plans", "customers", "subscriptions", "invoices", "charges"];
  for (const table of byAccount) {
    try {
      await db.execute(sql.raw(`DELETE FROM stripe.${table} WHERE _account_id = '${FAKE_ACCOUNT_ID}'`));
    } catch { /* a table the library has not created yet */ }
  }
  for (const statement of [
    `DELETE FROM stripe._managed_webhooks WHERE account_id = '${FAKE_ACCOUNT_ID}'`,
    `DELETE FROM stripe._sync_status WHERE account_id = '${FAKE_ACCOUNT_ID}'`,
    `DELETE FROM stripe.accounts WHERE id = '${FAKE_ACCOUNT_ID}'`,
  ]) {
    try {
      await db.execute(sql.raw(statement));
    } catch { /* absent table */ }
  }
}

describe("the fake Stripe driver and the database partition", () => {
  const restores: Array<() => void> = [];
  let restoreEnv: (() => void) | null = null;

  beforeEach(async () => {
    restoreEnv = clearStripeEnv();
    __resetVerificationStateForTests();
    __resetStripeInitForTests();
    _resetSyncRunnerForTests();
    await __endCachedSyncForTests();
    // Test mode, read strictly, without depending on the config row.
    restores.push(__setStrictModeReaderForTests(async () => false));
  });

  afterEach(async () => {
    while (restores.length > 0) restores.pop()!();
    restoreEnv?.();
    restoreEnv = null;
    __resetVerificationStateForTests();
    __resetStripeInitForTests();
    _resetSyncRunnerForTests();
    await __endCachedSyncForTests();
  });

  after(async () => {
    await clearFakeAccountRows();
  });

  /** Count account reads, answering as `answer` would. */
  function countAccountReads(answer: string): { count: () => number } {
    let n = 0;
    restores.push(__setAccountRetrieverForTests(async () => { n++; return answer; }));
    return { count: () => n };
  }

  function useFake(): void {
    restores.push(__setStripeDriverForTests(fakeStripeDriver));
  }

  function partitionAnswers(settings: DatabasePartitionSettings): void {
    restores.push(__setPartitionReaderForTests(async () => settings));
  }

  function useRealWithCredentials(): void {
    restores.push(__setStripeDriverForTests(realStripeDriver));
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_partition_probe";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_partition_probe";
    process.env.STRIPE_ACCOUNT_ID_TEST = "acct_partition_probe";
  }

  describe("which database each driver may use", () => {
    it("states the rule as a pure function: fake needs both settings, real-with-credentials needs neither", () => {
      assert.equal(partitionRefusal("fake", FAKE_OWNED), null);
      for (const s of [NEITHER, TEST_ONLY, FAKE_WITHOUT_TEST]) assert.ok(partitionRefusal("fake", s), s.database);
      assert.equal(partitionRefusal("real", NEITHER), null);
      for (const s of [TEST_ONLY, FAKE_OWNED, FAKE_WITHOUT_TEST]) assert.ok(partitionRefusal("real", s), s.database);
    });

    for (const settings of [NEITHER, TEST_ONLY, FAKE_WITHOUT_TEST]) {
      it(`the fake on '${settings.database}' is a fatal boot outcome, with no account read`, async () => {
        useFake();
        partitionAnswers(settings);
        const reads = countAccountReads(FAKE_ACCOUNT_ID);
        const outcome = await runStripeBootVerification();
        assert.equal(outcome.kind, "fatal");
        assert.match((outcome as { reason: string }).reason, /not created for the fake Stripe driver/);
        assert.equal(reads.count(), 0);
      });
    }

    it("the fake on a fake-owned database verifies the fake test account", async () => {
      useFake();
      partitionAnswers(FAKE_OWNED);
      const outcome = await runStripeBootVerification();
      assert.deepEqual(outcome, { kind: "verified", liveMode: false });
    });

    for (const settings of [TEST_ONLY, FAKE_OWNED]) {
      it(`the real driver with credentials on '${settings.database}' is a fatal boot outcome, with no account read`, async () => {
        useRealWithCredentials();
        partitionAnswers(settings);
        const reads = countAccountReads("acct_partition_probe");
        const outcome = await runStripeBootVerification();
        assert.equal(outcome.kind, "fatal");
        assert.match((outcome as { reason: string }).reason, /Real Stripe data never goes into a test or fake database/);
        assert.equal(reads.count(), 0);
      });
    }

    it("the real driver with credentials on a database carrying neither setting verifies as before", async () => {
      useRealWithCredentials();
      partitionAnswers(NEITHER);
      const reads = countAccountReads("acct_partition_probe");
      assert.deepEqual(await runStripeBootVerification(), { kind: "verified", liveMode: false });
      assert.equal(reads.count(), 1);
    });

    it("the real driver WITHOUT credentials never consults the partition: it boots unconfigured, as before", async () => {
      restores.push(__setStripeDriverForTests(realStripeDriver));
      let partitionReads = 0;
      restores.push(__setPartitionReaderForTests(async () => { partitionReads++; return TEST_ONLY; }));
      assert.deepEqual(await runStripeBootVerification(), { kind: "unconfigured" });
      assert.equal(partitionReads, 0);
    });
  });

  describe("an unreadable partition gates every path until a retry reads an answer", () => {
    let adminSid: string;

    before(async () => {
      await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
      const adminId = `${USER_PREFIX}${randomUUID()}`;
      await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true });
      const session: SessionData = {
        user: { id: adminId } as unknown as SessionData["user"],
        access_token: "test-token",
        isAdmin: true,
      };
      adminSid = await createSession(session, adminId);
      // The toggle route answers 404 for a key with no row; a fresh worker
      // database has none until something writes it.
      await db
        .insert(adminConfigTable)
        .values({ key: "stripe_live_mode", value: "false", dataType: "boolean", label: "Stripe live mode" })
        .onConflictDoNothing();
    });

    after(async () => {
      await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
    });

    function makeAdminApp(): Express {
      const app = express();
      app.use(express.json());
      app.use(authMiddleware);
      app.use(adminRouter);
      return app;
    }

    /**
     * The fake driver with an instrumented boundary: every account read, raw
     * client construction and sync build is counted, so "no Stripe work" is an
     * observation rather than an inference from a rejection.
     */
    function instrumentedFake(): { reads: () => number; clients: () => number; builds: () => number } {
      useFake();
      const reads = countAccountReads(FAKE_ACCOUNT_ID);
      let clients = 0;
      restores.push(
        __setRawClientFactoryForTests((key) => {
          clients++;
          return fakeStripeDriver.createClient(key) as never;
        }),
      );
      // Initialization after a recovered retry is not what is under test here,
      // and would write the fixture into the shared database.
      restores.push(
        __setStripeInitDepsForTests({
          runSyncMigrations: async () => {},
          getSync: async () => ({ findOrCreateManagedWebhook: async () => ({}), syncBackfill: async () => ({}), liveMode: false }),
          getSiteBaseUrl: () => "http://localhost",
        } as unknown as Parameters<typeof __setStripeInitDepsForTests>[0]),
      );
      const buildsAtStart = __stripeSyncBuildsForTests();
      return { reads: reads.count, clients: () => clients, builds: () => __stripeSyncBuildsForTests() - buildsAtStart };
    }

    async function assertEveryPathRefuses(expected: typeof StripeUnverifiedError | typeof StripeDatabasePartitionError) {
      // Request-driven client construction.
      await assert.rejects(getVerifiedStripeClient(), (err: unknown) => err instanceof expected || err instanceof StripeUnverifiedError);
      // Request-driven sync construction.
      await assert.rejects(getStripeSync(), (err: unknown) => err instanceof expected || err instanceof StripeUnverifiedError);
      // The mode toggle, through its route: it verifies the target mode before writing.
      const res = await request(makeAdminApp())
        .patch("/admin/config/stripe_live_mode")
        .set("authorization", `Bearer ${adminSid}`)
        .send({ value: "false" });
      assert.ok(res.status === 503 || res.status === 409, `toggle answered ${res.status}: ${JSON.stringify(res.body)}`);
    }

    it("unreadable → requests refuse → a retry reads ALLOWED → recovery proceeds", async () => {
      const seen = instrumentedFake();
      let answer: "unreadable" | DatabasePartitionSettings = "unreadable";
      restores.push(
        __setPartitionReaderForTests(async () => {
          if (answer === "unreadable") throw new Error("catalog unavailable");
          return answer;
        }),
      );

      assert.equal((await runStripeBootVerification()).kind, "pending");
      await assertEveryPathRefuses(StripeUnverifiedError);
      assert.deepEqual({ reads: seen.reads(), clients: seen.clients(), builds: seen.builds() }, { reads: 0, clients: 0, builds: 0 });

      answer = FAKE_OWNED;
      await runStripeVerificationRetryOnce();
      assert.equal(seen.reads(), 1, "the retry, and only the retry, read the account");

      const { client, liveMode } = await getVerifiedStripeClient();
      assert.equal(liveMode, false);
      assert.ok(client);
      assert.equal(seen.clients(), 1);
    });

    it("unreadable → requests refuse → a retry reads DISALLOWED → payments stay refused", async () => {
      const seen = instrumentedFake();
      let answer: "unreadable" | DatabasePartitionSettings = "unreadable";
      restores.push(
        __setPartitionReaderForTests(async () => {
          if (answer === "unreadable") throw new Error("catalog unavailable");
          return answer;
        }),
      );

      assert.equal((await runStripeBootVerification()).kind, "pending");
      await assertEveryPathRefuses(StripeUnverifiedError);

      answer = TEST_ONLY;
      await runStripeVerificationRetryOnce();
      await assertEveryPathRefuses(StripeDatabasePartitionError);
      assert.deepEqual({ reads: seen.reads(), clients: seen.clients(), builds: seen.builds() }, { reads: 0, clients: 0, builds: 0 });
    });
  });

  describe("the fake read path, against the real sync library", () => {
    before(async () => {
      const { runMigrations } = await import("stripe-replit-sync");
      await runMigrations({ databaseUrl: process.env.DATABASE_URL! });
      await clearFakeAccountRows();
    });

    it("verifies, registers the webhook, backfills the mirror, serves the catalog and runs a scoped sync", async () => {
      useFake();
      partitionAnswers(FAKE_OWNED);

      const sync = await getStripeSync();
      await sync.findOrCreateManagedWebhook("http://localhost/api/stripe/webhook");
      await sync.syncBackfill({ object: "all" });

      const counts = await db.execute(sql`
        SELECT (SELECT count(*) FROM stripe.products WHERE _account_id = ${FAKE_ACCOUNT_ID})::int AS products,
               (SELECT count(*) FROM stripe.prices WHERE _account_id = ${FAKE_ACCOUNT_ID})::int AS prices,
               (SELECT count(*) FROM stripe._managed_webhooks WHERE account_id = ${FAKE_ACCOUNT_ID})::int AS webhooks`);
      assert.deepEqual(counts.rows[0], { products: 1, prices: 3, webhooks: 1 });

      const catalog = await stripeStorage.listProductsWithPrices(false);
      const legendary = catalog.find((p) => p.id === "prod_fake_legendary");
      assert.ok(legendary, "the fixture product is in the catalog read");
      assert.equal(legendary.metadata.overhype_membership, "true");
      assert.deepEqual(
        legendary.prices.map((p) => p.id).sort(),
        ["price_fake_legendary_annual", "price_fake_legendary_lifetime", "price_fake_legendary_monthly"],
      );

      const run = runScopedSync(sync);
      assert.equal(run.alreadyRunning, false);
      for (let i = 0; i < 200 && isSyncRunning(); i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(isSyncRunning(), false, "the scoped sync finished");
    });

    it("refuses webhook processing by name, before any event is handled (the event channel is next)", async () => {
      useFake();
      partitionAnswers(FAKE_OWNED);
      const sync = await getStripeSync();
      await sync.findOrCreateManagedWebhook("http://localhost/api/stripe/webhook");
      await assert.rejects(
        sync.processWebhook(Buffer.from(JSON.stringify({ id: "evt_fake", type: "charge.refunded" })), "t=1,v1=x"),
        (err: unknown) => err instanceof StripeFakeUnsupportedError && err.member === "webhooks.constructEventAsync",
      );
    });

    it("a reboot after the fake's memory is gone re-registers the webhook instead of failing setup", async () => {
      useFake();
      partitionAnswers(FAKE_OWNED);
      const first = await getStripeSync();
      await first.findOrCreateManagedWebhook("http://localhost/api/stripe/webhook");

      // What a restart does: the fake's in-memory endpoints vanish, the
      // `_managed_webhooks` row stays, and the process builds a new sync.
      __forgetFakeWebhookEndpointsForTests();
      invalidateStripeSync();
      const second = await getStripeSync();
      const endpoint = await second.findOrCreateManagedWebhook("http://localhost/api/stripe/webhook");
      assert.equal((endpoint as { status?: string }).status, "enabled");

      const rows = await db.execute(sql`SELECT count(*)::int AS n FROM stripe._managed_webhooks WHERE account_id = ${FAKE_ACCOUNT_ID}`);
      assert.deepEqual(rows.rows[0], { n: 1 });
    });
  });

  describe("refusals", () => {
    it("refuses every payment mutation by name, and changes nothing", async () => {
      const client = fakeStripeDriver.createClient(FAKE_SECRET_KEY);
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ["checkout.sessions.create", () => client.checkout.sessions.create({})],
        ["subscriptions.update", () => client.subscriptions.update("sub_x", {})],
        ["subscriptions.cancel", () => client.subscriptions.cancel("sub_x")],
        ["customers.create", () => client.customers.create({})],
        ["billingPortal.sessions.create", () => client.billingPortal.sessions.create({ customer: "cus_x" })],
        ["invoices.createPreview", () => client.invoices.createPreview({})],
      ];
      for (const [member, attempt] of attempts) {
        await assert.rejects(attempt(), (err: unknown) => err instanceof StripeFakeUnsupportedError && err.member === member, member);
      }
    });

    it("refuses an unimplemented member by its dotted name, at any depth", async () => {
      const client = fakeStripeDriver.createClient(FAKE_SECRET_KEY) as unknown as {
        products: { search: () => Promise<unknown> };
        webhooks: { constructEventAsync: () => Promise<unknown> };
      };
      await assert.rejects(client.products.search(), /does not support products\.search/);
      await assert.rejects(client.webhooks.constructEventAsync(), /does not support webhooks\.constructEventAsync/);
    });

    it("accepts only its own placeholder key", () => {
      assert.throws(() => fakeStripeDriver.createClient("sk_test_somebody_real"), StripeFakeUnsupportedError);
    });

    it("is test-mode only", () => {
      assert.throws(() => fakeStripeDriver.credentials(true), /test-mode only/);
      assert.equal(fakeStripeDriver.expectedAccountId(true), undefined);
    });

    it("the payment-error responder answers a fake refusal with a typed 501, not a generic 500", () => {
      let status = 0;
      let body: Record<string, unknown> = {};
      const res = {
        status(code: number) { status = code; return this; },
        json(payload: Record<string, unknown>) { body = payload; return this; },
      } as unknown as Response;
      const req = { header: () => undefined } as unknown as Request;
      paymentErrorResponse({
        req,
        res,
        clientMessage: "Unable to start checkout. Please try again.",
        logMessage: "test",
        err: new StripeFakeUnsupportedError("checkout.sessions.create", "not yet"),
      });
      assert.equal(status, 501);
      assert.equal(body.code, "stripe_fake_unsupported");
    });
  });

  describe("isolation", () => {
    it("the fake driver's import closure never reaches the real driver or the SDK construction", () => {
      const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
      const seen = new Set<string>();
      const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = ts.createSourceFile(file, fs.readFileSync(path.join(lib, file), "utf8"), ts.ScriptTarget.ESNext, true);
        const walk = (node: ts.Node) => {
          let spec: string | undefined;
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            // Type-only imports are erased and load nothing.
            const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
            if (!typeOnly) spec = node.moduleSpecifier.text;
          } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            spec = arg && ts.isStringLiteralLike(arg) ? arg.text : "<computed>";
          }
          if (spec !== undefined) {
            assert.notEqual(spec, "<computed>", `${file} has a computed dynamic import`);
            if (spec.startsWith("./")) visit(spec.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
          }
          ts.forEachChild(node, walk);
        };
        walk(source);
      };
      visit("stripeFakeDriver.ts");
      assert.ok(!seen.has("stripeRealDriver.ts"), [...seen].join(", "));
      assert.ok(!seen.has("stripeRawClient.ts"), [...seen].join(", "));
      assert.ok(seen.has("stripeFakeFixture.ts"), "precondition: the walk follows local imports");
    });
  });
});
