---
name: Drizzle renders a single-table select's columns unqualified, so a correlated subquery can bind the outer column to itself
description: Inside a raw `sql` correlated subquery, `${outerTable.col}` renders as a bare column name when the outer select reads one table; if the subquery's own table has a column of that name, Postgres binds it to the inner table and the correlation silently disappears. Spell the outer column with its table's name.
---

# A correlated subquery binds an unqualified outer column to itself

Measured on launch Phase 5's content purger (PR #815 — Launch Phase 5,
Increment 4b: everything in My content is undoable for 30 days) and the
account purge (PR #820 — Launch Phase 5, Increment 5a: an account can leave
cleanly — the deletion engine).

**The trap.** Drizzle renders columns *unqualified* in a single-table select.
So in

```ts
db.select().from(memesTable).where(sql`
  (SELECT count(*) FROM memes m2 WHERE m2.storage_path = ${memesTable.storagePath}) = 1`)
```

`${memesTable.storagePath}` becomes plain `"storage_path"`. Inside the
subquery, Postgres resolves a bare name against the **innermost** table that
has it, so the predicate reads `m2.storage_path = m2.storage_path`: always
true, and no longer correlated. The purger's "do other rows name this file"
count silently counted zero until the outer table was spelled by name; a test
caught it, nothing else would have.

**The symptom is a plausible wrong number, never an error.** The query is
valid SQL either way.

**The fix.** Qualify the outer column with its table's name. In this repo
that is `outer(table, column)` in
`artifacts/api-server/src/lib/contentVisibility.ts`, which renders
`"table"."column"`. A subquery whose table happens to lack the column is safe
only by accident (`aiImageIsOwnersOwn` is, because `facts` has no
`fact_id`/`storage_path`) — qualify it anyway.
