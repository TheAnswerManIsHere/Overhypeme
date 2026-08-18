/**
 * A deadline for post-provider bookkeeping work.
 *
 * WHY THIS EXISTS. Several paths need a figure *only* so a ledger row can be
 * written, at a point where the provider has already completed and been paid.
 * Those lookups run queries, and a query first takes a client from the shared
 * pool — which sets no `connectionTimeoutMillis` (see `lib/db/src/index.ts`),
 * so under saturation the checkout queues with no deadline. An unbounded wait
 * there stalls a request whose real work is finished, purely for bookkeeping.
 *
 * RACING IS CORRECT HERE AND WRONG FOR `noteLedgerWriteFailure`. The difference
 * is what gets abandoned. These callers race a *complete* query, which acquires
 * and releases its own client, so dropping the `await` leaks nothing — the
 * query finishes and releases regardless. `noteLedgerWriteFailure` races a
 * `db.transaction`, where abandoning the wait does not cancel the underlying
 * `pool.connect()`: the client is still acquired and would never be released,
 * so that one is DETACHED instead (see `budgetGate.recordCost`). Do not
 * "unify" the two — they are different problems with different right answers.
 *
 * Blowing the deadline must always land somewhere that already handles a failed
 * lookup. Every caller routes it into a catch that skips the row and increments
 * `ledger_write_failures`, so a timeout is an instance of a handled case rather
 * than a new failure mode.
 */

/** Deliberately generous: this should fire on genuine saturation, not on a
 * merely slow environment. A too-tight bound would silently skip ledger rows
 * under ordinary load, which is the fail-open this subsystem exists to close. */
export const BOOKKEEPING_LOOKUP_TIMEOUT_MS = 10_000;

export function withBookkeepingTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${BOOKKEEPING_LOOKUP_TIMEOUT_MS}ms`)),
      BOOKKEEPING_LOOKUP_TIMEOUT_MS,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
