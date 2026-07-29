/**
 * Per-source leases and their fencing tokens.
 *
 * The problem this solves is not "two writers at once" — it is that **no
 * ordering token works**. The pinned Stripe `Subscription` exposes no version or
 * mutation timestamp, so nothing available to us derives from provider state.
 * Taking a locally-allocated token before issuing a request orders *requests*,
 * not *state*: request A takes token 1, stalls past a cancellation and returns
 * `canceled`; request B takes token 2, is served older `active` state, and wins
 * on the larger token. Access is resurrected. Taking it after retrieval has the
 * mirror-image failure.
 *
 * So instead: **one retrieval-and-apply in flight per source at a time.** With
 * that, completion order is issuance order is state order, and the guarantee
 * holds rather than being asserted.
 *
 *   1. `acquireLease` claims a row in a short transaction that COMMITS
 *      immediately, taking a fresh fence from a sequence.
 *   2. The Stripe retrieval runs with NO transaction open. That is what makes a
 *      lease admissible where a `SELECT … FOR UPDATE` held across network I/O is
 *      not: a lease is a committed row, so it pins no connection and blocks no
 *      unrelated query.
 *   3. `withLeaseFence` opens the short apply transaction by taking the lease row
 *      `FOR UPDATE` and requiring holder, fence and expiry to still match. The
 *      ROW LOCK — not the TTL — is what makes ownership and write atomic: once
 *      the holder has the lock and has seen the lease unexpired, nobody can
 *      acquire until it commits or rolls back. The TTL therefore does not have
 *      to exceed the apply transaction's duration.
 *   4. Release is compare-and-release, so a late holder cannot release a lease
 *      that now belongs to its successor.
 *
 * The version guard on `source_state_as_of` stays as defence in depth, NOT as
 * the fence. It cannot fence an expired holder: A stalls past expiry, B acquires
 * and is still retrieving, so B has written nothing — the stored token is still
 * the old one and A's late write passes the guard unchanged.
 *
 * Cost, stated plainly: concurrent updates to the SAME subscription queue
 * instead of racing. Different subscriptions are unaffected, and the queue depth
 * per source is bounded by how many events Stripe sends about one object at
 * once — small.
 */

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { membershipLeasesTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { EntitlementSourceType } from "@workspace/db/schema";

/** Scope for the lease guarding one entitlement source's retrieval-and-apply. */
export function sourceLeaseScope(
  sourceType: EntitlementSourceType,
  providerRef: string,
): string {
  return `source:${sourceType}:${providerRef}`;
}

/** Scope for the single reconciliation run lease. Heartbeated, not long-TTL'd. */
export const RECONCILE_RUN_LEASE_SCOPE = "reconcile:run";

/** A held lease. `fence` must be presented to every write made under it. */
export interface LeaseHandle {
  scope: string;
  holder: string;
  fence: number;
  expiresAt: Date;
}

/** Identifies this process for the lifetime of the module. Compared, never parsed. */
const PROCESS_HOLDER_ID = `${process.pid}-${randomUUID()}`;

export function currentHolderId(): string {
  return PROCESS_HOLDER_ID;
}

/**
 * Claim a lease, stealing one whose expiry has passed.
 *
 * Commits immediately — the caller must NOT hold a transaction open across this,
 * because the whole point is that the Stripe retrieval which follows runs
 * unencumbered.
 *
 * Returns null when the scope is held by a live holder.
 */
export async function acquireLease(
  scope: string,
  ttlSeconds: number,
  holder: string = PROCESS_HOLDER_ID,
): Promise<LeaseHandle | null> {
  // A single statement, so the check-and-claim cannot interleave: the ON
  // CONFLICT arm's WHERE sees the existing row and only steals it if it has
  // actually expired. A fresh fence is taken on EVERY acquisition, including a
  // steal — that is what lets the apply transaction tell a live holder from a
  // revenant one.
  const rows = await db.execute<{ scope: string; holder: string; fence: string; expires_at: Date }>(sql`
    INSERT INTO membership_leases (scope, holder, fence, acquired_at, expires_at)
    VALUES (
      ${scope},
      ${holder},
      nextval('membership_lease_fence_seq'),
      now(),
      now() + make_interval(secs => ${ttlSeconds}::double precision)
    )
    ON CONFLICT (scope) DO UPDATE
      SET holder = EXCLUDED.holder,
          fence = EXCLUDED.fence,
          acquired_at = EXCLUDED.acquired_at,
          expires_at = EXCLUDED.expires_at
      WHERE membership_leases.expires_at <= now()
    RETURNING scope, holder, fence, expires_at
  `);

  const row = rows.rows[0];
  if (!row) return null;
  return {
    scope: row.scope,
    holder: row.holder,
    fence: Number(row.fence),
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Acquire, waiting up to `waiterTimeoutSeconds` for a busy scope.
 *
 * A waiter that times out returns null and its caller **abandons its write**
 * rather than proceeding unordered — reconciliation repairs it. That is why the
 * timeout may be short: it trades latency for nothing.
 */
export async function acquireLeaseWithWait(
  scope: string,
  ttlSeconds: number,
  waiterTimeoutSeconds: number,
  holder: string = PROCESS_HOLDER_ID,
  opts: { pollIntervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LeaseHandle | null> {
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const deadline = now() + waiterTimeoutSeconds * 1000;
  for (;;) {
    const handle = await acquireLease(scope, ttlSeconds, holder);
    if (handle) return handle;
    if (now() >= deadline) return null;
    await sleep(pollIntervalMs);
  }
}

/**
 * Renew a lease the caller still owns. Used by the reconciliation run lease.
 *
 * Returns false when the lease has been taken over or already released — and a
 * run whose renewal fails **abandons rather than continuing unfenced**.
 *
 * Heartbeating is what makes expiry mean *the holder stopped* rather than *the
 * holder is slow*. A whole staging run has no bounded duration, so any fixed TTL
 * is either shorter than some legitimate run — the holder expires mid-run and
 * the fence then aborts it, so the run can never complete on a slow day — or
 * long enough that a crashed run blocks repair for that whole period.
 */
export async function heartbeatLease(
  handle: LeaseHandle,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await db
    .update(membershipLeasesTable)
    .set({ expiresAt: sql`now() + make_interval(secs => ${ttlSeconds}::double precision)` })
    .where(
      and(
        eq(membershipLeasesTable.scope, handle.scope),
        eq(membershipLeasesTable.holder, handle.holder),
        eq(membershipLeasesTable.fence, handle.fence),
      ),
    )
    .returning({ expiresAt: membershipLeasesTable.expiresAt });

  return result.length > 0;
}

/**
 * Compare-and-release. A late holder cannot release a lease that now belongs to
 * its successor, because the fence will not match.
 */
export async function releaseLease(handle: LeaseHandle): Promise<boolean> {
  const result = await db
    .delete(membershipLeasesTable)
    .where(
      and(
        eq(membershipLeasesTable.scope, handle.scope),
        eq(membershipLeasesTable.fence, handle.fence),
      ),
    )
    .returning({ scope: membershipLeasesTable.scope });

  return result.length > 0;
}

/** Thrown when the apply transaction finds the lease is no longer ours. */
export class LeaseFenceError extends Error {
  constructor(scope: string, detail: string) {
    super(`lease fence check failed for ${scope}: ${detail}`);
    this.name = "LeaseFenceError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run the apply transaction under the fence.
 *
 * The transaction BEGINS by taking the lease row `FOR UPDATE` and requiring
 * holder, fence and expiry to still hold. If any fails the transaction aborts
 * and the write is abandoned — which is the case the version guard cannot cover,
 * because a successor that is still retrieving has not stored a newer token yet.
 *
 * `lockTimeoutMs` is set inside the transaction. It is safe to bound because the
 * transaction holds no network I/O by construction.
 */
/**
 * Re-check the fence inside a transaction the caller already opened.
 *
 * This is the whole of the fencing check, factored out because the webhook path
 * must run it inside the SAME transaction that claims idempotency — it cannot
 * open its own. Throws `LeaseFenceError`, which aborts that transaction and
 * abandons the write.
 */
export async function assertFenceHeld(tx: Tx, handle: LeaseHandle): Promise<void> {
  // Expiry is evaluated by the DATABASE, not by comparing a fetched timestamp
  // against this process's clock — the leases are written with the database's
  // now(), and app-vs-database skew would make the fence wrong in whichever
  // direction the skew ran.
  const held = await tx.execute<{ holder: string; fence: string; expired: boolean }>(sql`
    SELECT holder, fence, (expires_at <= now()) AS expired
    FROM membership_leases
    WHERE scope = ${handle.scope}
    FOR UPDATE
  `);

  const row = held.rows[0];
  if (!row) throw new LeaseFenceError(handle.scope, "lease row is gone");
  if (row.holder !== handle.holder) {
    throw new LeaseFenceError(handle.scope, "held by another holder");
  }
  if (Number(row.fence) !== handle.fence) {
    throw new LeaseFenceError(handle.scope, `fence ${handle.fence} superseded by ${row.fence}`);
  }
  // Checked inside the row lock, so this is not a check-then-write race: once we
  // hold the lock and have seen it unexpired, no successor can acquire until
  // this transaction ends. That is why the TTL does not have to exceed the apply
  // transaction's duration.
  if (row.expired) {
    throw new LeaseFenceError(handle.scope, "lease expired before the apply");
  }
}

/**
 * Open the apply transaction and run the fence check first.
 *
 * `lockTimeoutMs` is set inside the transaction. It is safe to bound because the
 * transaction holds no network I/O by construction.
 */
export async function withLeaseFence<T>(
  handle: LeaseHandle,
  lockTimeoutMs: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(String(Math.trunc(lockTimeoutMs)))}`);
    await assertFenceHeld(tx, handle);
    return fn(tx);
  });
}
