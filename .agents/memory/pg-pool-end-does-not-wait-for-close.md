---
name: pg Pool.end() resolves before its connections close; a pool on a database you drop needs an error listener
description: In a shard every test file shares one Node process (--test-isolation=none). A pg Pool on a database a test force-drops, or whose connections it terminates, can throw "terminating connection due to administrator command" at that process after every test passed, failing the whole shard. Give such a pool an error listener (artifacts/api-server/src/__tests__/helpers/droppablePool.ts).
---

# `Pool.end()` does not wait for its connections to close

**Rule.** A `pg.Pool` on a database that is later dropped `WITH (FORCE)`, renamed, or has its backends terminated gets `pool.on("error", () => {})`. In a test, build it with `droppablePool()` (`artifacts/api-server/src/__tests__/helpers/droppablePool.ts`). A `pg.Client` whose `end()` is awaited is safe: `Client.end()` waits for the socket to close.

**Why.** `pg-pool`'s `end()` takes each idle client out of its list and calls `client.end()` without waiting, then resolves as soon as the list is empty (`pg-pool/index.js`, `_pulseQueue` and `_remove`). The client keeps the pool's idle listener, which re-emits a connection error as `pool.emit('error')`. When the force-drop reaches the server before the client's terminate message, the dying connection errors. A pool with no `error` listener throws, and because the sharded runner passes `--test-isolation=none` (`scripts/lib/test-db.sh`, `detect_isolation_flag`), that is an uncaught exception in the shard process. Node blames whichever test created the pool and fails the shard with every test at `# fail 0`.

**Measured.** Issue #808. It hit CI twice in one hour on 2026-11-01, on PR #807 and PR #811. A local probe (`await pool.end()`, then terminate) never reproduced it in 20 tries, because the race needs CI's latency. `droppablePool.test.ts` reproduces the same path deterministically by terminating an idle pooled connection: it fails 0 of 2 without the listener and passes 2 of 2 with it.
