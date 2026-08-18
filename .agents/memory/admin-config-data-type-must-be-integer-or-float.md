# `admin_config` numeric validation does NOT keep malformed text out — the consuming SQL is the only real defense

Two separate weaknesses, and the second is the one that matters:

**1. An unrecognized `data_type` skips validation entirely.** The
`/admin/config` PATCH route (`routes/admin.ts`) checks
`existing.dataType === "integer"`, then `else if === "float"`, with **no else
branch** — so any other value (e.g. a hand-written `'number'`) falls through
and the row accepts arbitrary text. The column default is `'integer'`.

**2. Even the recognized types don't store what they validated.** The route
validates with `parseInt`/`parseFloat` and then persists **`rawValue`, the
original string** (`newValue = rawValue`). So `3.5` on an `integer` key parses
to `3`, passes, and is stored verbatim as `"3.5"`; `1oops` on a `float` parses
to `1` and stores `"1oops"`. Setting the right `data_type` narrows the input
but **does not guarantee the stored value is canonical numeric text**.

> **Correction, PR #509 round 1.** An earlier version of this note prescribed
> "use `integer`" as the fix that closes the UI route. It doesn't, per (2).
> Anyone writing a new numeric config key needs to know that.

**So: make the consuming SQL survive a bad value, always.** That is the only
protection that holds regardless of how the value arrived — the admin UI, a
direct edit, a migration, a future code path:

```sql
CASE WHEN value ~ '^[0-9]+$' THEN value::bigint ELSE 0 END + 1
```

Without it, one malformed value permanently breaks the consumer. In the case
that produced this note, `::bigint` on `"3.5"` errors, and because
`noteLedgerWriteFailure` swallows its own errors by design the counter would
have been dead **and silent**.

**Two supporting measures, neither sufficient alone:** use a recognized
`data_type` with `min_value`/`max_value` so the UI at least rejects the obvious
cases, and self-heal metadata on conflict (`data_type = EXCLUDED.data_type`) or
a row created by an earlier build keeps its unvalidated type forever.

**A proper fix for (2)** — storing the parsed value rather than `rawValue` — is
a route change, not a caller's problem to work around. Not attempted here.

**Reference:** PR #498 round 2, PR #509 round 1, `routes/admin.ts`.
