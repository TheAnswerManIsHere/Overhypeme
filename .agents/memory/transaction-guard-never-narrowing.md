---
name: A let mutated inside db.transaction() narrows to never after await
description: Why a captured let flag written inside a db.transaction(async (tx) => {...}) callback can't be read reliably after the transaction resolves, and the discriminated-union-return fix.
---

# Don't mutate a captured `let` inside `db.transaction(...)` to signal an outcome — return it instead

A pattern that looks reasonable but breaks under TypeScript: declaring a `let`
before a `db.transaction(async (tx) => {...})` call, mutating it inside the
callback to record which branch fired, then reading it after `await
db.transaction(...)` to decide the HTTP response:

```ts
let guardFailure: { status: number; body: object } | null = null;
await db.transaction(async (tx) => {
  if (someCheck) { guardFailure = { status: 400, body: {...} }; return; }
  await tx.update(...);
});
if (guardFailure) { res.status(guardFailure.status).json(guardFailure.body); return; }
```

TypeScript's control-flow analysis narrows `guardFailure` to `never` when read
after the `await` — even with an explicit type annotation on the `let` — because
it can't see through the closure boundary to know the callback actually ran
before this point. Re-annotating the type at the read site doesn't fix it.

**Fix (used throughout PR #242's `admin.ts` PATCH handler):** never mutate a
captured variable for this — return a discriminated-union result directly from
the transaction callback instead:

```ts
type TxResult = { kind: "guard"; status: number; body: object } | { kind: "ok"; row: Row };
const result: TxResult = await db.transaction(async (tx): Promise<TxResult> => {
  if (someCheck) return { kind: "guard", status: 400, body: {...} };
  const row = await tx.update(...);
  return { kind: "ok", row };
});
if (result.kind === "guard") { res.status(result.status).json(result.body); return; }
```

This is now the established shape for any transaction that needs to signal
"reject with this response" vs. "here's the written row" — reach for it directly
rather than the mutable-capture pattern, which will hit the same `never` wall
every time.
