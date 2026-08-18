# Race a complete query; DETACH a transaction

Bounding a slow database call on a user-facing path has two right answers and
they are not interchangeable. Picking the wrong one makes the problem worse
under exactly the load that triggers it.

The shared pool (`lib/db/src/index.ts`) sets **no `connectionTimeoutMillis`**,
so every query first waits for a client with no deadline. That is the phase
that actually hangs under saturation — and it happens *before* any
`SET LOCAL statement_timeout` you put inside the transaction can exist.

**Race a complete query** (`db.select()...`, a whole drizzle call). It acquires
and releases its own client, so abandoning your `await` leaks nothing — the
query finishes and releases regardless. You simply stop waiting for an answer
you have a fallback for. This is `withBookkeepingTimeout` in
`lib/bookkeepingTimeout.ts`.

**Detach a transaction** (`db.transaction(...)`) — do not race it. Abandoning
the wait does not cancel the underlying `pool.connect()`: the client is still
acquired and now nobody releases it. Racing leaks a connection instead of
freeing one. Use `void fn()` and let it finish on its own. This is why
`budgetGate.recordCost` detaches `noteLedgerWriteFailure` rather than bounding
it, even though the two look like the same problem.

**The tell is what gets abandoned, not which file it is in.** Both call sites
carry comments saying so, including an explicit "do not unify these two",
because the natural instinct on seeing them side by side is to make them
consistent — in the wrong direction.

**A pool-wide `connectionTimeoutMillis` would fix the checkout phase properly**
and is deliberately not set: that pool serves every query in the process, so
bounding checkout globally is a real behavior change for unrelated paths and
deserves its own consideration rather than riding along with a diagnostic.

**Reference:** PR #498 rounds 2–4, `lib/bookkeepingTimeout.ts`,
`budgetGate.recordCost`.
