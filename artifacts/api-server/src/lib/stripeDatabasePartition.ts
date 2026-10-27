/**
 * Which Stripe driver the connected database belongs to (#566, plan decision 12).
 *
 * Two database-level settings, written only when a database is created, partition
 * databases between the drivers in both directions:
 *
 * | Driver                    | Allowed only where                                   |
 * | ------------------------- | ---------------------------------------------------- |
 * | fake                      | test marker AND fake-ownership setting are both set  |
 * | real, credentials present | NEITHER is set                                       |
 *
 * (The real driver without credentials never gets here: it boots "unconfigured"
 * and makes no Stripe call, exactly as before.)
 *
 * So fake and real Stripe data never share a database. Ownership is a static
 * property set at creation, so there is no claim for concurrent boots to race.
 *
 * ## A prerequisite, not a boot step
 *
 * The check runs inside `verifyStripeAccount()`'s attempt, ahead of the account
 * retrieval. Every path into Stripe work goes through that function first — the
 * boot attempt, the background retry, request-driven client and sync
 * construction, and the mode toggle — so none of them can reach Stripe while the
 * partition is unresolved or refused. Being inside the attempt also puts the
 * catalog read behind the guard's single-flight and throttle, so a flood of
 * forged webhooks cannot turn it into one query each.
 *
 * Under the fake, boot and retry also run it BEFORE resolving credentials
 * (`requireFakeStripeDatabaseOwnership`): the fake answers live mode with a
 * credentials refusal, which those two passes would otherwise record as
 * "unconfigured" and continue past without ever reading this (Codex, #671
 * round 2). On success the verdict is cached, so the attempt's check is free.
 *
 * - **Allowed** is cached for the life of the process: the settings are written
 *   at creation and never change under a running server.
 * - **Refused** is a confirmed fact (`StripeDatabasePartitionError`, definite):
 *   fatal at boot, a deterministic refusal after it. Not cached here — the guard
 *   records it as the mode's refused state, and the boot/retry machinery already
 *   stops asking on a definite answer.
 * - **Unreadable** is indefinite (`StripeUnverifiedError`): payments stay
 *   unavailable and every path refuses until a later attempt reads an answer.
 *   A transient database error never takes production down and never opens a path.
 */
import {
  DATABASE_PARTITION_SETTINGS_PARAMS,
  DATABASE_PARTITION_SETTINGS_SQL,
  type DatabasePartitionSettings,
} from "@workspace/db/test-database";
import { StripeDatabasePartitionError, StripeUnverifiedError } from "./stripeVerificationErrors.js";

type DriverKind = "real" | "fake";

let readSettings: () => Promise<DatabasePartitionSettings> = async () => {
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query<DatabasePartitionSettings>(DATABASE_PARTITION_SETTINGS_SQL, [
    ...DATABASE_PARTITION_SETTINGS_PARAMS,
  ]);
  return rows[0]!;
};

const allowed = new Set<DriverKind>();

/** Why `kind` may not use a database with these settings, or null when it may. */
export function partitionRefusal(kind: DriverKind, s: DatabasePartitionSettings): string | null {
  if (kind === "fake") {
    if (s.testMarked && s.fakeOwned) return null;
    return (
      `database '${s.database}' was not created for the fake Stripe driver ` +
      `(test marker: ${s.testMarked ? "set" : "absent"}, fake-ownership setting: ${s.fakeOwned ? "set" : "absent"}). ` +
      `Create one empty with \`pnpm --filter @workspace/db create-stripe-fake-db <name>\`, fill it ` +
      `(migrate, seeds — docs/tests/TESTING.md, "The Stripe fake") and point DATABASE_URL at it.`
    );
  }
  if (!s.testMarked && !s.fakeOwned) return null;
  return (
    `database '${s.database}' is a ${s.fakeOwned ? "fake-Stripe" : "test"} database, and real Stripe credentials ` +
    `are configured. Real Stripe data never goes into a test or fake database: remove the Stripe credentials ` +
    `from this environment, or point DATABASE_URL at the real database.`
  );
}

/**
 * Resolve when the connected database belongs to `kind`. Rejects with
 * `StripeDatabasePartitionError` (confirmed) or `StripeUnverifiedError` (unreadable).
 */
export async function requireStripeDatabasePartition(kind: DriverKind, liveMode: boolean | null): Promise<void> {
  if (allowed.has(kind)) return;
  let settings: DatabasePartitionSettings;
  try {
    settings = await readSettings();
  } catch (err) {
    throw new StripeUnverifiedError(
      `Could not read which Stripe driver this database belongs to, so no Stripe work may start: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      liveMode,
    );
  }
  const refusal = partitionRefusal(kind, settings);
  if (refusal) throw new StripeDatabasePartitionError(refusal, liveMode);
  allowed.add(kind);
}

/** Test seam: replace the catalog read. Returns a restore function. Also clears the cached verdict. */
export function __setPartitionReaderForTests(fn: () => Promise<DatabasePartitionSettings>): () => void {
  const previous = readSettings;
  readSettings = fn;
  allowed.clear();
  return () => {
    readSettings = previous;
    allowed.clear();
  };
}
