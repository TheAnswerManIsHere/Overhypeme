/**
 * @purpose Child-process probe for phase15.appRoleSplit.test.ts: in a published-deployment environment (REPLIT_DEPLOYMENT=1, the owner's DATABASE_URL beside the app's APP_DATABASE_URL), Stripe start-up's real sync migrations and the real Stripe driver's pool both run through the application's own login, after the owner's credential has left process.env (Launch Phase 15, 5b).
 * @subsystem tooling
 *
 * Only Stripe's network is absent: start-up stops on purpose at the step after migrations
 * (`getSync`), which is the first that would call Stripe. Prints one JSON line.
 */
import { appDatabaseUrl, OWNER_CREDENTIAL_VARIABLES, pool } from "@workspace/db";
import { __setStripeInitDepsForTests, resumeStripeInitialization } from "../../lib/stripeInit.js";
import { realStripeDriver } from "../../lib/stripeRealDriver.js";

if (process.env.REPLIT_DEPLOYMENT !== "1") throw new Error("this probe runs only with REPLIT_DEPLOYMENT=1");

const leftInEnv = OWNER_CREDENTIAL_VARIABLES.filter((name) => name in process.env);

let migrationsUser: string | null = null;
__setStripeInitDepsForTests({
  runSyncMigrations: async (opts) => {
    migrationsUser = decodeURIComponent(new URL(opts.databaseUrl).username);
    const { runMigrations } = await import("stripe-replit-sync");
    return runMigrations(opts);
  },
  getSync: async () => {
    throw new Error("probe: stop before the first call to Stripe");
  },
  getSiteBaseUrl: () => "https://probe.invalid",
});

const completed = await resumeStripeInitialization();

// The real driver's sync, as payments use it: its own pool, built from the app's login.
const sync = (await realStripeDriver.buildSync({ liveMode: false, secretKey: "sk_test_probe_never_used", webhookSecret: null })) as unknown as {
  postgresClient: { pool: { query: (sql: string) => Promise<{ rows: Array<{ u: string }> }>; end: () => Promise<void> } };
};
const { rows } = await sync.postgresClient.pool.query("SELECT current_user AS u");
await sync.postgresClient.pool.end();

const schema = await pool.query<{ owner: string | null }>(
  "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'stripe'",
);
await pool.end();

console.log(
  `[stripe-probe] ${JSON.stringify({
    leftInEnv,
    resolvedUser: decodeURIComponent(new URL(appDatabaseUrl()).username),
    migrationsUser,
    driverPoolUser: rows[0]?.u ?? null,
    stripeSchemaOwner: schema.rows[0]?.owner ?? null,
    completed,
  })}`,
);
