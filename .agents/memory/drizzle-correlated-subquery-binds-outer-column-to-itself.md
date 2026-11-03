---
name: Drizzle renders a single-table select's selected fields unqualified, so a correlated subquery there can bind the outer column to itself
description: In a single-table select, `${outer.col}` inside a raw `sql` expression in the SELECTED FIELDS renders as a bare column name (the WHERE clause qualifies it); if the subquery's own table has a column of that name, Postgres binds it to the inner table and the correlation silently disappears. Spell the outer column with its table's name.
---

# A correlated subquery in the selected fields binds an unqualified outer column to itself

Measured on launch Phase 5's content purger (PR #815 — Launch Phase 5,
Increment 4b: everything in My content is undoable for 30 days) and the
account purge (PR #820 — Launch Phase 5, Increment 5a: an account can leave
cleanly — the deletion engine); reproduced with `.toSQL()` against the
installed Drizzle on 2026-11-02 (PR #841, Astra's round-1 finding D4).

**The trap.** In a single-table select, Drizzle renders a column interpolated
into a selected `sql` expression *unqualified*, while the same column in the
WHERE clause is qualified:

```ts
db.select({ others: sql`(SELECT count(*) FROM user_ai_images o
                         WHERE o.storage_path = ${t.storagePath})` })
  .from(t).where(eq(t.id, 1)).toSQL().sql
// select (SELECT count(*) FROM user_ai_images o WHERE o.storage_path = "storage_path") from "user_ai_images" where "user_ai_images"."id" = $1

db.select({ id: t.id }).from(t)
  .where(sql`(SELECT count(*) FROM user_ai_images o WHERE o.storage_path = ${t.storagePath}) = 1`).toSQL().sql
// select "id" from "user_ai_images" where (SELECT count(*) FROM user_ai_images o WHERE o.storage_path = "user_ai_images"."storage_path") = 1
```

In the first, Postgres resolves the bare `"storage_path"` against the
**innermost** table that has it, so the predicate reads
`o.storage_path = o.storage_path`: always true, and no longer correlated. The
purger's "do other rows name this file" count silently counted zero until the
outer table was spelled by name; a test caught it, nothing else would have.

**The symptom is a plausible wrong number, never an error.** The query is
valid SQL either way.

**The fix.** Qualify the outer column with its table's name, as
`artifacts/api-server/src/jobs/contentPurger.ts` does
(`o.storage_path = user_ai_images.storage_path`) and as `outer(table, column)`
in `artifacts/api-server/src/lib/contentVisibility.ts` renders
(`"table"."column"`). Check a suspect query with `.toSQL()`. A subquery whose
table happens to lack the column is safe only by accident
(`aiImageIsOwnersOwn` is, because `facts` has no `fact_id`/`storage_path`) —
qualify it anyway.
