# Racing a DB call doesn't cancel it — so bound the wait, don't pretend you bounded the work

Bounding a slow database call on a user-facing path. The shared pool
(`lib/db/src/index.ts`) sets **no `connectionTimeoutMillis`**, so every query
first waits for a client with no deadline — and that checkout happens *before*
any `SET LOCAL statement_timeout` inside a transaction can exist. So SQL-level
bounds cannot cover the phase that actually hangs under saturation.

**What racing actually does, stated correctly.** `Promise.race` abandons your
*wait*. It does not cancel the underlying work: the query or transaction runs
to completion and releases its client on its own. For a `db.transaction`,
drizzle's `NodePgSession.transaction` holds the client through
`finally { if (isPool) session.client.release(); }`, so the release happens
whichever promise won. **Racing therefore does not relieve pool pressure at
all** — the client stays held for the full duration either way.

> **Correction, PR #509 round 1.** An earlier version of this note — and
> comments still on `main` in `budgetGate.recordCost` and
> `lib/bookkeepingTimeout.ts` — claimed that abandoning a raced transaction
> *strands* the client and leaks a connection. **That is false**, and it is a
> worse kind of wrong than a missing caveat: it invents an invariant that would
> steer a future saturation fix away from perfectly valid request-level
> timeouts. Tracked for correction in the code comments.

**So the real choice is about what you do with the answer, not about leaks:**

- **Race a lookup whose value you need** (`withBookkeepingTimeout` in
  `lib/bookkeepingTimeout.ts`) when you have a documented fallback for not
  getting it — you stop waiting, take the fallback path, and the query finishes
  harmlessly behind you.
- **Detach work whose result you don't need** (`void noteLedgerWriteFailure()`
  in `budgetGate.recordCost`). Nothing waits, so there is nothing to bound.
  This is simpler than racing, not safer than it.

**The thing neither option fixes** is pool pressure itself. A pool-wide
`connectionTimeoutMillis` is the only bound that reaches the checkout phase,
and it is deliberately unset: that pool serves every query in the process, so
bounding checkout globally is a real behavior change for unrelated paths and
deserves its own consideration rather than riding along with a diagnostic.

**Reference:** PR #498 rounds 2–4, PR #509 round 1 (the correction),
`drizzle-orm/node-postgres/session.js`.
