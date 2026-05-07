# Contributing

## Database migrations

### Normal workflow

When you change the Drizzle ORM schema in `lib/db/src/schema/`, run:

```bash
pnpm --filter @workspace/db generate
```

This creates a new SQL migration file in `lib/db/migrations/` **and** an
updated snapshot in `lib/db/migrations/meta/`. Both files must be committed
together. The snapshot is what lets Drizzle track the schema state between
migrations — committing the SQL without the snapshot (or vice-versa) will
break the chain.

### CI guards

Two validation scripts run in CI and block merges if the snapshot chain is
broken:

| Script | Catches |
|---|---|
| `check-snapshots` | Missing snapshot files; broken `prevId` chain |
| `validate-snapshots` | Stale snapshots (SQL has DDL not reflected in snapshot); phantom changes (snapshot gains structure not in SQL) |

If either check fails locally you can run them directly:

```bash
pnpm --filter @workspace/db check-snapshots
pnpm --filter @workspace/db validate-snapshots
```

### Recovery: rebuild-snapshots

`lib/db/scripts/rebuild-snapshots.ts` is a **one-time recovery tool**, not
part of the normal workflow. It reconstructs historical snapshots by working
backwards from accurate anchor snapshots.

Run it only when the snapshot chain has become inconsistent in a way that
`generate` alone cannot fix (e.g. after a force-pushed history rewrite or
manual SQL edits that bypassed snapshot tracking):

```bash
pnpm --filter @workspace/db rebuild-snapshots
pnpm --filter @workspace/db check-snapshots   # verify the result
pnpm --filter @workspace/db validate-snapshots
```

Do not run `rebuild-snapshots` as part of a regular feature branch — it
rewrites IDs across the entire snapshot history and will create spurious diffs
against `main`.
